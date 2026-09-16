import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";
import { desktopInfo } from "../src/desktop-handoff.mjs";

// Actual installed CLI, disposable private profile, one loopback seed response.
// Never launches a desktop app, reads personal profiles or uses model accounts.
const directory = await mkdtemp("/tmp/relay-desktop-handoff-");
let requests = 0, adapter, timeout;
const server = http.createServer(async (request, response) => {
  request.resume();
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  requests++;
  if (requests !== 1) { response.writeHead(500); response.end("Handoff inspection must not send model input"); return; }
  const item = { type: "message", id: "msg_desktop_seed", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Disposable desktop handoff fixture.", annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: "resp_desktop_seed", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_desktop_seed", status: "completed", output: [item], usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-only" });
  const store = new ChatStore(directory); await store.initialize();
  const chat = await store.create({ agent: "codex", title: "Disposable desktop handoff" }); await mkdir(chat.workspace, { recursive: true });
  const broker = new CapabilityBroker({ ttlMs: 120000 });
  const create = agentSessionId => new CodexAdapter({ chat: { ...chat, agentSessionId }, store, config, broker, gatewayOrigin: `http://127.0.0.1:${server.address().port}`,
    hooks: { onRequest: () => assert.fail("No tools expected"), onFatal: () => {} } });
  adapter = create(null); timeout = setTimeout(() => { void adapter?.stop(); server.closeAllConnections(); }, 45000);
  await adapter.start(); await adapter.send("Seed this disposable fixture; do not use tools.");
  const threadId = adapter.threadId, before = (await adapter.rpc.request("thread/read", { threadId, includeTurns: true })).thread.turns;
  const location = await adapter.desktopSession();
  assert.equal(location.threadId, threadId); assert.equal(location.workspace, chat.workspace); assert.equal(location.profile, adapter.nativeHome);
  assert(location.profile.startsWith(directory + "/")); assert.equal(requests, 1);
  const privateInfo = desktopInfo({ ...chat, agentSessionId: threadId }, location, { awake: true });
  assert.equal(privateInfo.url, null); assert.equal(privateInfo.privateProfile, true); assert.match(privateInfo.reason, /private Relay worker profile/);
  const after = (await adapter.rpc.request("thread/read", { threadId, includeTurns: true })).thread.turns;
  assert.deepEqual(after, before, "Inspection must not alter the native transcript");
  await adapter.stop(); adapter = create(threadId); await adapter.start();
  const resumed = await adapter.desktopSession(); assert.equal(resumed.threadId, threadId); assert.equal(resumed.profile, location.profile);
  assert.equal(requests, 1, "Resume and read-only inspection must not send another model request");
  console.log(`Installed Codex ${adapter.cliVersion}: same-session locator verified before/after resume; transcript unchanged; private-profile gate retained. One local fixture seed response, zero external model calls. OS desktop launch remains unverified.`);
} finally {
  clearTimeout(timeout); await adapter?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
