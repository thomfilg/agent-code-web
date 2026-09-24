import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { spawnWorker, terminateWorker } from "./worker-process.mjs";
import { redact } from "./utils.mjs";

export const CLAUDE_DEBUG_PRIVATE_ERROR = "Debugging requires this chat's private Claude profile. Shared host logs remain locked until company/profile isolation is complete.";
export const claudeDebugRequest = text => /^\/debug(?:\s|$)/.test(text.trim());

// Runs beside the native CLI, including on remote workers. Only actual native
// stderr received after explicit /debug opt-in is recorded. No transcript,
// personal-profile lookup, synthesized logs or pre-opt-in buffer is involved.
export async function writePrivateClaudeDebugLog(runtimeHome, sessionId) {
  const fs = await import("node:fs/promises"), path = await import("node:path"), { constants } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(sessionId)) throw Error("Invalid native session");
  const profile = path.join(runtimeHome, "claude"), directory = path.join(profile, "debug"), filename = path.join(directory, `${sessionId}.txt`);
  const checkDirectories = async () => {
    for (const value of [runtimeHome, profile, directory]) if (await fs.realpath(value) !== path.resolve(value) || !(await fs.lstat(value)).isDirectory()) throw Error("Invalid private debug directory");
  };
  if (await fs.realpath(runtimeHome) !== path.resolve(runtimeHome)) throw Error("Linked private runtime");
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  if (await fs.realpath(profile) !== path.resolve(profile)) throw Error("Linked private profile");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await checkDirectories();
  const file = await fs.open(filename, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const original = await file.stat(), limit = 2 * 1024 * 1024;
    if (!original.isFile() || original.nlink !== 1 || original.size > limit) throw Error("Invalid private debug file");
    await file.chmod(0o600);
    let size = original.size;
    const validate = async () => {
      await checkDirectories(); const current = await fs.lstat(filename), held = await file.stat();
      if (current.isSymbolicLink() || current.ino !== original.ino || current.dev !== original.dev || held.nlink !== 1) throw Error("Private debug file replaced");
    };
    await validate(); process.stdout.write('{"ready":true}\n');
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (Buffer.byteLength(line) > 65536) throw Error("Oversized debug packet");
      const packet = JSON.parse(line); await validate();
      if (typeof packet.line === "string" && packet.line.length <= 8192 && !/[\r\n]/.test(packet.line)) {
        const text = `${packet.line}\n`, bytes = Buffer.byteLength(text);
        if (size + bytes > limit) { await file.truncate(0); size = 0; }
        await file.writeFile(text); size += bytes;
      } else if (typeof packet.flush === "string" && /^[a-f\d-]{36}$/.test(packet.flush)) process.stdout.write(`${JSON.stringify({ flushed: packet.flush })}\n`);
      else throw Error("Invalid debug packet");
    }
  } finally { await file.close(); }
}

export class ClaudeDebugLog {
  static async open({ runtimeHome, sessionId, executor, isolation, signal, onError = () => {}, sanitize = value => value }) {
    signal?.throwIfAborted();
    const script = `(${writePrivateClaudeDebugLog.toString()})(process.argv[1],process.argv[2]).catch(() => { process.stderr.write("Private debug capture failed"); process.stdin.destroy(); process.exitCode = 1; });`;
    const spawn = executor && executor.metadata?.backend !== "local" ? executor.spawn.bind(executor) : spawnWorker;
    const child = spawn("node", ["-e", script, runtimeHome, sessionId], { cwd: runtimeHome, env: { PATH: executor?.environmentPath || process.env.PATH, LANG: "C.UTF-8" }, isolation, stdio: ["pipe", "pipe", "pipe"] });
    const log = new ClaudeDebugLog(child, onError, sanitize);
    const abort = () => log.fail(false); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { await log.ready.promise; signal?.throwIfAborted(); return log; }
    catch { await log.close(); throw Error("Cannot safely enable private Claude debug logging; the command was not sent."); }
    finally { signal?.removeEventListener("abort", abort); }
  }

  constructor(child, onError, sanitize = value => value) {
    this.child = child; this.onError = onError; this.ready = Promise.withResolvers(); this.pending = new Map();
    this.sanitize = sanitize;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.timer = setTimeout(() => this.fail(), 5000);
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", line => {
      try {
        if (line.length > 200) throw Error("Invalid debug receipt");
        const packet = JSON.parse(line);
        if (packet.ready === true && !this.isReady) { this.isReady = true; clearTimeout(this.timer); this.ready.resolve(); }
        else if (this.pending.has(packet.flushed)) { const pending = this.pending.get(packet.flushed); this.pending.delete(packet.flushed); clearTimeout(pending.timer); pending.resolve(); }
        else throw Error("Unexpected debug receipt");
      } catch { this.fail(); }
    });
    child.stderr.resume(); child.once("error", () => this.fail()); child.stdin.on("error", () => this.fail());
    child.once("close", code => {
      this.ended = true; if (!this.closing || code !== 0) this.fail();
      clearTimeout(this.timer); this.lines.close(); this.resolveClosed();
    });
  }

  fail(notify = true) {
    if (this.error) return;
    this.error = Error("Private Claude debug capture stopped; retry /debug after checking the private worker storage.");
    clearTimeout(this.timer); this.ready.reject(this.error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.error); } this.pending.clear();
    if (notify) this.onError(this.error); void terminateWorker(this.child);
  }

  append(line) {
    if (this.error || this.closing) return;
    if (typeof line !== "string" || line.length > 8192 || line.includes("\n")) { this.fail(); return; }
    if (this.child.stdin.writableLength > 256 * 1024) { this.fail(); return; }
    const safe = redact(this.sanitize(line).replace(/\r/g, "")
      .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer ***")
      .replace(/(["'](?:authorization|api[_-]?key|token|secret|password)["']\s*:\s*)["'][^"']*["']/gi, '$1"***"'));
    this.child.stdin.write(`${JSON.stringify({ line: safe })}\n`);
  }

  flush() {
    if (this.error || this.closing) return Promise.reject(this.error || Error("Private debug capture closed"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer: setTimeout(() => this.fail(), 5000) });
      this.child.stdin.write(`${JSON.stringify({ flush: id })}\n`);
    });
  }

  async close() {
    if (this.ended) return;
    if (!this.closing) {
      this.closing = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error("Private debug capture closed")); } this.pending.clear();
      this.child.stdin.end();
      this.closeTimer = setTimeout(() => { this.fail(); }, 5000);
    }
    await this.closed; clearTimeout(this.closeTimer);
  }
}
