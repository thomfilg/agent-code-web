import { createHash } from "node:crypto";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Make invisible/control characters explicit while reviewing executable text.
const text = (value, limit) => typeof value === "string" ? value.slice(0, limit).replace(/[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`) : "";
const EVENTS = new Set(["preToolUse", "permissionRequest", "postToolUse", "preCompact", "postCompact", "sessionStart", "sessionEnd", "userPromptSubmit", "subagentStart", "subagentStop", "stop", "interrupt"]);
const SOURCES = new Set(["user", "project", "plugin", "sessionFlags"]);
const managedSources = new Set(["system", "mdm", "cloudRequirements", "cloudManagedConfig", "legacyManagedConfigFile", "legacyManagedConfigMdm"]);
const validHash = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);

export class CodexHooks {
  constructor({ request, workspace, thread, mutable = false, busy = () => false }) {
    Object.assign(this, { workspace, thread, mutable, busy });
    this.changing = false; this.needsRefresh = false;
    this.request = async (method, params) => {
      try { return await request(method, params); }
      catch { throw new Error(`Native hook operation ${method} failed. Refresh to check its state and verify the worker's Codex version.`); }
    };
  }

  async #snapshot(check) {
    check(); const threadId = this.thread();
    if (!threadId) throw conflict("Connect this chat's native session before reviewing hooks");
    const result = await this.request("hooks/list", { cwds: [this.workspace] }); check();
    if (threadId !== this.thread()) throw conflict("The native session changed; reopen the hook browser");
    // Never accept metadata for another directory even if the worker returns it.
    if (!Array.isArray(result?.data) || result.data.length !== 1 || result.data[0]?.cwd !== this.workspace || !Array.isArray(result.data[0]?.hooks)) throw new Error("Codex did not return hooks for this chat's workspace");
    const entry = result.data[0], hooks = new Map(), duplicate = new Set();
    for (const hook of entry.hooks) {
      if (typeof hook?.key !== "string" || !hook.key || hook.key.length > 8192) continue;
      const id = hash(hook.key);
      if (hooks.has(id)) duplicate.add(id); else hooks.set(id, hook);
    }
    const items = [...hooks].sort(([a], [b]) => a.localeCompare(b));
    const review = items.slice(0, 200).map(([id, hook]) => {
      const managed = hook.isManaged === true || hook.trustStatus === "managed" || managedSources.has(hook.source);
      const trust = ["managed", "untrusted", "trusted", "modified"].includes(hook.trustStatus) ? hook.trustStatus : "unknown";
      const supported = ["command", "mcpTool"].includes(hook.handlerType) && EVENTS.has(hook.eventName) && !(hook.handlerType === "mcpTool" && hook.eventName === "sessionEnd");
      const complete = (typeof hook.sourcePath === "string" && hook.sourcePath.length > 0 && hook.sourcePath.length <= 4000) &&
        (hook.handlerType !== "command" || (typeof hook.command === "string" && hook.command.length > 0 && hook.command.length <= 16000)) &&
        (hook.handlerType !== "mcpTool" || (typeof hook.server === "string" && hook.server.length > 0 && hook.server.length <= 200 && typeof hook.tool === "string" && hook.tool.length > 0 && hook.tool.length <= 200)) &&
        (!hook.matcher || (typeof hook.matcher === "string" && hook.matcher.length <= 4000)) && (!hook.statusMessage || (typeof hook.statusMessage === "string" && hook.statusMessage.length <= 2000));
      const known = typeof hook.enabled === "boolean" && hook.isManaged === false && SOURCES.has(hook.source) && validHash(hook.currentHash) && trust !== "unknown";
      const canChange = this.mutable && !managed && known && supported && !duplicate.has(id) && !entry.errors?.length;
      const actions = canChange ? [...(["untrusted", "modified"].includes(trust) && complete ? ["trust"] : []), ...(hook.enabled ? ["disable"] : trust === "trusted" ? ["enable"] : [])] : [];
      return { id, event: text(hook.eventName, 100), type: text(hook.handlerType, 40), source: text(hook.source, 100),
        managed, enabled: hook.enabled === true, trust, actions,
        // Native key paths, error strings and host definitions are never public.
        ...(this.mutable ? { currentHash: text(hook.currentHash, 100), sourcePath: text(hook.sourcePath, 4000), pluginId: text(hook.pluginId, 200),
          command: hook.handlerType === "command" ? text(hook.command, 16000) : "", server: text(hook.server, 200), tool: text(hook.tool, 200),
          matcher: text(hook.matcher, 4000), statusMessage: text(hook.statusMessage, 2000), async: hook.async === true,
          timeoutSec: Number.isSafeInteger(hook.timeoutSec) ? hook.timeoutSec : null, additionalContextLimit: Number.isSafeInteger(hook.additionalContextLimit) ? hook.additionalContextLimit : null, complete } : {}),
        reason: !this.mutable ? "Shared host profile — definitions hidden and inspection only" : managed ? "Managed by native policy; user controls cannot change it" : duplicate.has(id) ? "Ambiguous hook identity" : entry.errors?.length ? "Resolve native hook configuration errors before changing hooks" : !supported ? "This hook handler or event is not supported by the current native runtime" : !known ? "Native trust state is unavailable" : !complete ? "Definition exceeds the review limit; trust is unavailable" : "",
      };
    });
    return { hooks, public: { threadId, revision: hash({ threadId, workspace: this.workspace, items, errors: entry.errors || [], warnings: entry.warnings || [] }),
      hooks: review, mutable: this.mutable, busy: this.busy(), truncated: items.length > 200,
      warning: entry.errors?.length ? "Native hook configuration has errors. No hook changes are allowed until they are resolved." : entry.warnings?.length ? "The native hook configuration has warnings. Inspect its source before trusting hooks." : "" } };
  }

  async list(check = () => {}) {
    check(); const threadId = this.thread();
    if (!threadId) throw conflict("Connect this chat's native session before reviewing hooks");
    // hooks/list reads definitions on disk, but loaded native threads cache
    // them. Reload an idle private worker before showing its current state so
    // the displayed trust decision matches what its next turn will execute.
    if (this.changing) throw conflict("Wait for the current hook change to finish");
    if (this.needsRefresh && this.busy()) throw conflict("Wait for this chat and its agents to be idle before refreshing hook state");
    if (this.mutable && !this.busy()) {
      this.changing = true;
      try {
        check(); this.needsRefresh = true; await this.#reload(); check();
        if (threadId !== this.thread()) throw conflict("The native session changed; reopen the hook browser");
        this.needsRefresh = false;
      } finally { this.changing = false; }
    }
    return (await this.#snapshot(check)).public;
  }

  async change(input, check = () => {}) {
    if (!this.mutable) throw conflict("Hook changes require a private chat profile. Shared host configuration is read-only.");
    if (this.changing || this.busy()) throw conflict("Wait for this chat and its agents to be idle before changing hooks");
    if (this.needsRefresh) throw conflict("Refresh the hook browser to reconcile the previous change before retrying");
    if (!/^[a-f0-9]{64}$/.test(input?.id || "") || !["trust", "enable", "disable"].includes(input.action) || input.confirm !== true) throw new Error("Choose and confirm a hook action from this chat's hook browser");
    if (input.threadId !== this.thread() || typeof input.revision !== "string") throw conflict("The native session changed; refresh the hook browser");
    this.changing = true;
    try {
      const before = await this.#snapshot(check); check();
      if (this.busy()) throw conflict("Wait for this chat and its agents to be idle before changing hooks");
      if (input.revision !== before.public.revision) throw conflict("The hook definition or state changed. Refresh and review it again before confirming.");
      const selected = before.public.hooks.find(hook => hook.id === input.id), native = before.hooks.get(input.id);
      if (!selected?.actions.includes(input.action) || !native) throw conflict("This hook action is not permitted by native policy");
      const edit = input.action === "trust" ? { keyPath: `hooks.state.${JSON.stringify(native.key)}.trusted_hash`, value: native.currentHash, mergeStrategy: "replace" }
        : { keyPath: `hooks.state.${JSON.stringify(native.key)}.enabled`, value: input.action === "enable", mergeStrategy: "replace" };
      this.needsRefresh = true;
      await this.request("config/batchWrite", { edits: [edit], reloadUserConfig: true }); check();
      const after = await this.#snapshot(check), actual = after.hooks.get(input.id);
      if (!actual || actual.currentHash !== native.currentHash || actual.isManaged !== false || actual.trustStatus === "managed" || managedSources.has(actual.source) ||
        (input.action === "enable" && actual.trustStatus !== "trusted") ||
        (input.action === "trust" ? actual.trustStatus !== "trusted" || actual.enabled !== native.enabled : actual.enabled !== (input.action === "enable"))) throw conflict("The native hook state changed or was overridden. Refresh and review it again; the requested state was not verified.");
      this.needsRefresh = false;
      return after.public;
    } finally { this.changing = false; }
  }

  async #reload() {
    if (!this.mutable) throw conflict("Shared host configuration is read-only");
    await this.request("config/batchWrite", { edits: [], reloadUserConfig: true });
  }
}
