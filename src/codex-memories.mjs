import { createHash } from "node:crypto";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(JSON.stringify(value, (_, item) => record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
const definitions = [
  { id: "feature", name: "Local memories", key: "features.memories", defaultEnabled: false },
  { id: "use", name: "Use memories", key: "memories.use_memories", defaultEnabled: true },
  { id: "generate", name: "Generate memories", key: "memories.generate_memories", defaultEnabled: true },
];
const lockedSources = new Set(["project", "sessionFlags", "mdm", "enterpriseManaged", "legacyManagedConfigTomlFromFile", "legacyManagedConfigTomlFromMdm"]);

export class CodexMemories {
  constructor({ request, workspace, thread, mutable = false, busy = () => false }) {
    Object.assign(this, { workspace, thread, mutable, busy });
    this.changing = false; this.needsRefresh = false; this.nextSessionRequired = false;
    this.currentThreadGeneration = null; this.pendingGeneration = null; this.resetUncertain = false;
    this.request = async (method, params) => {
      try { return await request(method, params); }
      catch { throw new Error(`Native memory operation ${method} failed. Refresh /memories before retrying.`); }
    };
  }

  async #snapshot(check) {
    check(); const threadId = this.thread();
    if (!threadId) throw conflict("Connect this chat's native session before reviewing memories");
    const flags = [], cursors = new Set(); let cursor, complete = false;
    for (let page = 0; page < 5; page++) {
      const result = await this.request("experimentalFeature/list", { threadId, limit: 100, ...(cursor ? { cursor } : {}) }); check();
      if (!Array.isArray(result?.data) || result.data.length > 100 || (result.nextCursor != null && typeof result.nextCursor !== "string")) throw new Error("Codex returned an invalid memory feature catalog");
      flags.push(...result.data.filter(item => item?.name === "memories"));
      cursor = result.nextCursor;
      if (!cursor) { complete = true; break; }
      if (cursors.has(cursor) || cursor.length > 4000) throw new Error("Native memory feature pagination did not advance");
      cursors.add(cursor);
    }
    const requirements = await this.request("configRequirements/read", {}); check();
    const config = await this.request("config/read", { cwd: this.workspace, includeLayers: false }); check();
    if (threadId !== this.thread()) throw conflict("The native session changed; refresh /memories");
    if (!record(config?.config) || !record(config.origins)) throw new Error("Codex did not return memory configuration origins");
    const requirementsKnown = requirements?.requirements === null || (record(requirements?.requirements) && (requirements.requirements.featureRequirements === null || (record(requirements.requirements.featureRequirements) && Object.values(requirements.requirements.featureRequirements).every(value => typeof value === "boolean"))));
    const pinned = requirements?.requirements?.featureRequirements || {};
    const policyKnown = requirementsKnown && (!Object.hasOwn(pinned, "memories") || (flags.length === 1 && flags[0].enabled === pinned.memories));
    const supported = complete && flags.length === 1 && ["stable", "beta", "underDevelopment"].includes(flags[0].stage) && typeof flags[0].enabled === "boolean";
    const memoryConfig = config.config.memories;
    const origins = Object.fromEntries(Object.entries(config.origins).filter(([key]) => key === "features" || key === "features.memories" || key === "features.memories.enabled" || key === "memories" || key.startsWith("memories.")));
    const controls = definitions.map(definition => {
      const origin = origins[`${definition.key}.enabled`] || origins[definition.key] || origins[definition.key.split(".")[0]];
      const source = origin?.name?.type || "default";
      const value = definition.id === "feature" ? flags[0]?.enabled : memoryConfig == null ? definition.defaultEnabled : record(memoryConfig) ? memoryConfig[definition.key.split(".")[1]] ?? definition.defaultEnabled : null;
      const locked = lockedSources.has(source) || (source === "user" && Boolean(origin.name.profile)) || (definition.id === "feature" && Object.hasOwn(pinned, "memories"));
      const known = ["default", "packagedDefaults", "system", "user"].includes(source) || lockedSources.has(source);
      const changeable = this.mutable && supported && policyKnown && known && !locked && typeof value === "boolean";
      return { id: definition.id, name: definition.name, enabled: typeof value === "boolean" ? value : null, defaultEnabled: definition.defaultEnabled,
        locked, actions: changeable ? [value ? "disable" : "enable"] : [],
        reason: !this.mutable ? "Shared host profile — inspection only" : !supported ? "Native memory feature metadata is unavailable or ambiguous" : !policyKnown || !known ? "Native memory policy is unavailable" : locked ? "Controlled by native policy, a project override or session configuration" : typeof value !== "boolean" ? "Native memory settings are incomplete" : "" };
    });
    return { threadId, revision: hash({ threadId, workspace: this.workspace, flags, complete, controls, origins, pinned, policyKnown, memoryConfig }), controls,
      mutable: this.mutable, busy: this.busy(), nextSessionRequired: this.nextSessionRequired, currentThreadGeneration: this.currentThreadGeneration,
      resetAllowed: this.mutable && supported && policyKnown,
      externalContextExcluded: Boolean(memoryConfig?.disable_on_external_context ?? memoryConfig?.no_memories_if_mcp_or_web_search ?? false),
      warning: this.resetUncertain ? "The previous reset did not finish cleanly. Some saved memory files may already have been removed." : !policyKnown ? "Cannot verify native admin requirements. Memory changes are disabled." : "" };
  }

  async #setGeneration(threadId, value, check) {
    this.pendingGeneration = { threadId, value }; this.currentThreadGeneration = null;
    await this.request("thread/memoryMode/set", { threadId, mode: value ? "enabled" : "disabled" }); check();
    if (threadId !== this.thread()) throw conflict("The native session changed before its memory choice was applied");
    this.pendingGeneration = null; this.currentThreadGeneration = value;
  }

  async list(check = () => {}) {
    check();
    if (this.changing) throw conflict("Wait for the current memory change to finish");
    if (this.needsRefresh && this.busy()) throw conflict("Wait for the agents to be idle before reconciling memory state");
    if (!this.mutable || this.busy()) return this.#snapshot(check);
    const threadId = this.thread(); if (!threadId) throw conflict("Connect this chat's native session before reviewing memories");
    this.changing = true;
    try {
      this.needsRefresh = true;
      await this.request("config/batchWrite", { edits: [], reloadUserConfig: true }); check();
      let result = await this.#snapshot(check);
      if (threadId !== result.threadId) throw conflict("The native session changed; refresh /memories");
      if (this.pendingGeneration) {
        const pending = this.pendingGeneration;
        if (pending.threadId !== threadId) throw conflict("The pending memory choice belongs to a different native session");
        const feature = result.controls.find(item => item.id === "feature"), generation = result.controls.find(item => item.id === "generate");
        if (!generation.actions.length || feature.enabled === null) throw conflict("Native policy changed; the pending memory choice cannot be reconciled");
        // Never re-enable contribution when the saved choice or feature changed.
        await this.#setGeneration(threadId, pending.value && feature.enabled && generation.enabled, check);
        result = await this.#snapshot(check);
      }
      this.needsRefresh = false; return result;
    } finally { this.changing = false; }
  }

  async change(input, check = () => {}) {
    if (!this.mutable) throw conflict("Memory changes require a private chat profile. Shared host configuration is read-only.");
    if (this.changing || this.busy()) throw conflict("Wait for this chat and its agents to be idle before changing memories");
    if (this.needsRefresh) throw conflict("Refresh /memories to reconcile the previous memory change before retrying");
    const definition = definitions.find(item => item.id === input?.id), reset = input?.id === "reset" && input.action === "reset";
    if ((!reset && (!definition || !["enable", "disable"].includes(input.action))) || input.confirm !== true) throw new Error("Choose and confirm a memory action from this chat's native controls");
    if (input.threadId !== this.thread() || typeof input.revision !== "string") throw conflict("The native session changed; refresh /memories");
    this.changing = true;
    try {
      const before = await this.#snapshot(check); check();
      if (this.busy()) throw conflict("Wait for this chat and its agents to be idle before changing memories");
      if (before.revision !== input.revision) throw conflict("The native memory configuration changed. Refresh and confirm again.");
      if (reset ? !before.resetAllowed : !before.controls.find(item => item.id === input.id)?.actions.includes(input.action)) throw conflict("This native memory change is not permitted");
      this.needsRefresh = true;
      if (reset) {
        this.resetUncertain = true; await this.request("memory/reset"); check();
        const after = await this.#snapshot(check);
        this.resetUncertain = false; this.needsRefresh = false; return { ...after, warning: "", reset: true };
      }
      const enabled = input.action === "enable";
      const changesGeneration = input.id === "generate" || input.id === "feature";
      const desiredGeneration = changesGeneration && enabled && before.controls.find(item => item.id === (input.id === "feature" ? "generate" : "feature")).enabled === true;
      // Opt out the current thread before saving defaults. A failed write must
      // not undo that opt-out or claim that defaults were saved.
      if (changesGeneration && !desiredGeneration) await this.#setGeneration(before.threadId, false, check);
      this.nextSessionRequired ||= input.id !== "generate";
      const write = await this.request("config/batchWrite", { edits: [{ keyPath: definition.key, value: enabled, mergeStrategy: "replace" }], reloadUserConfig: true }); check();
      let after = await this.#snapshot(check), actual = after.controls.find(item => item.id === input.id);
      if (write?.status !== "ok" || !actual?.actions.length || actual.enabled !== enabled) throw conflict("The memory write was overridden or its effective state could not be verified. Refresh before retrying.");
      if (changesGeneration && desiredGeneration) {
        await this.#setGeneration(before.threadId, true, check); after = await this.#snapshot(check);
        // A concurrent native opt-out must win over this in-flight opt-in.
        if (!after.controls.find(item => item.id === "feature")?.enabled || !after.controls.find(item => item.id === "generate")?.enabled) {
          await this.#setGeneration(before.threadId, false, check);
          throw conflict("Native memory preferences changed during the update. Current chat contribution was disabled; refresh before retrying.");
        }
        actual = after.controls.find(item => item.id === input.id);
        if (!actual?.actions.length || actual.enabled !== enabled) throw conflict("Native memory policy changed during the update. Refresh before retrying.");
      }
      this.needsRefresh = false; return after;
    } finally { this.changing = false; }
  }
}
