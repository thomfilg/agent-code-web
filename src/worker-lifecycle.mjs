const ACTIONS = new Set(["acquire", "resume", "hibernate", "stop", "destroy", "reconcile"]);
const STATES = new Set(["stopped", "acquiring", "active", "resuming", "suspending", "suspended", "stopping", "unknown", "failed", "unavailable"]);
const RESULTS = new Set(["succeeded", "failed", "unknown", "unavailable"]);
const MUTATIONS = new Set(["none", "created", "started", "inspected", "hibernated", "stopped", "destroyed"]);
const CLEANUPS = new Set(["not-required", "stopped", "failed", "unknown"]);
const STARTING_STATE = { acquire: "acquiring", resume: "resuming", hibernate: "suspending", stop: "stopping", destroy: "stopping", reconcile: "unknown" };

const timestamp = value => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
const generation = value => Number.isSafeInteger(value) && value >= 0;
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const backend = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);

function at(value) {
  if (!timestamp(value)) throw new Error("Invalid worker lifecycle timestamp");
  return value;
}

export function workerIdentity(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || !backend(value.backend)) throw new Error("Invalid worker identity");
  const identity = { backend: value.backend };
  if (value.instanceId !== undefined) {
    if (!safeId(value.instanceId)) throw new Error("Invalid worker instance identity");
    identity.instanceId = value.instanceId;
  }
  if (value.imageId !== undefined) {
    if (!safeId(value.imageId)) throw new Error("Invalid worker image identity");
    identity.imageId = value.imageId;
  }
  if (value.launchTime !== undefined) identity.launchTime = at(value.launchTime);
  if (value.bootId !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(value.bootId || "")) throw new Error("Invalid worker boot identity");
    identity.bootId = value.bootId;
  }
  if (value.backend === "ec2" && !/^i-[a-f0-9]{8,17}$/.test(identity.instanceId || "")) throw new Error("EC2 lifecycle identity requires an exact instance ID");
  return Object.freeze(identity);
}

export function workerIdentityFromMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !backend(value.backend)) return null;
  try {
    return workerIdentity({ backend: value.backend, ...(value.instanceId ? { instanceId: value.instanceId } : {}),
      ...(value.imageId ? { imageId: value.imageId } : {}), ...(value.launchTime ? { launchTime: value.launchTime } : {}),
      ...(value.bootId ? { bootId: value.bootId } : {}) });
  } catch { return null; }
}

export function publicControllerLease(value) {
  if (value === null || value === undefined) return null;
  // A lease credential, token or secret is never a lifecycle field. Reject it
  // rather than silently persisting a partially sanitized authority record.
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => /credential|token|secret/i.test(key))
    || !safeId(value.id) || !generation(value.generation) || value.generation < 1 || !safeId(value.controllerId)
    || !generation(value.controllerEpoch) || value.controllerEpoch < 1 || !timestamp(value.expiresAt)) throw new Error("Invalid public controller lease");
  return Object.freeze({ id: value.id, generation: value.generation, controllerId: value.controllerId,
    controllerEpoch: value.controllerEpoch, expiresAt: value.expiresAt });
}

export function initialWorkerLifecycle(recordedAt = new Date().toISOString()) {
  recordedAt = at(recordedAt);
  return { schema: 1, generation: 0, state: "stopped", worker: null, controllerLease: null,
    intent: null, result: null, updatedAt: recordedAt };
}

function normalizeIntent(value) {
  if (value === null) return null;
  if (!value || !ACTIONS.has(value.action) || !generation(value.generation) || value.generation < 1 || !timestamp(value.requestedAt)) throw new Error("Invalid worker lifecycle intent");
  return { action: value.action, generation: value.generation, requestedAt: value.requestedAt };
}

function normalizeResult(value) {
  if (value === null) return null;
  if (!value || !ACTIONS.has(value.action) || !generation(value.generation) || value.generation < 1 || !RESULTS.has(value.status)
    || !MUTATIONS.has(value.mutation) || !CLEANUPS.has(value.cleanup) || !timestamp(value.observedAt)) throw new Error("Invalid worker lifecycle result");
  return { action: value.action, generation: value.generation, status: value.status, mutation: value.mutation,
    cleanup: value.cleanup, observedAt: value.observedAt };
}

