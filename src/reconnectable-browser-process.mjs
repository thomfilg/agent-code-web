import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { WorkerProcessTransport } from "./worker-process-transport.mjs";
import { MAX_INPUT_BYTES } from "./worker-transport-wire.mjs";

const processId = "shared-chrome", controllerLifetime = randomUUID();
const hash = value => createHash("sha256").update(value).digest("hex");
const unavailable = message => new Error(`Browser reconnect: ${message}`);
function cleanupFailure(context) {
  const error = unavailable("startup cleanup is unconfirmed; retry Stop before opening another browser");
  Object.defineProperty(error, "retryBrowserCleanup", { value: () => context.dispose({ failed: true }) });
  return error;
}
const privateLimit = 2 * 1024 * 1024;
const readOnly = packet => packet.action === "status" || packet.action === "transportHeartbeat" || packet.action === "watch" && packet.params?.enabled === false;

// Explicitly injected local validation only. No environment flag, HTTP field,
// SSH fallback or marker boolean can admit this as production hibernation.
export function createLocalBrowserTransport({ openAttempt, watchLeaseMs = 3000 }) {
  if (typeof openAttempt !== "function" || !Number.isInteger(watchLeaseMs) || watchLeaseMs < 1000 || watchLeaseMs > 10000) throw unavailable("invalid coordinator");
  return {
    admission: "local-validation",
    async spawnBrowser(chat, command, args, options) {
      const context = await openAttempt(chat);
      if (context?.boundary !== "local-validation" || !context.identity || context.identity.ownerId !== chat.ownerId
        || context.identity.chatId !== chat.id || context.identity.provider !== chat.agent || context.identity.accountId !== chat.agentAccountId
        || !chat.agentAccountId || !["codex", "claude"].includes(chat.agent)
        || typeof context.issueLease !== "function" || typeof context.renewLease !== "function" || typeof context.dispose !== "function"
        || !context.claim?.attemptId || !context.claim?.controllerId || !Number.isInteger(context.claim?.controllerEpoch)
        || typeof context.socketPath !== "string"
        || typeof context.records?.workerTransportGet !== "function" || typeof context.records?.workerTransportTransaction !== "function") {
        // openAttempt may already own a private supervisor. Rejecting its
        // admission must not strand that resource outside the caller's entry.
        try { await context?.dispose?.({ failed: true }); }
        catch { throw cleanupFailure(context); }
        throw unavailable("an admitted named-account attempt and durable inbox are required");
      }
      const child = new ReconnectableBrowserProcess(context, watchLeaseMs);
      await child.start({ command, args, cwd: options.cwd, env: { ...options.env, RELAY_BROWSER_WATCH_LEASE_MS: String(watchLeaseMs) } });
      return child;
    },
  };
}

