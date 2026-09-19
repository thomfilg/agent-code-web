import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { CodexAgentThreads } from "../src/codex-agent-threads.mjs";
import { NativeAgentSnapshots } from "../src/native-agent-snapshots.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

class FixtureRpc extends EventEmitter {
  constructor() {
    super(); this.calls = []; this.responses = []; this.active = new Map(); this.goals = new Map();
    this.threads = new Map([
      ["child", { id: "child", parentThreadId: "main", agentNickname: "Ada", agentRole: "worker", status: { type: "idle" }, canAcceptDirectInput: true, model: "fixture-model", reasoningEffort: "high" }],
      ["nested", { id: "nested", parentThreadId: "child", agentNickname: "Lin", status: { type: "notLoaded" }, canAcceptDirectInput: true }],
      ["foreign", { id: "foreign", parentThreadId: "other-company", sessionId: "main", status: { type: "active" } }],
      ["fork", { id: "fork", forkedFromId: "main", sessionId: "main", status: { type: "idle" } }],
      ["other-company", { id: "other-company" }],
    ]);
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/list") return { data: [...this.threads.values()].reverse(), nextCursor: null };
    if (method === "thread/read" || method === "thread/resume") {
      const thread = this.threads.get(params.threadId); if (!thread) throw new Error("No thread");
      return { thread: structuredClone(thread) };
    }
    if (method === "thread/items/list") return { data: [
      { turnId: "seed", item: { id: params.cursor ? "older" : "answer", type: "agentMessage", text: params.cursor ? "Older response" : "Native answer" } },
      { turnId: "seed", item: { id: "private-reasoning", type: "reasoning", content: ["never render this"] } },
      { turnId: "seed", item: { id: "task", type: "userMessage", content: [{ type: "text", text: "Task delegated by parent" }] } },
    ], nextCursor: params.cursor ? null : "earlier" };
    if (method === "thread/turns/list") return { data: this.active.has(params.threadId) ? [{ id: this.active.get(params.threadId), status: "inProgress" }] : [] };
    if (method === "thread/goal/get") return { goal: this.goals.get(params.threadId) || null };
    if (method === "thread/goal/set") { const goal = { ...this.goals.get(params.threadId), status: params.status }; this.goals.set(params.threadId, goal); return { goal }; }
    if (method === "turn/start") { this.active.set(params.threadId, "active-child-turn"); this.notify("turn/started", { threadId: params.threadId, turn: { id: "active-child-turn" } }); return { turn: { id: "active-child-turn" } }; }
    if (method === "turn/steer") { assert.equal(params.expectedTurnId, this.active.get(params.threadId)); return { turnId: params.expectedTurnId }; }
    if (method === "turn/interrupt") { assert.equal(params.turnId, this.active.get(params.threadId)); this.active.delete(params.threadId); this.notify("turn/completed", { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } }); return {}; }
    throw new Error(`Unsupported fixture method ${method}`);
  }
  notify(method, params) { this.emit("notification", { method, params }); }
  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, code) { this.responses.push({ id, code }); }
}
function observer(t, options = {}) {
  const rpc = new FixtureRpc(), snapshots = [];
  const agents = new CodexAgentThreads({ rpc, root: () => "main", workspace: "/fixture/workspace", model: "fixture", publish: value => snapshots.push(value), ...options });
  t.after(() => agents.close()); return { rpc, agents, snapshots };
}

