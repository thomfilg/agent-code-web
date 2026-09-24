import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { WorkerProcessTransport } from "./worker-process-transport.mjs";
import { MAX_INPUT_BYTES, PROTOCOL, safeId } from "./worker-transport-wire.mjs";

const processId = "shared-chrome", controllerLifetime = randomUUID();
const hash = value => createHash("sha256").update(value).digest("hex");
const unavailable = message => new Error(`Browser reconnect: ${message}`);
const processNotFound = error => error?.code === "PROCESS_NOT_FOUND";
const sameReceipt = (left, right) => Boolean(left && right)
  && ["protocol", "supervisorInstanceId", "processId", "processInstanceId", "pid", "startedAt"].every(key => left[key] === right[key])
  && JSON.stringify(left.groupAnchor) === JSON.stringify(right.groupAnchor);
const validReceipt = receipt => receipt?.protocol === PROTOCOL && receipt.processId === processId
  && safeId(receipt.supervisorInstanceId) && safeId(receipt.processInstanceId)
  && Number.isSafeInteger(receipt.pid) && receipt.pid > 1
  && typeof receipt.startedAt === "string" && Number.isFinite(Date.parse(receipt.startedAt))
  && Number.isSafeInteger(receipt.groupAnchor?.pid) && receipt.groupAnchor.pid > 1
  && typeof receipt.groupAnchor?.start === "string" && /^[0-9]+$/.test(receipt.groupAnchor.start);
const acceptedMatchesLedger = (ledger, accepted) => {
  if (!Number.isSafeInteger(accepted) || accepted < 0) return false;
  if (!ledger.input) return accepted === ledger.nextInputSeq - 1;
  if (ledger.input.mutating || ledger.input.chunks !== 1 || !Number.isInteger(ledger.input.sent) || ledger.input.sent < 0 || ledger.input.sent > 1) return false;
  return accepted <= ledger.nextInputSeq - 1 && accepted >= Math.max(0, ledger.nextInputSeq - 2);
};
function cleanupFailure(context, retry = () => context.dispose({ failed: true })) {
  const error = unavailable("startup cleanup is unconfirmed; retry Stop before opening another browser");
  Object.defineProperty(error, "retryBrowserCleanup", { value: retry });
  return error;
}
function recoveryFailure(context, message, retry = () => context.dispose({ failed: true })) {
  const error = unavailable(`${message}; the retained process was not replaced. Use Stop to clean it up explicitly`);
  Object.defineProperty(error, "retryBrowserCleanup", { value: retry });
  return error;
}
const privateInboxLimit = 8192;
const readOnly = packet => packet.action === "status" || packet.action === "transportHeartbeat" || packet.action === "watch" && packet.params?.enabled === false;

// Explicitly injected local validation only. No environment flag, HTTP field,
// SSH fallback or marker boolean can admit this as production hibernation.
export function createLocalBrowserTransport({ openAttempt, watchLeaseMs = 3000, controllerLifetimeId = controllerLifetime }) {
  if (typeof openAttempt !== "function" || !Number.isInteger(watchLeaseMs) || watchLeaseMs < 1000 || watchLeaseMs > 10000
    || !safeId(controllerLifetimeId)) throw unavailable("invalid coordinator");
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
      const child = new ReconnectableBrowserProcess(context, watchLeaseMs, controllerLifetimeId);
      await child.start({ command, args, cwd: options.cwd, env: { ...options.env, RELAY_BROWSER_WATCH_LEASE_MS: String(watchLeaseMs) } });
      return child;
    },
  };
}

