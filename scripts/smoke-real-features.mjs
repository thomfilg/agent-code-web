import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";

// No host profile, credentials or inference. Only this fixture's native config
// is changed; the local model endpoint must receive zero requests.
const directory = await mkdtemp("/tmp/relay-native-features-smoke-");
let requests = 0;
const server = http.createServer((request, response) => { requests++; response.writeHead(503); response.end(); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused", CODEX_MODEL: "gpt-5.4" });
const store = new ChatStore(directory); await store.initialize();
const chat = await store.create({ agent: "codex", title: "Native feature fixture" }); await mkdir(chat.workspace, { recursive: true });
const adapter = new CodexAdapter({ chat, store, config, broker: new CapabilityBroker({ ttlMs: 120000 }), gatewayOrigin: `http://127.0.0.1:${server.address().port}`, hooks: { onFatal: () => {}, onRequest: () => assert.fail("Feature controls must not invoke model tools") } });
const timeout = setTimeout(() => { void adapter.stop(); server.closeAllConnections(); }, 45000);
try {
  await adapter.start();
  let catalog = await adapter.featureControls.list();
  assert.equal(catalog.threadId, adapter.threadId); assert.equal(catalog.mutable, true); assert.equal(catalog.restartRequired, false);
  const selected = id => catalog.features.find(feature => feature.id === id);
  const change = async (id, action) => { catalog = await adapter.featureControls.change({ id, action, confirm: true, threadId: catalog.threadId, revision: catalog.revision }); };
  const unchangedConfig = async () => {
    const result = await adapter.rpc.request("config/read", { cwd: chat.workspace, includeLayers: false });
    return Object.fromEntries(["model", "model_provider", "approval_policy", "sandbox_mode", "sandbox_workspace_write", "mcp_servers"].map(key => [key, result.config[key]]));
  };
  const before = await unchangedConfig(), old = catalog;
  for (const id of ["network_proxy", "worktrees", "prevent_idle_sleep"]) {
    assert.ok(selected(id), `Installed native beta flag missing: ${id}`);
    await change(id, "enable"); assert.equal(selected(id).enabled, true); assert.equal(catalog.restartRequired, true);
    assert.deepEqual(await unchangedConfig(), before, "Feature changes must not alter model, approval, sandbox or MCP configuration");
  }
  await assert.rejects(adapter.featureControls.change({ id: "network_proxy", action: "disable", confirm: true, threadId: old.threadId, revision: old.revision }), /configuration changed/);
  await adapter.stop(); await adapter.start(); catalog = await adapter.featureControls.list();
  assert.equal(catalog.restartRequired, false);
  for (const id of ["network_proxy", "worktrees", "prevent_idle_sleep"]) { assert.equal(selected(id).enabled, true); await change(id, "disable"); assert.equal(selected(id).enabled, false); }
  await change("network_proxy", "enable");
  // A trusted project override must be reflected in this loaded thread and
  // must not be silently overwritten through the private user-level toggle.
  execFileSync("git", ["init", "-q", chat.workspace]); await mkdir(path.join(chat.workspace, ".codex"));
  await writeFile(path.join(chat.workspace, ".codex/config.toml"), "[features]\nnetwork_proxy = false\n");
  await adapter.rpc.request("config/batchWrite", { edits: [{ keyPath: `projects.${JSON.stringify(chat.workspace)}.trust_level`, value: "trusted", mergeStrategy: "replace" }], reloadUserConfig: true });
  await adapter.stop(); await adapter.start(); catalog = await adapter.featureControls.list();
  assert.equal(selected("network_proxy").enabled, false); assert.equal(selected("network_proxy").source, "project"); assert.deepEqual(selected("network_proxy").actions, []);
  await assert.rejects(change("network_proxy", "enable"), /not permitted/);
  const saved = await readFile(path.join(store.runtimeHome(chat.id), "codex/config.toml"), "utf8"); assert.match(saved, /network_proxy = true/, "A project override does not replace the saved user choice");
  assert.equal(requests, 0);
  console.log("PASS: installed Codex beta catalog, toggles, native config reload, restart persistence, stale-state rejection and trusted project override; no inference or host-account changes.");
} finally {
  clearTimeout(timeout); await adapter.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
