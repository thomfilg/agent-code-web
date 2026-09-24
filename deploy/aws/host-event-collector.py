#!/usr/bin/env python3
"""Host-owned Docker witness. No Docker socket is mounted into Relay.

The collector records a small allowlisted event in an fsynced outbox before
advancing its replay cursor. Relay may be down throughout this operation.
"""

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import uuid


CONTAINER = re.compile(r"^[a-f0-9]{64}$")
ROLLBACK = re.compile(r"^relay-rollback-[a-f0-9]{7,40}-[0-9]{8,16}$")
ACTIONS = {"create", "start", "stop", "die", "oom", "destroy", "restart", "kill", "health_status"}
STATUSES = {"created", "running", "paused", "restarting", "exited", "dead"}


def atomic_json(directory, name, value, owner=None):
    target = directory / name
    temporary = directory / ("." + name + "." + uuid.uuid4().hex + ".tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, separators=(",", ":"), sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        if owner is not None and os.geteuid() == 0:
            os.chown(temporary, owner, owner)
        os.replace(temporary, target)
        directory_descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        temporary.unlink(missing_ok=True)


class HostEventCollector:
    def __init__(self, outbox):
        self.outbox = pathlib.Path(outbox)
        self.outbox.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.outbox.is_symlink() or not self.outbox.is_dir():
            raise RuntimeError("Host event outbox must be a real directory")
        # Relay and the restricted host service both run as UID 1000. Neither
        # needs a root writer in this shared directory.
        if os.geteuid() == 0:
            os.chown(self.outbox, 1000, 1000)
        self.outbox.chmod(0o700)

    def cursor(self):
        try:
            value = json.loads((self.outbox / ".cursor.json").read_text(encoding="utf-8"))
            return value["timeNano"] if type(value.get("timeNano")) is int and value["timeNano"] > 0 else None
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def accept(self, raw):
        if len(raw) > 65536:
            raise ValueError("Docker event exceeds size limit")
        event = json.loads(raw)
        if not isinstance(event, dict):
            raise ValueError("Docker event must be an object")
        nanos = event.get("timeNano")
        if type(nanos) is not int or nanos < 1_000_000_000_000_000_000 or nanos > time.time_ns() + 300_000_000_000:
            raise ValueError("Docker event has no valid nanosecond timestamp")
        previous = self.cursor()
        if previous is not None and nanos < previous:
            return None
        actor = event.get("Actor") or {}
        attributes = (actor.get("Attributes") or {}) if isinstance(actor, dict) else {}
        container_id = actor.get("ID") if isinstance(actor, dict) else None
        name = attributes.get("name") if isinstance(attributes, dict) else None
        action = event.get("Action")
        if isinstance(action, str) and action.startswith("health_status: "):
            health = action.removeprefix("health_status: ")
            action = "health_status"
        else:
            health = None
        recorded = None
        if (event.get("Type") == "container" and isinstance(container_id, str) and CONTAINER.fullmatch(container_id)
                and isinstance(name, str) and (name == "relay" or ROLLBACK.fullmatch(name)) and action in ACTIONS
                and (health is None or health in ("healthy", "unhealthy", "starting"))):
            source = hashlib.sha256(f"{container_id}:{nanos}:{event['Action']}".encode()).hexdigest()
            recorded = {"schema": 1, "source": "docker-host", "sourceId": "docker:" + source,
                        "containerId": container_id, "containerName": name, "action": action,
                        "observedAt": datetime.datetime.fromtimestamp(nanos / 1_000_000_000,
                                                                 tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")}
            if health is not None:
                recorded["health"] = health
            exit_code = attributes.get("exitCode") if isinstance(attributes, dict) else None
            if action == "die" and isinstance(exit_code, str) and re.fullmatch(r"[0-9]{1,3}", exit_code):
                recorded["exitCode"] = int(exit_code)
            filename = source + ".json"
            if not (self.outbox / filename).exists():
                atomic_json(self.outbox, filename, recorded, owner=1000)
        if previous is None or nanos > previous:
            atomic_json(self.outbox, ".cursor.json", {"timeNano": nanos})
        return recorded

    def accept_snapshot(self, raw):
        snapshot = json.loads(raw)
        if not isinstance(snapshot, dict) or not CONTAINER.fullmatch(snapshot.get("Id") or ""):
            raise ValueError("Invalid Docker snapshot identity")
        state = snapshot.get("State") or {}
        if (not isinstance(state, dict) or state.get("Status") not in STATUSES
                or type(state.get("OOMKilled")) is not bool
                or type(state.get("ExitCode")) is not int or not 0 <= state["ExitCode"] <= 255):
            raise ValueError("Invalid Docker snapshot state")
        started, finished = state.get("StartedAt"), state.get("FinishedAt")
        if any(not isinstance(value, str) or len(value) > 64 for value in (started, finished)):
            raise ValueError("Invalid Docker snapshot times")
        digest = hashlib.sha256(f"snapshot:{snapshot['Id']}:{state['Status']}:{state['OOMKilled']}:{state['ExitCode']}:{started}:{finished}".encode()).hexdigest()
        event = {"schema": 1, "source": "docker-host", "sourceId": "docker:" + digest,
                 "containerId": snapshot["Id"], "containerName": "relay", "action": "snapshot",
                 "status": state["Status"], "oomKilled": state["OOMKilled"], "exitCode": state["ExitCode"],
                 "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")}
        filename = digest + ".json"
        if not (self.outbox / filename).exists():
            atomic_json(self.outbox, filename, event, owner=1000)
        return event

    def reconcile(self):
        try:
            raw = subprocess.check_output(["/usr/bin/docker", "inspect", "relay", "--format",
                                           "{\"Id\":\"{{.Id}}\",\"State\":{{json .State}}}"],
                                          stderr=subprocess.DEVNULL, text=True, timeout=10)
            self.accept_snapshot(raw)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError):
            # During rollout there can briefly be no container named relay.
            # The event stream catches the subsequent start; the next collector
            # reconnect performs another snapshot.
            return

    def run(self):
        while True:
            self.reconcile()
            since = self.cursor()
            if since is None:
                since = max(0, time.time_ns() - 600 * 1_000_000_000)
            command = ["/usr/bin/docker", "events", "--format", "{{json .}}", "--since", f"{since // 1_000_000_000}.{since % 1_000_000_000:09d}",
                       "--filter", "type=container"]
            try:
                with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                      bufsize=1) as process:
                    for line in process.stdout:
                        try:
                            self.accept(line)
                        except (ValueError, KeyError, TypeError) as error:
                            print(f"Ignoring malformed Docker event: {type(error).__name__}", file=sys.stderr)
                    process.wait()
            except OSError as error:
                print(f"Docker event stream unavailable: {type(error).__name__}", file=sys.stderr)
            time.sleep(2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--outbox", default="/srv/relay/data/host-events")
    parser.add_argument("--stdin", action="store_true", help="Bounded fixture mode; read events until EOF")
    parser.add_argument("--snapshot-stdin", action="store_true", help="Bounded fixture mode; read one inspect snapshot")
    arguments = parser.parse_args()
    collector = HostEventCollector(arguments.outbox)
    if arguments.snapshot_stdin:
        collector.accept_snapshot(sys.stdin.read())
    elif arguments.stdin:
        for line in sys.stdin:
            collector.accept(line)
    else:
        collector.run()
