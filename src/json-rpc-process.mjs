import { EventEmitter } from "node:events";
import readline from "node:readline";
import { errorMessage, redact } from "./utils.mjs";
import { spawnWorker, terminateWorker } from "./worker-process.mjs";

export class JsonRpcProcess extends EventEmitter {
  #nextId = 1;
  #pending = new Map();

  constructor({ command, args = [], spawnOptions = {}, isolation = "none", spawnFn = null, requestTimeoutMs = 30_000 }) {
    super();
    this.command = command;
    this.args = args;
    this.spawnOptions = spawnOptions;
    this.isolation = isolation;
    this.spawnFn = spawnFn;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
  }

  start() {
    if (this.child) return;
    const spawnFn = this.spawnFn || spawnWorker;
    const child = spawnFn(this.command, this.args, {
      ...this.spawnOptions,
      isolation: this.isolation,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#receive(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.emit("stderr", redact(chunk)));
    child.once("error", (error) => this.emit("error", error));
    child.once("exit", (code, signal) => {
      const error = new Error(`agent process exited (${code ?? signal ?? "unknown"})`);
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.child = null;
      this.emit("exit", { code, signal });
    });
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, code, message) {
    this.#write({ id, error: { code, message } });
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    await terminateWorker(child);
    this.child = null;
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("agent process is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error(`non-JSON app-server output: ${redact(line).slice(0, 500)}`));
      return;
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${errorMessage(message.error.message || message.error)}`));
      else pending.resolve(message.result);
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      this.emit("request", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }
}
