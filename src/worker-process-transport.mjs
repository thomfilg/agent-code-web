import net from "node:net";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { MAX_INPUT_BYTES, PROTOCOL, identity, readFrames, requestId, safeId, sequence, transportError, writeFrame } from "./worker-transport-wire.mjs";

const streamAdmission = Symbol("worker-process-stream-admission");

// Internal controller transports (currently the pinned SSH bridge) may supply
// an already-authenticated byte stream. Keeping the constructor key private
// prevents an ordinary caller from accidentally bypassing the local Unix
// ownership checks by passing a similarly named option.
export function createStreamWorkerProcessTransport({ connectStream, ...options }) {
  return new WorkerProcessTransport({ ...options, connectStream }, streamAdmission);
}

// Controller-side connection only. No auto-reconnect, input resend, output ACK,
// process spawn or child termination is hidden in connection lifecycle methods.
export class WorkerProcessTransport extends EventEmitter {
  constructor({ socketPath, expectedIdentity, lease, timeoutMs = 5000, connectStream }, admission = null) {
    super();
    const remote = admission === streamAdmission && typeof connectStream === "function";
    if ((!remote && !path.isAbsolute(socketPath)) || typeof lease !== "string" || !lease || lease.length > 512
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw transportError("CONFIG_INVALID");
    Object.assign(this, { socketPath, expectedIdentity: identity(expectedIdentity), lease, timeoutMs,
      ...(remote ? { connectStream } : {}) });
    this.pending = new Map(); this.attachment = null;
  }
  async connect() {
    if (this.socket) throw transportError("ALREADY_CONNECTED");
    let socket, connected = false;
    if (this.connectStream) {
      try { socket = await this.connectStream(); }
      catch { throw transportError("CONNECTION_FAILED"); }
      if (!socket || typeof socket.on !== "function" || typeof socket.write !== "function" || typeof socket.destroy !== "function") {
        try { socket?.destroy?.(); } catch {}
        throw transportError("CONNECTION_FAILED");
      }
      connected = true;
    } else {
      const parent = await lstat(path.dirname(this.socketPath)), endpoint = await lstat(this.socketPath);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700
        || await realpath(path.dirname(this.socketPath)) !== path.resolve(path.dirname(this.socketPath))) throw transportError("PRIVATE_DIRECTORY_REQUIRED");
      if (!endpoint.isSocket() || endpoint.uid !== process.getuid?.() || (endpoint.mode & 0o777) !== 0o600) throw transportError("PRIVATE_SOCKET_REQUIRED");
      socket = net.createConnection(this.socketPath);
    }
    this.socket = socket;
    this.closed = false;
    const lost = () => {
      if (this.closed) return; this.closed = true;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(transportError("CONNECTION_LOST_OUTCOME_UNKNOWN")); }
      this.pending.clear(); this.emit("disconnect");
    };
    socket.on("error", lost); socket.on("close", lost);
    readFrames(socket, frame => {
      try { this.receive(frame); } catch { socket.destroy(); }
    }, () => socket.destroy());
    if (!connected) await new Promise((resolve, reject) => {
      const error = () => { clearTimeout(timer); reject(transportError("CONNECTION_FAILED")); };
      const timer = setTimeout(() => { socket.destroy(); error(); }, this.timeoutMs); timer.unref();
      socket.once("error", error); socket.once("connect", () => { clearTimeout(timer); socket.off("error", error); resolve(); });
    });
    return this;
  }
  receive(frame) {
    if (frame.event === "output") {
      const attached = this.attachment;
      if (!attached || frame.supervisorInstanceId !== attached.supervisorInstanceId || frame.processId !== attached.processId
        || frame.processInstanceId !== attached.processInstanceId || frame.seq !== this.receivedThrough + 1
        || !["stdout", "stderr", "exit"].includes(frame.channel) || typeof frame.data !== "string") throw transportError("OUTPUT_INVALID");
      const data = Buffer.from(frame.data, "base64");
      if (data.length > MAX_INPUT_BYTES || data.toString("base64") !== frame.data) throw transportError("OUTPUT_INVALID");
      this.receivedThrough = frame.seq;
      this.emit("output", { ...frame, data }); return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return; // An expired operation is NEVER resent automatically.
    this.pending.delete(frame.id); clearTimeout(pending.timer);
    if (frame.error) {
      pending.reject(transportError(/^[A-Z_]{1,80}$/.test(frame.error.code) ? frame.error.code : "OPERATION_FAILED")); return;
    }
    try { pending.accept?.(frame.result); pending.resolve(frame.result); }
    catch (error) { pending.reject(error); this.socket.destroy(); }
  }
  request(action, processId, fields = {}, accept) {
    if (!this.socket || this.closed || this.socket.destroyed) return Promise.reject(transportError("NOT_CONNECTED"));
    if (!safeId(processId) || this.pending.size >= 16) return Promise.reject(transportError("REQUEST_LIMIT_OR_ID_INVALID"));
    const id = requestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(transportError("TIMEOUT_OUTCOME_UNKNOWN")); }, this.timeoutMs); timer.unref();
      this.pending.set(id, { resolve, reject, timer, accept });
      try { writeFrame(this.socket, { protocol: PROTOCOL, ...fields, id, action, processId, identity: this.expectedIdentity, lease: this.lease }); }
      catch { this.pending.delete(id); clearTimeout(timer); reject(transportError("REQUEST_INVALID")); }
    });
  }
  launch(processId, spec) { return this.request("launch", processId, { spec }); }
  inspect(processId) { return this.request("inspect", processId); }
  attach(receipt, committedOutputSeq) {
    if (this.attachment || !receipt || receipt.protocol !== PROTOCOL || !safeId(receipt.processInstanceId) || !safeId(receipt.supervisorInstanceId)
      || !sequence(committedOutputSeq)) return Promise.reject(transportError("ATTACH_INVALID"));
    return this.request("attach", receipt.processId, { processInstanceId: receipt.processInstanceId, committedOutputSeq }, result => {
      if (result?.supervisorInstanceId !== receipt.supervisorInstanceId || result?.processInstanceId !== receipt.processInstanceId
        || result?.processId !== receipt.processId) throw transportError("PROCESS_IDENTITY_CHANGED");
      this.attachment = receipt; this.receivedThrough = committedOutputSeq;
    });
  }
  attached(action, fields = {}) {
    if (!this.attachment) return Promise.reject(transportError("NOT_ATTACHED"));
    return this.request(action, this.attachment.processId, { ...fields, processInstanceId: this.attachment.processInstanceId });
  }
  writeInput(seq, data) {
    if (!sequence(seq) || seq < 1 || !Buffer.isBuffer(data) || data.length > MAX_INPUT_BYTES) return Promise.reject(transportError("INPUT_INVALID"));
    return this.attached("input", { seq, data: data.toString("base64") });
  }
  endInput(seq) { return this.attached("endInput", { seq }); }
  // Caller must durably persist every output record through seq BEFORE this.
  ackOutput(seq) { return this.attached("ackOutput", { seq }); }
  status() { return this.attached("status"); }
  terminate() { return this.attached("terminate"); }
  disconnect() { this.socket?.destroy(); }
}
