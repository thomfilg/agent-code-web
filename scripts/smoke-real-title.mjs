import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";
import { prepareWorkspace } from "../src/workspace.mjs";
import { titleItemValue } from "../public/tab-title.js";

// Installed Codex 0.154.0 exposes goal tools, not update_plan (also absent with
// goals disabled). Test its real title-progress source. Optional legacy plan
// notifications are covered separately by the generated-schema protocol fixture.
const root = await mkdtemp("/tmp/relay-title-smoke-");
let requests = 0, adapter, timeout;
const server = http.createServer((request, response) => {
  requests++; request.resume(); response.writeHead(500); response.end("This test must never request inference.");
});
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused" });
  const store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ agent: "codex", title: "Isolated title fixture" }); await prepareWorkspace({ destination: chat.workspace });
  const events = [];
  adapter = new CodexAdapter({ chat, store, config, broker: new CapabilityBroker({ ttlMs: 60000 }), gatewayOrigin: `http://127.0.0.1:${server.address().port}`,
    hooks: { onEvent: event => events.push(event), onRequest: () => assert.fail("Title metadata never needs tool approval"), onFatal: () => {} } });
  timeout = setTimeout(() => { void adapter.stop(); }, 45000);
  await adapter.start();
  for (const [status, expected] of [["paused", "Goal paused"], ["active", "Goal active"], ["blocked", "Goal blocked"], ["usageLimited", "Goal usage-limited"], ["budgetLimited", "Goal budget-limited"], ["complete", "Goal complete"]]) {
    const goal = await adapter.goalAction("set", "Private objective must not enter the tab title", status);
    assert.equal(goal.status, status);
    const title = titleItemValue("task-progress", { agent: "codex", agentSessionId: adapter.threadId, goal });
    assert.equal(title, expected); assert(!title.includes(goal.objective));
    assert.equal(events.filter(event => event.type === "goal" && event.goal).at(-1).goal.status, status);
  }
  await adapter.goalAction("clear");
  assert.equal(titleItemValue("task-progress", { agent: "codex", agentSessionId: adapter.threadId, goal: adapter.goal }), "Progress not reported");
  assert.equal(requests, 0, "Reading/changing this empty fixture goal must not request a model");
  console.log(`Installed Codex ${adapter.cliVersion}: all six native goal states and clearing feed the tab-title progress field; no objective exposure, model calls or real credentials.`);
} finally {
  clearTimeout(timeout); await adapter?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}