test("named-account child previews redact split tokens before snapshot, cache, replay and close", async t => {
  const token = "private-child-account-token", rotated = "renewed-child-account-token", secrets = new Set([token]);
  const { rpc, agents, snapshots } = observer(t, { secrets }); await agents.refresh();
  const wait = () => waitFor(() => agents.queues.size === 0);
  for (let split = 1; split < token.length; split++) {
    const itemId = `split-${split}`;
    rpc.notify("item/agentMessage/delta", { threadId: "child", itemId, turnId: "turn", delta: token.slice(0, split) }); await wait();
    assert.equal(agents.snapshot().threads.find(thread => thread.id === "child").messages.at(-1).text, "");
    rpc.notify("item/agentMessage/delta", { threadId: "child", itemId, turnId: "turn", delta: token.slice(split) }); await wait();
    assert.equal(agents.snapshot().threads.find(thread => thread.id === "child").messages.at(-1).text, "[redacted]");
  }
  secrets.add(rotated);
  for (const delta of rotated) rpc.notify("item/agentMessage/delta", { threadId: "child", itemId: "rotated", turnId: "turn", delta }); await wait();
  rpc.notify("item/completed", { threadId: "child", turnId: "turn", item: { type: "agentMessage", id: "complete", text: `${token} ${rotated}` } });
  rpc.notify("item/agentMessage/delta", { threadId: "nested", itemId: "partial", turnId: "other", delta: token.slice(0, 12) }); await wait();
  await agents.close();
  assert.equal(agents.snapshot().threads.find(thread => thread.id === "nested").messages.at(-1).text, "[redacted]");
  assert.doesNotMatch(JSON.stringify([snapshots, agents.snapshot()]), /private-child-account-token|renewed-child-account-token/);
  const restarted = observer(t, { secrets, saved: agents.snapshot() }).agents; await restarted.refresh();
  assert.doesNotMatch(JSON.stringify(restarted.snapshot()), /private-child-account-token|renewed-child-account-token/);
});

test("native agent membership follows parent chains, not fork/session/company aliases", async t => {
  const { rpc, agents } = observer(t);
  const snapshot = await agents.refresh();
  assert.deepEqual(snapshot.threads.map(thread => thread.id).sort(), ["child", "nested"]);
  assert.deepEqual(rpc.calls.find(call => call.method === "thread/list").params, { ancestorThreadId: "main", sourceKinds: ["subAgentThreadSpawn"], limit: 100 });
  assert.deepEqual(rpc.calls.filter(call => call.method === "thread/resume").map(call => call.params.threadId), ["child"], "Unloaded descendants must not be woken by discovery");
  for (const id of ["main", "foreign", "fork", "../bad", "missing"]) await assert.rejects(agents.select(id));
  assert.ok(rpc.calls.filter(call => call.method === "thread/resume").every(call => ["child", "nested"].includes(call.params.threadId)));
  const selected = await agents.select("nested");
  assert.equal(selected.page.messages[0].text, "Task delegated by parent");
  assert.ok(!JSON.stringify(selected).includes("never render this"));
  assert.equal((await agents.select("nested", "earlier")).page.messages.at(-1).text, "Older response");
  assert.equal(agents.snapshot().threads.find(thread => thread.id === "nested").messages.at(-1).text, "Native answer", "Paging older history must not replace the latest snapshot");
});

test("agent input starts or steers only the chosen thread, deduplicates retries and targets child stop", async t => {
  const { rpc, agents } = observer(t); await agents.refresh();
  const first = { text: "First child input", requestId: "request-first" };
  await agents.send("child", first, "plan");
  await agents.send("child", first, "plan");
  assert.equal(rpc.calls.filter(call => call.method === "turn/start").length, 1);
  const start = rpc.calls.find(call => call.method === "turn/start").params;
  assert.equal(start.threadId, "child"); assert.equal(start.sandboxPolicy.type, "readOnly"); assert.equal(start.collaborationMode.settings.model, "fixture-model");
  assert.equal(start.collaborationMode.settings.reasoning_effort, "high");
  await agents.send("child", { text: "Follow-up", requestId: "request-followup" }, "auto");
  assert.equal(rpc.calls.filter(call => call.method === "turn/steer").length, 1);
  await assert.rejects(agents.send("child", { ...first, text: "Different input" }), /different message/);
  await assert.rejects(agents.send("child", { text: "/compact", requestId: "request-command" }), /main composer/);
  rpc.goals.set("main", { status: "active", objective: "Parent goal" }); rpc.goals.set("child", { status: "active", objective: "Child goal" });
  await agents.interrupt("child");
  assert.equal(rpc.goals.get("main").status, "active"); assert.equal(rpc.goals.get("child").status, "paused");
  await waitFor(() => !agents.busy());
  assert.ok(!rpc.calls.some(call => ["turn/start", "turn/steer", "turn/interrupt"].includes(call.method) && call.params.threadId === "main"));
  await agents.close(); await assert.rejects(agents.send("child", first), /no longer available/);
  assert.equal(rpc.listenerCount("notification"), 0);
});

