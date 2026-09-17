import { createHash } from "node:crypto";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
// Native config maps need not retain JSON key order between reads.
const hash = value => createHash("sha256").update(JSON.stringify(value, (_, item) => record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
const clean = (value, limit) => typeof value === "string" ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").slice(0, limit) : "";
const validName = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const lockedSources = new Set(["project", "sessionFlags", "mdm", "enterpriseManaged", "legacyManagedConfigTomlFromFile", "legacyManagedConfigTomlFromMdm"]);

export class CodexFeatures {
  constructor({ request, workspace, thread, mutable = false, busy = () => false }) {
    Object.assign(this, { workspace, thread, mutable, busy });
    this.changing = false; this.needsRefresh = false; this.restartRequired = false;
    this.request = async (method, params) => {
      try { return await request(method, params); }
      catch { throw new Error(`Native feature operation ${method} failed. Refresh and check the worker's Codex version before retrying.`); }
    };
  }

  async #snapshot(check) {
    check(); const threadId = this.thread();
    if (!threadId) throw conflict("Connect this chat's native session before reviewing features");
    const features = new Map(), duplicates = new Set(), cursors = new Set(); let cursor, truncated = false;
    for (let page = 0; page < 5; page++) {
      const result = await this.request("experimentalFeature/list", { threadId, limit: 100, ...(cursor ? { cursor } : {}) }); check();
      if (!Array.isArray(result?.data) || result.data.length > 100 || (result.nextCursor != null && typeof result.nextCursor !== "string")) throw new Error("Codex returned an invalid native feature catalog");
      for (const feature of result.data) {
        if (typeof feature?.name !== "string" || feature.name.length > 200) continue;
        if (features.has(feature.name)) duplicates.add(feature.name); else features.set(feature.name, feature);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor) || cursor.length > 4000) throw new Error("Native feature pagination did not advance");
      cursors.add(cursor); if (page === 4) truncated = true;
    }
    const requirements = await this.request("configRequirements/read", {}); check();
    const config = await this.request("config/read", { cwd: this.workspace, includeLayers: false }); check();
    if (threadId !== this.thread()) throw conflict("The native session changed; refresh the feature picker");
    if (!record(config?.config) || !record(config.origins)) throw new Error("Codex did not return feature configuration origins");
    const policyKnown = requirements?.requirements === null || (record(requirements?.requirements) && (requirements.requirements.featureRequirements === null || (record(requirements.requirements.featureRequirements) && Object.values(requirements.requirements.featureRequirements).every(value => typeof value === "boolean"))));
    const pinned = record(requirements?.requirements?.featureRequirements) ? requirements.requirements.featureRequirements : {};
    const beta = [...features.values()].filter(feature => feature.stage === "beta").sort((a, b) => a.name.localeCompare(b.name));
    const origins = Object.fromEntries(Object.entries(config.origins).filter(([key]) => key === "features" || key.startsWith("features.")));
    const items = beta.slice(0, 200).map(feature => {
      const origin = origins[`features.${feature.name}.enabled`] || origins[`features.${feature.name}`] || origins.features;
      const source = origin?.name?.type || "default", pinnedValue = Object.hasOwn(pinned, feature.name);
      const locked = pinnedValue || lockedSources.has(source) || (source === "user" && Boolean(origin.name.profile));
      const complete = validName(feature.name) && typeof feature.enabled === "boolean" && typeof feature.defaultEnabled === "boolean" && typeof feature.displayName === "string" && feature.displayName.length > 0 && feature.displayName.length <= 160 && typeof feature.description === "string" && feature.description.length <= 2000;
      const knownSource = ["default", "packagedDefaults", "system", "user"].includes(source) || lockedSources.has(source);
      const changeable = this.mutable && complete && policyKnown && knownSource && !locked && !duplicates.has(feature.name) && !truncated && beta.length <= 200;
      return { id: feature.name, name: clean(feature.displayName || feature.name, 160), description: clean(feature.description, 2000), announcement: clean(feature.announcement, 2000), enabled: typeof feature.enabled === "boolean" ? feature.enabled : null, defaultEnabled: typeof feature.defaultEnabled === "boolean" ? feature.defaultEnabled : null,
        source: clean(source, 80), locked, actions: changeable ? [feature.enabled ? "disable" : "enable"] : [],
        reason: !this.mutable ? "Shared host profile — inspection only" : !policyKnown || !knownSource ? "Native feature policy is unavailable" : locked ? "Controlled by native policy, a project override or session configuration" : duplicates.has(feature.name) ? "Ambiguous native feature identity" : truncated || beta.length > 200 ? "The native catalog is incomplete; changes are unavailable" : !complete ? "Native feature metadata is incomplete or unsupported" : "" };
    });
    return { threadId, revision: hash({ threadId, workspace: this.workspace, beta, origins, pinned, policyKnown, duplicates: [...duplicates], truncated }), features: items,
      mutable: this.mutable, busy: this.busy(), restartRequired: this.restartRequired, truncated: truncated || beta.length > 200,
      warning: !policyKnown ? "Cannot verify native admin requirements. Feature changes are disabled." : "" };
  }

  async list(check = () => {}) {
    check(); const threadId = this.thread();
    if (!threadId) throw conflict("Connect this chat's native session before reviewing features");
    if (this.changing) throw conflict("Wait for the current feature change to finish");
    if (this.needsRefresh && this.busy()) throw conflict("Wait for the agents to be idle before reconciling feature state");
    if (this.mutable && !this.busy()) {
      this.changing = true;
      try {
        this.needsRefresh = true; await this.request("config/batchWrite", { edits: [], reloadUserConfig: true }); check();
        if (threadId !== this.thread()) throw conflict("The native session changed; refresh the feature picker");
        this.needsRefresh = false;
      } finally { this.changing = false; }
    }
    return this.#snapshot(check);
  }

  async change(input, check = () => {}) {
    if (!this.mutable) throw conflict("Feature changes require a private chat profile. Shared host configuration is read-only.");
    if (this.changing || this.busy()) throw conflict("Wait for this chat and its agents to be idle before changing features");
    if (this.needsRefresh) throw conflict("Refresh /experimental to reconcile the previous feature change before retrying");
    if (!validName(input?.id) || !["enable", "disable"].includes(input.action) || input.confirm !== true) throw new Error("Choose and confirm a feature from this chat's native picker");
    if (input.threadId !== this.thread() || typeof input.revision !== "string") throw conflict("The native session changed; refresh the feature picker");
    this.changing = true;
    try {
      const before = await this.#snapshot(check); check();
      if (this.busy()) throw conflict("Wait for this chat and its agents to be idle before changing features");
      if (before.revision !== input.revision) throw conflict("The native feature configuration changed. Refresh and confirm again.");
      const selected = before.features.find(feature => feature.id === input.id);
      if (!selected?.actions.includes(input.action)) throw conflict("This native feature change is not permitted");
      this.needsRefresh = true; this.restartRequired = true;
      const result = await this.request("config/batchWrite", { edits: [{ keyPath: `features.${selected.id}`, value: input.action === "enable", mergeStrategy: "replace" }], reloadUserConfig: true }); check();
      const after = await this.#snapshot(check), actual = after.features.find(feature => feature.id === input.id);
      if (result?.status !== "ok" || !actual || actual.locked || actual.enabled !== (input.action === "enable") || !actual.actions.length) throw conflict("The feature write was overridden or its effective state could not be verified. Refresh before retrying.");
      this.needsRefresh = false; return after;
    } finally { this.changing = false; }
  }
}
