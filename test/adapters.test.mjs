import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ChatStore } from "../src/store.mjs";
import { prepareWorkspace } from "../src/workspace.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("native Codex reviews apply turn settings, report exitedReviewMode and interrupt the review turn", async t => {
  const { root, store, chat } = await fixtureChat(t, "codex");
  const adapter = new CodexAdapter({ chat, store, config: testConfig(root, { CODEX_BIN: path.join(fixtureDir, "fake-codex.mjs") }), broker: new CapabilityBroker({ ttlMs: 10000 }), hooks: {} });
  t.after(() => adapter.stop()); await adapter.start();
  const calls = [], request = adapter.rpc.request.bind(adapter.rpc);
  let slow = false;
  adapter.rpc.request = (method, params, timeout) => { calls.push({ method, params }); return request(method, { ...params, ...(method === "review/start" && slow ? { fixtureDelayMs: 10000 } : {}) }, timeout); };
  const reviewTarget = { type: "baseBranch", branch: "main" };
  const result = await adapter.send("not sent as a prompt", { model: "fixture-gpt", effort: "high", mode: "plan", reviewTarget });
  assert.equal(result.text, "Native review completed without a normal prompt.");
  assert.ok(!calls.some(call => call.method === "turn/start"));
  const settings = calls.find(call => call.method === "thread/settings/update").params;
  assert.equal(settings.model, "fixture-gpt"); assert.equal(settings.effort, "high"); assert.equal(settings.sandboxPolicy.type, "readOnly");
  assert.deepEqual(calls.find(call => call.method === "review/start").params, { threadId: "thr_fixture", target: reviewTarget, delivery: "inline" });
  slow = true;
  const pending = adapter.send("", { reviewTarget }); const rejected = assert.rejects(pending, /interrupted/);
  await waitFor(() => adapter.current?.turnId?.startsWith("review_fixture"));
  await adapter.interrupt(); await rejected;
  assert.equal(adapter.current, null);
  assert.ok(calls.find(call => call.method === "turn/interrupt").params.turnId.startsWith("review_fixture"));
});

async function fixtureChat(t, agent) {
  const root = await temporaryDirectory(t);
  const store = new ChatStore(root);
  await store.initialize();
  const chat = await store.create({ title: "Adapter", agent, source: "" });
  await prepareWorkspace({ destination: chat.workspace, source: "" });
  return { root, store, chat };
}

test("forked Codex sessions never silently replace missing or mismatched history with an empty thread", async t => {
  const { root, store, chat } = await fixtureChat(t, "codex"), sessions = [];
  const config = testConfig(root, { CODEX_BIN: path.join(fixtureDir, "fake-codex.mjs") });
  for (const agentSessionId of [null, "thr_missing", "thr_wrong_identity"]) {
    const adapter = new CodexAdapter({ chat: { ...chat, agentSessionId, nativeForkSessionId: "thr_original_fork" }, store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), hooks: { onSessionId: id => sessions.push(id) } });
    try { await assert.rejects(adapter.start(), /refusing to start an empty|no empty conversation was created/); assert.equal(adapter.threadId, agentSessionId); }
    finally { await adapter.stop(); }
  }
  assert.deepEqual(sessions, []);
});

test("stopping Codex archives only its unpublished forks, never the source or a committed fork", async t => {
  const { root, store, chat } = await fixtureChat(t, "codex");
  const adapter = new CodexAdapter({ chat, store, config: testConfig(root, { CODEX_BIN: path.join(fixtureDir, "fake-codex.mjs") }), broker: new CapabilityBroker({ ttlMs: 10000 }), hooks: {} });
  t.after(() => adapter.stop()); await adapter.start();
  const original = adapter.rpc.request.bind(adapter.rpc), archived = [];
  adapter.rpc.request = (method, params, timeout) => { if (method === "thread/archive") { archived.push(params.threadId); return Promise.resolve({}); } return original(method, params, timeout); };
  adapter.createdForks.add("unpublished"); adapter.createdForks.add("committed"); adapter.releaseFork("committed");
  await adapter.stop(); assert.deepEqual(archived, ["unpublished"]); assert.equal(adapter.createdForks.size, 0);
});