test("child approvals and questions never resolve a main or foreign request; queued native events stay ordered", async t => {
  const { rpc, agents } = observer(t); await agents.refresh();
  const question = (threadId, id) => rpc.emit("request", { id, method: "item/tool/requestUserInput", params: { threadId, questions: [{ id: "q", question: "Proceed?" }] } });
  question("main", 1); question("foreign", 2); question("child", 3);
  await waitFor(() => agents.snapshot().threads.find(thread => thread.id === "child").pendingRequest);
  await assert.rejects(agents.respond("child", "approval_1", { answers: { q: "yes" } }), /no longer active/);
  await assert.rejects(agents.respond("nested", "approval_3", { answers: { q: "yes" } }), /no longer active/);
  await assert.rejects(agents.respond("child", "approval_3", { answers: { foreign: "yes" } }), /match a requested/);
  await agents.respond("child", "approval_3", { answers: { q: "yes" } });
  assert.deepEqual(rpc.responses, [{ id: 3, result: { answers: { q: { answers: ["yes"] } } } }]);
  question("child", 4); rpc.notify("serverRequest/resolved", { threadId: "child", requestId: 4 });
  await waitFor(() => agents.queues.size === 0);
  assert.equal(agents.snapshot().threads.find(thread => thread.id === "child").pendingRequest, null);
  rpc.notify("item/agentMessage/delta", { threadId: "child", itemId: "streamed", turnId: "t", delta: "Live response" });
  rpc.notify("item/completed", { threadId: "child", turnId: "t", item: { type: "agentMessage", id: "streamed", text: "Completed response" } });
  await waitFor(() => agents.queues.size === 0);
  assert.equal(agents.snapshot().threads.find(thread => thread.id === "child").messages.at(-1).text, "Completed response");
});

test("native parent and nested activity discover agents and surface approvals without opening the picker", async t => {
  const { rpc, agents } = observer(t);
  rpc.notify("item/completed", { threadId: "main", item: { type: "collabAgentToolCall", receiverThreadIds: ["child", "foreign"] } });
  await waitFor(() => agents.snapshot().threads.some(thread => thread.id === "child"));
  rpc.threads.get("nested").status = { type: "active" };
  rpc.notify("item/started", { threadId: "child", item: { type: "subAgentActivity", agentThreadId: "nested" } });
  rpc.emit("request", { id: 99, method: "item/commandExecution/requestApproval", params: { threadId: "nested", command: "fixture command" } });
  await waitFor(() => agents.snapshot().threads.find(thread => thread.id === "nested")?.pendingRequest);
  assert.equal(agents.busy(), true);
  assert.ok(!agents.snapshot().threads.some(thread => thread.id === "foreign"));
  assert.ok(rpc.calls.some(call => call.method === "thread/resume" && call.params.threadId === "nested"));
});

test("read-only or unsupported native agents reject input without changing their parent", async t => {
  const { rpc, agents } = observer(t);
  rpc.threads.get("child").canAcceptDirectInput = false;
  await assert.rejects(agents.send("child", { text: "Hello", requestId: "readonly-request" }), /cannot accept/);
  assert.ok(!rpc.calls.some(call => call.method.startsWith("turn/")));
});