function normalized(value) {
  if (!value || value.schema !== 1 || !generation(value.generation) || !STATES.has(value.state) || !timestamp(value.updatedAt)) throw new Error("Invalid worker lifecycle");
  const intent = normalizeIntent(value.intent ?? null), result = normalizeResult(value.result ?? null);
  if (intent && intent.generation !== value.generation || result && result.generation !== value.generation
    || result && intent && result.action !== intent.action) throw new Error("Worker lifecycle generation does not match its intent/result");
  return { schema: 1, generation: value.generation, state: value.state, worker: workerIdentity(value.worker),
    controllerLease: publicControllerLease(value.controllerLease), intent, result, updatedAt: value.updatedAt };
}

export function beginWorkerLifecycle(value, action, recordedAt = new Date().toISOString()) {
  if (!ACTIONS.has(action) || action === "reconcile") throw new Error("Invalid worker lifecycle operation");
  const current = normalized(value), next = current.generation + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Worker lifecycle generation exhausted");
  recordedAt = at(recordedAt);
  return { ...current, generation: next, state: STARTING_STATE[action],
    intent: { action, generation: next, requestedAt: recordedAt }, result: null, updatedAt: recordedAt };
}

export function finishWorkerLifecycle(value, receipt, recordedAt = new Date().toISOString()) {
  const current = normalized(value);
  if (!receipt || !generation(receipt.generation) || !ACTIONS.has(receipt.action) || !RESULTS.has(receipt.status)
    || !MUTATIONS.has(receipt.mutation || "none") || !CLEANUPS.has(receipt.cleanup || "not-required")) throw new Error("Invalid worker lifecycle receipt");
  // A stale callback may observe a real provider result, but it does not own a
  // newer generation and therefore cannot rewrite that generation's state.
  if (!current.intent || current.generation !== receipt.generation || current.intent.action !== receipt.action) return current;
  recordedAt = at(recordedAt);
  let state;
  if (receipt.status === "failed") state = "failed";
  else if (receipt.status === "unknown") state = "unknown";
  else if (receipt.status === "unavailable") state = "unavailable";
  else if (["acquire", "resume"].includes(receipt.action)) state = "active";
  else if (receipt.action === "hibernate") state = "suspended";
  else if (["stop", "destroy"].includes(receipt.action)) state = "stopped";
  else state = "unknown";
  const suppliedWorker = receipt.worker === undefined ? current.worker : workerIdentity(receipt.worker);
  const worker = receipt.action === "destroy" && receipt.status === "succeeded" ? null : suppliedWorker;
  const controllerLease = ["stop", "destroy"].includes(receipt.action) || receipt.status !== "succeeded"
    ? null : receipt.controllerLease === undefined ? current.controllerLease : publicControllerLease(receipt.controllerLease);
  return { ...current, state, worker, controllerLease,
    result: { action: receipt.action, generation: receipt.generation, status: receipt.status,
      mutation: receipt.mutation || "none", cleanup: receipt.cleanup || "not-required", observedAt: recordedAt }, updatedAt: recordedAt };
}

export function restoreWorkerLifecycle(value, runtimeMetadata = null, recordedAt = new Date().toISOString()) {
  recordedAt = at(recordedAt);
  let current, malformed = false;
  try { current = normalized(value); }
  catch { malformed = value !== null && value !== undefined; current = initialWorkerLifecycle(recordedAt); }
  const legacyWorker = workerIdentityFromMetadata(runtimeMetadata);
  if (!current.worker && legacyWorker) current = { ...current, worker: legacyWorker };
  // A persisted controller observation is not proof that the same machine or
  // process is still live after this controller starts. Fence the old lease and
  // require an explicit provider/transport inspection before admission.
  if (malformed || current.worker || !["stopped", "failed", "unavailable"].includes(current.state) || current.controllerLease) {
    const next = current.generation + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Worker lifecycle generation exhausted");
    return { ...current, generation: next, state: "unknown", controllerLease: null,
      intent: { action: "reconcile", generation: next, requestedAt: recordedAt },
      result: { action: "reconcile", generation: next, status: "unknown", mutation: "inspected", cleanup: "unknown", observedAt: recordedAt },
      updatedAt: recordedAt };
  }
  return { ...current, controllerLease: null, updatedAt: recordedAt };
}
