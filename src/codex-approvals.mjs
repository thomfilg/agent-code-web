import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { companyForChat } from "../public/company-scope.js";
import { redact } from "./utils.mjs";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const string = value => typeof value === "string";
const nullable = test => value => value === null || test(value);
const strings = value => Array.isArray(value) && value.every(string);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const oneOf = (...values) => value => values.includes(value);
function shape(value, fields, optional = {}) {
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(fields, key) && !Object.hasOwn(optional, key))
    || Object.entries(fields).some(([key, test]) => !test(value[key]))
    || Object.entries(optional).some(([key, test]) => Object.hasOwn(value, key) && !test(value[key]))) throw new Error("Unsupported native automatic-review action");
  return value;
}
function filePath(value) {
  if (value?.type === "path") shape(value, { type: oneOf("path"), path: string });
  else if (value?.type === "glob_pattern") shape(value, { type: oneOf("glob_pattern"), pattern: string });
  else if (value?.type === "special") {
    shape(value, { type: oneOf("special"), value: object });
    const kind = value.value.kind;
    shape(value.value, { kind: oneOf("root", "minimal", "project_roots", "tmpdir", "slash_tmp", "unknown"),
      ...(["project_roots", "unknown"].includes(kind) ? { subpath: nullable(string) } : {}), ...(kind === "unknown" ? { path: string } : {}) });
  } else throw new Error("Unsupported native file permission");
  return true;
}
function permissions(value) {
  shape(value, { network: nullable(object), fileSystem: nullable(object) });
  if (value.network) shape(value.network, { enabled: nullable(value => typeof value === "boolean") });
  if (value.fileSystem) shape(value.fileSystem, { read: nullable(strings), write: nullable(strings) }, {
    globScanMaxDepth: integer,
    entries: entries => Array.isArray(entries) && entries.every(entry => { shape(entry, { path: filePath, access: oneOf("read", "write", "deny") }); return true; }),
  });
  const fs = value.fileSystem;
  // The installed core accepts legacy read/write OR canonical entries, never
  // both. v2 retains nullable deprecated fields beside its canonical entries.
  // Reject conflicting deprecated grants rather than silently choosing a side.
  if (fs?.entries) for (const access of ["read", "write"]) for (const path of fs[access] || []) {
    if (!fs.entries.some(entry => entry.path.type === "path" && entry.path.path === path && (entry.access === access || access === "read" && entry.access === "write"))) throw new Error("Ambiguous native file permission representations");
  }
  return { network: value.network, file_system: fs === null ? null : {
    ...(Object.hasOwn(fs, "entries") ? { entries: fs.entries } : { read: fs.read, write: fs.write }),
    ...(Object.hasOwn(value.fileSystem, "globScanMaxDepth") ? { glob_scan_max_depth: value.fileSystem.globScanMaxDepth } : {}),
  } };
}

function stdinCwd(value) {
  // Only this core action currently uses PathUri for cwd. The v2 boundary
  // exports its LegacyAppPathString; our workers are Linux/POSIX. Other action
  // paths still use native absolute strings and must not be converted.
  if (value.startsWith("/")) return pathToFileURL(value).href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  throw new Error("Native stdin approval did not provide an absolute working directory");
}