test("native side forks route approvals by thread and detach without stopping their parent RPC", async t => {
  const { root, store, chat } = await fixtureChat(t, "codex");
  const parentRequests = [], sideRequests = [], sessions = [];
  const adapter = new CodexAdapter({ chat, store, config: testConfig(root, { CODEX_BIN: path.join(fixtureDir, "fake-codex.mjs") }), broker: new CapabilityBroker({ ttlMs: 10000 }), hooks: { onRequest: request => parentRequests.push(request), onSessionId: id => sessions.push(id) } });
  t.after(() => adapter.stop()); await adapter.start();
  const rpc = adapter.rpc, original = rpc.request.bind(rpc), calls = [], responses = [];
  rpc.request = async (method, params, timeout) => {
    calls.push({ method, params });
    if (method === "thread/fork") return { thread: { id: "thr_side_fixture", ephemeral: true } };
    if (["thread/backgroundTerminals/clean", "thread/unsubscribe"].includes(method)) return {};
    return original(method, params, timeout);
  };
  rpc.respond = (id, result) => responses.push({ id, result });
  const listeners = rpc.listenerCount("request");
  const child = await adapter.forkSide({ onRequest: request => sideRequests.push(request) });
  assert.deepEqual(calls[0], { method: "thread/fork", params: { threadId: "thr_fixture", cwd: chat.workspace, ephemeral: true, excludeTurns: true } });
  rpc.emit("request", { id: 101, method: "item/commandExecution/requestApproval", params: { threadId: "thr_side_fixture", command: "side command" } });
  rpc.emit("request", { id: 102, method: "item/tool/requestUserInput", params: { threadId: "thr_fixture", questions: [] } });
  assert.deepEqual(parentRequests.map(r => r.requestId), ["approval_102"]);
  assert.deepEqual(sideRequests.map(r => r.requestId), ["approval_101"]);
  await assert.rejects(adapter.respond("approval_101", { decision: "accept" }), /no longer active/);
  await child.respond("approval_101", { decision: "decline" });
  assert.deepEqual(responses, [{ id: 101, result: { decision: "decline" } }]);
  await assert.rejects(child.forkSide({}), /inside a side chat/);
  adapter.current = { review: true }; await assert.rejects(adapter.forkSide({}), /during review/); adapter.current = null;
  await child.stop();
  assert.equal(adapter.rpc, rpc); assert.equal(rpc.listenerCount("request"), listeners); assert.equal(adapter.children.size, 0);
  assert.deepEqual(sessions, ["thr_fixture"]);
  assert.ok(calls.some(call => call.method === "thread/unsubscribe" && call.params.threadId === child.threadId));
  assert.ok(!calls.some(call => call.method.startsWith("thread/goal/")), "Fork must not change the parent's persisted goal");
  await assert.rejects(child.send("closed"), /closed/);
});

