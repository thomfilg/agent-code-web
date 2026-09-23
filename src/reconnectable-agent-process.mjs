import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { MAX_INPUT_BYTES, PROTOCOL, safeId } from "./worker-transport-wire.mjs";

const processId = "native-agent", defaultLifetime = randomUUID();
const privateLimit = 2 * 1024 * 1024;
const digest = value => createHash("sha256").update(value).digest("hex");
const failure = message => new Error(`Native agent reconnect: ${message}`);
const sameReceipt = (left, right) => Boolean(left && right)
  && ["protocol", "supervisorInstanceId", "processId", "processInstanceId", "pid", "startedAt"].every(key => left[key] === right[key])
  && JSON.stringify(left.groupAnchor) === JSON.stringify(right.groupAnchor);
const validReceipt = receipt => receipt?.protocol === PROTOCOL && receipt.processId === processId
  && safeId(receipt.supervisorInstanceId) && safeId(receipt.processInstanceId)
  && Number.isSafeInteger(receipt.pid) && receipt.pid > 1
  && typeof receipt.startedAt === "string" && Number.isFinite(Date.parse(receipt.startedAt))
  && Number.isSafeInteger(receipt.groupAnchor?.pid) && receipt.groupAnchor.pid > 1
  && typeof receipt.groupAnchor?.start === "string" && /^[0-9]+$/.test(receipt.groupAnchor.start);
const validCheckpoint = ledger => ledger?.checkpoint
  && Number.isSafeInteger(ledger.checkpoint.inputAcceptedThrough) && ledger.checkpoint.inputAcceptedThrough >= 0
  && Number.isSafeInteger(ledger.checkpoint.outputCommittedThrough) && ledger.checkpoint.outputCommittedThrough >= 0
  && ledger.checkpoint.inputAcceptedThrough === ledger.nextInputSeq - 1
  && ledger.checkpoint.outputCommittedThrough === ledger.committedOutputSeq
  && ledger.appliedOutputSeq === ledger.committedOutputSeq
  && !ledger.input && Array.isArray(ledger.inbox) && !ledger.inbox.length;

function recoveryFailure(message) {
  return failure(`${message}; the retained process was not replaced. Use Stop to clean it up explicitly`);
}