test("a child finishing between read and steer safely starts one fresh turn instead of losing or duplicating input", async t => {
  const { rpc, agents } = observer(t); rpc.active.set("child", "finishing-turn");
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method === "turn/steer") { rpc.active.delete("child"); throw new Error("turn/steer: no active turn to steer"); }
    return original(method, params);
  };
  const input = { requestId: "finish-race-request", text: "Next input" };
  await agents.send("child", input, "auto"); await agents.send("child", input, "auto");
  const started = rpc.calls.filter(call => call.method === "turn/start");
  assert.equal(started.length, 1); assert.equal(started[0].params.approvalsReviewer, "auto_review");
});

test("reconnected observers recover only verified saved transcripts, without restoring approvals or trusting saved membership", async t => {
  const saved = { rootThreadId: "main", threads: [
    { id: "child", historyLoaded: true, messages: [{ id: "saved", role: "assistant", text: "Saved child context" }], pendingRequest: { requestId: "stale" } },
    { id: "foreign", historyLoaded: true, messages: [{ id: "foreign-secret", role: "assistant", text: "Do not expose" }] },
  ] };
  const { agents } = observer(t, { saved }); await agents.refresh();
  assert.deepEqual(agents.snapshot().threads.find(thread => thread.id === "child").messages, saved.threads[0].messages);
  assert.equal(agents.snapshot().threads.find(thread => thread.id === "child").pendingRequest, null);
  assert.ok(!JSON.stringify(agents.snapshot()).includes("Do not expose"));
});

test("live child items win over delayed history pages without letting stale cached items overwrite fresh history", async t => {
  const { rpc, agents } = observer(t); await agents.refresh(); await agents.select("child");
  const original = rpc.request.bind(rpc), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  rpc.request = async (method, params) => {
    const result = await original(method, params);
    if (method === "thread/items/list") { result.data[0].item.text = "Fresh native history"; entered.resolve(); await gate.promise; }
    return result;
  };
  const reading = agents.select("child"); await entered.promise;
  rpc.notify("thread/status/changed", { threadId: "child", status: { type: "active" } });
  rpc.notify("item/completed", { threadId: "child", turnId: "live", item: { id: "new-live-item", type: "agentMessage", text: "Newer live response" } });
  await waitFor(() => agents.queues.size === 0); gate.resolve(); await reading;
  const messages = agents.snapshot().threads.find(thread => thread.id === "child").messages;
  assert.equal(messages.find(item => item.id === "answer").text, "Fresh native history");
  assert.equal(messages.at(-1).text, "Newer live response");
});

test("controller agent endpoints enforce auth/origin/owner/root, retain snapshots offline and preserve the main chat", async t => {
  const directory = await temporaryDirectory(t), rpc = new FixtureRpc(); let starts = 0, live;
  const app = await createAgentWebServer({ config: testConfig(directory, { AGENT_WEB_AUTH_TOKEN: "agent-fixture", AGENT_IDLE_TIMEOUT_MS: "60000" }),
    adapterFactory: ({ hooks }) => ({
      get agents() { return live; },
      start: async () => { starts++; await hooks.onSessionId("main"); live = new CodexAgentThreads({ rpc, root: () => "main", workspace: "/fixture", model: "fixture", publish: hooks.onAgentThreads }); },
      stop: async () => { await live?.close(); },
    }),
  });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "codex" });
  const headers = { authorization: "Bearer agent-fixture", "content-type": "application/json" };
  const request = (tail = "", body = null) => fetch(`${url}/api/chats/${chat.id}/subagents${tail}`, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/subagents`)).status, 401);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/subagents`, { method: "POST", headers: { ...headers, origin: "https://foreign.example" } })).status, 403);
  assert.equal((await request()).status, 200); assert.equal(starts, 0, "Snapshot reads must not acquire a worker");
  assert.equal((await request("", {})).status, 200); assert.equal(starts, 1);
  assert.equal((await request("/select", { rootThreadId: "wrong", threadId: "child" })).status, 409);
  assert.equal((await request("/select", { rootThreadId: "main", threadId: "foreign" })).status, 404);
  assert.equal((await request("/select", { rootThreadId: "main", threadId: "child" })).status, 200);
  const input = { rootThreadId: "main", threadId: "child", text: "Native followup", requestId: "api-native-followup" };
  assert.equal((await request("/messages", input)).status, 200);
  await waitFor(() => app.store.get(chat.id).idleKeepAwakeReason === "agents");
  assert.deepEqual(app.store.get(chat.id).messages, []); assert.equal(app.store.get(chat.id).pendingRequest, null);
  await app.manager.stop(chat.id); const saved = await (await request()).json();
  assert.equal(saved.awake, false); assert.equal(starts, 1); assert.ok(saved.threads.some(thread => thread.messages.some(message => message.text === "Native answer")));
  const reloaded = await new NativeAgentSnapshots(app.store, () => {}).get(chat.id);
  assert.equal(reloaded.awake, false); assert.ok(reloaded.threads.every(thread => !thread.pendingRequest));
  assert.ok(!app.manager.eventsSince(chat.id).some(event => event.type === "agent_threads_updated"));
  await app.store.update(chat.id, { ownerId: "someone-else" });
  assert.equal((await request()).status, 404); assert.equal((await request("", {})).status, 404);
});

