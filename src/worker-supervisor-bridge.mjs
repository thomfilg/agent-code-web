import net from "node:net";
import { pathToFileURL } from "node:url";
import { WORKER_SUPERVISOR_SOCKET } from "./worker-supervisor-paths.mjs";

// Runs on the worker behind the pinned SSH forced-command boundary. It carries
// opaque framed bytes only; identity and lease admission remain enforced by the
// worker-owned supervisor on every request.
export function bridgeWorkerSupervisor({ socketPath = WORKER_SUPERVISOR_SOCKET, input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const fail = () => {
      if (settled) return; settled = true;
      input.unpipe(socket); socket.unpipe(output); socket.destroy();
      reject(new Error("Worker supervisor bridge unavailable"));
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      input.pipe(socket); socket.pipe(output);
      socket.once("close", () => { if (!settled) { settled = true; resolve(); } });
      input.once("error", fail); output.once("error", fail);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bridgeWorkerSupervisor().then(() => process.exitCode = 0, () => process.exitCode = 1);
}
