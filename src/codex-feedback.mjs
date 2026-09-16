import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { companyForChat } from "../public/company-scope.js";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const FEEDBACK_TYPES = ["bug", "bad", "good", "other"];

function localRoot(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return null;
  try { return value.startsWith("file:") ? fileURLToPath(value) : path.isAbsolute(value) ? value : null; } catch { return null; }
}
function within(home, target) {
  if (!home || !target || !path.isAbsolute(home)) return false;
  const relative = path.relative(home, target);
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

// This inspects policy only: no logs are read, no config is written and no
// feedback RPC is issued. Codex remains responsible for its native collection.
export async function codexFeedbackPolicy({ request, workspace, nativeHome, privateProfile, threadId, workerId }, check = () => {}) {
  check();
  if (!threadId || !workerId) throw conflict("Connect a native Codex session before reviewing feedback");
  let config, requirements;
  try {
    config = await request("config/read", { cwd: workspace, includeLayers: false }); check();
    requirements = await request("configRequirements/read", {}); check();
  } catch { check(); throw new Error("Cannot verify native feedback policy. Check this worker's Codex version and refresh."); }
  const feedback = config?.config?.feedback, managed = requirements?.requirements;
  if (!object(config?.config) || feedback != null && (!object(feedback) || feedback.enabled != null && typeof feedback.enabled !== "boolean")
    || managed !== null && (!object(managed) || managed.feedback !== null && (!object(managed.feedback) || managed.feedback.enabled != null && typeof managed.feedback.enabled !== "boolean"))) {
    throw new Error("Codex returned unsupported feedback policy. No report was sent.");
  }
  const enabled = feedback?.enabled !== false && managed?.feedback?.enabled !== false;
  const logRoot = localRoot(config.config.log_dir, path.join(nativeHome || "", "log"));
  const sqliteRoot = localRoot(config.config.sqlite_home, nativeHome);
  const managedLogRoot = localRoot(managed?.logDir, logRoot), managedSqliteRoot = localRoot(managed?.sqliteHome, sqliteRoot);
  const privateRoots = privateProfile === true && [logRoot, sqliteRoot, managedLogRoot, managedSqliteRoot].every(root => within(nativeHome, root));
  const logsAllowed = enabled && privateRoots;
  const logsReason = !enabled ? "Feedback is disabled by native configuration or admin policy."
    : !privateProfile ? "Diagnostic logs are unavailable for shared host profiles until company/profile isolation is complete."
    : !privateRoots ? "The native diagnostic storage points outside this chat's private profile; logs are unavailable." : "";
  return { threadId, enabled, logsAllowed, logsReason,
    revision: hash([threadId, workerId, workspace, nativeHome, privateProfile, feedback?.enabled ?? null, managed?.feedback?.enabled ?? null, logRoot, sqliteRoot, managedLogRoot, managedSqliteRoot]) };
}

export class CodexFeedback {
  constructor(store, config) { this.store = store; this.config = config; this.locks = new Map(); this.active = new Set(); }
  binding(chat) {
    return hash([chat.id, chat.ownerId || null, chat.agent, chat.agentSessionId || null, companyForChat(chat),
      (chat.repositories || []).map(repo => repo.fullName || `${repo.owner}/${repo.name}`), chat.environmentId || null,
      chat.workspace, this.config.codex.authMode, this.config.workerBackend]);
  }
  #chat(chatId, binding) {
    const chat = this.store.get(chatId);
    if (!chat || chat.agent !== "codex" || binding && this.binding(chat) !== binding) throw conflict("The feedback chat, project or native session changed. Reopen /feedback.");
    if (!this.store.records) throw conflict("Encrypted storage is required to track feedback submissions");
    return chat;
  }
  async #locked(chatId, task) {
    const previous = this.locks.get(chatId) || Promise.resolve(), running = previous.catch(() => {}).then(task);
    this.locks.set(chatId, running);
    try { return await running; } finally { if (this.locks.get(chatId) === running) this.locks.delete(chatId); }
  }
  async #state(chatId) {
    const binding = this.binding(this.#chat(chatId)), saved = await this.store.records.get("native-feedback", chatId);
    this.#chat(chatId, binding);
    return saved?.version === 1 && saved.binding === binding ? saved : { version: 1, binding, reports: [] };
  }
  async #save(chatId, state) {
    this.#chat(chatId, state.binding); await this.store.records.put("native-feedback", chatId, state); this.#chat(chatId, state.binding);
  }
  #public(item) {
    return { id: item.id, revision: item.revision, threadId: item.threadId, classification: item.classification, reason: item.reason,
      includeLogs: item.includeLogs, createdAt: item.createdAt, expiresAt: item.expiresAt, completedAt: item.completedAt || null,
      state: item.state === "uploading" && !this.active.has(item.id) ? "uncertain" : item.state, reference: item.reference || null };
  }
  async status(chatId) {
    const state = await this.#state(chatId);
    // A read neither wakes a worker nor waits behind an in-flight upload.
    return { threadId: this.#chat(chatId, state.binding).agentSessionId || null, reports: state.reports.map(item => this.#public(item)) };
  }
  async existing(chatId, input) {
    if (input?.confirm !== true || typeof input.id !== "string" || typeof input.revision !== "string") throw conflict("Review and explicitly confirm a feedback report first");
    const state = await this.#state(chatId), item = state.reports.find(item => item.id === input.id);
    if (!item || item.revision !== input.revision || item.threadId !== input.threadId) throw conflict("This feedback review is no longer available. Prepare a new review.");
    return item.state !== "prepared" ? this.#public(item) : null;
  }
  async prepare(chatId, input, adapter, check = () => {}) {
    if (!FEEDBACK_TYPES.includes(input?.classification) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 6000
      || typeof input.includeLogs !== "boolean" || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.reason)) throw new Error("Choose a feedback type, write a report of 1–6,000 characters and choose whether to include logs");
    return this.#locked(chatId, async () => {
      check(); const chat = this.#chat(chatId), binding = this.binding(chat), threadId = chat.agentSessionId;
      if (!threadId || chat.archived || adapter.threadId !== threadId) throw conflict("The feedback session is not available");
      const policy = await adapter.feedbackPolicy(check); check(); this.#chat(chatId, binding);
      if (policy.threadId !== threadId || !policy.enabled) throw conflict("Feedback is disabled by native configuration or admin policy. No report was sent.");
      if (input.includeLogs && !policy.logsAllowed) throw conflict(policy.logsReason || "Native diagnostic logs are not available for this profile");
      const state = await this.#state(chatId); check(); this.#chat(chatId, binding);
      const createdAt = Date.now(), item = { id: randomUUID(), threadId, workerId: adapter.importWorkerId, policyRevision: policy.revision,
        classification: input.classification, reason: input.reason, includeLogs: input.includeLogs, createdAt, expiresAt: createdAt + 300000, state: "prepared" };
      if (!item.workerId) throw conflict("This Codex worker does not expose a feedback session identity");
      item.revision = hash([binding, item]); state.reports.unshift(item);
      const retained = new Set(state.reports.slice(0, 20)); state.reports = state.reports.filter(entry => retained.has(entry) || entry.state === "uploading");
      await this.#save(chatId, state); check(); return this.#public(item);
    });
  }
  async send(chatId, input, adapter, check = () => {}) {
    return this.#locked(chatId, async () => {
      check(); const prior = await this.existing(chatId, input); check(); if (prior) return prior;
      const state = await this.#state(chatId), item = state.reports.find(entry => entry.id === input.id);
      if (!item || item.revision !== input.revision || item.threadId !== input.threadId) throw conflict("The feedback review changed. Prepare a new review.");
      const guard = () => {
        check(); const chat = this.#chat(chatId, state.binding);
        if (chat.archived || !adapter || adapter.threadId !== item.threadId || adapter.importWorkerId !== item.workerId) throw conflict("The reviewed worker changed or stopped. Prepare a new feedback review.");
      };
      let dispatched = false;
      try {
        guard(); if (item.expiresAt < Date.now()) throw conflict("The feedback review expired. Prepare a new review.");
        const policy = await adapter.feedbackPolicy(guard); guard();
        if (policy.revision !== item.policyRevision || !policy.enabled || item.includeLogs && !policy.logsAllowed) throw conflict("The native feedback policy changed. Prepare a new review.");
        this.active.add(item.id); item.state = "uploading"; await this.#save(chatId, state); guard();
        if (item.expiresAt < Date.now()) throw conflict("The feedback review expired. Prepare a new review.");
        // Durable intent precedes the external RPC. Native feedback has no
        // idempotency key or receipt lookup: unknown outcomes NEVER auto-retry.
        dispatched = true;
        const result = await adapter.uploadFeedback({ classification: item.classification, reason: item.reason, threadId: item.threadId, includeLogs: item.includeLogs, extraLogFiles: [] }, guard);
        guard();
        if (!result || result.threadId !== item.threadId) throw new Error("Unrecognized native feedback acknowledgement");
        item.state = "sent"; item.reference = result.threadId; item.completedAt = Date.now(); await this.#save(chatId, state);
        return this.#public(item);
      } catch (error) {
        item.state = dispatched ? "uncertain" : "cancelled"; await this.#save(chatId, state).catch(() => {});
        if (dispatched) return this.#public(item); // Never expose diagnostic/provider error bodies to the browser.
        throw error;
      } finally { this.active.delete(item.id); }
    });
  }
}
