#!/usr/bin/env python3
"""Root host launcher for one reviewed preview-provider acceptance container.
No product data, secret env, listener, unrelated container or AWS credential file.
"""
import base64
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys

IMAGE = "456808212788.dkr.ecr.us-east-2.amazonaws.com/agent-relay-mvp-applicationrepository-sujdgarjwejp@sha256:9dbb6306863a60de96cf91118165b6164d053de72dbe04777fc5dfd296db6d9a"
HELPER_SHA256 = "25f402ecdc8684c20d347d693c923c845165e978d8c59584cfd6163534559040"
PARENT = pathlib.Path("/srv/relay-preview-acceptance")
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"


def require(value):
    if not value:
        raise RuntimeError("Scoped acceptance launcher check failed")


def validate(payload):
    require(isinstance(payload, dict) and set(payload) == {"input", "helperSource", "stackArn"})
    value = payload["input"]
    require(isinstance(value, dict) and set(value) == {"schema", "runId", "expectedRoleArn", "vpcOriginId", "controllerOriginDns"})
    require(value["schema"] == 1 and re.fullmatch(UUID, value.get("runId", "")))
    require(re.fullmatch(r"arn:aws:iam::456808212788:role/agent-relay-mvp-ControllerRole-[A-Za-z0-9]+", value.get("expectedRoleArn", "")))
    require(re.fullmatch(r"vo_[A-Za-z0-9]+", value.get("vpcOriginId", "")))
    require(re.fullmatch(r"ip-[0-9-]+(?:\.[a-z0-9-]+)?\.(?:compute\.internal|ec2\.internal)", value.get("controllerOriginDns", "")))
    require(re.fullmatch(r"arn:aws:cloudformation:us-east-2:456808212788:stack/agent-relay-mvp/[a-f0-9-]{36}", payload["stackArn"]))
    source = base64.b64decode(payload["helperSource"], validate=True)
    require(len(source) < 65536 and hashlib.sha256(source).hexdigest() == HELPER_SHA256)
    return value, source


def baseline(containers, payload):
    value, _ = validate(payload)
    require(len(containers) == 2)
    fields = {"AGENT_PREVIEW_ENABLED": "1", "AGENT_PREVIEW_ACCOUNT_ID": "456808212788", "AGENT_PREVIEW_CONTROLLER_INSTANCE_ID": "i-08c991c22089589a5", "AGENT_PREVIEW_RELAY_DISTRIBUTION_ID": "E2FQ8W4AL72G7G", "AGENT_PREVIEW_VPC_ORIGIN_ID": value["vpcOriginId"], "AGENT_PREVIEW_CONTROLLER_ORIGIN_DNS": value["controllerOriginDns"]}
    for container, name, running in zip(containers, ["/relay", "/relay-previous"], [True, False]):
        config = container.get("Config", {})
        labels = config.get("Labels") or {}
        require(container.get("Name") == name and config.get("Image") == IMAGE and container.get("State", {}).get("Running") is running)
        require(labels.get("ci.12-apps.managed") == "true" and labels.get("ci.12-apps.stack") == payload["stackArn"])
        for key, expected in fields.items():
            require([item for item in config.get("Env", []) if item.startswith(key + "=")] == [key + "=" + expected])


def arguments(value, directory, helper):
    return ["docker", "create", "--interactive", "--name", "relay-preview-acceptance-" + value["runId"],
            "--label", "agent-relay.acceptance=preview-host-v1", "--label", "agent-relay.acceptance-run=" + value["runId"],
            "--network", "host", "--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--cpus", "1", "--memory", "512m", "--pids-limit", "128",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", "--env", "HOME=/tmp/preview-home", "--env", "AWS_REGION=us-east-2",
            "--mount", "type=bind,src=" + str(directory) + ",dst=/acceptance",
            "--mount", "type=bind,src=" + str(helper) + ",dst=/app/scripts/smoke-preview-hosts.mjs,readonly",
            "--entrypoint", "node", IMAGE, "/app/scripts/smoke-preview-hosts.mjs", "--run"]