// This is deliberately a BrowserProcess-specific facade, not a general fake
// ChildProcess. Remote PIDs exist ONLY in receipts; no local kill(pid) fallback.
export class ReconnectableBrowserProcess extends EventEmitter {
  constructor(context, watchLeaseMs, lifetime = controllerLifetime) {
    super(); this.context = context; this.watchLeaseMs = watchLeaseMs;
    this.controllerLifetime = lifetime;
    this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.stdin = new EventEmitter(); this.pendingOutput = [];
    this.exitCode = null; this.signalCode = null; this.detached = true; this.epoch = 0;
    this.outputQueue = Promise.resolve(); this.inputQueue = Promise.resolve(); this.storageQueue = Promise.resolve();
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.storageRequest = { attemptId: context.claim.attemptId, processId, controllerId: context.claim.controllerId, controllerEpoch: context.claim.controllerEpoch };
  }
  update(decide) {
    // Every browser message crosses this ledger, so the revision of the last
    // write is reused instead of re-reading the row first. The transaction is
    // still compare-and-swap: a stale revision fails and falls back to a read.
    const operation = this.storageQueue.then(async () => {
      const records = this.context.records;
      if (Number.isSafeInteger(this.revision)) {
        try {
          const stored = await records.workerTransportTransaction({ ...this.storageRequest, expectedRevision: this.revision }, decide);
          this.revision = stored.revision; return stored;
        } catch (error) { this.revision = null; if (error?.code !== "CAS_CONFLICT") throw error; }
      }
      const snapshot = await records.workerTransportGet(this.storageRequest);
      const stored = await records.workerTransportTransaction({ ...this.storageRequest, expectedRevision: snapshot.revision }, decide);
      this.revision = stored.revision; return stored;
    });
    this.storageQueue = operation.catch(() => {}); return operation;
  }
  check(epoch, stopping = false) {
    if (epoch !== this.epoch || this.stopping && !stopping) throw unavailable("operation was superseded by Stop");
  }
  async connection(epoch, stopping = false) {
    const lease = await this.context.issueLease(); this.check(epoch, stopping);
    if (typeof lease?.credential !== "string") throw unavailable("lease authority did not issue a credential");
    const client = this.context.connectTransport
      ? await this.context.connectTransport(lease.credential)
      : await new WorkerProcessTransport({ socketPath: this.context.socketPath, expectedIdentity: this.context.identity, lease: lease.credential }).connect();
    if (!client || typeof client.launch !== "function" || typeof client.attach !== "function") throw unavailable("worker transport is invalid");
    client.authorityLeaseId = lease.id;
    try { this.check(epoch, stopping); } catch (error) { client.disconnect(); throw error; }
    client.on("disconnect", () => {
      if (this.client !== client) return;
      this.detached = true; clearInterval(this.renewal);
      if (!this.stopping) this.emit("transportDetached");
    });
    client.on("output", frame => {
      this.pendingOutput.push({ frame, client });
      this.outputQueue = this.outputQueue.then(() => this.drainOutput()).catch(() => {
        this.storageFailed = true; client.disconnect();
        this.emit("transportFault", { message: "Private browser output could not be retained; reconnect is blocked. Stop the browser explicitly." });
      });
    });
    return client;
  }
  async start(spec) {
    const epoch = ++this.epoch;
    let recovering = false;
    try {
      this.client = await this.connection(epoch);
      const saved = (await this.context.records.workerTransportGet(this.storageRequest)).value;
      const closed = saved?.schema === 2 && saved.state === "closed" && saved.receipt?.processId === processId
        && !saved.input && Array.isArray(saved.rpcs) && !saved.rpcs.length
        && Number.isSafeInteger(saved.committedOutputSeq) && saved.committedOutputSeq >= 0
        && saved.appliedOutputSeq === saved.committedOutputSeq && Array.isArray(saved.inbox) && !saved.inbox.length;
      if (!saved || closed) {
        await this.update(({ value }) => {
          if (saved ? JSON.stringify(value) !== JSON.stringify(saved) : value) throw unavailable("another controller initialized the browser transport");
          return { schema: 2, lifetime: this.controllerLifetime, state: "launching", receipt: null, nextInputSeq: 1, input: null, rpcs: [], committedOutputSeq: 0, appliedOutputSeq: 0, inbox: [] };
        });
        this.receipt = await this.client.launch(processId, spec);
        this.context.retain?.(this.receipt);
        await this.update(({ value }) => ({ ...value, receipt: this.receipt, state: "running" }));
        await this.client.attach(this.receipt, 0);
      } else {
        recovering = true;
        if (saved?.receipt) { this.receipt = saved.receipt; this.context.retain?.(this.receipt); }
        const retry = () => this.receipt ? this.terminateRemote() : this.context.dispose({ failed: true });
        if (saved.lifetime === this.controllerLifetime) throw recoveryFailure(this.context, "a second facade in the same controller lifetime was refused", retry);
        if (saved.schema !== 2 || saved.state !== "running" || !validReceipt(saved.receipt)
          || !Number.isSafeInteger(saved.nextInputSeq) || saved.nextInputSeq < 1 || !Array.isArray(saved.rpcs)
          || saved.rpcs.some(rpc => rpc?.mutating !== false)
          || saved.input && (saved.input.mutating || saved.input.chunks !== 1)
          || !Number.isSafeInteger(saved.committedOutputSeq) || saved.committedOutputSeq < 0
          || saved.appliedOutputSeq !== saved.committedOutputSeq || !Array.isArray(saved.inbox) || saved.inbox.length) {
          throw recoveryFailure(this.context, "the durable browser ledger is not at a quiescent recovery boundary", retry);
        }
        const observed = await this.client.inspect(processId);
        if (observed.state !== "running" || !sameReceipt(saved.receipt, observed)) throw recoveryFailure(this.context, "the worker process no longer matches the exact durable identity", retry);
        if (!acceptedMatchesLedger(saved, observed.inputAcceptedThrough)) throw recoveryFailure(this.context, "the worker input cursor does not match the durable ledger", retry);
        if (observed.outputCommittedThrough > saved.committedOutputSeq || observed.outputProducedThrough < saved.committedOutputSeq) {
          throw recoveryFailure(this.context, "the worker output cursor does not match the durable ledger", retry);
        }
        const attached = await this.client.attach(this.receipt, saved.committedOutputSeq);
        if (!sameReceipt(this.receipt, attached) || attached.state !== "running"
          || attached.inputAcceptedThrough !== observed.inputAcceptedThrough) throw recoveryFailure(this.context, "the attached worker process changed during recovery", retry);
        await this.update(({ value }) => {
          if (value.lifetime !== saved.lifetime || value.state !== "running"
            || JSON.stringify(value.input) !== JSON.stringify(saved.input) || JSON.stringify(value.rpcs) !== JSON.stringify(saved.rpcs)
            || value.committedOutputSeq !== value.appliedOutputSeq || value.inbox?.length || !sameReceipt(value.receipt, saved.receipt)) {
            throw unavailable("durable browser ledger changed during recovery");
          }
          return { ...value, lifetime: this.controllerLifetime, nextInputSeq: attached.inputAcceptedThrough + 1, input: null, rpcs: [] };
        });
        this.recovered = true;
      }
      this.detached = false; this.renew();
    } catch (error) {
      // The coordinator owns this exact attempt, including failed/late launch
      // cleanup. Never fall back to killing a number in the controller PID space.
      this.client?.disconnect();
      if (recovering && typeof error.retryBrowserCleanup === "function") throw error;
      if (recovering) throw recoveryFailure(this.context, error?.message || "controller recovery failed", () => this.receipt ? this.terminateRemote() : this.context.dispose({ failed: true }));
      try { await this.context.dispose({ failed: true }); }
      catch { throw cleanupFailure(this.context, () => this.receipt ? this.terminateRemote() : this.context.dispose({ failed: true })); }
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
        if (!ledger || ledger.lifetime !== this.controllerLifetime) throw unavailable("controller ownership changed");
        if (this.storageFailed) throw unavailable("private inbox persistence failed; explicit Stop is required");
        const receipt = await client.attach(this.receipt, ledger.committedOutputSeq); this.check(epoch);
        await this.update(({ value }) => {
          if (receipt.inputAcceptedThrough >= value.nextInputSeq) throw unavailable("unexpected remote input identity");
          // Only read-only heartbeat/status operations may reconcile a lost
          // acknowledgement. A mutating command is never replayed or inferred.
          if (value.rpcs?.some(rpc => rpc.mutating)) throw unavailable("a previous mutating browser action has unknown outcome; use Stop instead of replaying it");
          if (value.input?.unknown && !value.input.mutating && value.input.chunks === 1) {
            return { ...value, nextInputSeq: receipt.inputAcceptedThrough + 1, input: null, rpcs: [] };
          }
          if (!value.input && value.rpcs?.length) return { ...value, rpcs: [] };
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
    // A single-chunk command (nearly every browser action) reserves its RPC and
    // its input sequence in one write: the same state the two-step path reaches
    // just before sending, without persisting the intermediate "sent: 0" step.
    const reserved = await this.update(({ value }) => {
      if (value.input) throw unavailable("a previous action has unknown outcome; use Stop instead of replaying it");
      const rpcs = Array.isArray(value.rpcs) ? value.rpcs : [];
      if (rpcs.length >= 100 || rpcs.some(rpc => rpc.commandId === packet.id)) throw unavailable("browser RPC ledger is full or duplicated");
      const rpc = { commandId: packet.id, digest, mutating: !readOnly(packet), state: "sending" };
      const input = { commandId: packet.id, digest, data: data.toString("base64"), mutating: rpc.mutating, chunks, sent: 0, unknown: false };
      if (chunks === 1) return { ...value, rpcs: [...rpcs, rpc], nextInputSeq: value.nextInputSeq + 1, input: { ...input, seq: value.nextInputSeq, sent: 1 } };
      return { ...value, rpcs: [...rpcs, rpc], input };
    });
    try {
      if (chunks === 1) {
        this.check(epoch);
        if (this.detached || this.stopping) throw unavailable("connection changed during input; action was not replayed");
        await this.client.writeInput(reserved.value.input.seq, data);
      } else for (let offset = 0; offset < data.length; offset += MAX_INPUT_BYTES) {
        this.check(epoch);
        if (this.detached || this.stopping) throw unavailable("connection changed during input; action was not replayed");
        const reserved = (await this.update(({ value }) => ({ ...value, nextInputSeq: value.nextInputSeq + 1,
          input: { ...value.input, seq: value.nextInputSeq, sent: value.input.sent + 1 } }))).value;
        this.check(epoch);
        await this.client.writeInput(reserved.input.seq, data.subarray(offset, offset + MAX_INPUT_BYTES));
      }
      await this.update(({ value }) => ({ ...value, input: null,
        rpcs: value.rpcs.map(rpc => rpc.commandId === packet.id ? { ...rpc, state: "accepted" } : rpc) }));
    } catch (error) {
      await this.update(({ value }) => ({ ...value, input: { ...value.input, unknown: true } })).catch(() => { this.storageFailed = true; });
      throw unavailable("action outcome may be unknown; it was not replayed. Stop is available.");
    }
  }
  async commandSettled(commandId) {
    try {
      await this.update(({ value }) => {
        if (!Array.isArray(value.rpcs) || !value.rpcs.some(rpc => rpc.commandId === commandId)) throw unavailable("browser RPC acknowledgement was not reserved");
        return { ...value, rpcs: value.rpcs.filter(rpc => rpc.commandId !== commandId) };
      });
    } catch (error) {
      this.storageFailed = true; this.client?.disconnect();
      this.emit("transportFault", { message: "Private browser RPC acknowledgement could not be retained; reconnect is blocked. Stop the browser explicitly." });
      throw error;
    }
  }
  // Chunks that arrived while the previous batch was being retained are
  // committed, delivered and applied together, one batch per client link.
  async drainOutput() {
    while (this.pendingOutput.length) {
      const client = this.pendingOutput[0].client, batch = [];
      while (this.pendingOutput[0]?.client === client && batch.length < 256) batch.push(this.pendingOutput.shift().frame);
      await this.output(batch, client);
    }
  }
  async output(frames, client) {
    // Commit before delivery, so a reattach never re-delivers a written chunk.
    // Payloads are not retained: recovery after a controller restart requires
    // an empty inbox, so only the sequence cursor is ever read back.
    const stored = await this.update(({ value }) => {
      let seq = value.committedOutputSeq;
      const inbox = [...value.inbox];
      for (const frame of frames) {
        if (frame.seq !== seq + 1) throw unavailable("unexpected output sequence");
        seq = frame.seq; inbox.push({ seq, channel: frame.channel, bytes: frame.data.length });
      }
      if (inbox.length > privateInboxLimit) throw unavailable("private output retention bound reached");
      return { ...value, committedOutputSeq: seq, inbox };
    });
    let exitFrame = null;
    for (const frame of frames) {
      if (frame.channel === "exit") { exitFrame = frame; continue; }
      if (frame.channel !== "stdout" && frame.channel !== "stderr") continue;
      const stream = this[frame.channel];
      if (!stream.write(frame.data)) await new Promise(resolve => stream.once("drain", resolve));
    }
    const last = frames.at(-1).seq;
    await this.update(({ value }) => ({ ...value, appliedOutputSeq: last, inbox: value.inbox.filter(item => item.seq > last) }));
    // The stable BrowserProcess/readline instance survives link detach. This
    // compaction is NOT enough to reconstruct it after controller restart.
    await client.ackOutput(stored.value.committedOutputSeq).catch(() => {});
    if (exitFrame) {
      const frame = exitFrame;
      const exit = JSON.parse(frame.data.toString()); this.exitCode = exit.code; this.signalCode = exit.signal;
      this.stdout.end(); this.stderr.end(); clearInterval(this.renewal); this.resolveClosed(); this.emit("exit", exit.code, exit.signal);
    }
  }
  async terminateRemote() {
    if (this.terminating) return this.terminating;
    this.stopping = true; ++this.epoch; clearInterval(this.renewal);
    this.terminating = (async () => {
      if (this.processClosed) { await this.context.dispose({ failed: false, receipt: this.receipt, processAbsent: true }); return; }
      await this.reconnecting?.catch(() => {}); await this.outputQueue;
      const epoch = this.epoch;
      let absent = false;
      if (this.detached || this.client.closed) {
        try {
          const client = await this.connection(epoch, true); this.client = client;
          const ledger = (await this.context.records.workerTransportGet(this.storageRequest)).value;
          await client.attach(this.receipt, ledger.committedOutputSeq); this.detached = false;
        } catch (error) {
          if (!processNotFound(error)) throw error;
          absent = true;
        }
      }
      let result;
      if (!absent) {
        try { result = await this.client.terminate(); }
        catch (error) {
          if (!processNotFound(error)) throw error;
          // The authenticated supervisor has authoritatively confirmed that
          // the exact retained process no longer exists. Treat that as
          // idempotent Stop success: keeping the facade/lease alive cannot make
          // it safer and prevents a replacement in this controller lifetime.
          absent = true;
        }
      }
      if (!absent && result.groupCleanup !== "confirmed") throw unavailable("worker process cleanup is unconfirmed");
      await this.inputQueue;
      if (!absent) {
        let timeout;
        try { await Promise.race([this.closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(unavailable("final output could not be retained")), 4000); timeout.unref(); })]); }
        finally { clearTimeout(timeout); }
      }
      await this.outputQueue;
      await this.update(({ value }) => ({ ...value, state: "closed", input: null, rpcs: [], inbox: [],
        appliedOutputSeq: value.committedOutputSeq }));
      this.processClosed = true;
      if (absent && this.exitCode === null && this.signalCode === null) {
        this.exitCode ??= 0; this.signalCode ??= null;
        this.stdout.end(); this.stderr.end(); this.resolveClosed(); this.emit("exit", this.exitCode, this.signalCode);
      }
      this.client.disconnect();
      await this.context.dispose({ failed: false, receipt: this.receipt, processAbsent: true });
    })();
    try { return await this.terminating; }
    catch (error) { this.terminating = null; throw error; }
  }
}
