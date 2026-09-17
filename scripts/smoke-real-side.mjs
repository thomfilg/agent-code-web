import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";
import { installSessionBundle } from "../src/codex-session-bundle.mjs";
import { snapshotWorkspace } from "../src/workspace-snapshot.mjs";

// Real installed Codex, private temporary home, deterministic loopback model.
// No real account, live chat, repository, or personal Chrome is accessed.
const directory = await mkdtemp("/tmp/relay-side-smoke-");
let sequence = 0, releaseMain, holdSeen;
const mainWaiting = new Promise(resolve => { holdSeen = resolve; });
const requests = [];
const server = http.createServer(async (request, response) => {
  let input = ""; for await (const chunk of request) input += chunk;
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  const data = JSON.parse(input); requests.push(data);
  const last = data.input.filter(item => item.role === "user").at(-1);
  const marker = /SIDE_FIXTURE_\w+/.exec(JSON.stringify(last))?.[0] || "unknown";
  const reply = () => {
    const n = ++sequence, text = `Received ${marker}`;
    const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  if (marker === "SIDE_FIXTURE_HOLD") { releaseMain = reply; holdSeen(); }
  else if (marker !== "SIDE_FIXTURE_CANCEL") reply();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused", CODEX_MODEL: "gpt-5.4" });
const store = new ChatStore(directory); await store.initialize();
const chat = await store.create({ agent: "codex", title: "Isolated native side fixture" }); await mkdir(chat.workspace, { recursive: true });
const broker = new CapabilityBroker({ ttlMs: 120000 });
let revoked = 0; const originalRevoke = broker.revokeChat.bind(broker); broker.revokeChat = id => { revoked++; originalRevoke(id); };
const events = [], sideEvents = [];
const adapter = new CodexAdapter({ chat, store, config, broker, gatewayOrigin: `http://127.0.0.1:${server.address().port}`, hooks: { onEvent: e => events.push(e), onRequest: () => assert.fail("No tools in this fixture"), onFatal: () => {} } });
const timeout = setTimeout(() => { void adapter.stop(); server.closeAllConnections(); }, 60000);
try {
  await adapter.start();
  const parentRevocations = revoked;
  assert.match((await adapter.send("SIDE_FIXTURE_SEED")).text, /SIDE_FIXTURE_SEED/);
  await adapter.goalAction("set", "Keep the fixture goal paused", "paused", 100000);
  const main = adapter.send("SIDE_FIXTURE_HOLD"); main.catch(() => {});
  await mainWaiting;
  const mainTurn = adapter.current.turnId, goal = structuredClone(adapter.goal);
  await adapter.goalAction("resume");
  const activeGoal = structuredClone(adapter.goal);
  const child = await adapter.forkSide({ onEvent: e => sideEvents.push(e), onRequest: () => assert.fail("No side tools in this fixture"), onFatal: () => {} });
  assert.notEqual(child.threadId, adapter.threadId); assert.equal(child.rpc, adapter.rpc);
  assert.equal(child.goal, null); assert.deepEqual(await adapter.goalAction("get"), activeGoal);
  assert.match((await child.send("SIDE_FIXTURE_QUESTION")).text, /SIDE_FIXTURE_QUESTION/);
  assert.equal(adapter.current.turnId, mainTurn, "Side notifications replaced the main turn");
  assert.ok(JSON.stringify(requests.at(-1)).includes("SIDE_FIXTURE_SEED"), "Native fork lost its source context");
  assert.ok(!events.some(e => e.delta?.includes("SIDE_FIXTURE_QUESTION")), "Side text leaked to main");
  assert.equal(child.goal, null); assert.deepEqual(await adapter.goalAction("get"), activeGoal);
  await assert.rejects(child.forkSide({}), /inside a side chat/);
  await adapter.goalAction("pause");
  releaseMain(); assert.match((await main).text, /SIDE_FIXTURE_HOLD/);
  assert.ok(!sideEvents.some(e => e.delta?.includes("SIDE_FIXTURE_HOLD")), "Main text leaked to side");
  const pending = child.send("SIDE_FIXTURE_CANCEL"); const rejection = assert.rejects(pending, /interrupted|closed/);
  while (!child.current?.turnId) await new Promise(resolve => setTimeout(resolve, 10));
  await child.stop(); await rejection;
  assert.equal(revoked, parentRevocations, "Closing side revoked parent capabilities");
  assert.ok(adapter.rpc); assert.equal(adapter.children.size, 0);
  assert.match((await adapter.send("SIDE_FIXTURE_AFTER_CLOSE")).text, /SIDE_FIXTURE_AFTER_CLOSE/);
  await assert.rejects(child.send("Do not reopen"), /closed/);
  assert.equal((await adapter.goalAction("get")).objective, goal.objective);
  assert.equal(adapter.goal.status, "paused");
  console.log("Real Codex side fork: inherited context, independent concurrent replies, goal isolation, cancellation and parent survival passed (loopback fixture only).");
  if (process.argv.includes("--persistent")) {
    const target = await store.create({ agent: "codex", title: "Persistent native fork fixture" });
    await writeFile(path.join(chat.workspace, "uncommitted.txt"), "original workspace content");
    await snapshotWorkspace({ source: chat.workspace, destination: target.workspace });
    const bundle = await adapter.forkSession(target.workspace);
    await adapter.send("SIDE_FIXTURE_SOURCE_ONLY_AFTER_BRANCH");
    assert.equal(bundle.files.length, 2); assert.equal(bundle.goal.objective, goal.objective);
    await installSessionBundle(path.join(store.runtimeHome(target.id), "codex"), bundle);
    let forkAdapter;
    const probeEvents = [];
    try {
      forkAdapter = new CodexAdapter({ chat: { ...target, agentSessionId: bundle.threadId }, requireResume: true, store, config, broker, gatewayOrigin: `http://127.0.0.1:${server.address().port}`, hooks: { onEvent: e => probeEvents.push(e), onFatal: () => {} } });
      await forkAdapter.start();
      assert.equal(forkAdapter.threadId, bundle.threadId); assert.deepEqual(probeEvents.filter(e => e.type === "notice"), []);
      assert.equal(forkAdapter.goal, null, "Goals need separate transfer; they are not restored from JSONL history");
      await forkAdapter.goalAction("set", bundle.goal.objective, bundle.goal.status, bundle.goal.tokenBudget);
      assert.equal(forkAdapter.goal.tokenBudget, 100000);
      await forkAdapter.send("SIDE_FIXTURE_PERSISTENT");
      assert.match(JSON.stringify(requests.at(-1)), /SIDE_FIXTURE_SEED/);
      assert.doesNotMatch(JSON.stringify(requests.at(-1)), /SIDE_FIXTURE_SOURCE_ONLY_AFTER_BRANCH/);
      assert.ok(JSON.stringify(requests.at(-1)).includes(target.workspace), "Resumed session lost its new workspace");
      await writeFile(path.join(target.workspace, "uncommitted.txt"), "independent fork edit");
      assert.equal(await readFile(path.join(chat.workspace, "uncommitted.txt"), "utf8"), "original workspace content");
      const next = await store.create({ agent: "codex", title: "Nested fork fixture" });
      await snapshotWorkspace({ source: target.workspace, destination: next.workspace });
      const nested = await forkAdapter.forkSession(next.workspace); assert.equal(nested.files.length, 3);
      await adapter.stop(); await forkAdapter.stop();
      await rm(store.runtimeHome(chat.id), { recursive: true, force: true });
      await rm(store.runtimeHome(target.id), { recursive: true, force: true });
      await installSessionBundle(path.join(store.runtimeHome(next.id), "codex"), nested);
      const resumed = new CodexAdapter({ chat: { ...next, agentSessionId: nested.threadId }, requireResume: true, store, config, broker, gatewayOrigin: `http://127.0.0.1:${server.address().port}`, hooks: { onFatal: () => {} } });
      try {
        await resumed.start(); assert.equal(resumed.threadId, nested.threadId);
        await resumed.send("SIDE_FIXTURE_NESTED");
        assert.match(JSON.stringify(requests.at(-1)), /SIDE_FIXTURE_SEED/); assert.match(JSON.stringify(requests.at(-1)), /SIDE_FIXTURE_PERSISTENT/);
        assert.doesNotMatch(JSON.stringify(requests.at(-1)), /SIDE_FIXTURE_SOURCE_ONLY_AFTER_BRANCH/);
        assert.equal(await readFile(path.join(next.workspace, "uncommitted.txt"), "utf8"), "independent fork edit");
      } finally { await resumed.stop(); }
      console.log("Persistent native fork transfer passed: exact history boundary, nested lineage, independent profile/workspace, restored goal budget, strict resume, and continuation after source profiles were removed.");
    } finally { await forkAdapter?.stop(); }
  }
} finally {
  clearTimeout(timeout); await adapter.stop();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
