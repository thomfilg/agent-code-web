import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readFrames, writeFrame } from "./worker-transport-wire.mjs";
import { WORKER_SUPERVISOR_CONTROL_SOCKET } from "./worker-supervisor-paths.mjs";

const controlError = code => Object.assign(new Error(`Worker supervisor control: ${code}`), { code });

export async function workerSupervisorControl(request, { socketPath = WORKER_SUPERVISOR_CONTROL_SOCKET, timeoutMs = 5000 } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw controlError("REQUEST_INVALID");
  const parent = await lstat(path.dirname(socketPath)), endpoint = await lstat(socketPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700
    || await realpath(path.dirname(socketPath)) !== path.resolve(path.dirname(socketPath))
    || !endpoint.isSocket() || endpoint.isSymbolicLink() || endpoint.uid !== process.getuid?.() || (endpoint.mode & 0o777) !== 0o600) throw controlError("PRIVATE_SOCKET_REQUIRED");
  const socket = net.createConnection(socketPath), id = randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => done(controlError("TIMEOUT")), timeoutMs); timer.unref();
    socket.once("error", () => done(controlError("CONNECTION_FAILED")));
    readFrames(socket, frame => {
      if (frame.id !== id) { done(controlError("RESPONSE_INVALID")); return; }
      if (frame.error) done(controlError(/^[A-Z_]{1,80}$/.test(frame.error.code || "") ? frame.error.code : "OPERATION_FAILED"));
      else done(null, frame.result);
    }, () => done(controlError("RESPONSE_INVALID")));
    socket.once("connect", () => { try { writeFrame(socket, { ...request, id }); } catch { done(controlError("REQUEST_INVALID")); } });
  });
}

async function cli() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 64 * 1024) throw controlError("REQUEST_INVALID");
  }
  let request;
  try { request = JSON.parse(data); } catch { throw controlError("REQUEST_INVALID"); }
  const result = await workerSupervisorControl(request);
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch(error => {
  process.stdout.write(JSON.stringify({ error: /^[A-Z_]{1,80}$/.test(error?.code || "") ? error.code : "OPERATION_FAILED" }) + "\n");
  process.exitCode = 1;
});