test("Codex adapter speaks app-server JSON-RPC, streams, resumes, and answers approval", async (t) => {
  const { root, store, chat } = await fixtureChat(t, "codex");
  const config = testConfig(root, { CODEX_BIN: path.join(fixtureDir, "fake-codex.mjs") });
  const broker = new CapabilityBroker({ ttlMs: 10_000 });
  const events = [];
  let sessionId;
  let adapter;
  const hooks = {
    onEvent: (event) => events.push(event),
    onSessionId: (id) => { sessionId = id; },
    onRequest: (request) => setImmediate(() => adapter.respond(request.requestId, { decision: "accept" })),
    onFatal: (error) => { throw error; },
  };
  adapter = new CodexAdapter({ chat, store, config, broker, gatewayOrigin: "http://127.0.0.1:9", hooks });
  await adapter.start();
  let turnParams;
  const originalRequest = adapter.rpc.request.bind(adapter.rpc);
  adapter.rpc.request = (method, params, timeout) => { if (method === "turn/start") turnParams = params; return originalRequest(method, params, timeout); };
  const result = await adapter.send("fixture turn", { model: "fixture-gpt", effort: "high", mode: "plan", images: ["/tmp/image.png"] });
  assert.equal(turnParams.model, "fixture-gpt");
  assert.equal(turnParams.effort, "high");
  assert.deepEqual(turnParams.sandboxPolicy, { type: "readOnly" });
  assert.equal(turnParams.collaborationMode.mode, "plan");
  assert.deepEqual(turnParams.input[1], { type: "localImage", path: "/tmp/image.png" });
  assert.equal(sessionId, "thr_fixture");
  assert.equal(result.text, "hello world");
  assert.ok(events.some((event) => event.type === "assistant_delta" && event.delta === "hello "));
  assert.ok(events.some((event) => event.type === "tool" && event.state === "completed"));
  assert.ok(events.some(event => event.type === "request_resolved" && event.requestId === "approval_900"));
  const info = await adapter.inspect(); assert.equal(info.rateLimits[0].windows[0].usedPercent, 25); assert.equal(info.connectors[0].tools, 1);
  assert.equal((await adapter.compact()).status, "completed");
  await adapter.send("default mode", { model: "fixture-gpt" });
  assert.equal(turnParams.collaborationMode.mode, "default"); assert.equal(turnParams.sandboxPolicy.type, "workspaceWrite");
  assert.equal(turnParams.approvalsReviewer, "user");
  await adapter.send("automatic reviews", { model: "fixture-gpt", mode: "auto" });
  assert.equal(turnParams.approvalsReviewer, "auto_review"); assert.equal(turnParams.approvalPolicy, "on-request"); assert.equal(turnParams.sandboxPolicy.type, "workspaceWrite");
  await adapter.stop();

  const resumedChat = { ...chat, agentSessionId: sessionId };
  const resumed = new CodexAdapter({ resumedChat, chat: resumedChat, store, config, broker, gatewayOrigin: "http://127.0.0.1:9", hooks: { ...hooks, onSessionId: () => assert.fail("resume should retain session") } });
  adapter = resumed;
  await resumed.start();
  assert.equal((await resumed.send("resumed")).text, "hello world");
  await resumed.stop();
});

