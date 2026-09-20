import { createHash } from "node:crypto";

export const leaseFailure = (code = "ADMISSION_DENIED") => Object.assign(new Error(`Worker lease: ${code}`), { code });
export const leaseId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const revision = value => Number.isSafeInteger(value) && value >= 0;
export const digest = value => createHash("sha256").update(value).digest("hex");
export const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

// This descriptor is constructed by the server authority, not accepted by any
// HTTP/wire endpoint. It can name only the five persisted admission records.
export function scopeRecords(scope) {
  if (!scope || !/^user_[a-f0-9]{32}$/.test(scope.ownerId || "") || !/^chat_[a-f0-9]{32}$/.test(scope.chatId || "")
    || !/^account_[a-f0-9-]{36}$/.test(scope.accountId || "") || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(scope.companyId || "")
    || !leaseId(scope.environmentId) || typeof scope.legacy !== "boolean") throw leaseFailure("SCOPE_INVALID");
  const prefix = scope.legacy ? "" : `user:${scope.ownerId}:`;
  return [["chat", scope.chatId], ["agent-account", scope.accountId], ["agent-account-disconnection", scope.accountId],
    [`${prefix}company`, scope.companyId], [`${prefix}environment`, scope.environmentId]];
}

export function workerAttemptKey(identity) {
  return digest(canonical([identity.deploymentId, identity.ownerId, identity.chatId, identity.attemptId]));
}
export const workerTransportKey = (attemptId, processId) => {
  if (!/^[a-f0-9]{64}$/.test(attemptId || "") || !leaseId(processId)) throw leaseFailure("IDENTITY_INVALID");
  return digest(canonical([attemptId, processId]));
};
export const admissionRecordKind = kind => ["chat", "agent-account", "agent-account-disconnection", "company", "environment"].includes(kind)
  || /^user:user_[a-f0-9]{32}:(company|environment)$/.test(kind);
export const recordLockKey = (kind, id) => canonical(["worker-lease", kind, id]);

export function synchronousTransition(transition, snapshot) {
  const result = transition(structuredClone(snapshot));
  if (result && typeof result.then === "function") {
    // Consume a rejected accidental Promise without awaiting its side effects.
    Promise.resolve(result).catch(() => {});
    throw leaseFailure("ASYNC_TRANSITION_FORBIDDEN");
  }
  return result;
}

export function assertAttemptFence(attempt, request, now) {
  const lease = attempt?.leases?.[request.processId];
  if (!attempt || attempt.status !== "active" || attempt.pendingInvalidations?.length || attempt.controllerId !== request.controllerId || attempt.controllerEpoch !== request.controllerEpoch
    || !attempt.processIds?.includes(request.processId) || !lease || lease.expiresAt <= now) throw leaseFailure("CONTROLLER_FENCED");
}
