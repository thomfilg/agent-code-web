"""Static SSM helper. Never emit subprocess stderr, environments or secrets."""
import base64
import fcntl
import http.client
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import traceback

SAFE_STAGES = frozenset(('inspect', 'controller', 'device', 'validate_source',
    'audit_other_writers', 'http', 'state', 'save', 'fingerprint', 'recover',
    'arm_recovery', 'disarm_recovery', 'watchdog', 'hold', 'cleanup_restore', 'restore', 'run'))


def failure_receipt(error):
    # Emit only fixed code-stage/type enums. Never echo exception messages,
    # subprocess diagnostics, record data or credential-bearing environments.
    stages = [frame.f_code.co_name for frame, _ in traceback.walk_tb(error.__traceback__)
              if frame.f_code.co_name in SAFE_STAGES]
    kind = type(error).__name__
    if kind not in ('BackupError', 'FileNotFoundError', 'PermissionError', 'ValueError', 'KeyError', 'OSError', 'JSONDecodeError'):
        kind = 'unknown'
    return {'ok': False, 'stage': stages[-1] if stages else 'unknown', 'failure': kind,
            'error': 'Backup host operation failed; private diagnostics suppressed. Inspect the exact run and original controller.'}


class BackupError(Exception):
    pass


class Host:
    def __init__(self, config):
        self.c = config
        if not re.fullmatch(r"[a-f0-9-]{36}", config["run"]):
            raise BackupError("Invalid run ID")
        self.directory = pathlib.Path("/run/relay-backup-" + config["run"])
        self.mount = self.directory / "restore"
        self.reader = "relay-backup-" + config["run"]
        self.guard_unit = "relay-backup-recovery-" + config["run"]

    def cmd(self, args, timeout=30):
        try:
            value = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
            if value.returncode:
                raise BackupError("Host command failed; private diagnostics suppressed")
            return value.stdout
        except (OSError, subprocess.TimeoutExpired):
            raise BackupError("Host command failed or timed out; inspect this run before retrying")

    def inspect(self, name):
        names = self.cmd(["docker", "container", "ls", "--all", "--format", "{{.Names}}"]).splitlines()
        if name not in names:
            return None
        values = json.loads(self.cmd(["docker", "inspect", "--type", "container", name]))
        if len(values) != 1 or values[0].get("Name") != "/" + name:
            raise BackupError("Invalid container inventory")
        return values[0]

    def controller(self, expected=None):
        value = self.inspect("relay")
        labels = (value or {}).get("Config", {}).get("Labels", {}) or {}
        mounts = (value or {}).get("Mounts", [])
        if not value or labels.get("ci.12-apps.managed") != "true" or labels.get("ci.12-apps.stack") != self.c["stack"]:
            raise BackupError("Controller ownership mismatch")
        if expected and (value["Id"] != expected["container"] or value["Image"] != expected["image"]):
            raise BackupError("Original controller identity changed; manual recovery required")
        if not re.fullmatch(re.escape(self.c["repository"]) + r"@sha256:[a-f0-9]{64}", value["Config"].get("Image", "")):
            raise BackupError("Controller must use its exact immutable application image")
        if not any(m.get("Type") == "bind" and m.get("Source") == "/srv/relay/data" and m.get("Destination") == "/var/lib/relay" for m in mounts):
            raise BackupError("Unexpected controller data mount")
        env = dict(item.split("=", 1) for item in value["Config"].get("Env", []) if "=" in item)
        if env.get("AGENT_DATABASE_MODE") != "embedded" or env.get("AGENT_CONTROL_DIR") != "/var/lib/relay/control":
            raise BackupError("Backup supports only the pinned embedded database layout")
        return value, env

    def device(self, volume, absent=False):
        tree = json.loads(self.cmd(["lsblk", "--json", "--paths", "--output", "NAME,SERIAL,TYPE,MOUNTPOINTS"]))
        matches = [d for d in tree["blockdevices"] if (d.get("serial") or "").replace("-", "").strip() == volume.replace("-", "")]
        if not matches and absent:
            return None
        if len(matches) != 1 or matches[0].get("type") != "disk" or matches[0].get("children"):
            raise BackupError("Expected one unpartitioned exact EBS device")
        return matches[0]

    def validate_source(self):
        device = self.device(self.c["source"])
        mount = json.loads(self.cmd(["findmnt", "--json", "--mountpoint", "/srv/relay/data", "--output", "SOURCE,TARGET,FSTYPE"]))["filesystems"][0]
        if mount != {"source": device["name"], "target": "/srv/relay/data", "fstype": "ext4"}:
            raise BackupError("Source mount does not match the stack-owned EBS volume")
        return device

    def audit_other_writers(self):
        for name in self.cmd(["docker", "container", "ls", "--all", "--format", "{{.Names}}"]).splitlines():
            if name == "relay":
                continue
            value = self.inspect(name)
            if value and value.get("State", {}).get("Running"):
                for mount in value.get("Mounts", []):
                    source = mount.get("Source", "")
                    if os.path.isabs(source) and os.path.commonpath([os.path.realpath(source), "/srv/relay/data"]) in [os.path.realpath(source), "/srv/relay/data"]:
                        raise BackupError("Another running container overlaps the controller data")

    def http(self, method, route):
        connection = http.client.HTTPConnection("127.0.0.1", 8787, timeout=5)
        try:
            connection.request(method, route, headers={"Content-Length": "0"})
            response = connection.getresponse()
            return response.status == 200 and json.loads(response.read(65537)).get("ok") is True
        except (OSError, ValueError, http.client.HTTPException):
            return False
        finally:
            connection.close()

    def state(self):
        info = self.directory.lstat()
        if self.directory.is_symlink() or info.st_uid != 0 or info.st_mode & 0o077:
            raise BackupError("Unsafe backup control directory")
        value = json.loads((self.directory / "state.json").read_text())
        if value.get("run") != self.c["run"] or value.get("source") != self.c["source"]:
            raise BackupError("Backup session ownership mismatch")
        return value

    def save(self, state):
        temporary = self.directory / "state.next"
        with open(temporary, "w") as stream:
            json.dump(state, stream)
        os.replace(temporary, self.directory / "state.json")

    def fingerprint(self, mount, original, env):
        if self.inspect(self.reader):
            raise BackupError("A prior verification reader needs inspection")
        runtime = json.loads(self.cmd(["findmnt", "--json", "--mountpoint", "/run", "--output", "FSTYPE"]))
        if runtime.get("filesystems") != [{"fstype": "tmpfs"}]:
            raise BackupError("Private reader credentials require /run on tmpfs")
        script = self.directory / "fingerprint.mjs"
        script.write_bytes(base64.b64decode(self.c["fingerprintScript"], validate=True))
        os.chmod(script, 0o644)  # Public source only; application secrets remain 0600.
        envfile = self.directory / "reader.env"
        key = env.get("AGENT_ENCRYPTION_KEY", "")
        if any(char in key for char in "\r\n\0"):
            raise BackupError("Invalid encryption-key environment")
        with open(envfile, "w") as stream:
            stream.write("AGENT_ENCRYPTION_KEY=" + key + "\n")
        try:
            # Override entrypoint and command: only embedded PG + SELECTs, no
            # Relay startup, workers, timers, OAuth, model clients or network.
            output = self.cmd(["docker", "run", "--rm", "--name", self.reader,
                "--label", "relay.backup.run=" + self.c["run"], "--network", "none", "--user", "1000:1000",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
                "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,mode=1777", "--env-file", str(envfile),
                "--mount", "type=bind,src=" + str(mount) + ",dst=/var/lib/relay",
                "--mount", "type=bind,src=" + str(script) + ",dst=/app/deploy/aws/backup-fingerprint.mjs,readonly",
                "--entrypoint", "node", original["image"], "/app/deploy/aws/backup-fingerprint.mjs"], timeout=120)
            result = json.loads(output)
            if result.get("version") != 1 or result.get("encryptionVerified") is not True or not all(re.fullmatch(r"[a-f0-9]{64}", result.get(k, "")) for k in ["recordsSha256", "attachmentsSha256"]):
                raise BackupError("Invalid fingerprint response")
            return result
        finally:
            envfile.unlink(missing_ok=True)
            reader = self.inspect(self.reader)
            if reader:
                if reader.get("Config", {}).get("Labels", {}).get("relay.backup.run") != self.c["run"]:
                    raise BackupError("Reader ownership changed; manual inspection required")
                self.cmd(["docker", "stop", "--time", "30", self.reader], timeout=45)
                if self.inspect(self.reader):
                    raise BackupError("Verification reader did not exit; do not detach its volume")

    def recover(self, original):
        if self.inspect(self.reader):
            raise BackupError("Verification reader remains; refusing concurrent database access")
        self.validate_source(); self.audit_other_writers()
        value, _ = self.controller(original)
        if not value["State"]["Running"]:
            self.cmd(["docker", "start", original["container"]], timeout=60)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            self.http("POST", "/internal/deploy/resume")
            if self.http("GET", "/readyz"):
                return
            time.sleep(2)
        raise BackupError("Original controller did not recover; manual recovery required")

    def arm_recovery(self):
        # A systemd-owned timer survives cancellation/termination of the SSM
        # process group. Its exact-ID recovery waits for the same rollout lock.
        config = {**self.c, "action": "watchdog"}
        payload = base64.b64encode(json.dumps(config).encode()).decode()
        script = "/run/relay-backup-code-" + self.c["run"] + ".py"
        self.cmd(["systemd-run", "--quiet", "--unit=" + self.guard_unit,
                  "--on-active=600s", "--timer-property=AccuracySec=1s",
                  "--property=Type=oneshot", "--property=RuntimeMaxSec=600", "--collect",
                  "/usr/bin/python3", script, payload])

    def disarm_recovery(self):
        self.cmd(["systemctl", "stop", self.guard_unit + ".timer"])

    def watchdog(self):
        original = self.state()
        if original["phase"] != "recovered":
            # A killed SSM process may leave its database reader behind.
            # Stop only this run's labelled reader before restarting Relay.
            reader = self.inspect(self.reader)
            if reader:
                if reader.get("Config", {}).get("Labels", {}).get("relay.backup.run") != self.c["run"]:
                    raise BackupError("Watchdog reader identity changed")
                self.cmd(["docker", "stop", "--time", "30", self.reader], timeout=45)
            if not self.inspect(self.reader):
                (self.directory / "reader.env").unlink(missing_ok=True)
            self.recover(original)
            original["phase"] = "recovered"; self.save(original)
        return {"ok": True, "run": self.c["run"], "originalRecovered": True}

    def hold(self):
        self.directory.mkdir(mode=0o700)  # Existing runs are never reused.
        self.validate_source()
        self.audit_other_writers()
        value, env = self.controller()
        if not value["State"]["Running"] or not self.http("GET", "/readyz"):
            raise BackupError("Controller must be healthy before backup")
        original = {"container": value["Id"], "image": value["Image"], "run": self.c["run"], "source": self.c["source"], "phase": "preparing"}
        self.save(original)
        self.arm_recovery()  # Never stop the original unless the guard exists.
        # The same host-wide lock as deployments is held across fingerprint,
        # the operator's snapshot request, and recovery, even if it disconnects.
        try:
            if not self.http("POST", "/internal/deploy/drain"):
                raise BackupError("Controller is busy; backup refused")
            self.cmd(["docker", "stop", "--time", "120", original["container"]], timeout=150)
            if self.controller(original)[0]["State"]["Running"]:
                raise BackupError("Original controller did not stop")
            original["fingerprint"] = self.fingerprint("/srv/relay/data", original, env)
            self.cmd(["sync", "-f", "/srv/relay/data"])
            original["phase"] = "snapshot-ready"; self.save(original)
            deadline = time.monotonic() + 180
            while not (self.directory / "release").exists():
                if time.monotonic() >= deadline:
                    raise BackupError("Snapshot lease expired; original controller is being recovered")
                time.sleep(1)
        finally:
            self.recover(original)
            original["phase"] = "recovered"; self.save(original)
            self.disarm_recovery()
        return original

    def cleanup_restore(self):
        state = self.state()
        volume = self.c.get("restore")
        if volume == self.c["source"] or not re.fullmatch(r"vol-[a-f0-9]{8,17}", volume or ""):
            raise BackupError("Invalid restore volume")
        if self.inspect(self.reader):
            reader = self.inspect(self.reader)
            if reader.get("Config", {}).get("Labels", {}).get("relay.backup.run") != self.c["run"]:
                raise BackupError("Reader ownership changed; refusing cleanup")
            self.cmd(["docker", "stop", "--time", "30", self.reader], timeout=45)
            if self.inspect(self.reader):
                raise BackupError("Reader is still present; refusing unmount")
        (self.directory / "reader.env").unlink(missing_ok=True)
        device = self.device(volume, absent=True)
        if device:
            mounts = [m for m in device.get("mountpoints", []) if m]
            if mounts and mounts != [str(self.mount)]:
                raise BackupError("Restore volume has an unexpected mount")
            if mounts:
                self.cmd(["umount", str(self.mount)])
            device = self.device(volume)
            if any(device.get("mountpoints", [])):
                raise BackupError("Restore volume remains mounted")
        state["restoreUnmounted"] = volume; self.save(state)
        return {"ok": True, "restoreUnmounted": volume, "run": self.c["run"]}

    def restore(self):
        original = self.state()
        if original["phase"] != "recovered":
            raise BackupError("Original controller has not recovered")
        self.validate_source(); value, env = self.controller(original)
        if not value["State"]["Running"]:
            raise BackupError("Original controller is not running")
        volume = self.c["restore"]
        if volume == self.c["source"]:
            raise BackupError("Cannot restore on the original volume")
        device = self.device(volume)
        if any(device.get("mountpoints", [])) or self.cmd(["blkid", "-s", "TYPE", "-o", "value", device["name"]]).strip() != "ext4":
            raise BackupError("Restore device must be an unmounted ext4 snapshot copy")
        self.mount.mkdir(mode=0o700)
        try:
            # Explicit device avoids collision with the source filesystem UUID.
            # Never format, fsck, edit fstab, or mount by UUID.
            self.cmd(["mount", "-t", "ext4", "-o", "nosuid,nodev", device["name"], str(self.mount)])
            actual = self.fingerprint(self.mount, original, env)
            if actual != original["fingerprint"]:
                raise BackupError("Restored record/attachment fingerprint differs")
            if not self.controller(original)[0]["State"]["Running"] or not self.http("GET", "/readyz"):
                raise BackupError("Original controller is not healthy after restore verification")
            return {"ok": True, "run": self.c["run"], "fingerprint": actual, "originalRecovered": True}
        finally:
            self.cleanup_restore()

    def run(self):
        action = self.c["action"]
        if action == "probe":
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                if (self.directory / "state.json").exists():
                    state = self.state()
                    if state["phase"] in ["snapshot-ready", "recovered"]:
                        return state
                time.sleep(1)
            raise BackupError("Backup preparation did not become ready")
        if action == "release":
            deadline = time.monotonic() + 180
            while not (self.directory / "state.json").exists() and time.monotonic() < deadline:
                time.sleep(1)
            self.state(); (self.directory / "release").touch(mode=0o600)
            return {"ok": True}
        with open("/run/12-apps-controller-rollout.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX if action == "watchdog" else fcntl.LOCK_EX | fcntl.LOCK_NB)
            if action == "watchdog":
                return self.watchdog()
            if action == "hold":
                return self.hold()
            if action == "restore":
                return self.restore()
            if action == "cleanup":
                return self.cleanup_restore()
            raise BackupError("Unknown host operation")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        print(json.dumps(Host(json.loads(base64.b64decode(sys.argv[1], validate=True))).run()))
    except Exception as error:
        print(json.dumps(failure_receipt(error)))
        sys.exit(1)
