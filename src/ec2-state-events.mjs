import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const instanceId = /^i-[a-f0-9]{8,17}$/;
const eventId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const states = new Set(["pending", "running", "stopping", "stopped", "shutting-down", "terminated"]);
const queueUrl = /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/[0-9]{12}\/[A-Za-z0-9_-]{1,80}$/;

export function parseEc2StateMessage(body, region) {
  if (typeof body !== "string" || body.length > 65536) throw new Error("EC2 state message exceeds size limit");
  const event = JSON.parse(body);
  const id = event?.detail?.["instance-id"], state = event?.detail?.state;
  if (event?.source !== "aws.ec2" || event?.["detail-type"] !== "EC2 Instance State-change Notification"
    || event.region !== region || !/^[0-9]{12}$/.test(event.account || "") || !eventId.test(event.id || "")
    || !instanceId.test(id || "") || !states.has(state)
    || !Array.isArray(event.resources) || event.resources.length !== 1
    || event.resources[0] !== `arn:aws:ec2:${region}:${event.account}:instance/${id}`
    || typeof event.time !== "string" || event.time.length > 40 || !Number.isFinite(Date.parse(event.time))) {
    throw new Error("Invalid EC2 state event identity");
  }
  return { eventId: event.id, instanceId: id, state, observedAt: event.time, account: event.account, region };
}

