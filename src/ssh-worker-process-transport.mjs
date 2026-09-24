import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { createStreamWorkerProcessTransport } from "./worker-process-transport.mjs";
import { WORKER_SUPERVISOR_CODE } from "./worker-supervisor-paths.mjs";

export const SSH_WORKER_SUPERVISOR_BRIDGE = `export HOME=/home/agent XDG_RUNTIME_DIR=/run/user/$(id -u); exec /usr/bin/node ${WORKER_SUPERVISOR_CODE}/worker-supervisor-bridge.mjs`;

export function createSshWorkerProcessTransport({ sshBin = "ssh", sshArgs, expectedIdentity, lease, timeoutMs = 5000, spawnProcess = spawn }) {
  if (typeof sshBin !== "string" || !sshBin || !Array.isArray(sshArgs) || sshArgs.some(value => typeof value !== "string")
    || typeof spawnProcess !== "function") throw new Error("Invalid worker supervisor SSH transport");
  return createStreamWorkerProcessTransport({ expectedIdentity, lease, timeoutMs, connectStream: async () => {
    let child;
    try {
      child = spawnProcess(sshBin, [...sshArgs, SSH_WORKER_SUPERVISOR_BRIDGE], { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch { throw new Error("Worker supervisor SSH bridge failed"); }
    child.stdin.on("error", () => {}); child.stderr.resume();
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const fail = (kind, detail) => {
      if (stream.destroyed) return;
      const value = kind === "exit"
        ? `code=${Number.isInteger(detail?.code) ? detail.code : "none"} signal=${/^[A-Z0-9]+$/.test(detail?.signal || "") ? detail.signal : "none"}`
        : `code=${/^[A-Z0-9_]+$/.test(detail?.code || "") ? detail.code : "unknown"}`;
      // Never log SSH stderr: it may contain worker or authentication data.
      console.warn(`[worker-transport] SSH bridge ${kind}: ${value}`);
      stream.destroy(new Error("Worker supervisor SSH bridge closed"));
    };
    const onError = error => fail("error", error);
    const onExit = (code, signal) => fail("exit", { code, signal });
    child.once("error", onError); child.once("exit", onExit);
    stream.once("close", () => {
      child.off("error", onError); child.off("exit", onExit);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    return stream;
  } });
}