def isolated(container, value, directory, helper):
    require(re.fullmatch(r"[a-f0-9]{64}", container.get("Id", "")))
    require(container.get("Name") == "/relay-preview-acceptance-" + value["runId"])
    config, host = container.get("Config", {}), container.get("HostConfig", {})
    require(config.get("Image") == IMAGE and config.get("User") == "1000:1000" and config.get("Entrypoint") == ["node"] and config.get("Cmd") == ["/app/scripts/smoke-preview-hosts.mjs", "--run"])
    require(config.get("Labels", {}).get("agent-relay.acceptance") == "preview-host-v1" and config.get("Labels", {}).get("agent-relay.acceptance-run") == value["runId"])
    require(host.get("NetworkMode") == "host" and host.get("ReadonlyRootfs") is True and host.get("Privileged") is False and host.get("PidMode", "") == "")
    require(host.get("CapDrop") == ["ALL"] and host.get("SecurityOpt") in [["no-new-privileges"], ["no-new-privileges:true"], ["no-new-privileges=true"]] and not host.get("PortBindings"))
    require(host.get("NanoCpus") == 1000000000 and host.get("Memory") == 536870912 and host.get("PidsLimit") == 128)
    require(host.get("Tmpfs") == {"/tmp": "rw,nosuid,nodev,size=64m,mode=1777"})
    env = config.get("Env", [])
    require("HOME=/tmp/preview-home" in env and "AWS_REGION=us-east-2" in env)
    forbidden = re.compile(r"^(?:AWS_(?!REGION=|DEFAULT_REGION=)|GOOGLE_CLIENT_SECRET=|AUTH_SECRET=|AGENT_ENCRYPTION_KEY=|DOPPLER_TOKEN=|GH_TOKEN=|GITHUB_TOKEN=|OPENAI_API_KEY=|ANTHROPIC_API_KEY=|AGENT_WORKER_SSH_KEY_BASE64=)")
    require(not any(forbidden.match(item) for item in env))
    mounts = container.get("Mounts", [])
    tmpfs = [mount for mount in mounts if mount.get("Type") == "tmpfs"]
    require(len(tmpfs) <= 1 and all(mount.get("Destination") == "/tmp" and mount.get("RW") is True and mount.get("Source", "") == "" for mount in tmpfs))
    mounts = [mount for mount in mounts if mount.get("Type") != "tmpfs"]
    require(len(mounts) == 2)
    expected = {(str(directory), "/acceptance", True), (str(helper), "/app/scripts/smoke-preview-hosts.mjs", False)}
    require({(mount.get("Source"), mount.get("Destination"), mount.get("RW")) for mount in mounts} == expected and all(mount.get("Type") == "bind" for mount in mounts))


