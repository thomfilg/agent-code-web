import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { MAX_INPUT_BYTES } from "./worker-transport-wire.mjs";

const processId = "native-agent";
const failure = message => new Error(`Native agent reconnect: ${message}`);
const sameReceipt = (left, right) => Boolean(left && right)
  && ["protocol", "supervisorInstanceId", "processId", "processInstanceId", "pid", "startedAt"].every(key => left[key] === right[key])
  && JSON.stringify(left.groupAnchor) === JSON.stringify(right.groupAnchor);

// ChildProcess-compatible facade for the long-lived native CLI owner. It keeps
// the same streams/readline consumers across a transport reconnect. Input is
// sequenced and never replayed after an unknown acknowledgement; output is ACKed
// only after it has entered the stable controller-side stream.
export class ReconnectableAgentProcess extends EventEmitter {
  constructor(context, spec) {
    super();
    this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.exitCode = null; this.signalCode = null; this.killed = false; this.detached = true;
    this.outputSeq = 0; this.inputSeq = 0; this.outputQueue = Promise.resolve(); this.inputQueue = Promise.resolve();
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => { const operation = this.#write(Buffer.from(chunk)); this.inputQueue = operation.catch(() => {}); operation.then(() => done(), done); },
      final: done => { const operation = this.#endInput(); this.inputQueue = operation.catch(() => {}); operation.then(() => done(), done); },
    });
    // ChildProcess callers do not normally need a separate stdin error listener;
    // retain that contract while still surfacing startup/transport errors here.
    this.stdin.on("error", () => {});
    this.ready = Promise.resolve(context).then(value => { this.context = value; return this.#start(spec); });
    this.ready.catch(error => this.#startFailed(error));
  }
  async #connection(stopping = false) {
    const lease = await this.context.issueLease();
    if (typeof lease?.credential !== "string") throw failure("lease authority did not issue a credential");
    const client = await this.context.connectTransport(lease.credential);
    if (!client || typeof client.launch !== "function" || typeof client.attach !== "function") throw failure("worker transport is invalid");
    client.authorityLeaseId = lease.id;
    client.on("disconnect", () => {
      if (this.client !== client) return;
      this.detached = true; clearInterval(this.renewal);
      if (!this.stopping && !this.commandExited) this.emit("transportDetached");
    });
    client.on("output", frame => {
      this.outputQueue = this.outputQueue.then(() => this.#output(frame, client)).catch(error => {
        this.outputFailed = error; client.disconnect();
        if (!this.stopping) this.emit("transportFault", { message: "Native output could not be retained; reconnect is blocked. Stop the worker explicitly." });
      });
    });
    if (this.stopping && !stopping) { client.disconnect(); throw failure("process is stopping"); }
    return client;
  }
  async #start(spec) {
    this.client = await this.#connection();
    this.receipt = await this.client.launch(processId, spec);
    if (this.receipt?.processId !== processId || !Number.isInteger(this.receipt.pid)) throw failure("worker returned an invalid process receipt");
    this.context.retain?.(this.receipt); this.pid = this.receipt.pid;
    await this.client.attach(this.receipt, 0);
    this.detached = false; this.#renew();
    return this;
  }
  #startFailed(error) {
    if (this.startError || this.receipt) return;
    this.startError = error; this.stdout.end(); this.stderr.end();
    if (!this.stdin.destroyed) this.stdin.destroy();
    queueMicrotask(() => { this.emit("error", error); this.emit("close", null, null); this.resolveClosed(); });
  }
  #renew() {
    clearInterval(this.renewal);
    this.renewal = setInterval(() => {
      if (!this.detached && !this.stopping && !this.renewing) {
        const client = this.client;
        this.renewing = Promise.resolve().then(() => this.context.renewLease(client.authorityLeaseId)).then(() => client.status())
          .catch(() => client.disconnect()).finally(() => { this.renewing = null; });
      }
    }, 1000);
    this.renewal.unref();
  }
  async reconnect() {
    await this.ready;
    if (!this.detached) return this;
    if (this.stopping || this.commandExited || this.inputUncertain || this.outputFailed) throw failure("process is not at a safe reconnect boundary");
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      await this.inputQueue; await this.outputQueue;
      const client = await this.#connection();
      try {
        const observed = await client.inspect(processId);
        if (observed.state !== "running" || !sameReceipt(observed, this.receipt)
          || observed.inputAcceptedThrough !== this.inputSeq || observed.outputCommittedThrough > this.outputSeq
          || observed.outputProducedThrough < this.outputSeq) throw failure("worker process no longer matches the exact retained cursors");
        const attached = await client.attach(this.receipt, this.outputSeq);
        if (!sameReceipt(attached, this.receipt) || attached.state !== "running" || attached.inputAcceptedThrough !== this.inputSeq) throw failure("worker process changed during reconnect");
        this.client = client; this.detached = false; this.#renew(); return this;
      } catch (error) { client.disconnect(); throw error; }
    })();
    try { return await this.reconnecting; } finally { this.reconnecting = null; }
  }
  async #attached() {
    await this.ready;
    if (this.inputUncertain) throw failure("previous input outcome is unknown; it was not replayed");
    if (this.stopping || this.commandExited) throw failure("process input is closed");
    if (this.detached) await this.reconnect();
    return this.client;
  }
  async #write(data) {
    const client = await this.#attached();
    try {
      for (let offset = 0; offset < data.length; offset += MAX_INPUT_BYTES) {
        const seq = this.inputSeq + 1;
        await client.writeInput(seq, data.subarray(offset, offset + MAX_INPUT_BYTES));
        this.inputSeq = seq;
      }
    } catch (error) { this.inputUncertain = true; throw failure(`input outcome is unknown (${error?.code || "transport"}); it was not replayed`); }
  }
  async #endInput() {
    const client = await this.#attached();
    const seq = this.inputSeq + 1;
    try { await client.endInput(seq); this.inputSeq = seq; this.inputEnded = true; }
    catch (error) { this.inputUncertain = true; throw failure(`stdin close outcome is unknown (${error?.code || "transport"}); it was not replayed`); }
  }
  async #output(frame, client) {
    if (frame.seq !== this.outputSeq + 1) throw failure("unexpected output sequence");
    if (frame.channel === "stdout" || frame.channel === "stderr") {
      const stream = this[frame.channel];
      if (!stream.write(frame.data)) await new Promise(resolve => stream.once("drain", resolve));
    } else if (frame.channel === "exit") {
      let exit; try { exit = JSON.parse(frame.data.toString()); } catch { throw failure("invalid exit record"); }
      if (exit?.code !== null && !Number.isInteger(exit?.code) || exit?.signal !== null && typeof exit?.signal !== "string") throw failure("invalid exit record");
      this.exitCode = exit.code; this.signalCode = exit.signal; this.commandExited = true;
    } else throw failure("invalid output channel");
    this.outputSeq = frame.seq;
    await client.ackOutput(frame.seq);
    if (frame.channel === "exit") {
      clearInterval(this.renewal); this.stdout.end(); this.stderr.end();
      this.emit("exit", this.exitCode, this.signalCode); this.emit("close", this.exitCode, this.signalCode); this.resolveClosed();
    }
  }
  detach() { this.client?.disconnect(); }
  kill(signal = "SIGTERM") {
    if (!["SIGTERM", "SIGKILL"].includes(signal)) return false;
    void this.terminateRemote().catch(error => { if (this.listenerCount("error")) this.emit("error", error); });
    return true;
  }
  async terminateRemote() {
    if (this.termination) return this.termination;
    this.stopping = true; this.killed = true; clearInterval(this.renewal);
    this.termination = (async () => {
      try { await this.ready; }
      catch {
        if (this.context) await this.context.dispose({});
        return;
      }
      await this.renewing?.catch(() => {}); await this.reconnecting?.catch(() => {}); await this.outputQueue;
      if (this.detached || this.client?.closed) {
        const client = await this.#connection(true); this.client = client;
        const observed = await client.inspect(processId);
        if (!sameReceipt(observed, this.receipt)) throw failure("cleanup process identity changed");
        await client.attach(this.receipt, this.outputSeq); this.detached = false;
      }
      const result = await this.client.terminate();
      if (result.groupCleanup !== "confirmed") throw failure("worker process cleanup is unconfirmed");
      let timer;
      try { await Promise.race([this.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(failure("final output could not be retained")), 4000); timer.unref(); })]); }
      finally { clearTimeout(timer); }
      await this.outputQueue;
      this.client.disconnect(); await this.context.dispose({ receipt: this.receipt });
      this.processReleased = true;
    })();
    try { return await this.termination; }
    catch (error) { this.termination = null; throw error; }
  }
}