// v2 notifications use camelCase; approveGuardianDeniedAction intentionally
// accepts the serialized core GuardianAssessmentEvent (snake_case). Preserve
// the reviewed command/argv verbatim. Never rebuild a shell command or accept
// an action/event supplied by the browser.
export function guardianDeniedEvent(report) {
  if (!object(report) || !string(report.threadId) || !report.threadId || !string(report.reviewId) || !report.reviewId
    || !string(report.turnId) || !report.turnId || !integer(report.startedAtMs) || !integer(report.completedAtMs)
    || report.completedAtMs < report.startedAtMs || report.decisionSource !== "agent" || !nullable(string)(report.targetItemId)
    || JSON.stringify(report).length > 128_000) throw new Error("Invalid native automatic review");
  const review = shape(report.review, { status: oneOf("denied"), riskLevel: nullable(oneOf("low", "medium", "high", "critical")),
    userAuthorization: nullable(oneOf("unknown", "low", "medium", "high")), rationale: nullable(string) });
  const source = oneOf("shell", "unifiedExec"), a = report.action;
  let action;
  switch (a?.type) {
    case "command":
      shape(a, { type: oneOf("command"), source, command: string, cwd: string });
      action = { ...a, source: a.source === "unifiedExec" ? "unified_exec" : "shell" }; break;
    case "execve":
      shape(a, { type: oneOf("execve"), source, program: string, argv: strings, cwd: string });
      action = { ...a, source: a.source === "unifiedExec" ? "unified_exec" : "shell" }; break;
    case "writeStdin":
      shape(a, { type: oneOf("writeStdin"), approvalId: string, processId: string, stdin: string, cwd: string });
      action = { type: "write_stdin", approval_id: a.approvalId, process_id: a.processId, stdin: a.stdin, cwd: stdinCwd(a.cwd) }; break;
    case "applyPatch":
      shape(a, { type: oneOf("applyPatch"), cwd: string, files: strings });
      action = { ...a, type: "apply_patch" }; break;
    case "networkAccess":
      shape(a, { type: oneOf("networkAccess"), target: string, host: string, protocol: oneOf("http", "https", "socks5Tcp", "socks5Udp"), port: value => integer(value) && value <= 65535 });
      action = { ...a, type: "network_access", protocol: ({ socks5Tcp: "socks5_tcp", socks5Udp: "socks5_udp" })[a.protocol] || a.protocol }; break;
    case "mcpToolCall":
      shape(a, { type: oneOf("mcpToolCall"), server: string, toolName: string, connectorId: nullable(string), connectorName: nullable(string), toolTitle: nullable(string) });
      action = { type: "mcp_tool_call", server: a.server, tool_name: a.toolName, connector_id: a.connectorId, connector_name: a.connectorName, tool_title: a.toolTitle }; break;
    case "requestPermissions":
      shape(a, { type: oneOf("requestPermissions"), reason: nullable(string), permissions: object });
      action = { type: "request_permissions", reason: a.reason, permissions: permissions(a.permissions) }; break;
    default: throw new Error("Unsupported native automatic-review action");
  }
  return { id: report.reviewId, turn_id: report.turnId, target_item_id: report.targetItemId,
    started_at_ms: report.startedAtMs, completed_at_ms: report.completedAtMs, status: "denied",
    risk_level: review.riskLevel, user_authorization: review.userAuthorization, rationale: review.rationale,
    decision_source: report.decisionSource, action };
}

