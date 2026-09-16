import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";

// Real CLI + synthetic stored descendant fixtures + loopback Responses server.
// No model account, actual delegated work, live chat or personal profile.
const directory = await mkdtemp("/tmp/relay-agent-navigation-");
const requests = [], snapshots = []; let counter = 0;
const server = http.createServer(async (request, response) => {
  let body = ""; for await (const chunk of request) body += chunk;
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  const data = JSON.parse(body); requests.push(data);
  const marker = /NATIVE_AGENT_\w+/.exec(JSON.stringify(data.input.filter(item => item.role === "user").at(-1)))?.[0] || "unknown";
  if (marker === "NATIVE_AGENT_HOLD") return; // Explicit child-stop verification.
  const id = ++counter, text = `Received ${marker}`;
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_${id}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-only", CODEX_MODEL: "gpt-5.4" });
const store = new ChatStore(directory); await store.initialize();
const chat = await store.create({ agent: "codex", title: "Private agent-navigation fixture" }); await mkdir(chat.workspace, { recursive: true });
const broker = new CapabilityBroker({ ttlMs: 120000 });
let adapter;
const create = agentSessionId => new CodexAdapter({ chat: { ...chat, agentSessionId }, store, config, broker, gatewayOrigin: `http://127.0.0.1:${server.address().port}`,
  hooks: { onAgentThreads: snapshot => snapshots.push(snapshot), onRequest: () => assert.fail("No tools expected"), onFatal: () => {} } });
const wait = async predicate => { const end = Date.now() + 10000; while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error("Native fixture condition timed out"); };
const timeout = setTimeout(() => { void adapter?.stop(); server.closeAllConnections(); }, 60000);
try {
  adapter = create(null); await adapter.start(); await adapter.send("NATIVE_AGENT_SEED");
  const rootId = adapter.threadId;
  const { thread } = await adapter.rpc.request("thread/read", { threadId: rootId });
  await adapter.stop();
  const seed = await readFile(thread.path, "utf8");
  const childId = randomUUID(), nestedId = randomUUID(), otherId = randomUUID();
  for (const [id, parent, nickname] of [[childId, rootId, "Child fixture"], [nestedId, childId, "Nested fixture"], [otherId, randomUUID(), "Foreign fixture"]]) {
    const lines = seed.trim().split("\n").map(line => JSON.parse(line.replaceAll(rootId, id)));
    const meta = lines.find(line => line.type === "session_meta").payload;
    Object.assign(meta, { id, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: parent === rootId ? 1 : 2, agent_nickname: nickname, agent_role: "worker" } } }, agent_nickname: nickname, agent_role: "worker" });
    const file = path.join(path.dirname(thread.path), path.basename(thread.path).replace(rootId, id));
    await writeFile(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  }
  adapter = create(rootId); await adapter.start();
  // Handwritten stored fixtures need the native index populated, just as the
  // native spawn operation normally does. Resume joins without model input.
  for (const threadId of [childId, nestedId, otherId]) {
    const resumed = await adapter.rpc.request("thread/resume", { threadId, excludeTurns: true });
    assert.ok(resumed.thread.parentThreadId || resumed.thread.source?.subAgent?.thread_spawn?.parent_thread_id);
  }
  const before = requests.length;
  const list = await adapter.agents.refresh();
  assert.deepEqual(list.threads.map(item => item.id).sort(), [childId, nestedId].sort());
  assert.equal(requests.length, before, "Listing agents must not trigger model input");
  const selected = await adapter.agents.select(childId);
  assert.ok(selected.page.messages.some(message => message.text.includes("NATIVE_AGENT_SEED")));
  assert.equal(adapter.threadId, rootId); assert.equal(requests.length, before);
  await assert.rejects(adapter.agents.select(otherId), /not found/);
  await adapter.agents.send(childId, { requestId: "native-child-reply", text: "NATIVE_AGENT_REPLY" }, "accept_edits");
  await wait(() => adapter.agents.snapshot().threads.find(item => item.id === childId)?.messages.some(message => message.text.includes("Received NATIVE_AGENT_REPLY")));
  assert.equal(adapter.current, null, "Child turns must not replace the main adapter's current turn");
  await adapter.agents.send(childId, { requestId: "native-child-hold", text: "NATIVE_AGENT_HOLD" }, "accept_edits");
  await wait(() => adapter.agents.busy());
  await adapter.rpc.request("thread/goal/set", { threadId: childId, objective: "Keep the fixture turn active until explicitly stopped", status: "active" });
  await adapter.agents.send(childId, { requestId: "native-child-steer", text: "NATIVE_AGENT_STEER" }, "accept_edits");
  await adapter.agents.interrupt(childId);
  assert.equal((await adapter.rpc.request("thread/goal/get", { threadId: childId })).goal.status, "paused");
  assert.equal(adapter.goal, null, "Stopping a child must not alter the main goal");
  await wait(() => !adapter.agents.busy());
  assert.match((await adapter.send("NATIVE_AGENT_PARENT_ALIVE")).text, /NATIVE_AGENT_PARENT_ALIVE/);
  await adapter.stop();
  assert.equal(snapshots.at(-1).awake, false);
  console.log("Real Codex agent navigation passed: descendant filtering, nested membership, read without inference, bounded native history, direct child replies/steering, child interruption and parent survival (private loopback fixture only).");
} finally {
  clearTimeout(timeout); await adapter?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