for (const field of ["environmentId", "workspace"]) for (const kind of ["select", "stop"]) test(`agent ${kind} and observer hooks reject ${field} changes across native awaits`, async t => {
  const directory = await temporaryDirectory(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); let hooks, controls = 0;
  const snapshot = { rootThreadId: "main", epoch: "fixture", revision: 1, awake: true, threads: [] };
  const app = await createAgentWebServer({ config: testConfig(directory, { AGENT_IDLE_TIMEOUT_MS: "60000" }),
    adapterFactory: options => {
      hooks = options.hooks;
      return { start: async () => { await hooks.onSessionId("main"); }, stop: async () => {}, agents: {
        busy: () => false,
        refresh: async () => { hooks.assertAgentCurrent("main"); return snapshot; },
        select: async () => { hooks.assertAgentCurrent("main"); entered.resolve(); await release.promise; hooks.assertAgentCurrent("main"); controls++; return snapshot; },
        interrupt: async () => { hooks.assertAgentCurrent("main"); controls++; entered.resolve(); await release.promise; return snapshot; },
      } };
    },
  });
  await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "codex" });
  await app.manager.agentThreadAction(chat.id, "refresh");
  const action = app.manager.agentThreadAction(chat.id, kind, { rootThreadId: "main", threadId: "child" });
  await entered.promise; await app.store.update(chat.id, { [field]: `${app.store.get(chat.id)[field] || "initial"}-changed` }); release.resolve();
  await assert.rejects(action, /scope changed/); assert.equal(controls, kind === "select" ? 0 : 1, "A dispatched Stop is not replayed or treated as success in a new scope");
  assert.throws(() => hooks.assertAgentCurrent("main"), /scope changed/);
  hooks.onAgentThreads(snapshot); assert.deepEqual((await app.manager.agentThreads.get(chat.id)).threads, []);
});

test("Claude child input denial and cached reads never start a worker", async t => {
  const directory = await temporaryDirectory(t); let starts = 0;
  const app = await createAgentWebServer({ config: testConfig(directory), adapterFactory: () => { starts++; throw Error("Worker must not start"); } });
  await app.start(); t.after(() => app.stop()); const chat = await app.manager.createChat({ agent: "claude" });
  assert.deepEqual((await app.manager.agentThreads.get(chat.id)).threads, []);
  await assert.rejects(app.manager.agentThreadAction(chat.id, "messages", { text: "Do not proxy" }), /not supported/);
  await assert.rejects(app.manager.agentThreadAction(chat.id, "select", { rootThreadId: "unbound", threadId: "child" }), /session changed/);
  assert.equal(starts, 0); assert.deepEqual(app.store.get(chat.id).messages, []);
});