export class Ec2StateEventConsumer {
  constructor({ records, store, region, deployment, awsBin = "aws", profile = "", runner = null, onError = () => {}, auditIntervalMs = 300_000 }) {
    if (!records?.appendSystemEvent || !records?.get || !records?.put || !store?.list || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region || "")
      || !Number.isSafeInteger(auditIntervalMs) || auditIntervalMs < 60_000
      || !/^[A-Za-z][A-Za-z0-9-]{0,59}$/.test(deployment || "")) throw new Error("EC2 event consumer configuration is invalid");
    Object.assign(this, { records, store, region, deployment, awsBin, profile, onError, auditIntervalMs });
    this.runner = runner || (async (args, signal) => {
      const { stdout } = await runFile(this.awsBin, ["--region", this.region, ...(this.profile ? ["--profile", this.profile] : []), ...args],
        { signal, timeout: 35000, maxBuffer: 512000 });
      return stdout;
    });
    this.closed = false;
  }

  async start() {
    const name = `${this.deployment}-worker-state`;
    const response = JSON.parse(await this.runner(["sqs", "get-queue-url", "--queue-name", name, "--output", "json"]));
    if (!queueUrl.test(response?.QueueUrl || "") || !response.QueueUrl.endsWith(`/${name}`)) throw new Error("EC2 event queue identity is invalid");
    this.url = response.QueueUrl;
    this.expectedAccount = new URL(this.url).pathname.split("/")[1];
    this.loop = this.#receiveLoop();
    this.audit = setInterval(() => { void this.reconcile().catch(error => this.onError(new Error(`EC2 fleet audit unavailable (${error?.code || error?.name || "error"})`))); }, this.auditIntervalMs);
    this.audit.unref?.();
    void this.reconcile().catch(error => this.onError(new Error(`EC2 fleet audit unavailable (${error?.code || error?.name || "error"})`)));
    return this;
  }

  async reconcile() {
    if (this.closed) return;
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.#reconcile();
    try { return await this.reconciling; } finally { this.reconciling = null; }
  }

  async #reconcile() {
    const chats = this.store.list().filter(chat => instanceId.test(chat.workerLifecycle?.worker?.instanceId || chat.runtimeMetadata?.instanceId || ""));
    if (!chats.length) return;
    const raw = await this.runner(["ec2", "describe-instances", "--filters",
      `Name=tag:AgentRelayDeployment,Values=${this.deployment}`, "Name=tag:ManagedBy,Values=agent-relay",
      "--output", "json"]);
    const reservations = JSON.parse(raw || "{}").Reservations;
    if (!Array.isArray(reservations)) throw new Error("EC2 fleet audit response is invalid");
    const instances = reservations.flatMap(reservation => Array.isArray(reservation.Instances) ? reservation.Instances : []);
    const byId = new Map(instances.filter(item => instanceId.test(item.InstanceId || "")).map(item => [item.InstanceId, item]));
    for (const chat of chats) {
      if (this.closed) return;
      const id = chat.workerLifecycle?.worker?.instanceId || chat.runtimeMetadata?.instanceId;
      const observed = byId.get(id);
      const tags = Object.fromEntries((observed?.Tags || []).map(({ Key, Value }) => [Key, Value]));
      if (observed && (tags.AgentRelayDeployment !== this.deployment || tags.ManagedBy !== "agent-relay" || tags.AgentWebChat !== chat.id)) {
        throw new Error("EC2 fleet audit identity mismatch");
      }
      const state = observed?.State?.Name || "missing";
      if (state !== "missing" && !states.has(state)) throw new Error("EC2 fleet audit state is invalid");
      const generation = chat.workerLifecycle?.generation || 0;
      const prior = await this.records.get("ec2-observation", chat.id);
      if (prior?.instanceId === id && prior?.state === state && prior?.generation === generation) continue;
      // Include the previous committed observation so a state cycle
      // (running→missing→running) is not mistaken for the first running event.
      // A crash after append but before updating this cursor reuses the same
      // ID and is safely deduplicated on replay.
      const sourceId = `ec2-audit:${createHash("sha256").update(`${id}:${generation}:${state}:${prior?.sourceId || "initial"}`).digest("hex")}`;
      const event = { type: "ec2-instance-observation", chatId: chat.id, instanceId: id, state,
        generation, observedAt: new Date().toISOString(), source: "ec2-fleet-audit" };
      if (!this.store.get(chat.id)) continue;
      await this.records.appendSystemEvent(sourceId, event);
      await this.records.appendWorkerEvent(chat.id, sourceId, event);
      await this.records.put("ec2-observation", chat.id, { instanceId: id, state, generation, sourceId });
    }
  }

  async #receiveLoop() {
    while (!this.closed) {
      const controller = this.controller = new AbortController();
      try {
        const response = await this.runner(["sqs", "receive-message", "--queue-url", this.url,
          "--wait-time-seconds", "20", "--max-number-of-messages", "10", "--visibility-timeout", "120", "--output", "json"], controller.signal);
        const messages = JSON.parse(response || "{}").Messages || [];
        if (!Array.isArray(messages) || messages.length > 10) throw new Error("Invalid SQS receive batch");
        for (const message of messages) {
          if (this.closed) break;
          try {
            await this.consume(message);
          } catch (error) {
            // No receipt handle, body, CLI command or credential is logged.
            this.onError(new Error(`EC2 state message not acknowledged (${error?.code || error?.name || "error"})`));
          }
        }
      } catch (error) {
        if (!this.closed) {
          this.onError(new Error(`EC2 event queue unavailable (${error?.code || error?.name || "error"})`));
          await new Promise(resolve => {
            this.wake = resolve;
            this.delay = setTimeout(() => { this.delay = null; this.wake = null; resolve(); }, 2_000);
            this.delay.unref?.();
          });
        }
      }
    }
  }

  async consume(message) {
    if (!message || typeof message.ReceiptHandle !== "string" || message.ReceiptHandle.length > 4096) throw new Error("Invalid SQS receipt");
    const event = parseEc2StateMessage(message.Body, this.region);
    const queueAccount = this.expectedAccount || new URL(this.url).pathname.split("/")[1];
    if (event.account !== queueAccount) throw new Error("EC2 event account does not match its queue");
    const matching = this.store.list().filter(chat => chat.workerLifecycle?.worker?.instanceId === event.instanceId
      || chat.runtimeMetadata?.instanceId === event.instanceId);
    if (matching.length > 1) throw new Error("EC2 worker instance is bound to multiple chats");
    if (matching.length === 1) {
      const chat = matching[0];
      const publicEvent = { type: "ec2-instance-state", instanceId: event.instanceId, state: event.state,
        chatId: chat.id, observedAt: event.observedAt, region: event.region, source: "eventbridge" };
      await this.records.appendSystemEvent(`ec2:${event.eventId}`, publicEvent);
      // The per-chat stream can replay the exact external observation after a
      // controller restart. This is evidence, not permission to Stop a worker.
      if (this.store.get(chat.id)) await this.records.appendWorkerEvent(chat.id, `ec2:${event.eventId}`, publicEvent);
    }
    // ACK only after both durable writes, or after proving the event is for an
    // unrelated instance. A crash before ACK is harmless source-ID replay.
    await this.runner(["sqs", "delete-message", "--queue-url", this.url,
      "--receipt-handle", message.ReceiptHandle]);
  }

  async close() {
    this.closed = true; this.controller?.abort(); clearTimeout(this.delay); clearInterval(this.audit); this.wake?.();
    await Promise.allSettled([this.loop, this.reconciling].filter(Boolean));
  }
}
