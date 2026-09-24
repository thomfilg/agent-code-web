// Project only public lifecycle fields into the durable observability stream.
// Never copy a chat, native request, environment, token, argv or tool output.
const safeTime = value => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
const safeAction = value => ["acquire", "resume", "hibernate", "stop", "destroy", "reconcile"].includes(value);
const safeReason = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);

export function workerLifecycleEvents(chat) {
  const lifecycle = chat?.workerLifecycle;
  if (!/^chat_[a-f0-9]{32}$/.test(chat?.id || "") || !Number.isSafeInteger(lifecycle?.generation) || lifecycle.generation < 1) return [];
  const worker = lifecycle.worker;
  const identity = worker && /^i-[a-f0-9]{8,17}$/.test(worker.instanceId || "")
    ? { backend: "ec2", instanceId: worker.instanceId } : worker?.backend === "local" ? { backend: "local" } : null;
  const base = { generation: lifecycle.generation, ...(identity ? { worker: identity } : {}) };
  const events = [];
  const intent = lifecycle.intent;
  if (intent?.generation === lifecycle.generation && safeAction(intent.action) && safeTime(intent.requestedAt)) {
    events.push({ sourceId: `lifecycle:${lifecycle.generation}:intent`, value: {
      type: "worker-lifecycle", phase: "intent", ...base, action: intent.action,
      ...(safeReason(intent.reason) ? { reason: intent.reason } : {}), observedAt: intent.requestedAt,
    } });
  }
  const result = lifecycle.result;
  if (result?.generation === lifecycle.generation && safeAction(result.action) && safeTime(result.observedAt)
    && ["succeeded", "failed", "unknown", "unavailable"].includes(result.status)
    && ["none", "created", "started", "inspected", "hibernated", "stopped", "destroyed"].includes(result.mutation)
    && ["not-required", "stopped", "failed", "unknown"].includes(result.cleanup)) {
    events.push({ sourceId: `lifecycle:${lifecycle.generation}:result`, value: {
      type: "worker-lifecycle", phase: "result", ...base, action: result.action,
      ...(safeReason(intent?.reason) ? { reason: intent.reason } : {}), status: result.status,
      mutation: result.mutation, cleanup: result.cleanup, observedAt: result.observedAt,
    } });
  }
  return events;
}

export async function recordWorkerLifecycle(records, chat) {
  if (!records?.appendWorkerEvent) return;
  for (const event of workerLifecycleEvents(chat)) await records.appendWorkerEvent(chat.id, event.sourceId, event.value);
}
