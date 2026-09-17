import { createHash, randomBytes } from "node:crypto";
import { planCodexImport } from "./codex-import-plan.mjs";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const text = (value, max = 4000) => typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
const sources = new Set(["claude-code", "cursor"]);
const unfinished = job => ["starting", "running", "uncertain"].includes(job.phase);

// The adapter supplies a guarded, no-follow source/target inspector and durable
// encrypted storage. Keeping these dependencies mandatory prevents falling back
// to an unreviewed import or a memory-only job after a controller restart.
export class CodexImports {
  constructor({ request, inspect, save, reconcile, thread, workspace, home, binding, workerId, mutable = false, busy = () => false, saved = null }) {
    if (![request, inspect, save, reconcile, thread, busy].every(item => typeof item === "function") || !text(binding, 512) || !binding || !text(workerId, 512) || !workerId) throw new Error("Native import requires scoped review, persistence and lifecycle dependencies");
    Object.assign(this, { inspect, save, reconcile, thread, workspace, home, binding, workerId, mutable, busy });
    this.request = async (method, params) => {
      try { return await request(method, params); }
      catch { throw new Error(`Native import operation ${method} failed. Refresh /import to check its recorded outcome; it has not been retried.`); }
    };
    this.jobs = []; this.preparing = false; this.closed = false; this.storageDirty = false;
    this.writes = Promise.resolve(); this.early = new Map(); this.reviews = new Map();
    if (saved !== null) {
      if (!record(saved) || saved.version !== 1 || saved.binding !== binding || !Array.isArray(saved.jobs) || saved.jobs.length > 10 || !mutable && saved.jobs.length || JSON.stringify(saved).length > 4000000) throw conflict("Saved import state belongs to another scope or is incomplete");
      this.jobs = structuredClone(saved.jobs);
      const ids = new Set();
      for (const job of this.jobs) {
        if (!uuid(job.id) || ids.has(job.id) || !sources.has(job.source) || !text(job.threadId) || !job.threadId || !text(job.workerId, 512) || !job.workerId || job.providerId !== this.#provider(job.id) || !Array.isArray(job.selection) || !job.selection.length || job.selection.length > 100 || job.selection.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) || new Set(job.selection).size !== job.selection.length || typeof job.revision !== "string" || !/^[a-f0-9]{64}$/.test(job.revision) || !Number.isSafeInteger(job.startedAt) || !Array.isArray(job.choices) || !Array.isArray(job.migrationItems) || !Array.isArray(job.results) || !["starting", "running", "uncertain", "completed", "cancelled", "acknowledged"].includes(job.phase) || typeof job.reconciled !== "boolean" || typeof job.workerStopped !== "boolean" || job.importId !== null && !uuid(job.importId)) throw conflict("Saved native import state is incomplete");
        const restored = planCodexImport({ items: job.migrationItems }, { source: job.source, workspace, home, includeHome: true });
        if (restored.catalog.items.length !== job.selection.length || restored.catalog.items.some(item => !job.selection.includes(item.id))) throw conflict("Saved import selection does not match its source scope");
        job.choices = restored.catalog.items; job.results = this.#results(job, job.results);
        ids.add(job.id);
        if (["starting", "running"].includes(job.phase)) job.phase = "uncertain";
        // Restoration does not prove that the previous native worker stopped.
        // Only its matching exit/stop observation can authorize acknowledgement.
      }
    }
  }

  get changing() { return this.preparing || this.jobs.some(job => ["starting", "running"].includes(job.phase)); }
  get needsRefresh() { return this.storageDirty || this.jobs.some(job => !job.reconciled); }
  #provider(id) { return `relay-import:${digest(this.binding).slice(0, 24)}:${id}`; }
  #check(check) {
    check();
    if (this.closed) throw conflict("The native import connection stopped");
    if (!this.thread()) throw conflict("Connect this chat's native session before importing");
  }
  #persist() {
    const saved = structuredClone({ version: 1, binding: this.binding, jobs: this.jobs });
    const write = this.writes.catch(() => {}).then(() => this.save(saved));
    this.writes = write;
    return write.then(() => { this.storageDirty = false; }, () => {
      this.storageDirty = true;
      throw new Error("Import tracking could not be saved. Refresh /import before any further change.");
    });
  }
  #operation(job) {
    const summaries = new Map();
    for (const choice of job.choices) {
      if (!summaries.has(choice.itemType)) summaries.set(choice.itemType, { itemType: choice.itemType, name: choice.itemType === "SESSIONS" ? "Recent chats" : choice.name, selected: 0, imported: 0, failed: 0 });
      summaries.get(choice.itemType).selected += choice.count;
    }
    const sessions = [];
    for (const result of job.results) {
      const summary = summaries.get(result.itemType); if (!summary) continue;
      summary.imported += result.successes.length; summary.failed += result.failures.length;
      if (result.itemType === "SESSIONS") for (const item of result.successes) {
        const source = job.migrationItems.flatMap(group => group.details?.sessions || []).find(session => session.path === item.source);
        sessions.push({ id: digest([job.id, item.target]), title: (source?.title || "Imported conversation").slice(0, 160) });
      }
    }
    return { id: job.id, source: job.source, phase: job.phase, startedAt: job.startedAt, completedAt: job.completedAt || null,
      reconciled: job.reconciled, canAcknowledge: job.phase === "uncertain" && job.workerStopped,
      results: [...summaries.values()].map(item => ({ ...item, notReported: job.phase === "completed" ? Math.max(0, item.selected - item.imported - item.failed) : null })), sessions,
      warning: job.phase === "uncertain" ? "The outcome is not fully recorded. Files may already have changed. Refresh to recover results; this import will not be repeated automatically." : job.phase === "completed" && !job.reconciled ? "Import results are recorded. Review and reconcile the saved setup before continuing." : job.phase === "acknowledged" ? "Incomplete results were acknowledged after the original worker stopped. No import was repeated." : "" };
  }
  status() {
    return { threadId: this.thread(), mutable: this.mutable, busy: this.busy(), changing: this.changing, needsRefresh: this.needsRefresh,
      operations: this.jobs.map(job => this.#operation(job)).reverse() };
  }

  async #review(source, check) {
    this.#check(check);
    if (!sources.has(source)) throw new Error("Choose Claude Code or Cursor as the import source");
    const threadId = this.thread(), before = await this.inspect({ source, includeHome: this.mutable }, check); this.#check(check);
    if (typeof before !== "string" || !/^[a-f0-9]{64}$/.test(before)) throw new Error("Native import file review is unavailable");
    const detected = await this.request("externalAgentConfig/detect", { migrationSource: source, cwds: [this.workspace], includeHome: this.mutable, maxSessions: 50, maxSessionAgeDays: 30 }); this.#check(check);
    const plan = planCodexImport(detected, { source, workspace: this.workspace, home: this.home, includeHome: this.mutable });
    const after = await this.inspect({ source, includeHome: this.mutable }, check); this.#check(check);
    if (threadId !== this.thread() || before !== after) throw conflict("The import source, destination or native session changed during review. Refresh and review again.");
    return { plan, threadId, fileRevision: before, revision: digest([this.binding, threadId, plan.catalog.revision, before]) };
  }

  async list(source = "claude-code", check = () => {}) {
    this.#check(check);
    if (this.preparing) throw conflict("Wait for the current import request to finish");
    const review = await this.#review(source, check);
    const revision = randomBytes(32).toString("hex");
    for (const [id, saved] of this.reviews) if (Date.now() - saved.createdAt > 600000) this.reviews.delete(id);
    if (this.reviews.size >= 10) this.reviews.delete(this.reviews.keys().next().value);
    this.reviews.set(revision, { revision: review.revision, createdAt: Date.now() });
    return { ...review.plan.catalog, revision, ...this.status() };
  }

  async start(input, check = () => {}) {
    this.#check(check);
    if (!this.mutable) throw conflict("Import requires a private chat profile. Shared host configuration is read-only.");
    if (!uuid(input?.requestId) || !sources.has(input.source) || input.confirm !== true || input.threadId !== this.thread() || typeof input.revision !== "string" || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || input.ids.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) || new Set(input.ids).size !== input.ids.length) throw conflict("Choose and confirm entries from this chat's current import review");
    const selection = [...input.ids].sort(), previous = this.jobs.find(job => job.id === input.requestId);
    if (previous) {
      if (previous.source !== input.source || previous.threadId !== input.threadId || previous.revision !== input.revision || JSON.stringify(previous.selection) !== JSON.stringify(selection)) throw conflict("This import request ID already belongs to a different selection");
      return { ...this.status(), operation: this.#operation(previous), reused: true };
    }
    const confirmedReview = this.reviews.get(input.revision);
    if (!confirmedReview || Date.now() - confirmedReview.createdAt > 600000) throw conflict("This import review expired or was already used. Refresh and confirm a new review.");
    if (this.changing || this.needsRefresh || this.busy()) throw conflict("Wait for the agents and current import, then refresh /import before starting another change");
    this.preparing = true;
    let job, issued = false;
    try {
      const review = await this.#review(input.source, check); this.#check(check);
      if (this.busy() || input.threadId !== this.thread()) throw conflict("Wait for this chat and its agents to be idle before importing");
      if (review.revision !== confirmedReview.revision) throw conflict("The reviewed import changed. Refresh and confirm it again.");
      const selected = review.plan.select(selection);
      job = { id: input.requestId, providerId: this.#provider(input.requestId), source: input.source, threadId: input.threadId, workerId: this.workerId,
        revision: input.revision, selection, choices: review.plan.catalog.items.filter(item => selection.includes(item.id)), migrationItems: selected.migrationItems,
        phase: "starting", startedAt: Date.now(), completedAt: null, importId: null, results: [], reconciled: false, workerStopped: false };
      this.jobs = this.jobs.slice(-9); this.jobs.push(job);
      // A consumed review cannot be reused with a new request ID, even after
      // its old operation rolls out of the bounded recent-results window.
      this.reviews.delete(input.revision);
      // Persist intent before sending anything: a timeout or crash must not
      // silently turn the same user confirmation into a second native import.
      await this.#persist(); this.#check(check);
      const files = await this.inspect({ source: input.source, includeHome: true }, check); this.#check(check);
      if (files !== review.fileRevision) throw conflict("Import files changed while saving the confirmation. Review and confirm again.");
      if (this.busy() || input.threadId !== this.thread()) throw conflict("The chat changed before the import could start");
      issued = true;
      const result = await this.request("externalAgentConfig/import", { ...selected, source: input.source, providerId: job.providerId });
      if (!uuid(result?.importId)) throw new Error("Codex did not return a valid import identity");
      job.importId = result.importId;
      const early = this.early.get(result.importId); this.early.clear();
      if (early) for (const message of early) this.#accept(job, message);
      if (job.phase === "starting") job.phase = job.workerStopped ? "uncertain" : "running";
      await this.#persist(); this.#check(check);
      this.preparing = false;
      return { ...this.status(), operation: this.#operation(job), reused: false };
    } catch (error) {
      if (job && job.phase !== "completed") {
        job.phase = issued ? "uncertain" : "cancelled"; job.reconciled = !issued;
        await this.#persist();
      }
      throw error;
    } finally { this.preparing = false; this.early.clear(); }
  }

  #results(job, results) {
    if (!Array.isArray(results) || results.length > 20 || JSON.stringify(results).length > 1000000) throw new Error("Native import results are incomplete or too large");
    const types = new Set(job.migrationItems.map(item => item.itemType));
    const normalized = new Map(); let count = 0;
    for (const result of results) {
      if (!record(result) || !types.has(result.itemType) || !Array.isArray(result.successes) || !Array.isArray(result.failures)) throw new Error("Native import returned unexpected result types");
      const target = normalized.get(result.itemType) || { itemType: result.itemType, successes: [], failures: [] };
      for (const field of ["successes", "failures"]) for (const entry of result[field]) {
        if (++count > 4000 || !record(entry) || entry.itemType !== result.itemType || entry.cwd !== null && entry.cwd !== this.workspace || !job.migrationItems.some(item => item.itemType === entry.itemType && (entry.itemType === "SESSIONS" ? item.details.sessions.some(session => session.cwd === entry.cwd && session.path === entry.source) : item.cwd === entry.cwd))) throw new Error("Native import returned results outside the confirmed scope");
        if (entry.source !== null && !text(entry.source)) throw new Error("Native import returned invalid source metadata");
        if (field === "successes") {
          if (entry.target !== null && !text(entry.target) || entry.title != null && !text(entry.title) || entry.itemType === "SESSIONS" && !uuid(entry.target)) throw new Error("Native import returned invalid target metadata");
          target.successes.push({ itemType: entry.itemType, cwd: entry.cwd, source: entry.source, target: entry.target, title: entry.title || null });
        } else {
          // Raw native error strings can contain config values and credentials.
          // They are deliberately not persisted or sent to the browser.
          target.failures.push({ itemType: entry.itemType, cwd: entry.cwd, source: entry.source });
        }
      }
      normalized.set(result.itemType, target);
    }
    return [...normalized.values()];
  }
  #accept(job, message) {
    const results = this.#results(job, message.params.itemTypeResults);
    if (message.method === "externalAgentConfig/import/completed") {
      job.results = results; job.phase = "completed"; job.completedAt ||= Date.now(); job.reconciled = false;
    } else if (job.phase !== "completed") {
      // Progress can be incremental per scope or cumulative. Deduplicate both
      // shapes instead of erasing an earlier profile/project result.
      for (const result of results) {
        let current = job.results.find(item => item.itemType === result.itemType);
        if (!current) { current = { itemType: result.itemType, successes: [], failures: [] }; job.results.push(current); }
        for (const field of ["successes", "failures"]) {
          const seen = new Set(current[field].map(value => JSON.stringify(value)));
          current[field].push(...result[field].filter(value => { const key = JSON.stringify(value); if (seen.has(key)) return false; seen.add(key); return true; }));
        }
      }
    }
  }
  notification(message) {
    if (this.closed || !["externalAgentConfig/import/progress", "externalAgentConfig/import/completed"].includes(message?.method) || !uuid(message.params?.importId)) return;
    const job = this.jobs.find(item => item.importId === message.params.importId);
    if (!job) {
      if (this.preparing && this.jobs.some(item => item.phase === "starting" && !item.importId) && this.early.size < 20 && JSON.stringify(message).length <= 1000000) {
        const previous = this.early.get(message.params.importId) || [];
        if (!previous.some(item => item.method === "externalAgentConfig/import/completed") && previous.length < 40 && JSON.stringify(previous).length + JSON.stringify(message).length <= 1000000) {
          this.early.set(message.params.importId, message.method === "externalAgentConfig/import/completed" ? [structuredClone(message)] : [...previous, structuredClone(message)]);
        }
      }
      return;
    }
    if (job.reconciled || job.workerId !== this.workerId) return;
    try { this.#accept(job, message); }
    catch { job.phase = "uncertain"; job.reconciled = false; }
    void this.#persist().catch(() => {});
  }

  async refresh(check = () => {}) {
    this.#check(check);
    if (this.preparing) throw conflict("Wait for the current import request to finish");
    if (!this.mutable || !this.jobs.length) return this.status();
    this.preparing = true;
    try {
      const response = await this.request("externalAgentConfig/import/readHistories", {}); this.#check(check);
      if (!Array.isArray(response?.data) || response.data.length > 1000) throw new Error("Native import history is unavailable or too large");
      for (const job of this.jobs.filter(item => !item.reconciled)) {
        const candidates = response.data.filter(item => item.providerId === job.providerId);
        if (candidates.length > 1) { job.phase = "uncertain"; throw conflict("Multiple native imports match this confirmation. No import was repeated; review the recorded state."); }
        const history = candidates[0];
        if (history) {
          // Correlate by the persisted operation identity, not wall-clock
          // ordering: the controller and remote worker can have clock skew.
          if (!uuid(history.importId) || job.importId && job.importId !== history.importId || !Number.isSafeInteger(history.completedAtMs) || history.completedAtMs < 0 || history.completedAtMs > 8640000000000000 || !Array.isArray(history.successes) || !Array.isArray(history.failures)) throw new Error("Native import history does not match the saved operation");
          const results = new Map();
          for (const field of ["successes", "failures"]) for (const entry of history[field]) {
            if (!record(entry)) throw new Error("Native import history contains invalid results");
            if (!results.has(entry.itemType)) results.set(entry.itemType, { itemType: entry.itemType, successes: [], failures: [] });
            results.get(entry.itemType)[field].push(entry);
          }
          job.importId = history.importId;
          this.#accept(job, { method: "externalAgentConfig/import/completed", params: { itemTypeResults: [...results.values()] } });
          job.completedAt = history.completedAtMs;
        }
        if (job.phase === "completed" && !this.busy()) {
          // The adapter reconciles saved setup and policies; this dependency
          // must never approve hooks, authorize accounts or restart the worker.
          await this.reconcile({ source: job.source, itemTypes: [...new Set(job.migrationItems.map(item => item.itemType))] }, check); this.#check(check);
          job.reconciled = true;
        }
      }
      await this.#persist(); this.#check(check);
      this.preparing = false; return this.status();
    } finally { this.preparing = false; }
  }

  async workerStopped(workerId, confirmed = true) {
    if (workerId !== this.workerId && !this.jobs.some(job => job.workerId === workerId)) return;
    if (workerId === this.workerId) this.closed = true;
    for (const job of this.jobs) if (job.workerId === workerId) {
      // Losing the SSH transport is not evidence that the remote process
      // exited. Its owning backend can confirm the stop after the VM is down.
      if (confirmed === true) job.workerStopped = true;
      if (unfinished(job)) { job.phase = "uncertain"; job.reconciled = false; }
    }
    this.early.clear(); this.reviews.clear(); await this.#persist();
  }

  async acknowledge(input, check = () => {}) {
    this.#check(check);
    if (!this.mutable || input?.confirm !== true || input.threadId !== this.thread() || this.preparing || this.busy()) throw conflict("Confirm the incomplete import from an idle private chat session");
    const job = this.jobs.find(item => item.id === input.id);
    if (!job || job.phase !== "uncertain" || !job.workerStopped) throw conflict("The original import worker must be confirmed stopped before acknowledging incomplete results");
    await this.refresh(check); this.#check(check);
    if (job.phase === "completed") return this.status();
    if (this.busy()) throw conflict("Wait for the agents to be idle before reconciling incomplete results");
    this.preparing = true;
    try {
      const inspected = await this.inspect({ source: job.source, includeHome: true }, check); this.#check(check);
      if (typeof inspected !== "string" || !/^[a-f0-9]{64}$/.test(inspected)) throw new Error("Native import file review is unavailable");
      await this.reconcile({ source: job.source, itemTypes: [...new Set(job.migrationItems.map(item => item.itemType))] }, check); this.#check(check);
      job.phase = "acknowledged"; job.reconciled = true;
      await this.#persist(); this.#check(check); this.preparing = false; return this.status();
    } finally { this.preparing = false; }
  }

  // Opening still requires the controller's owner/company guard and a native
  // thread read that verifies the returned cwd before creating a Relay chat.
  importedSession(operationId, id, check = () => {}) {
    this.#check(check);
    const job = this.jobs.find(item => item.id === operationId && item.phase === "completed" && item.reconciled);
    const entry = job?.results.flatMap(item => item.itemType === "SESSIONS" ? item.successes : []).find(item => digest([job.id, item.target]) === id);
    if (!entry) throw conflict("Choose an imported conversation from this chat's recorded results");
    return { threadId: entry.target, cwd: entry.cwd, source: job.source, title: job.migrationItems.flatMap(item => item.details?.sessions || []).find(item => item.path === entry.source)?.title || "Imported conversation" };
  }
}
