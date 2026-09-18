import copy
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("backup_host", pathlib.Path(__file__).parents[1] / "deploy/aws/backup-host.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
RUN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
SOURCE = "vol-0123456789abcdef0"
RESTORE = "vol-abcdef01234567890"
FP = {"version": 1, "records": 1, "recordsSha256": "a" * 64, "attachments": 0, "attachmentBytes": 0, "attachmentsSha256": "b" * 64, "encryptionVerified": True}


class Fake(module.Host):
    def __init__(self, root):
        super().__init__({"run": RUN, "source": SOURCE, "restore": RESTORE, "stack": "agent-relay-mvp", "repository": "owned.ecr/relay", "fingerprintScript": "Ly8gZml4dHVyZQ=="})
        self.directory = pathlib.Path(root) / "backup"
        self.mount = self.directory / "restore"
        self.events = []
        self.busy = False
        self.fail_fingerprint = False
        self.fail_stop = False
        self.fail_guard = False
        self.extra_reader = False
        self.drained = False
        self.mounts = []
        self.value = {"Id": "original-id", "Image": "sha256:" + "b" * 64, "Name": "/relay", "State": {"Running": True},
                      "Config": {"Image": "owned.ecr/relay@sha256:" + "a" * 64, "Labels": {"ci.12-apps.managed": "true", "ci.12-apps.stack": "agent-relay-mvp"},
                                 "Env": ["AGENT_DATABASE_MODE=embedded", "AGENT_CONTROL_DIR=/var/lib/relay/control", "AGENT_ENCRYPTION_KEY=private-fixture-value", "GOOGLE_CLIENT_SECRET=never-forward"]},
                      "Mounts": [{"Type": "bind", "Source": "/srv/relay/data", "Destination": "/var/lib/relay"}]}

    def inspect(self, name):
        return self.value if name == "relay" else {"Config": {"Labels": {"relay.backup.run": RUN}}} if self.extra_reader and name == self.reader else None

    def cmd(self, args, timeout=30):
        self.events.append(args)
        if args[:2] == ["docker", "stop"]:
            if self.fail_stop:
                raise module.BackupError("injected stop failure")
            if args[-1] == self.reader:
                self.extra_reader = False
            else:
                self.value["State"]["Running"] = False
        elif args[:2] == ["docker", "start"]:
            self.value["State"]["Running"] = True
        elif args[:3] == ["docker", "container", "ls"]:
            return "relay"
        elif args[:2] == ["docker", "run"]:
            envfile = pathlib.Path(args[args.index("--env-file") + 1])
            assert envfile.stat().st_mode & 0o077 == 0
            assert envfile.read_text() == "AGENT_ENCRYPTION_KEY=private-fixture-value\n"
            return json.dumps(FP)
        elif args[0] == "umount":
            self.mounts = []
        elif args[0] == "mount":
            self.mounts = [args[-1]]
        elif args[0] == "blkid":
            return "ext4"
        elif args[0] == "findmnt":
            return json.dumps({"filesystems": [{"fstype": "tmpfs"}]})
        elif args[0] in ["systemd-run", "systemctl", "sync"]:
            if args[0] == "systemd-run" and self.fail_guard:
                raise module.BackupError("guard unavailable")
        else:
            raise AssertionError("Unexpected host command")
        return ""

    def validate_source(self):
        return {"name": "/dev/nvme1n1"}

    def http(self, method, route):
        self.events.append([method, route])
        if route.endswith("drain"):
            if self.busy:
                return False
            self.drained = True
        if route.endswith("resume"):
            self.drained = False
        return self.value["State"]["Running"] and not self.drained if route == "/readyz" else True

    def fingerprint(self, mount, original, env):
        if self.fail_fingerprint:
            raise module.BackupError("injected fingerprint failure")
        (self.directory / "release").touch()
        return FP

    def state(self):
        return json.loads((self.directory / "state.json").read_text())

    def device(self, volume, absent=False):
        return {"name": "/dev/nvme2n1", "type": "disk", "mountpoints": self.mounts}


class Tests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="relay-backup-host-test-")
        self.mask = os.umask(0o077)
        self.host = Fake(self.directory.name)

    def tearDown(self):
        os.umask(self.mask)
        self.directory.cleanup()

    def test_hold_recovers_exact_original_and_preserves_fingerprint(self):
        result = self.host.hold()
        self.assertEqual(result["phase"], "recovered")
        self.assertEqual(result["fingerprint"], FP)
        self.assertTrue(self.host.value["State"]["Running"])
        self.assertFalse(self.host.drained)
        self.assertIn(["docker", "stop", "--time", "120", "original-id"], self.host.events)
        self.assertIn(["docker", "start", "original-id"], self.host.events)

    def test_preparation_failures_recover_in_finally_without_other_controller(self):
        for failure in ["busy", "fail_fingerprint", "fail_stop"]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix="backup-failure-") as root:
                host = Fake(root)
                setattr(host, failure, True)
                with self.assertRaises(module.BackupError):
                    host.hold()
                self.assertTrue(host.value["State"]["Running"])
                self.assertFalse(host.drained)
                self.assertFalse(any(event[:2] == ["docker", "run"] for event in host.events))

    def test_independent_guard_is_required_before_stop_and_cancelled_ssm_can_be_recovered(self):
        self.host.fail_guard = True
        with self.assertRaises(module.BackupError):
            self.host.hold()
        self.assertFalse(any(event[:2] == ["docker", "stop"] for event in self.host.events))
        self.host.fail_guard = False
        self.host.events = []
        self.host.arm_recovery()
        command = self.host.events[0]
        self.assertEqual(command[0], "systemd-run")
        self.assertIn("--on-active=600s", command)
        # Simulate SIGKILL/cancel after stop: do not call hold's finally. The
        # independent systemd invocation reads only exact private saved state.
        original = {"run": RUN, "source": SOURCE, "phase": "preparing", "container": "original-id", "image": self.host.value["Image"]}
        self.host.save(original)
        self.host.value["State"]["Running"] = False
        self.host.drained = True
        self.host.extra_reader = True
        (self.host.directory / "reader.env").write_text("private-fixture-value")
        self.assertTrue(self.host.watchdog()["originalRecovered"])
        self.assertTrue(self.host.value["State"]["Running"])
        self.assertFalse(self.host.extra_reader)
        self.assertFalse(self.host.drained)
        self.assertFalse((self.host.directory / "reader.env").exists())
        self.assertEqual(self.host.state()["phase"], "recovered")

    def test_recovery_rejects_changed_identity_or_remaining_database_reader(self):
        self.host.value["State"]["Running"] = False
        for original in [{"container": "foreign-id", "image": self.host.value["Image"]}, {"container": "original-id", "image": "foreign-image"}]:
            with self.assertRaises(module.BackupError):
                self.host.recover(original)
        self.host.extra_reader = True
        with self.assertRaisesRegex(module.BackupError, "concurrent database"):
            self.host.recover({"container": "original-id", "image": self.host.value["Image"]})
        self.assertFalse(self.host.value["State"]["Running"])
        self.assertFalse(any(event[:2] == ["docker", "start"] for event in self.host.events))

    def test_reader_receives_only_private_key_and_same_image_without_network_or_relay(self):
        self.host.directory.mkdir(mode=0o700)
        value, env = self.host.controller()
        result = module.Host.fingerprint(self.host, "/private-copy", {"image": value["Image"]}, env)
        self.assertEqual(result, FP)
        command = next(event for event in self.host.events if event[:2] == ["docker", "run"])
        self.assertIn(value["Image"], command)
        self.assertEqual(command[command.index("--network") + 1], "none")
        self.assertEqual(command[command.index("--entrypoint") + 1], "node")
        self.assertNotIn("GOOGLE_CLIENT_SECRET", " ".join(command))
        self.assertFalse((self.host.directory / "reader.env").exists())

    def test_cleanup_refuses_source_or_unexpected_mount_and_unmounts_only_restore(self):
        self.host.directory.mkdir(mode=0o700)
        self.host.save({"run": RUN, "source": SOURCE, "phase": "recovered"})
        self.host.c["restore"] = SOURCE
        with self.assertRaises(module.BackupError):
            self.host.cleanup_restore()
        self.host.c["restore"] = RESTORE
        self.host.mounts = ["/srv/relay/data"]
        with self.assertRaises(module.BackupError):
            self.host.cleanup_restore()
        self.assertFalse(self.host.events)
        self.host.mounts = [str(self.host.mount)]
        self.assertEqual(self.host.cleanup_restore()["restoreUnmounted"], RESTORE)
        self.assertEqual(self.host.events, [["umount", str(self.host.mount)]])

    def test_controller_ownership_and_layout_are_mandatory(self):
        for property in ["Labels", "Image", "Env"]:
            original = copy.deepcopy(self.host.value)
            self.host.value["Config"][property] = {} if property == "Labels" else "foreign" if property == "Image" else []
            with self.assertRaises(module.BackupError):
                self.host.controller()
            self.host.value = original

    def test_mismatched_restore_fingerprint_still_unmounts_without_touching_original(self):
        self.host.hold()
        self.host.events = []
        self.host.fingerprint = lambda *args: {**FP, "records": 99}
        with self.assertRaisesRegex(module.BackupError, "fingerprint differs"):
            self.host.restore()
        self.assertTrue(self.host.value["State"]["Running"])
        self.assertIn(["umount", str(self.host.mount)], self.host.events)
        self.assertFalse(self.host.mounts)
        self.assertFalse(any(event[:2] in [["docker", "stop"], ["docker", "start"]] for event in self.host.events))


if __name__ == "__main__":
    unittest.main()
