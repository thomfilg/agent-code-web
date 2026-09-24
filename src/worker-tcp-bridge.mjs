import { Duplex } from "node:stream";

const MAX_FRAME = 65536;
const failed = code => Object.assign(new Error(`Worker TCP transport failed (${code})`), { code });

// Serialized as fixed Node source through the existing executor. No host,
// command, environment, shell fragment or request path is accepted as input.
async function workerTcpMain() {
  const { createConnection } = await import("node:net");
  let header = Buffer.alloc(0), socket, connectTimer, idleTimer, lifetimeTimer;
  let initialized = false, stopping = false, inputEnded = false, remoteEnded = false;
  const frame = (type, bytes = Buffer.alloc(0)) => {
    const prefix = Buffer.alloc(5); prefix[0] = type; prefix.writeUInt32BE(bytes.length, 1);
    return process.stdout.write(Buffer.concat([prefix, bytes]));
  };
  const stop = () => {
    if (stopping) return; stopping = true;
    clearTimeout(headerTimer); clearTimeout(connectTimer); clearTimeout(idleTimer); clearTimeout(lifetimeTimer);
    socket?.destroy(); process.stdin.destroy(); process.exitCode = 1;
    // No upstream errors or configuration values become output diagnostics.
    process.stderr.end("Worker TCP bridge failed\n");
  };
  const headerTimer = setTimeout(stop, 10000);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
  process.stdin.on("error", stop); process.stdout.on("error", stop); process.stderr.on("error", () => {});
  process.stdin.on("end", () => { inputEnded = true; if (!initialized) stop(); });
  const readHeader = chunk => {
    header = Buffer.concat([header, chunk]);
    const newline = header.indexOf(10);
    if (newline < 0) { if (header.length > 512) stop(); return; }
    process.stdin.pause(); process.stdin.off("data", readHeader); clearTimeout(headerTimer);
    try {
      if (newline > 512) throw Error();
      const request = JSON.parse(header.subarray(0, newline));
      if (!request || typeof request !== "object" || Array.isArray(request) ||
          Object.keys(request).sort().join(",") !== "connectTimeoutMs,idleTimeoutMs,maxLifetimeMs,port,version" || request.version !== 1 ||
          !Number.isInteger(request.port) || request.port < 1024 || request.port > 65535 ||
          !Number.isInteger(request.connectTimeoutMs) || request.connectTimeoutMs < 1 || request.connectTimeoutMs > 30000 ||
          !Number.isInteger(request.idleTimeoutMs) || request.idleTimeoutMs < 1 || request.idleTimeoutMs > 300000 ||
          !Number.isInteger(request.maxLifetimeMs) || request.maxLifetimeMs < 1 || request.maxLifetimeMs > 900000) throw Error();
      initialized = true;
      const remainder = header.subarray(newline + 1); header = null;
      const activity = () => { clearTimeout(idleTimer); idleTimer = setTimeout(stop, request.idleTimeoutMs); };
      connectTimer = setTimeout(stop, request.connectTimeoutMs);
      lifetimeTimer = setTimeout(stop, request.maxLifetimeMs);
      socket = createConnection({ host: "127.0.0.1", port: request.port, family: 4, allowHalfOpen: true });
      socket.setNoDelay(true);
      socket.on("error", stop);
      socket.on("connect", () => {
        clearTimeout(connectTimer); if (stopping) return;
        frame(1); activity();
        if (remainder.length && !socket.write(remainder)) process.stdin.pause();
        process.stdin.on("data", activity);
        process.stdin.pipe(socket); process.stdin.resume();
        if (inputEnded) socket.end();
      });
      socket.on("data", bytes => {
        activity();
        // net.Socket chunks are bounded in practice; split defensively so the
        // wire format never trusts a platform's stream high-water mark.
        for (let offset = 0; offset < bytes.length; offset += 65536) if (!frame(2, bytes.subarray(offset, offset + 65536))) socket.pause();
      });
      process.stdout.on("drain", () => { if (!stopping) socket.resume(); });
      socket.on("end", () => { remoteEnded = true; frame(3); activity(); });
      socket.on("close", hadError => {
        if (stopping) return;
        if (hadError || !remoteEnded || !inputEnded) { stop(); return; }
        clearTimeout(idleTimer); clearTimeout(lifetimeTimer); clearTimeout(connectTimer);
        process.stdin.destroy(); process.exitCode = 0;
      });
    } catch { stop(); }
  };
  process.stdin.on("data", readHeader);
}

