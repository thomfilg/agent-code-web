import { randomUUID } from "node:crypto";

export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_INPUT_BYTES = 16 * 1024;
export const PROTOCOL = "relay-worker-process/1";
export const identityFields = ["deploymentId", "ownerId", "chatId", "workerId", "provider", "accountId", "attemptId"];
export class TransportError extends Error {
  constructor(code) { super(`Worker transport: ${code}`); this.code = code; }
}
export const transportError = code => new TransportError(code);
export const safeId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const sequence = value => Number.isSafeInteger(value) && value >= 0;
export function identity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== identityFields.length
    || identityFields.some(key => typeof value[key] !== "string" || !value[key] || value[key].length > 256 || /[\x00-\x1f\x7f]/.test(value[key]))) throw transportError("IDENTITY_INVALID");
  return Object.freeze(Object.fromEntries(identityFields.map(key => [key, value[key]])));
}
export function writeFrame(socket, frame) {
  const data = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(data) > MAX_FRAME_BYTES) throw transportError("FRAME_TOO_LARGE");
  return socket.write(data);
}
export function readFrames(socket, receive, invalid) {
  let buffer = Buffer.alloc(0), failed = false;
  socket.on("data", chunk => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      if (end > MAX_FRAME_BYTES) { failed = true; invalid(); return; }
      const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      let frame;
      try { frame = JSON.parse(line); if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw Error(); }
      catch { failed = true; invalid(); return; }
      receive(frame);
    }
    if (buffer.length > MAX_FRAME_BYTES) { failed = true; invalid(); }
  });
}
export function requestId() { return randomUUID(); }