// This is deliberately a BrowserProcess-specific facade, not a general fake
// ChildProcess. Remote PIDs exist ONLY in receipts; no local kill(pid) fallback.
export class ReconnectableBrowserProcess extends EventEmitter {
  constructor(context, watchLeaseMs) {
    super(); this.context = context; this.watchLeaseMs = watchLeaseMs;
    this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.stdin = new EventEmitter();
    this.exitCode = null; this.signalCode = null; this.detached = true; this.epoch = 0;
    this.outputQueue = Promise.resolve(); this.inputQueue = Promise.resolve(); this.storageQueue = Promise.resolve();
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.storageRequest = { attemptId: context.claim.attemptId, processId, controllerId: context.claim.controllerId, controllerEpoch: context.claim.controllerEpoch };
  }
  update(decide) {
    const operation = this.storageQueue.then(async () => {
      const snapshot = await this.context.records.workerTransportGet(this.storageRequest);
      return this.context.records.workerTransportTransaction({ ...this.storageRequest, expectedRevision: snapshot.revision }, decide);
    });
    this.storageQueue = operation.catch(() => {}); return operation;
  }
  check(epoch, stopping = false) {
    if (epoch !== this.epoch || this.stopping && !stopping) throw unavailable("operation was superseded by Stop");
  }
  async connection(epoch, stopping = false) {
    const lease = await this.context.issueLease(); this.check(epoch, stopping);
    if (typeof lease?.credential !== "string") throw unavailable("lease authority did not issue a credential");
    const client = await new WorkerProcessTransport({ socketPath: this.context.socketPath, expectedIdentity: this.context.identity, lease: lease.credential }).connect();
    client.authorityLeaseId = lease.id;
    try { this.check(epoch, stopping); } catch (error) { client.disconnect(); throw error; }
    client.on("disconnect", () => {
      if (this.client !== client) return;
      this.detached = true; clearInterval(this.renewal);
      if (!this.stopping) this.emit("transportDetached");
    });
    client.on("output", frame => {
      this.outputQueue = this.outputQueue.then(() => this.output(frame, client)).catch(() => {
        this.storageFailed = true; client.disconnect();
        this.emit("transportFault", { message: "Private browser output could not be retained; reconnect is blocked. Stop the browser explicitly." });
      });
    });
    return client;
  }
  async start(spec) {
    const epoch = ++this.epoch;
    try {
      this.client = await this.connection(epoch);
      await this.update(({ value }) => {
        if (value) throw unavailable("controller/browser reconstruction is not supported by this local slice");
        return { lifetime: controllerLifetime, state: "launching", receipt: null, nextInputSeq: 1, input: null, committedOutputSeq: 0, appliedOutputSeq: 0, inbox: [] };
      });
      this.receipt = await this.client.launch(processId, spec);
      await this.update(({ value }) => ({ ...value, receipt: this.receipt, state: "running" }));
      await this.client.attach(this.receipt, 0); this.detached = false; this.renew();
    } catch (error) {
      // The coordinator owns this exact attempt, including failed/late launch
      // cleanup. Never fall back to killing a number in the controller PID space.
      this.client?.disconnect();
      try { await this.context.dispose({ failed: true }); }
      catch { throw cleanupFailure(this.context); }
      throw error;
    }
  }
  renew() {
    clearInterval(this.renewal);
    this.renewal = setInterval(() => {
      if (!this.detached && !this.stopping && !this.renewing) {
        const client = this.client;
        this.renewing = Promise.resolve().then(() => this.context.renewLease?.(client.authorityLeaseId)).then(() => client.status())
          .catch(() => client.disconnect()).finally(() => { this.renewing = null; });
      }
    }, 1000);
    this.renewal.unref();
  }
  detach() { this.client?.disconnect(); }
  async reconnect() {
    if (this.reconnecting) return this.reconnecting;
    if (this.storageFailed) throw unavailable("private inbox persistence failed; explicit Stop is required");
    const epoch = ++this.epoch;
    this.reconnecting = (async () => {
      this.check(epoch); this.client?.disconnect(); await this.outputQueue; await this.inputQueue;
      this.check(epoch);
      if (this.storageFailed) throw unavailable("private inbox persistence failed; explicit Stop is required");
      const client = await this.connection(epoch);
      try {
        this.check(epoch); this.client = client;
        if (this.storageFailed) throw unavailable("private inbox persistence failed; explicit Stop is required");
        const ledger = (await this.context.records.workerTransportGet(this.storageRequest)).value;
        if (!ledger || ledger.lifetime !== controllerLifetime) throw unavailable("controller restart recovery is not implemented");
        if (this.storageFailed) throw unavailable("private inbox persistence failed; explicit Stop is required");
        const receipt = await client.attach(this.receipt, ledger.committedOutputSeq); this.check(epoch);
        await this.update(({ value }) => {
          if (receipt.inputAcceptedThrough >= value.nextInputSeq) throw unavailable("unexpected remote input identity");
          // Only read-only heartbeat/status operations may reconcile a lost
          // acknowledgement. A mutating command is never replayed or inferred.
          if (value.input?.unknown && !value.input.mutating && value.input.chunks === 1) return { ...value, nextInputSeq: receipt.inputAcceptedThrough + 1, input: null };
          return value;
        });
        this.detached = false; this.renew();
      } catch (error) { client.disconnect(); throw error; }
    })();
    try { return await this.reconnecting; } finally { this.reconnecting = null; }
  }
  sendCommand(packet) {
    const operation = this.inputQueue.then(() => this.input(packet));
    this.inputQueue = operation.catch(() => {}); return operation;
  }
  async input(packet) {
    if (this.detached || this.stopping) throw unavailable("connection is detached; no action was sent");
    const epoch = this.epoch;
    const data = Buffer.from(JSON.stringify(packet) + "\n");
    if (data.length > 128 * 1024) throw unavailable("command exceeds the private input bound");
    const chunks = Math.ceil(data.length / MAX_INPUT_BYTES), digest = hash(data);
    await this.update(({ value }) => {
      if (value.input) throw unavailable("a previous action has unknown outcome; use Stop instead of replaying it");
      return { ...value, input: { commandId: packet.id, digest, data: data.toString("base64"), mutating: !readOnly(packet), chunks, sent: 0, unknown: false } };
    });
    try {
      for (let offset = 0; offset < data.length; offset += MAX_INPUT_BYTES) {
        this.check(epoch);
        if (this.detached || this.stopping) throw unavailable("connection changed during input; action was not replayed");
        const reserved = (await this.update(({ value }) => ({ ...value, nextInputSeq: value.nextInputSeq + 1,
          input: { ...value.input, seq: value.nextInputSeq, sent: value.input.sent + 1 } }))).value;
        this.check(epoch);
        await this.client.writeInput(reserved.input.seq, data.subarray(offset, offset + MAX_INPUT_BYTES));
      }
      await this.update(({ value }) => ({ ...value, input: null }));
    } catch (error) {
      await this.update(({ value }) => ({ ...value, input: { ...value.input, unknown: true } })).catch(() => { this.storageFailed = true; });
      throw unavailable("action outcome may be unknown; it was not replayed. Stop is available.");
    }
  }
  async output(frame, client) {
    const raw = frame.data.toString("base64");
    const stored = await this.update(({ value }) => {
      if (frame.seq !== value.committedOutputSeq + 1) throw unavailable("unexpected output sequence");
      const inbox = [...value.inbox, { seq: frame.seq, channel: frame.channel, data: raw }];
      if (Buffer.byteLength(JSON.stringify(inbox)) > privateLimit) throw unavailable("private output retention bound reached");
      return { ...value, committedOutputSeq: frame.seq, inbox };
    });
    if (frame.channel === "stdout" || frame.channel === "stderr") {
      const stream = this[frame.channel];
      if (!stream.write(frame.data)) await new Promise(resolve => stream.once("drain", resolve));
    }
    await this.update(({ value }) => ({ ...value, appliedOutputSeq: frame.seq, inbox: value.inbox.filter(item => item.seq > frame.seq) }));
    // The stable BrowserProcess/readline instance survives link detach. This
    // compaction is NOT enough to reconstruct it after controller restart.
    await client.ackOutput(stored.value.committedOutputSeq).catch(() => {});
    if (frame.channel === "exit") {
      const exit = JSON.parse(frame.data.toString()); this.exitCode = exit.code; this.signalCode = exit.signal;
      this.stdout.end(); this.stderr.end(); clearInterval(this.renewal); this.resolveClosed(); this.emit("exit", exit.code, exit.signal);
    }
  }
  async terminateRemote() {
    if (this.terminating) return this.terminating;
    this.stopping = true; ++this.epoch; clearInterval(this.renewal);
    this.terminating = (async () => {
      if (this.processClosed) { await this.context.dispose({ failed: false }); return; }
      await this.reconnecting?.catch(() => {}); await this.outputQueue;
      const epoch = this.epoch;
      if (this.detached || this.client.closed) {
        const client = await this.connection(epoch, true); this.client = client;
        const ledger = (await this.context.records.workerTransportGet(this.storageRequest)).value;
        await client.attach(this.receipt, ledger.committedOutputSeq); this.detached = false;
      }
      const result = await this.client.terminate();
      if (result.groupCleanup !== "confirmed") throw unavailable("worker process cleanup is unconfirmed");
      await this.inputQueue;
      let timeout;
      try { await Promise.race([this.closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(unavailable("final output could not be retained")), 4000); timeout.unref(); })]); }
      finally { clearTimeout(timeout); }
      await this.outputQueue;
      await this.update(({ value }) => ({ ...value, state: "closed", input: null }));
      this.processClosed = true;
      this.client.disconnect(); await this.context.dispose({ failed: false });
    })();
    try { return await this.terminating; }
    catch (error) { this.terminating = null; throw error; }
  }
}
