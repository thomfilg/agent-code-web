import { createHash } from "node:crypto";
import { companyForChat } from "../public/company-scope.js";
import { CodexImports } from "./codex-imports.mjs";
import { inspectCodexImportFiles } from "./codex-import-files.mjs";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Reconciliation reloads only the saved configuration. It does not approve
// hooks, authenticate imported MCPs, start a turn or restart the worker.
export async function reconcileCodexImport({ request, workspace, inspect, changed }, input, check) {
  check(); await inspect({ source: input.source, includeHome: true }, check); check();
  try {
    const policy = await request("configRequirements/read", {}); check();
    if (policy?.requirements !== null && !record(policy?.requirements)) throw new Error();
    const reload = await request("config/batchWrite", { edits: [], reloadUserConfig: true }); check();
    if (reload?.status !== "ok") throw new Error();
    const config = await request("config/read", { cwd: workspace, includeLayers: false }); check();
    if (!record(config?.config) || !record(config.origins)) throw new Error();
    const hooks = await request("hooks/list", { cwds: [workspace] }); check();
    if (!Array.isArray(hooks?.data) || hooks.data.length !== 1 || hooks.data[0].cwd !== workspace || !Array.isArray(hooks.data[0].hooks) || hooks.data[0].errors?.length) throw new Error();
  } catch {
    check(); throw conflict("The imported configuration could not be reconciled with native policy. Review its files, then refresh /import; no import or authorization was repeated.");
  }
  await changed(); check();
}

export async function createCodexImportControls(adapter, env, rpc, workerId) {
  const { store, config, chat, executor, workspace } = adapter;
  // No plaintext or memory-only fallback for tracking an external write.
  if (!store.records) return null;
  const scope = current => [current.id, current.ownerId || null, current.agent, companyForChat(current), current.environmentId || null,
    current.agentAccountId || null, adapter.nativeAuthMode || config.codex.authMode, executor?.metadata?.backend || "local", workspace, env.HOME, env.CODEX_HOME];
  const identity = JSON.stringify(scope(chat));
  const binding = createHash("sha256").update(identity).digest("hex");
  const scopeCheck = () => {
    const current = store.get(chat.id);
    if (!current || JSON.stringify(scope(current)) !== identity) throw conflict("The native import owner, company or profile changed");
  };
  const liveCheck = () => {
    scopeCheck();
    if (adapter.rpc !== rpc || adapter.intentionalStop) throw conflict("The native import worker stopped or changed");
  };
  scopeCheck(); const saved = await store.records.get("native-import", chat.id); scopeCheck();
  const request = async (method, params) => { liveCheck(); const result = await rpc.request(method, params, 30000); liveCheck(); return result; };
  const inspect = async (input, check) => {
    const guard = () => { liveCheck(); check(); };
    return inspectCodexImportFiles(executor, { ...input, workspace, home: env.HOME, codexHome: env.CODEX_HOME }, guard);
  };
  return new CodexImports({ workspace, home: env.HOME, binding, workerId, saved: saved ?? null,
    mutable: (adapter.nativeAuthMode || config.codex.authMode) !== "host", thread: () => adapter.threadId,
    busy: () => adapter.nativeSettingsBusy() || [adapter.plugins, adapter.hookControls, adapter.featureControls, adapter.memoryControls].some(service => service?.changing || service?.needsRefresh),
    request, inspect,
    save: async state => { scopeCheck(); await store.records.put("native-import", chat.id, state); scopeCheck(); },
    reconcile: (input, check) => reconcileCodexImport({ request, workspace, inspect, changed: () => adapter.refreshSkills() }, input, () => { liveCheck(); check(); }),
  });
}
