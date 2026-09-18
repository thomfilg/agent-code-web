import base64
import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest
from types import SimpleNamespace

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("preview_launch", ROOT / "deploy/aws/preview-host-launch.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def payload():
    return {"input": {"schema": 1, "runId": "11111111-2222-4333-8444-555555555555", "expectedRoleArn": "arn:aws:iam::456808212788:role/agent-relay-mvp-ControllerRole-Fixture", "vpcOriginId": "vo_fixture", "controllerOriginDns": "ip-10-84-1-2.us-east-2.compute.internal"}, "stackArn": "arn:aws:cloudformation:us-east-2:456808212788:stack/agent-relay-mvp/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "helperSource": base64.b64encode((ROOT / "scripts/smoke-preview-hosts.mjs").read_bytes()).decode()}


def baseline(value):
    settings = {"AGENT_PREVIEW_ENABLED": "1", "AGENT_PREVIEW_ACCOUNT_ID": "456808212788", "AGENT_PREVIEW_CONTROLLER_INSTANCE_ID": "i-08c991c22089589a5", "AGENT_PREVIEW_RELAY_DISTRIBUTION_ID": "E2FQ8W4AL72G7G", "AGENT_PREVIEW_VPC_ORIGIN_ID": value["input"]["vpcOriginId"], "AGENT_PREVIEW_CONTROLLER_ORIGIN_DNS": value["input"]["controllerOriginDns"]}
    return [{"Name": name, "Config": {"Image": module.IMAGE, "Labels": {"ci.12-apps.managed": "true", "ci.12-apps.stack": value["stackArn"]}, "Env": [key + "=" + item for key, item in settings.items()] + ["PRIVATE=DO-NOT-PRINT"]}, "State": {"Running": running}} for name, running in [("/relay", True), ("/relay-previous", False)]]


def isolated(value):
    directory = module.PARENT / value["input"]["runId"]
    helper = directory / "operator.mjs"
    return {"Id": "a" * 64, "Name": "/relay-preview-acceptance-" + value["input"]["runId"], "Config": {"Image": module.IMAGE, "User": "1000:1000", "Entrypoint": ["node"], "Cmd": ["/app/scripts/smoke-preview-hosts.mjs", "--run"], "Labels": {"agent-relay.acceptance": "preview-host-v1", "agent-relay.acceptance-run": value["input"]["runId"]}, "Env": ["HOME=/tmp/preview-home", "AWS_REGION=us-east-2", "NODE_ENV=production"]}, "HostConfig": {"NetworkMode": "host", "ReadonlyRootfs": True, "Privileged": False, "PidMode": "", "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges"], "PortBindings": {}, "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=64m,mode=1777"}}, "Mounts": [{"Type": "bind", "Source": str(directory), "Destination": "/acceptance", "RW": True}, {"Type": "bind", "Source": str(helper), "Destination": "/app/scripts/smoke-preview-hosts.mjs", "RW": False}]}, directory, helper


class FakeLauncher(module.Launcher):
    def __init__(self, fault=None):
        self.payload = payload()
        self.container, self.directory, self.helper = isolated(self.payload)
        self.container["HostConfig"].update(NanoCpus=1000000000, Memory=536870912, PidsLimit=128)
        self.container.update(Image="sha256:fixture", State={"Running": False})
        self.fault, self.calls = fault, []

    def prepare(self, value, source):
        return self.directory, self.helper

    def command(self, argv, data=None, timeout=30, allow_failure=False):
        self.calls.append(argv)
        result = SimpleNamespace(returncode=0, stdout="", stderr="")
        if argv == ["docker", "inspect", "relay", "relay-previous"]:
            result.stdout = json.dumps(baseline(self.payload))
        elif argv[:3] == ["docker", "image", "inspect"]:
            result.stdout = json.dumps([{"Id": "sha256:fixture", "RepoDigests": [module.IMAGE]}])
        elif argv[:2] == ["docker", "create"]:
            result.stdout = self.container["Id"]
        elif argv[:2] == ["docker", "inspect"]:
            result.stdout = json.dumps([self.container])
        elif argv[:2] == ["docker", "start"]:
            assert timeout == 1660 and json.loads(data) == self.payload["input"]
            if self.fault in ["timeout", "stop-unconfirmed"]:
                self.container["State"]["Running"] = True
                raise subprocess.TimeoutExpired("docker", timeout)
            receipt = {"schema": 1, "ok": True, "category": None, "roleVerified": True, "ready": True, "restartRevalidated": True, "immediatelyRevoked": True, "deleted": True, "recordId": "pp_" + self.payload["input"]["runId"], "distributionId": "EFIXTURE123", "hostname": "dfixture.cloudfront.net", "successfulOperations": {"create": 1, "update": 1, "delete": 1}, "journalRetained": True, "productUserConsent": False, "productDataUsed": False, "applicationTrafficTested": False, "journalClosed": True}
            if self.fault == "private-receipt":
                receipt["category"] = "PRIVATE-RAW-OUTPUT"
            result.stdout = json.dumps(receipt)
        elif argv[:2] == ["docker", "stop"]:
            if self.fault != "stop-unconfirmed":
                self.container["State"]["Running"] = False
        elif argv[:2] == ["docker", "rm"]:
            assert self.container["State"]["Running"] is False
        elif argv[:3] == ["docker", "container", "ls"]:
            if self.fault == "removal-unconfirmed":
                result.stdout = self.container["Id"]
        else:
            raise AssertionError("Unexpected command")
        return result