export class CodexApprovals {
  constructor(store, config) { this.store = store; this.config = config; this.locks = new Map(); }
  binding(chat) {
    return hash([chat.id, chat.ownerId || null, chat.agent, chat.agentSessionId || null, companyForChat(chat),
      (chat.repositories || []).map(repo => repo.fullName || `${repo.owner}/${repo.name}`), chat.environmentId || null,
      chat.workspace, this.config.codex.authMode, this.config.workerBackend, ...(chat.agentAccountId ? ["account", chat.agentAccountId] : [])]);
  }
  #chat(chatId, binding) {
    const chat = this.store.get(chatId);
    if (!chat || chat.agent !== "codex" || !chat.agentSessionId || binding && this.binding(chat) !== binding) throw conflict("The reviewed chat, project or native session changed. Refresh /approve.");
    if (!this.store.records) throw conflict("Encrypted storage is required to retain native approval reviews");
    return chat;
  }
  async #locked(chatId, task) {
    const previous = this.locks.get(chatId) || Promise.resolve();
    const running = previous.catch(() => {}).then(task); this.locks.set(chatId, running);
    try { return await running; } finally { if (this.locks.get(chatId) === running) this.locks.delete(chatId); }
  }
  async #state(chatId) {
    const chat = this.#chat(chatId), binding = this.binding(chat);
    const saved = await this.store.records.get("native-approvals", chatId); this.#chat(chatId, binding);
    return saved?.version === 1 && saved.binding === binding ? saved : { version: 1, binding, through: 0, throughIds: [], reviews: [] };
  }
  async #save(chatId, state) {
    this.#chat(chatId, state.binding); await this.store.records.put("native-approvals", chatId, state); this.#chat(chatId, state.binding);
  }
  async capture(chatId, report, binding) {
    const event = guardianDeniedEvent(report);
    return this.#locked(chatId, async () => {
      const chat = this.#chat(chatId, binding);
      if (chat.agentSessionId !== report.threadId) return;
      const state = await this.#state(chatId); this.#chat(chatId, binding);
      // Late/duplicate events cannot re-arm an already consumed approval, even
      // after bounded older display records have been removed.
      if (state.reviews.some(item => item.event.id === event.id) || event.completed_at_ms < state.through
        || event.completed_at_ms === state.through && (state.throughIds?.includes(event.id) || state.throughIds?.length >= 200)) return;
      state.throughIds = event.completed_at_ms === state.through ? [...(state.throughIds || []), event.id] : [event.id];
      state.through = event.completed_at_ms;
      state.reviews.unshift({ id: randomUUID(), revision: hash([state.binding, event]), event, state: "available" });
      const retained = new Set(state.reviews.slice(0, 20));
      state.reviews = state.reviews.filter(item => retained.has(item) || ["queued", "preparing", "applying", "approved", "retrying"].includes(item.state));
      await this.#save(chatId, state);
    });
  }
  async list(chatId) {
    const chat = this.store.get(chatId);
    if (chat?.agent !== "codex") throw conflict("Automatic-review retries require Codex");
    if (!chat.agentSessionId) return { threadId: null, reviews: [] };
    return this.#locked(chatId, async () => {
      const state = await this.#state(chatId);
      return { threadId: this.#chat(chatId, state.binding).agentSessionId, reviews: state.reviews.map(item => ({
        id: item.id, revision: item.revision, state: item.state, createdAt: item.event.completed_at_ms,
        action: redact(JSON.stringify(item.event.action, null, 2)), rationale: redact(item.event.rationale || "No reason provided."),
        risk: item.event.risk_level, authorization: item.event.user_authorization,
      })) };
    });
  }
  async queue(chatId, input, enqueue, check = () => {}) {
    return this.#locked(chatId, async () => {
      check(); const state = await this.#state(chatId); check();
      const chat = this.#chat(chatId, state.binding), item = state.reviews.find(item => item.id === input.id);
      if (chat.archived || input.confirm !== true || input.threadId !== chat.agentSessionId || !item || input.revision !== item.revision) throw conflict("Confirm a current denied action from this chat's /approve panel");
      if (item.state !== "available" && item.state !== "queued") return { id: item.id, state: item.state };
      item.state = "queued";
      item.queueId ||= `queued_${randomUUID()}`;
      await this.#save(chatId, state); check();
      await enqueue({ id: item.queueId, text: "/approve · Retry the confirmed denied action", attachmentIds: [], nativeApprovalId: item.id, createdAt: new Date().toISOString() }, () => { check(); this.#chat(chatId, state.binding); });
      return { id: item.id, state: item.state };
    });
  }
  async claim(chatId, id) {
    return this.#locked(chatId, async () => {
      const state = await this.#state(chatId), item = state.reviews.find(item => item.id === id);
      if (item?.state !== "queued") throw conflict("This approval retry is no longer queued. Refresh /approve; it will not be replayed automatically.");
      item.state = "preparing"; await this.#save(chatId, state);
      return { id, binding: state.binding, threadId: this.#chat(chatId, state.binding).agentSessionId };
    });
  }
  async cancel(chatId, id) {
    return this.#locked(chatId, async () => {
      // Removing an obsolete queue entry must still work after switching the
      // provider/company/session. Cancellation grants nothing; do not rebind
      // its old review or require the original native worker to be available.
      const state = await this.store.records?.get("native-approvals", chatId);
      const item = state?.version === 1 && state.reviews.find(item => item.id === id);
      if (this.store.get(chatId) && item && ["queued", "preparing"].includes(item.state)) {
        item.state = "cancelled"; await this.store.records.put("native-approvals", chatId, state);
      }
    });
  }
  async retry(chatId, claim, adapter, send, check) {
    // The durable phases deliberately fail closed after interruption/crash.
    // Codex's approval RPC has no idempotency key; an uncertain write must not
    // be repeated, nor may a possibly-started retry be silently sent twice.
    const transition = next => this.#locked(chatId, async () => {
      const state = await this.#state(chatId); this.#chat(chatId, claim.binding);
      const item = state.reviews.find(item => item.id === claim.id);
      if (!item) throw conflict("This native review is no longer available");
      const allowed = { applying: ["preparing"], approved: ["applying"], retrying: ["approved"], completed: ["retrying"], uncertain: ["applying", "approved", "retrying"], cancelled: ["preparing", "applying"] };
      if (!allowed[next]?.includes(item.state)) throw conflict("This approval was already consumed or cancelled. Refresh /approve.");
      item.state = next; await this.#save(chatId, state); return structuredClone(item.event);
    });
    const guard = () => {
      check(); const chat = this.#chat(chatId, claim.binding);
      if (adapter.threadId !== claim.threadId || chat.agentSessionId !== claim.threadId) throw conflict("The reviewed native session changed before retrying");
    };
    let dispatched = false;
    try {
      guard();
      if (!adapter.approveDeniedAction) throw new Error("Update this Codex worker to support native automatic-review retries");
      const event = await transition("applying"); guard();
      dispatched = true;
      await adapter.approveDeniedAction(event, guard); guard();
      await transition("approved"); guard();
      await transition("retrying"); guard();
      const result = await send();
      await transition("completed"); return result;
    } catch (error) {
      await transition(dispatched ? "uncertain" : "cancelled").catch(() => {});
      if (dispatched) throw new Error("The approved retry did not finish cleanly. Approval or input may already have reached Codex; it will not be repeated automatically. Inspect the chat before requesting another retry.");
      throw error;
    }
  }
}