test("stored child snapshots bind every scope field and recheck delayed reads; legacy roots alone confer no access", async () => {
  const base = { id: "chat", ownerId: "owner", agent: "claude", agentAccountId: "account", environmentId: "environment", workspace: "/workspace", agentSessionId: "main", repositories: [] };
  let chat = { ...base }, record;
  const store = { get: () => chat, records: { get: async () => record, put: async (_kind, _id, value) => { record = value; } } };
  const snapshot = { provider: "claude", rootThreadId: "main", awake: true, threads: [{ id: "child", messages: [{ role: "assistant", text: "Bound history" }] }] };
  const manager = new NativeAgentSnapshots(store, () => {}); await manager.update("chat", snapshot);
  assert.equal((await new NativeAgentSnapshots(store, () => {}).get("chat")).threads.length, 1);
  for (const field of ["ownerId", "agentAccountId", "environmentId", "workspace", "agentSessionId", "agent"]) {
    chat = { ...base, [field]: "different" };
    assert.deepEqual((await manager.get("chat")).threads, []);
    assert.deepEqual((await new NativeAgentSnapshots(store, () => {}).get("chat")).threads, []);
  }
  chat = { ...base }; const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  store.records.get = async () => { entered.resolve(); await gate.promise; return record; };
  const reading = new NativeAgentSnapshots(store, () => {}).get("chat"); await entered.promise; chat = { ...base, ownerId: "new-owner" }; gate.resolve();
  assert.deepEqual((await reading).threads, []);
  chat = { ...base }; store.records.get = async () => snapshot;
  assert.deepEqual((await new NativeAgentSnapshots(store, () => {}).get("chat")).threads, []);
});

test("Codex dispatch rechecks scope after cached authorization and after native goal updates", async t => {
  let current = true;
  const { agents, rpc } = observer(t, { assertCurrent: () => { if (!current) throw Error("Scope changed"); } });
  await agents.refresh();
  const before = rpc.calls.length, selecting = agents.select("nested"); current = false;
  await assert.rejects(selecting, /Scope changed/);
  assert.equal(rpc.calls.length, before, "No resume/history RPC after cached authorize yields");
  current = true; rpc.goals.set("child", { status: "active" });
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, input) => { const result = await original(method, input); if (method === "thread/goal/set") current = false; return result; };
  await assert.rejects(agents.interrupt("child"), /Scope changed/);
  assert.equal(rpc.calls.at(-1).method, "thread/goal/set", "No subsequent turn lookup/interrupt after scope revocation");
});

test("agent POST rechecks ownership after its delayed request body before any worker action", async t => {
  const directory = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(directory, { AGENT_WEB_AUTH_TOKEN: "fixture-token" }) });
  const { url } = await app.start(); t.after(() => app.stop()); const chat = await app.manager.createChat({ agent: "codex" });
  const checked = Promise.withResolvers(), original = app.browserUsers.canRead.bind(app.browserUsers); let actions = 0;
  app.browserUsers.canRead = (value, user) => { const result = original(value, user); if (value?.id === chat.id && result) checked.resolve(); return result; };
  app.manager.agentThreadAction = async () => { actions++; throw Error("No action authorized"); };
  const body = JSON.stringify({ rootThreadId: "main", threadId: "child" });
  let request; const response = new Promise((resolve, reject) => {
    request = httpRequest(`${url}/api/chats/${chat.id}/subagents/stop`, { method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, reply => { reply.resume(); reply.on("end", () => resolve(reply.statusCode)); });
    request.on("error", reject); request.flushHeaders();
  });
  t.after(() => request.destroy()); await checked.promise;
  await app.store.update(chat.id, { ownerId: "new-owner" }); request.end(body);
  assert.equal(await response, 404); assert.equal(actions, 0);
});