// ChildProcess-compatible facade for the long-lived native CLI owner. Input,
// output and the explicit quiescent checkpoint are durable, so a replacement
// controller can adopt the exact process only after the adapter has proved that
// no logical request is in flight. Ambiguous input/output is never replayed.
export class ReconnectableAgentProcess extends EventEmitter {
  constructor(context, spec, lifetime = defaultLifetime, { recoverOnly = false } = {}) {
    super();
    if (!safeId(lifetime)) throw failure("controller lifetime is invalid");
    this.controllerLifetime = lifetime;
    this.recoverOnly = recoverOnly === true;
    this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.exitCode = null; this.signalCode = null; this.killed = false; this.detached = true;
    this.outputSeq = 0; this.inputSeq = 0; this.outputQueue = Promise.resolve(); this.inputQueue = Promise.resolve(); this.storageQueue = Promise.resolve();
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => { const operation = this.#write(Buffer.from(chunk)); this.inputQueue = operation.catch(() => {}); operation.then(() => done(), done); },
      final: done => { const operation = this.#endInput(); this.inputQueue = operation.catch(() => {}); operation.then(() => done(), done); },
    });
    this.stdin.on("error", () => {});
    this.ready = Promise.resolve(context).then(value => { this.context = value; return this.#start(spec); });
    this.lastHeartbeatAt = new Date().toISOString();
    this.ready.catch(error => this.#startFailed(error));
  }
  #storage(decide) {
    const operation = this.storageQueue.then(async () => {
      const snapshot = await this.context.records.workerTransportGet(this.storageRequest);
      return this.context.records.workerTransportTransaction({ ...this.storageRequest, expectedRevision: snapshot.revision }, decide);
    });
    this.storageQueue = operation.catch(() => {}); return operation;
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
    if (!this.context?.claim?.attemptId || !this.context?.claim?.controllerId || !Number.isInteger(this.context?.claim?.controllerEpoch)
      || typeof this.context.records?.workerTransportGet !== "function" || typeof this.context.records?.workerTransportTransaction !== "function") {
      throw failure("durable attempt context is invalid");
    }
    this.storageRequest = { attemptId: this.context.claim.attemptId, processId, controllerId: this.context.claim.controllerId, controllerEpoch: this.context.claim.controllerEpoch };
    this.client = await this.#connection();
    const saved = (await this.context.records.workerTransportGet(this.storageRequest)).value;
    if (!saved) {
      if (this.recoverOnly) {
        this.client.disconnect();
        throw recoveryFailure("the durable native checkpoint is missing");
      }
      await this.#storage(({ value }) => {
        if (value) throw failure("another controller initialized the native transport");
        return { schema: 1, lifetime: this.controllerLifetime, state: "launching", receipt: null, nextInputSeq: 1, input: null,
          committedOutputSeq: 0, appliedOutputSeq: 0, inbox: [], checkpoint: null };
      });
      this.receipt = await this.client.launch(processId, spec);
      if (this.receipt?.processId !== processId || !Number.isInteger(this.receipt.pid)) throw failure("worker returned an invalid process receipt");
      this.context.retain?.(this.receipt); this.pid = this.receipt.pid;
      await this.#storage(({ value }) => ({ ...value, receipt: this.receipt, state: "running" }));
      await this.client.attach(this.receipt, 0);
    } else {
      this.receipt = saved.receipt; this.context.retain?.(this.receipt);
      if (saved.lifetime === this.controllerLifetime && saved.detachedForRecovery !== true) {
        throw recoveryFailure("a second facade in the same controller lifetime was refused");
      }
      if (saved.schema !== 1 || saved.state !== "running" || !validReceipt(saved.receipt)
        || !Number.isSafeInteger(saved.nextInputSeq) || saved.nextInputSeq < 1 || !Number.isSafeInteger(saved.committedOutputSeq) || saved.committedOutputSeq < 0
        || !validCheckpoint(saved)) throw recoveryFailure("the durable native ledger is not at a quiescent recovery boundary");
      const observed = await this.client.inspect(processId);
      if (observed.state !== "running" || !sameReceipt(saved.receipt, observed)) throw recoveryFailure("the worker process no longer matches the exact durable identity");
      if (observed.inputAcceptedThrough !== saved.checkpoint.inputAcceptedThrough
        || observed.outputProducedThrough !== saved.checkpoint.outputCommittedThrough
        || observed.outputCommittedThrough > saved.checkpoint.outputCommittedThrough) {
        throw recoveryFailure("the worker cursors changed after the quiescent checkpoint");
      }
      const attached = await this.client.attach(this.receipt, saved.committedOutputSeq);
      if (!sameReceipt(attached, this.receipt) || attached.state !== "running" || attached.inputAcceptedThrough !== saved.checkpoint.inputAcceptedThrough
        || attached.outputProducedThrough !== saved.checkpoint.outputCommittedThrough) throw recoveryFailure("the attached worker process changed during recovery");
      await this.#storage(({ value }) => {
        if (value.lifetime !== saved.lifetime || !validCheckpoint(value) || !sameReceipt(value.receipt, saved.receipt)
          || JSON.stringify(value.checkpoint) !== JSON.stringify(saved.checkpoint)) throw failure("durable native ledger changed during recovery");
        return { ...value, lifetime: this.controllerLifetime, detachedForRecovery: false };
      });
      this.recovered = true; this.recovery = saved.checkpoint.metadata || null;
      this.inputSeq = saved.checkpoint.inputAcceptedThrough; this.outputSeq = saved.checkpoint.outputCommittedThrough; this.pid = this.receipt.pid;
    }
    this.detached = false; this.#renew(); return this;
  }
  #startFailed(error) {
    if (this.startError || this.receipt && this.recovered) return;
    this.startError = error; this.stdout.end(); this.stderr.end();
    if (!this.stdin.destroyed) this.stdin.destroy();
    queueMicrotask(() => { this.emit("error", error); this.emit("close", null, null); this.resolveClosed(); });
  }
  #renew() {
    clearInterval(this.renewal);
    this.renewal = setInterval(() => {
      if (!this.detached && !this.stopping && !this.renewing) {
        const client = this.client;
        this.renewing = Promise.resolve().then(() => this.context.renewLease(client.authorityLeaseId)).then(() => client.status()).then(result => { this.lastHeartbeatAt = new Date().toISOString(); return result; })
          .catch(() => client.disconnect()).finally(() => { this.renewing = null; });
      }
    }, 1000);
    this.renewal.unref();
  }
  async reconnect() {
    await this.ready;
    if (this.relinquished) throw failure("process ownership was transferred to a replacement facade");
    if (!this.detached) return this;
    if (this.stopping || this.commandExited || this.inputUncertain || this.outputFailed) throw failure("process is not at a safe reconnect boundary");
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      await this.inputQueue; await this.outputQueue; await this.storageQueue;
      const ledger = (await this.context.records.workerTransportGet(this.storageRequest)).value;
      const client = await this.#connection();
      try {
        const observed = await client.inspect(processId);
        if (observed.state !== "running" || !sameReceipt(observed, this.receipt)
          || observed.inputAcceptedThrough !== ledger.nextInputSeq - 1 || observed.outputCommittedThrough > ledger.committedOutputSeq
          || observed.outputProducedThrough < ledger.committedOutputSeq || ledger.input || ledger.inbox?.length
          || ledger.committedOutputSeq !== ledger.appliedOutputSeq) throw failure("worker process no longer matches the exact retained cursors");
        const attached = await client.attach(this.receipt, ledger.committedOutputSeq);
        if (!sameReceipt(attached, this.receipt) || attached.state !== "running" || attached.inputAcceptedThrough !== ledger.nextInputSeq - 1) throw failure("worker process changed during reconnect");
        this.inputSeq = ledger.nextInputSeq - 1; this.outputSeq = ledger.committedOutputSeq;
        this.client = client; this.detached = false; this.#renew(); return this;
      } catch (error) { client.disconnect(); throw error; }
    })();
    try { return await this.reconnecting; } finally { this.reconnecting = null; }
  }
  async #attached() {
    await this.ready;
    if (this.relinquished) throw failure("process ownership was transferred to a replacement facade");
    if (this.inputUncertain) throw failure("previous input outcome is unknown; it was not replayed");
    if (this.stopping || this.commandExited) throw failure("process input is closed");
    if (this.detached) await this.reconnect();
    return this.client;
  }
  async #write(data) {
    const client = await this.#attached();
    const chunks = Math.ceil(data.length / MAX_INPUT_BYTES);
    await this.#storage(({ value }) => {
      if (value.input) throw failure("previous input outcome is unknown; it was not replayed");
      return { ...value, checkpoint: null, input: { digest: digest(data), data: data.toString("base64"), chunks, sent: 0, unknown: false } };
    });
    try {
      for (let offset = 0; offset < data.length; offset += MAX_INPUT_BYTES) {
        const reserved = (await this.#storage(({ value }) => ({ ...value, nextInputSeq: value.nextInputSeq + 1,
          input: { ...value.input, seq: value.nextInputSeq, sent: value.input.sent + 1 } }))).value;
        await client.writeInput(reserved.input.seq, data.subarray(offset, offset + MAX_INPUT_BYTES));
        this.inputSeq = reserved.input.seq;
      }
      await this.#storage(({ value }) => ({ ...value, input: null }));
    } catch (error) {
      this.inputUncertain = true;
      await this.#storage(({ value }) => ({ ...value, checkpoint: null, input: value.input ? { ...value.input, unknown: true } : value.input })).catch(() => {});
      throw failure(`input outcome is unknown (${error?.code || "transport"}); it was not replayed`);
    }
  }
  async #endInput() {
    const client = await this.#attached();
    await this.#storage(({ value }) => {
      if (value.input) throw failure("previous input outcome is unknown; it was not replayed");
      return { ...value, checkpoint: null, input: { digest: digest("end-input"), data: null, chunks: 1, sent: 0, unknown: false, ending: true } };
    });
    try {
      const reserved = (await this.#storage(({ value }) => ({ ...value, nextInputSeq: value.nextInputSeq + 1,
        input: { ...value.input, seq: value.nextInputSeq, sent: 1 } }))).value;
      await client.endInput(reserved.input.seq); this.inputSeq = reserved.input.seq; this.inputEnded = true;
      await this.#storage(({ value }) => ({ ...value, input: null }));
    } catch (error) {
      this.inputUncertain = true;
      await this.#storage(({ value }) => ({ ...value, checkpoint: null, input: value.input ? { ...value.input, unknown: true } : value.input })).catch(() => {});
      throw failure(`stdin close outcome is unknown (${error?.code || "transport"}); it was not replayed`);
    }
  }
  async #output(frame, client) {
    const raw = frame.data.toString("base64");
    const stored = await this.#storage(({ value }) => {
      if (frame.seq !== value.committedOutputSeq + 1) throw failure("unexpected output sequence");
      const inbox = [...value.inbox, { seq: frame.seq, channel: frame.channel, data: raw }];
      if (Buffer.byteLength(JSON.stringify(inbox)) > privateLimit) throw failure("private output retention bound reached");
      return { ...value, checkpoint: null, committedOutputSeq: frame.seq, inbox };
    });
    if (frame.channel === "stdout" || frame.channel === "stderr") {
      const stream = this[frame.channel];
      if (!stream.write(frame.data)) await new Promise(resolve => stream.once("drain", resolve));
    } else if (frame.channel === "exit") {
      let exit; try { exit = JSON.parse(frame.data.toString()); } catch { throw failure("invalid exit record"); }
      if (exit?.code !== null && !Number.isInteger(exit?.code) || exit?.signal !== null && typeof exit?.signal !== "string") throw failure("invalid exit record");
      this.exitCode = exit.code; this.signalCode = exit.signal; this.commandExited = true;
    } else throw failure("invalid output channel");
    this.outputSeq = frame.seq;
    await this.#storage(({ value }) => ({ ...value, appliedOutputSeq: frame.seq, inbox: value.inbox.filter(item => item.seq > frame.seq) }));
    try { await client.ackOutput(stored.value.committedOutputSeq); }
    catch {
      // The durable inbox is already applied. Losing only the supervisor ACK
      // is a transport-detach case: a later attach starts strictly after the
      // committed cursor, so the frame is neither replayed nor lost.
      if (!this.stopping && this.client === client) client.disconnect();
    }
    if (frame.channel === "exit") {
      clearInterval(this.renewal); this.stdout.end(); this.stderr.end();
      this.emit("exit", this.exitCode, this.signalCode); this.emit("close", this.exitCode, this.signalCode); this.resolveClosed();
    }
  }
  async markRecoverable(metadata = {}) {
    await this.ready; await this.inputQueue; await this.outputQueue; await this.storageQueue;
    if (this.detached || this.stopping || this.commandExited || this.inputUncertain || this.outputFailed) throw failure("process is not at a quiescent checkpoint boundary");
    const observed = await this.client.status();
    const row = await this.#storage(({ value }) => {
      if (value.state !== "running" || value.input || value.inbox?.length || value.committedOutputSeq !== value.appliedOutputSeq
        || observed.state !== "running" || !sameReceipt(observed, value.receipt)
        || observed.inputAcceptedThrough !== value.nextInputSeq - 1 || observed.outputProducedThrough !== value.committedOutputSeq
        || observed.outputCommittedThrough > value.committedOutputSeq) throw failure("process changed while creating the quiescent checkpoint");
      return { ...value, checkpoint: { inputAcceptedThrough: observed.inputAcceptedThrough,
        outputCommittedThrough: value.committedOutputSeq, metadata: structuredClone(metadata) } };
    });
    return structuredClone(row.value.checkpoint);
  }
  async relinquish() {
    await this.ready; await this.inputQueue; await this.outputQueue; await this.storageQueue;
    if (this.detached || this.stopping || this.commandExited || this.inputUncertain || this.outputFailed) {
      throw failure("process is not at a quiescent transfer boundary");
    }
    await this.#storage(({ value }) => {
      if (value.lifetime !== this.controllerLifetime || !validCheckpoint(value)) {
        throw failure("the durable native checkpoint changed before transfer");
      }
      return { ...value, detachedForRecovery: true };
    });
    this.relinquished = true;
    this.client.disconnect();
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
        const ledger = (await this.context.records.workerTransportGet(this.storageRequest)).value;
        const observed = await client.inspect(processId);
        if (!sameReceipt(observed, this.receipt)) throw failure("cleanup process identity changed");
        await client.attach(this.receipt, ledger.committedOutputSeq); this.detached = false;
      }
      const result = await this.client.terminate();
      if (result.groupCleanup !== "confirmed") throw failure("worker process cleanup is unconfirmed");
      let timer;
      try { await Promise.race([this.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(failure("final output could not be retained")), 4000); timer.unref(); })]); }
      finally { clearTimeout(timer); }
      await this.outputQueue;
      await this.#storage(({ value }) => ({ ...value, state: "closed", checkpoint: null, input: null }));
      this.client.disconnect(); await this.context.dispose({ receipt: this.receipt });
      this.processReleased = true;
    })();
    try { return await this.termination; }
    catch (error) { this.termination = null; throw error; }
  }
}