export const WORKER_TCP_BRIDGE = `(${workerTcpMain.toString()})().catch(() => { process.stderr.write("Worker TCP bridge failed\\n"); process.exitCode = 1; });`;

function configuration(options) {
  const allowed = new Set(["port", "signal", "connectTimeoutMs", "idleTimeoutMs", "maxLifetimeMs"]);
  if (!options || typeof options !== "object" || Object.keys(options).some(key => !allowed.has(key))) throw failed("invalid-options");
  const value = { version: 1, port: options.port, connectTimeoutMs: options.connectTimeoutMs ?? 15000,
    idleTimeoutMs: options.idleTimeoutMs ?? 60000, maxLifetimeMs: options.maxLifetimeMs ?? 300000 };
  for (const [key, min, max] of [["port", 1024, 65535], ["connectTimeoutMs", 1, 30000], ["idleTimeoutMs", 1, 300000], ["maxLifetimeMs", 1, 900000]]) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw failed("invalid-options");
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw failed("invalid-options");
  return value;
}

class WorkerTcpDuplex extends Duplex {
  constructor(executor, config, signal) {
    super({ allowHalfOpen: true, autoDestroy: false, highWaterMark: MAX_FRAME });
    this.connecting = true; this.buffer = Buffer.alloc(0); this.wantRead = true;
    this.remoteEnded = false; this.inputEnded = false; this.childClosed = false; this.cleanupConfirmed = false;
    let resolveReady, rejectReady;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Callers can use stream error events without awaiting ready; no unhandled
    // rejection is manufactured. The original promise still rejects on await.
    this.ready.catch(() => {}); this.resolveReady = resolveReady; this.rejectReady = rejectReady;
    this.abort = () => this.destroy(failed("cancelled")); this.signal = signal;
    if (signal?.aborted) { queueMicrotask(this.abort); return; }
    signal?.addEventListener("abort", this.abort, { once: true });
    this.connectTimer = setTimeout(() => this.destroy(failed("connect-timeout")), config.connectTimeoutMs);
    this.lifetimeTimer = setTimeout(() => this.destroy(failed("lifetime-timeout")), config.maxLifetimeMs);
    this.idleTimeoutMs = config.idleTimeoutMs;
    this.on("end", () => this.maybeFinished()); this.on("finish", () => this.maybeFinished());
    try {
      this.child = executor.spawn("/usr/bin/node", ["--input-type=module", "-e", WORKER_TCP_BRIDGE],
        { cwd: executor.workspace, env: {}, stdio: ["pipe", "pipe", "pipe"] });
      const child = this.child;
      child.on("error", () => this.destroy(failed("child-failed")));
      child.stdin.on("error", () => this.destroy(failed("input-failed")));
      child.stderr.on("error", () => {}); child.stderr.resume();
      child.stdout.on("error", () => this.destroy(failed("output-failed")));
      child.stdout.on("data", chunk => {
        if (this.destroyed) return;
        if (this.buffer.length + chunk.length > MAX_FRAME * 3) { this.destroy(failed("invalid-frame")); return; }
        this.buffer = Buffer.concat([this.buffer, chunk]); this.pump();
      });
      child.once("close", (code, signal) => {
        this.childClosed = true; this.cleanupConfirmed = true; clearTimeout(this.killTimer); clearTimeout(this.cleanupTimer);
        if (this.destroyed) { this.destroyDone?.(); return; }
        if (code !== 0 || signal || this.connecting || !this.remoteEnded || !this.inputEnded || this.buffer.length) this.destroy(failed("child-failed"));
        else this.maybeFinished();
      });
      child.stdin.write(JSON.stringify(config) + "\n");
    } catch { queueMicrotask(() => this.destroy(failed("child-failed"))); }
  }
  activity() { clearTimeout(this.idleTimer); this.idleTimer = setTimeout(() => this.destroy(failed("idle-timeout")), this.idleTimeoutMs); }
  pump() {
    if (this.pumping || this.destroyed) return;
    this.pumping = true;
    try {
      while (this.wantRead && this.buffer.length >= 5) {
        const type = this.buffer[0], size = this.buffer.readUInt32BE(1);
        if (![1, 2, 3].includes(type) || size > MAX_FRAME || (type !== 2 && size !== 0) || (type === 2 && size === 0)) throw failed("invalid-frame");
        if (this.buffer.length < size + 5) break;
        const bytes = this.buffer.subarray(5, size + 5); this.buffer = this.buffer.subarray(size + 5);
        if (type === 1) {
          if (!this.connecting || this.remoteEnded) throw failed("invalid-frame");
          this.connecting = false; clearTimeout(this.connectTimer); this.activity(); this.resolveReady(); this.emit("connect");
        } else {
          if (this.connecting || this.remoteEnded) throw failed("invalid-frame");
          this.activity();
          if (type === 3) { this.remoteEnded = true; this.push(null); }
          else if (!this.push(bytes)) { this.wantRead = false; this.child.stdout.pause(); }
        }
      }
    } catch { this.destroy(failed("invalid-frame")); }
    finally { this.pumping = false; }
  }
  _read() { this.wantRead = true; this.pump(); if (this.wantRead && !this.destroyed) this.child?.stdout.resume(); }
  _write(chunk, _encoding, callback) {
    this.ready.then(() => {
      if (this.destroyed) { callback(failed("closed")); return; }
      this.activity(); this.child.stdin.write(chunk, error => callback(error ? failed("input-failed") : undefined));
    }, () => callback(failed("connect-failed")));
  }
  _final(callback) {
    this.ready.then(() => {
      if (this.destroyed) { callback(failed("closed")); return; }
      this.inputEnded = true; this.child.stdin.end(error => callback(error ? failed("input-failed") : undefined));
    }, () => callback(failed("connect-failed")));
  }
  maybeFinished() { if (this.childClosed && this.readableEnded && this.writableFinished) this.destroy(); }
  _destroy(error, callback) {
    clearTimeout(this.connectTimer); clearTimeout(this.idleTimer); clearTimeout(this.lifetimeTimer);
    this.signal?.removeEventListener("abort", this.abort); this.rejectReady(error || failed("closed"));
    this.buffer = Buffer.alloc(0);
    const child = this.child;
    if (!child || this.childClosed) { this.cleanupConfirmed = true; callback(error); return; }
    this.destroyDone = (failure = error) => {
      this.destroyDone = null; clearTimeout(this.killTimer); clearTimeout(this.cleanupTimer); callback(failure);
    };
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    // Only this bridge's own process is terminated. Existing executor/SSH
    // signal handling owns its remote process group and heartbeat cleanup.
    const kill = signal => { try { child.kill(signal); } catch { /* Close observation, not kill(), determines cleanup. */ } };
    kill("SIGTERM");
    this.killTimer = setTimeout(() => kill("SIGKILL"), 2000); this.killTimer.unref();
    this.cleanupTimer = setTimeout(() => this.destroyDone?.(failed("cleanup-unconfirmed")), 5000);
  }
}

export function openWorkerTcp(executor, options) {
  const config = configuration(options);
  if (!executor || typeof executor.spawn !== "function" || typeof executor.workspace !== "string" || !executor.workspace.startsWith("/")) throw failed("invalid-executor");
  return new WorkerTcpDuplex(executor, config, options.signal);
}
