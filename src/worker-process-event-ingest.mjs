import { safeId } from "./worker-transport-wire.mjs";

const sourcePattern = /^worker-supervisor:[a-f0-9]{64}$/;
const exactWorker = /^i-[a-f0-9]{8,17}$/;
const allowed = new Set(["schema", "source", "sourceId", "type", "action", "chatId", "workerId", "attemptId", "processId",
  "processInstanceId", "supervisorInstanceId", "observedAt", "exit"]);

export function validWorkerProcessEvent(event, chatId, workerId) {
  if (!event || typeof event !== "object" || Array.isArray(event) || event.schema !== 1 || event.source !== "worker-supervisor"
    || !sourcePattern.test(event.sourceId || "") || event.type !== "native-process" || !["started", "exited", "unconfirmed"].includes(event.action)
    || event.chatId !== chatId || event.workerId !== workerId || !exactWorker.test(workerId || "")
    || !safeId(event.attemptId) || !safeId(event.processId) || !safeId(event.processInstanceId) || !safeId(event.supervisorInstanceId)
    || typeof event.observedAt !== "string" || event.observedAt.length > 40 || !Number.isFinite(Date.parse(event.observedAt))
    || Object.keys(event).some(key => !allowed.has(key))) return false;
  if (event.action === "started") return event.exit === undefined;
  return event.exit && typeof event.exit === "object" && !Array.isArray(event.exit)
    && Object.keys(event.exit).every(key => ["code", "signal"].includes(key))
    && (event.exit.code === null || Number.isInteger(event.exit.code) && event.exit.code >= 0 && event.exit.code <= 255)
    && (event.exit.signal === null || typeof event.exit.signal === "string" && /^SIG[A-Z0-9]{1,20}$/.test(event.exit.signal));
}

// The worker does not ACK until the encrypted controller ledger commits. If
// either side crashes in between, the exact source ID makes replay idempotent.
export async function ingestWorkerProcessEvents({ chatId, workerId, records, control }) {
  if (!safeId(chatId) || !exactWorker.test(workerId || "") || typeof records?.appendWorkerEvent !== "function" || typeof control !== "function") {
    throw new Error("Worker process event ingestion is not configured");
  }
  let count = 0;
  for (let batch = 0; batch < 11; batch++) {
    const response = await control({ action: "events" });
    if (!Array.isArray(response?.events) || response.events.length > 100) throw new Error("Invalid worker process event batch");
    if (!response.events.length) return count;
    for (const event of response.events) {
      if (!validWorkerProcessEvent(event, chatId, workerId)) throw new Error("Worker process event identity is invalid");
      await records.appendWorkerEvent(chatId, event.sourceId, event);
      const ack = await control({ action: "ackEvent", sourceId: event.sourceId });
      if (ack?.acknowledged !== true) throw new Error("Worker process event acknowledgement failed");
      count++;
    }
    if (response.events.length < 100) return count;
  }
  throw new Error("Worker process event outbox exceeded bounded catch-up");
}