test("Codex compaction waits for completion and can be interrupted using its native turn ID", async t => {
  const { root, store, chat } = await fixtureChat(t, "codex");
  const adapter = new CodexAdapter({ chat, store, config: testConfig(root, { CODEX_BIN: path.join(fixtureDir, "fake-codex.mjs") }), broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://127.0.0.1:9", hooks: {} });
  t.after(() => adapter.stop()); await adapter.start();
  const request = adapter.rpc.request.bind(adapter.rpc);
  adapter.rpc.request = (method, params, timeout) => request(method, method === "thread/compact/start" ? { ...params, fixtureDelayMs: 200 } : params, timeout);
  let settled = false;
  const compact = adapter.compact(); const result = assert.rejects(compact, /interrupted/).then(() => { settled = true; });
  await waitFor(() => adapter.current?.turnId); assert.equal(settled, false);
  await adapter.interrupt(); await result; assert.equal(adapter.current, null);
  assert.equal((await adapter.compact()).status, "completed");
});

test("Claude adapter parses stream-json and retains its resume id", async (t) => {
  const { root, store, chat } = await fixtureChat(t, "claude");
  const config = testConfig(root, { CLAUDE_BIN: path.join(fixtureDir, "fake-claude.mjs") });
  const broker = new CapabilityBroker({ ttlMs: 10_000 });
  const events = [];
  let sessionId;
  const adapter = new ClaudeAdapter({
    chat,
    store,
    config,
    broker,
    gatewayOrigin: "http://127.0.0.1:9",
    hooks: { onEvent: (event) => events.push(event), onSessionId: (id) => { sessionId = id; } },
  });
  await adapter.start();
  const result = await adapter.send("hello");
  assert.match(sessionId, /^[a-f0-9-]{36}$/);
  assert.equal(result.text, "claude received hello");
  assert.ok(events.some((event) => event.type === "tool" && event.tool === "Read" && event.state === "running"));
  assert.ok(events.some((event) => event.type === "tool" && event.tool === "Read" && event.state === "completed" && event.output === "fixture.txt"));
  const settings = JSON.parse((await adapter.send("inspect-settings", { model: "sonnet", effort: "low" })).text);
  assert.equal(settings.model, "sonnet"); assert.equal(settings.effort, "low");
  assert.equal(settings.mode, "acceptEdits");
  for (const mode of ["plan", "auto"]) assert.equal(JSON.parse((await adapter.send("inspect-settings", { mode })).text).mode, mode);
  const reset = JSON.parse((await adapter.send("inspect-settings", { model: "default", resetEffort: true })).text);
  assert.equal(reset.model, "default"); assert.equal(reset.effort, null); assert.equal(reset.environmentEffort, "auto");
  await adapter.stop();
});

test("Claude adapter rejects structured error results even when the CLI exits zero", async (t) => {
  const { root, store, chat } = await fixtureChat(t, "claude");
  const config = testConfig(root, { CLAUDE_BIN: path.join(fixtureDir, "fake-claude.mjs") });
  const adapter = new ClaudeAdapter({
    chat,
    store,
    config,
    broker: new CapabilityBroker({ ttlMs: 10_000 }),
    gatewayOrigin: "http://127.0.0.1:9",
    hooks: {},
  });
  await adapter.start();
  await assert.rejects(adapter.send("force failure"), /fixture failed/);
  await adapter.stop();
});

test("Codex interrupts a turn by its ID and reuses the same app-server and thread", async t => {
  const { root, store, chat } = await fixtureChat(t, "codex");
  let request;
  const adapter = new CodexAdapter({ chat, store, config: testConfig(root, { CODEX_BIN: path.join(fixtureDir, "fake-codex.mjs") }), broker: new CapabilityBroker({ ttlMs: 10000 }), hooks: { onRequest: value => { request = value; } } });
  t.after(() => adapter.stop()); await adapter.start();
  const rpc = adapter.rpc;
  const sent = adapter.send("interrupt me");
  const rejected = assert.rejects(sent, /interrupted/);
  await waitFor(() => request); await adapter.interrupt(); await rejected;
  assert.equal(adapter.rpc, rpc); assert.equal(adapter.threadId, "thr_fixture"); assert.equal(adapter.requests.size, 0);
  request = null; const next = adapter.send("next"); await waitFor(() => request);
  await adapter.respond(request.requestId, { decision: "accept" }); assert.equal((await next).text, "hello world");
  await adapter.interrupt(); assert.equal(adapter.rpc, rpc);
});

test("Claude interruption preserves its session and gateway capability", async t => {
  const { root, store, chat } = await fixtureChat(t, "claude");
  const adapter = new ClaudeAdapter({ chat, store, config: testConfig(root, { CLAUDE_BIN: path.join(fixtureDir, "fake-claude.mjs") }), broker: new CapabilityBroker({ ttlMs: 10000 }), hooks: {} });
  t.after(() => adapter.stop()); await adapter.start();
  const capability = adapter.capability, sent = adapter.send("wait for interruption");
  const rejected = assert.rejects(sent, /interrupted/); await waitFor(() => adapter.child);
  const sessionId = adapter.sessionId; await adapter.interrupt(); await rejected;
  assert.equal(adapter.sessionId, sessionId); assert.equal(adapter.capability, capability);
  assert.equal((await adapter.send("next")).text, "claude received next");
});