class TestLauncher(unittest.TestCase):
    def test_lifecycle_checks_exact_stopped_removal_and_retains_only_public_receipt(self):
        fake = FakeLauncher()
        result = fake.run(fake.payload)
        self.assertEqual(result["receipt"]["ok"], True)
        self.assertEqual(result["operatorContainerObservedStopped"], True)
        self.assertEqual(result["operatorContainerRemoved"], True)
        self.assertEqual(fake.calls[-1][:3], ["docker", "container", "ls"])
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_timeout_and_unknown_cleanup_never_become_success_or_remove_running_container(self):
        for fault in ["timeout", "stop-unconfirmed", "removal-unconfirmed", "private-receipt"]:
            fake = FakeLauncher(fault)
            with self.assertRaises(Exception):
                fake.run(fake.payload)
            if fault == "stop-unconfirmed":
                self.assertFalse(any(call[:2] == ["docker", "rm"] for call in fake.calls))
            if fault == "timeout":
                self.assertEqual(sum(call[:2] == ["docker", "stop"] for call in fake.calls), 1)
                self.assertEqual(sum(call[:2] == ["docker", "rm"] for call in fake.calls), 1)

    def test_default_plan_never_runs_docker_or_aws(self):
        result = subprocess.run([sys.executable, str(ROOT / "deploy/aws/preview-host-launch.py")], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["dockerCalls"], False)

    def test_exact_helper_hash_and_public_target_only(self):
        value = payload()
        self.assertEqual(module.validate(value)[0], value["input"])
        for change in [lambda p: p.update(helperSource=base64.b64encode(b"arbitrary source").decode()), lambda p: p.update(extra="private"), lambda p: p["input"].update(runId="../unsafe"), lambda p: p["input"].update(expectedRoleArn=p["input"]["expectedRoleArn"] + "\n"), lambda p: p.update(stackArn=p["stackArn"].replace("456808212788", "111122223333"))]:
            bad = copy.deepcopy(value)
            change(bad)
            with self.assertRaises(Exception):
                module.validate(bad)

    def test_current_and_previous_preview_aware_exact_images_are_required(self):
        value = payload()
        containers = baseline(value)
        module.baseline(containers, value)
        for index in [0, 1]:
            for change in [lambda c: c["Config"].update(Image="legacy"), lambda c: c["Config"]["Labels"].update({"ci.12-apps.stack": "foreign"}), lambda c: c["Config"].update(Env=[e for e in c["Config"]["Env"] if not e.startswith("AGENT_PREVIEW_ENABLED=")])]:
                bad = copy.deepcopy(containers)
                change(bad[index])
                with self.assertRaises(Exception):
                    module.baseline(bad, value)

    def test_create_plan_has_only_exact_mounts_and_no_app_env_or_container_entry(self):
        value = payload()
        container, directory, helper = isolated(value)
        container["HostConfig"].update(NanoCpus=1000000000, Memory=536870912, PidsLimit=128)
        argv = module.arguments(value["input"], directory, helper)
        self.assertNotIn("--env-file", argv)
        self.assertNotIn("/srv/relay/data", " ".join(argv))
        self.assertEqual(argv.count("--mount"), 2)
        self.assertEqual(argv[-3:], [module.IMAGE, "/app/scripts/smoke-preview-hosts.mjs", "--run"])
        module.isolated(container, value["input"], directory, helper)
        container["Mounts"].append({"Type": "tmpfs", "Destination": "/tmp", "Source": "", "RW": True})
        module.isolated(container, value["input"], directory, helper)

    def test_inspection_rejects_secret_env_privilege_or_mount_widening(self):
        value = payload()
        original, directory, helper = isolated(value)
        original["HostConfig"].update(NanoCpus=1000000000, Memory=536870912, PidsLimit=128)
        for change in [lambda c: c["Config"]["Env"].append("GOOGLE_CLIENT_SECRET=PRIVATE"), lambda c: c["Config"]["Env"].append("AWS_PROFILE=operator"), lambda c: c["HostConfig"].update(Privileged=True), lambda c: c["HostConfig"].update(ReadonlyRootfs=False), lambda c: c["Mounts"].append({"Source": "/srv/relay/data", "Destination": "/data", "RW": True, "Type": "bind"}), lambda c: c["Config"].update(User="0")]:
            bad = copy.deepcopy(original)
            change(bad)
            with self.assertRaises(Exception):
                module.isolated(bad, value["input"], directory, helper)

    def test_controller_load_limits_and_tmpfs_are_not_widened(self):
        value = payload()
        original, directory, helper = isolated(value)
        original["HostConfig"].update(NanoCpus=1000000000, Memory=536870912, PidsLimit=128)
        for key, setting in [("NanoCpus", 0), ("Memory", 0), ("PidsLimit", -1)]:
            bad = copy.deepcopy(original)
            bad["HostConfig"][key] = setting
            with self.assertRaises(Exception):
                module.isolated(bad, value["input"], directory, helper)
        bad = copy.deepcopy(original)
        bad["Mounts"].append({"Type": "tmpfs", "Destination": "/other", "RW": True})
        with self.assertRaises(Exception):
            module.isolated(bad, value["input"], directory, helper)


if __name__ == "__main__":
    unittest.main()
