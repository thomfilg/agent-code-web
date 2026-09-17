import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";

// A private, unauthenticated native profile: check the installed protocol and
// empty-catalog behavior without reading the host account or calling a model.
const directory = await mkdtemp("/tmp/relay-native-apps-smoke-");
let requests = 0;
const server = http.createServer((request, response) => { requests++; response.writeHead(503); response.end(); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused", CODEX_MODEL: "gpt-5.4" });
const store = new ChatStore(directory); await store.initialize();
const chat = await store.create({ agent: "codex", title: "Native apps protocol fixture" }); await mkdir(chat.workspace, { recursive: true });
const adapter = new CodexAdapter({ chat, store, config, broker: new CapabilityBroker({ ttlMs: 120000 }), gatewayOrigin: `http://127.0.0.1:${server.address().port}`, hooks: { onFatal: () => {}, onRequest: () => assert.fail("App listing must not request tools") } });
const timeout = setTimeout(() => { void adapter.stop(); server.closeAllConnections(); }, 45000);
try {
  await adapter.start();
  const catalog = await adapter.apps.list();
  assert.equal(catalog.threadId, adapter.threadId); assert.deepEqual(catalog.apps, []);
  await assert.rejects(adapter.apps.select("not_installed", adapter.threadId), /no longer accessible/);
  assert.equal(requests, 0, "App discovery must not call the model");
  console.log("Native apps protocol passed: scoped app/list + app/installed, empty private profile, denied unknown selection, and zero inference. Authenticated account invocation is not exercised by this smoke.");
} finally {
  clearTimeout(timeout); await adapter.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
