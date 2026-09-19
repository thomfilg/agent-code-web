import { createHash } from "node:crypto";
import { companyForChat } from "../public/company-scope.js";
import { environmentAllows } from "../public/environment-scope.js";
import { validateSessionBundle } from "./codex-session-bundle.mjs";
import { canonical } from "./worker-lease-scope.mjs";
import { nativeSessionRecords, sessionFailure } from "./native-session-scope.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const same = (a, b) => canonical(a) === canonical(b);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

// Private journal storage only. This service never returns a bundle to an HTTP
// handler, publishes it as chat metadata, or substitutes web transcript text.
export class NativeSessionCheckpoints {
  constructor({ records, isLegacy = () => false }) { this.records = records; this.isLegacy = isLegacy; }
  available(chat) {
    return Boolean(this.records?.nativeSessionTransaction && chat?.agent === "codex" && chat.ownerId && chat.agentAccountId && companyForChat(chat));
  }
  scope(chat) {
    const scope = { ownerId: chat.ownerId, chatId: chat.id, accountId: chat.agentAccountId,
      companyId: companyForChat(chat), environmentId: chat.environmentId || null, legacy: this.isLegacy(chat.ownerId) === true };
    nativeSessionRecords(scope); return scope;
  }
  transaction(request, transition) {
    return this.records.nativeSessionTransaction(request, transition).catch(error => {
      if (error?.message?.startsWith("Native history:") || ["CAS_CONFLICT", "ASYNC_TRANSITION_FORBIDDEN", "COMMIT_OWNERSHIP_REQUIRED"].includes(error.code)) throw error;
      throw sessionFailure("STORAGE_FAILURE");
    });
  }
  current(scope, records, threadId) {
    const { chat, account, disconnection, company, environment } = records;
    if (!uuid(threadId) || !chat || chat.id !== scope.chatId || chat.ownerId !== scope.ownerId || chat.agent !== "codex"
      || chat.agentAccountId !== scope.accountId || chat.agentSessionId !== threadId || (chat.environmentId || null) !== scope.environmentId
      || chat.archived || chat.workflowState === "archived" || chat.status === "deleting"
      || companyForChat(chat) !== scope.companyId || !Array.isArray(chat.repositories)
      || chat.repositories.some(repo => companyForChat({ repositories: [repo] }) !== scope.companyId)
      || !company || company.id !== scope.companyId
      || !account || account.id !== scope.accountId || account.ownerId !== scope.ownerId || account.provider !== "codex"
      || account.status !== "connected" || !account.auth || disconnection
      || !account.accountIdentity || !account.subject
      || scope.environmentId !== null && (!environment || environment.id !== scope.environmentId || environment.archived || !environmentAllows(environment, scope.companyId))) throw sessionFailure();
    // Revisions are authorization observations, not history identity. Adding an
    // environment variable or renewing the same account must not erase context.
    return { ownerId: scope.ownerId, chatId: scope.chatId, companyId: scope.companyId, environmentId: scope.environmentId,
      provider: "codex", accountId: scope.accountId, accountIdentity: account.accountIdentity, subject: account.subject, threadId };
  }
  async read(chat, check = () => {}) {
    if (!this.available(chat)) throw sessionFailure("UNAVAILABLE");
    const scope = this.scope(chat);
    const row = await this.transaction({ scope }, ({ records, value }) => {
      check(); const binding = this.current(scope, records, chat.agentSessionId);
      if (value && (!same(value.binding, binding) || !same(value.scope, scope))) throw sessionFailure("BINDING_CHANGED");
    });
    check();
    if (row.value) {
      validateSessionBundle(row.value.bundle, chat.agentSessionId);
      if (hash(canonical(row.value.bundle)) !== row.value.digest) throw sessionFailure("CHECKPOINT_CORRUPT");
    }
    return row;
  }
  async save(chat, bundle, expectedRevision, { turnId = null, boundary = "complete-records" } = {}, check = () => {}) {
    if (!this.available(chat)) throw sessionFailure("UNAVAILABLE");
    const files = validateSessionBundle(bundle, chat.agentSessionId), scope = this.scope(chat);
    if (turnId !== null && !uuid(turnId) || !["complete-records", "turn-completed", "stopping"].includes(boundary)) throw sessionFailure("INVALID_BOUNDARY");
    // A notification is not a journal flush barrier. Only call this a completed
    // turn checkpoint when the exact native terminal marker is actually present.
    if (boundary === "turn-completed" && (!turnId || !files.get(bundle.threadId).bytes.toString("utf8").trimEnd().split("\n").some(line => {
      const record = JSON.parse(line);
      return record.type === "event_msg" && record.payload?.type === "task_complete" && record.payload.turn_id === turnId;
    }))) throw sessionFailure("TERMINAL_RECORD_NOT_FLUSHED");
    const digest = hash(canonical(bundle));
    const row = await this.transaction({ scope, expectedRevision }, ({ records, value, now }) => {
      check(); const binding = this.current(scope, records, bundle.threadId);
      if (value) {
        if (!same(value.binding, binding) || !same(value.scope, scope)) throw sessionFailure("BINDING_CHANGED");
        const previous = validateSessionBundle(value.bundle, bundle.threadId);
        for (const [id, old] of previous) {
          const next = files.get(id)?.bytes;
          if (!next || next.length < old.bytes.length || !next.subarray(0, old.bytes.length).equals(old.bytes)) throw sessionFailure("HISTORY_DIVERGED");
        }
      }
      return { schema: 1, scope, binding, bundle, digest, savedAt: new Date(now).toISOString(), boundary, turnId,
        bytes: [...files.values()].reduce((sum, file) => sum + file.bytes.length, 0) };
    });
    check(); return row;
  }
}
