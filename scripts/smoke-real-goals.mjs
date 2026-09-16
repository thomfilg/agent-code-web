import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { JsonRpcProcess } from "../src/json-rpc-process.mjs";

// Protocol-only smoke: isolated Codex home, local deterministic Responses stub,
// no account credentials, model service, shell actions or user workspace.
const root = await mkdtemp("/tmp/relay-goal-smoke-");
let requests = 0;
const server = http.createServer((req, res) => {
  req.resume();
  if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
  const n = ++requests;
  if (n > 5) { res.writeHead(429); res.end(); return; }
  const item = n === 1 ? { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "get_goal", arguments: "{}" }
    : n === 3 ? { type: "function_call", id: "fc_complete", call_id: "call_complete", name: "update_goal", arguments: '{"status":"complete"}' }
    : { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Protocol fixture response; no real model was used.", annotations: [] }] };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const rpc = new JsonRpcProcess({ command: "codex", args: ["app-server", "-c", 'model_provider="fixture"', "-c", 'model_providers.fixture.name="Fixture"', "-c", `model_providers.fixture.base_url="${origin}/v1"`, "-c", 'model_providers.fixture.wire_api="responses"', "-c", "model_providers.fixture.requires_openai_auth=false", "-c", 'model="fixture"'], spawnOptions: { cwd: root, env: { HOME: root, CODEX_HOME: root, PATH: process.env.PATH } }, requestTimeoutMs: 10000 });
const events = []; rpc.on("error", () => {}); rpc.on("notification", e => { if (/goal|turn\//.test(e.method)) events.push(e); });
try {
  rpc.start(); await rpc.request("initialize", { clientInfo: { name: "relay_goal_smoke", version: "1" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized", {});
  const { thread } = await rpc.request("thread/start", { cwd: root, model: "fixture", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only" });
  const set = await rpc.request("thread/goal/set", { threadId: thread.id, objective: "Protocol fixture goal", status: "active" });
  assert.equal(set.goal.objective, "Protocol fixture goal");
  await rpc.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Protocol fixture" }], model: "fixture" });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !events.some(e => e.method === "turn/completed")) await new Promise(r => setTimeout(r, 50));
  assert.ok(events.some(e => e.method === "turn/completed"), "Fixture turn did not complete");
  await new Promise(r => setTimeout(r, 2000));
  console.log(JSON.stringify({ stubRequests: requests, events: events.map(e => ({ method: e.method, status: e.params.goal?.status || e.params.turn?.status })) }));
  const paused = await rpc.request("thread/goal/set", { threadId: thread.id, status: "paused" }); assert.equal(paused.goal.status, "paused");
  const read = await rpc.request("thread/goal/get", { threadId: thread.id }); assert.equal(read.goal.objective, "Protocol fixture goal");
  await rpc.request("thread/goal/clear", { threadId: thread.id }); assert.equal((await rpc.request("thread/goal/get", { threadId: thread.id })).goal, null);
  const countBefore = requests;
  await rpc.request("thread/goal/set", { threadId: thread.id, objective: "Second protocol fixture", status: "active" });
  await new Promise(r => setTimeout(r, 500));
  console.log(JSON.stringify({ setGoalStartsTurnOnExistingThread: requests > countBefore }));
  await rpc.request("thread/goal/set", { threadId: thread.id, status: "paused" });
  console.log("Real Codex goal set/get/pause/clear: passed against the local protocol fixture (no LLM calls).");
} finally { await rpc.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); }
