import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { Attachments } from "../src/attachments.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";

// Real native CLI + real controller fork workflow, private temporary profiles,
// deterministic loopback responses. No model service, live chat or user account.
const directory = await mkdtemp("/tmp/relay-native-fork-");
let sequence = 0, branchRequests = 0, release;
const waiting = Promise.withResolvers(), requests = [];
const server = http.createServer(async (request, response) => {
  let input = ""; for await (const chunk of request) input += chunk;
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  const data = JSON.parse(input); requests.push(data);
  const lastUser = JSON.stringify(data.input.filter(item => item.role === "user").at(-1));
  const branch = input.includes("REAL_FORK_BRANCH");
  if (branch && ++branchRequests > 5) { response.writeHead(429); response.end(); return; }
  const reply = () => {
    const n = ++sequence;
    const item = branch && branchRequests === 2
      ? { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: "update_goal", arguments: '{"status":"complete"}' }
      : { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Native fork fixture reply", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  if (!branch && lastUser.includes("REAL_FORK_HOLD")) { release = reply; waiting.resolve(); } else reply();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused", CODEX_MODEL: "gpt-5.4" });
const records = new MemoryRecords(), store = new ChatStore(directory, records); await store.initialize();
const broker = new CapabilityBroker({ ttlMs: 120000 }), attachments = new Attachments(records, store), adapters = new Map();
const origin = `http://127.0.0.1:${server.address().port}`;
const manager = new RuntimeManager({ store, config, broker, attachments, gatewayOrigin: origin,
  adapterFactory: params => { const adapter = new CodexAdapter({ ...params, store, config, broker, gatewayOrigin: origin }); adapters.set(params.chat.id, adapter); return adapter; },
});
const timeout = setTimeout(() => { void manager.shutdown(); server.closeAllConnections(); }, 60000);
try {
  const empty = await manager.createChat({ agent: "codex", title: "Empty source fixture" });
  const emptyCopy = await manager.forkChat(empty.id, { requestId: "empty-native-fork" });
  assert.equal(emptyCopy.messages.length, 0); assert.equal(emptyCopy.goal, null); assert.equal(requests.length, 0);
  await manager.remove(empty.id); await manager.remove(emptyCopy.id);
  const primed = await manager.createChat({ agent: "codex", title: "Opened but empty source fixture" });
  await manager.goalAction(primed.id, "clear"); // Assigns an ID, but no native rollout or user input.
  const primedCopy = await manager.forkChat(primed.id, { requestId: "primed-empty-fork" });
  assert.equal(primedCopy.messages.length, 0); assert.equal(primedCopy.goal, null); assert.equal(requests.length, 0);
  await manager.remove(primed.id); await manager.remove(primedCopy.id);
  const source = await manager.createChat({ agent: "codex", title: "Real fork source" });
  const file = await attachments.upload(source.id, { name: "notes.txt", mime: "text/plain", data: Buffer.from("attachment before fork").toString("base64") });
  const seed = await manager.submit(source.id, "REAL_FORK_SEED", [file.id]); await seed.completion;
  await writeFile(path.join(source.workspace, "uncommitted.txt"), "source workspace");
  await adapters.get(source.id).goalAction("set", "Finish the isolated fork fixture", "paused", 100000);
  const running = await manager.submit(source.id, "REAL_FORK_HOLD"); running.completion.catch(() => {});
  await waiting.promise;
  await adapters.get(source.id).goalAction("resume");
  const count = requests.length;
  const copy = await manager.forkChat(source.id, { requestId: "real-native-fork" });
  assert.equal(copy.status, "stopped"); assert.equal(copy.forkGoalPending, true); assert.equal(copy.goal.status, "paused");
  assert.equal(requests.length, count, "Forking must not start another model turn");
  assert.equal(store.get(source.id).status, "running");
  await adapters.get(source.id).goalAction("pause"); release(); await running.completion;
  await manager.remove(source.id); // The fork must survive its source profile disappearing.
  assert.equal(store.get(source.id), null);
  const branch = await manager.submit(copy.id, "REAL_FORK_BRANCH"); await branch.completion;
  const current = store.get(copy.id);
  assert.notEqual(current.status, "error", current.messages.at(-1)?.text);
  assert.equal(current.goal.status, "complete"); assert.equal(current.goal.tokenBudget, 100000);
  assert.equal(current.forkGoalPending, false); assert.equal(current.forkContextPending, false);
  assert.equal((await records.get("native-fork", copy.id)).initialized, true);
  assert.ok(branchRequests >= 3, "The first fork input must own native automatic goal continuation");
  assert.match(JSON.stringify(requests.at(-1)), /REAL_FORK_SEED/);
  assert.ok(JSON.stringify(requests.at(-1)).includes(copy.workspace));
  assert.equal(await readFile(path.join(copy.workspace, "uncommitted.txt"), "utf8"), "source workspace");
  const [copiedFile] = await attachments.resolve(copy.id, [copy.messages[0].attachments[0].id]);
  assert.equal(Buffer.from(copiedFile.data, "base64").toString(), "attachment before fork");
  await manager.stop(copy.id, "idle-timeout");
  const beforeRestart = current.agentSessionId;
  await manager.send(copy.id, "REAL_FORK_AFTER_RESTART");
  assert.equal(store.get(copy.id).agentSessionId, beforeRestart); assert.equal(store.get(copy.id).goal.status, "complete");
  console.log("Real controller /fork passed: active-source isolation, source deletion, independent workspace/attachments, deferred goal continuation, budget, and native resume after restart. Loopback fixture only.");
} finally {
  clearTimeout(timeout); await manager.shutdown();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