class Launcher:
    def command(self, argv, data=None, timeout=30, allow_failure=False):
        result = subprocess.run(argv, input=data, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
        require(allow_failure or result.returncode == 0)
        return result

    def inspect(self, identifier):
        values = json.loads(self.command(["docker", "inspect", identifier]).stdout)
        require(isinstance(values, list) and len(values) == 1)
        return values[0]

    def prepare(self, value, source):
        # Private parent is never recursively replaced/deleted. A fresh UUID may
        # only create its own absent directory; all journals remain for recovery.
        if not PARENT.exists():
            PARENT.mkdir(mode=0o700)
        info = PARENT.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077 and PARENT.resolve() == PARENT)
        directory = PARENT / value["runId"]
        directory.mkdir(mode=0o700)
        os.chown(directory, 1000, 1000)
        helper = directory / "operator.mjs"
        descriptor = os.open(helper, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(descriptor, "wb") as output:
            output.write(source)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(helper, 0o644)
        for durable in [directory, PARENT]:
            descriptor = os.open(durable, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        return directory, helper

    def run(self, payload):
        value, source = validate(payload)
        baseline(json.loads(self.command(["docker", "inspect", "relay", "relay-previous"]).stdout), payload)
        images = json.loads(self.command(["docker", "image", "inspect", IMAGE]).stdout)
        require(len(images) == 1 and IMAGE in images[0].get("RepoDigests", []))
        directory, helper = self.prepare(value, source)
        identifier, receipt, stopped = None, None, False
        try:
            identifier = self.command(arguments(value, directory, helper)).stdout.strip()
            require(re.fullmatch(r"[a-f0-9]{64}", identifier))
            created = self.inspect(identifier)
            isolated(created, value, directory, helper)
            require(created.get("Image") == images[0].get("Id") and not created.get("State", {}).get("Running"))
            result = self.command(["docker", "start", "--attach", "--interactive", identifier], json.dumps(value), timeout=1660, allow_failure=True)
            require(len(result.stdout) < 16384)
            receipt = json.loads(result.stdout)
            allowed = {"schema", "ok", "category", "roleVerified", "ready", "restartRevalidated", "immediatelyRevoked", "deleted", "recordId", "distributionId", "hostname", "successfulOperations", "journalRetained", "productUserConsent", "productDataUsed", "applicationTrafficTested", "journalClosed"}
            require(isinstance(receipt, dict) and set(receipt) == allowed and receipt.get("schema") == 1)
            require(all(type(receipt.get(key)) is bool for key in ["ok", "roleVerified", "ready", "restartRevalidated", "immediatelyRevoked", "deleted", "journalRetained", "productUserConsent", "productDataUsed", "applicationTrafficTested", "journalClosed"]))
            require(receipt["category"] in [None, "existing-journal-cleanup-only", "missing-journal", "provider-ownership-rejected", "cancelled", "create-not-ready", "restart-not-revalidated", "acceptance-failed", "close-unconfirmed", "cleanup-unconfirmed", "journal-close-unconfirmed"])
            require(receipt["recordId"] is None or re.fullmatch("pp_" + UUID, receipt["recordId"]))
            require(receipt["distributionId"] is None or re.fullmatch(r"[A-Z0-9]{6,32}", receipt["distributionId"]) and receipt["distributionId"] != "E2FQ8W4AL72G7G")
            require(receipt["hostname"] is None or re.fullmatch(r"d[a-z0-9]{3,60}\.cloudfront\.net", receipt["hostname"]))
            require(set(receipt["successfulOperations"]) == {"create", "update", "delete"} and all(type(n) is int and 0 <= n <= 1000 for n in receipt["successfulOperations"].values()))
            require(receipt["productUserConsent"] is False and receipt["productDataUsed"] is False and receipt["applicationTrafficTested"] is False and receipt["journalRetained"] is True)
            require(not receipt["ok"] or result.returncode == 0 and all(receipt[key] for key in ["roleVerified", "ready", "restartRevalidated", "immediatelyRevoked", "deleted", "journalClosed"]))
        finally:
            if identifier and re.fullmatch(r"[a-f0-9]{64}", identifier):
                current = self.inspect(identifier)
                isolated(current, value, directory, helper)
                if current.get("State", {}).get("Running"):
                    self.command(["docker", "stop", "--time", "30", identifier], timeout=45)
                    current = self.inspect(identifier)
                    isolated(current, value, directory, helper)
                stopped = current.get("State", {}).get("Running") is False
                require(stopped)
                self.command(["docker", "rm", identifier])
                inventory = self.command(["docker", "container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"])
                require(identifier not in inventory.stdout.splitlines())
        return {"operatorContainerObservedStopped": stopped, "operatorContainerRemoved": True, "imagePinnedAndIsolated": True, "receipt": receipt}


def main():
    if len(sys.argv) == 1:
        print(json.dumps({"dryRun": True, "awsCalls": False, "dockerCalls": False, "requires": "explicit --run, root on exact controller, reviewed public payload stdin"}))
        return 0
    try:
        require(sys.argv[1:] == ["--run"] and os.geteuid() == 0)
        os.umask(0o077)
        payload = json.loads(sys.stdin.buffer.read(131073))
        require(len(json.dumps(payload)) <= 131072)
        # Hold the same host-wide lock as the deployment engine so a legacy
        # rollback cannot race the lifetime of this temporary public hostname.
        descriptor = os.open("/run/12-apps-controller-rollout.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "r+") as lock:
            lock_info = os.fstat(lock.fileno())
            require(lock_info.st_uid == 0 and stat.S_ISREG(lock_info.st_mode) and lock_info.st_nlink == 1)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = Launcher().run(payload)
        print(json.dumps(result))
        return 0 if result["receipt"]["ok"] else 1
    except Exception:
        print(json.dumps({"ok": False, "category": "operator-launch-or-cleanup-unconfirmed", "journalRetained": True, "cloudCleanupConfirmed": False}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
