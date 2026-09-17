import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { ClaudeRequests } from "../src/claude-requests.mjs";
import { publicRequest, responseFor } from "../src/agent-requests.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const packet = (id = "native-1", input = { command: "node harmless.mjs" }, tool = "Bash") => ({ type: "control_request", request_id: id,
  request: { subtype: "can_use_tool", tool_name: tool, input, permission_suggestions: [{ type: "addRules", destination: "userSettings" }] } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(hooks = {}) {
  const f = { sent: [], shown: [], events: [], child: new EventEmitter() };
  f.child.stdin = new Writable({ write(chunk, _encoding, done) {
    f.sent.push(JSON.parse(String(chunk)));
    if (f.fail) done(Error("Fixture EPIPE")); else if (f.hold) f.release = done; else done();
  } });
  f.child.stdin.on("error", () => {});
  f.requests = new ClaudeRequests(f.child, { onRequest: async request => f.shown.push(publicRequest(request)), onEvent: event => f.events.push(event), ...hooks }, "/private/workspace");
  return f;
}

test("Claude approvals bind opaque IDs to unchanged native inputs and never persist suggested permissions", async () => {
  const f = fixture(), input = { file_path: "/private/workspace/.claude/skills/verify/SKILL.md", content: "Fixture recipe", note: "AUTH_TOKEN=private-fixture-token" };
  f.requests.accept(packet("native-1", input, "Write")); input.content = "Mutated after receipt"; await tick();
  const request = f.shown[0]; assert.match(request.requestId, /^claude_request_/); assert.notEqual(request.requestId, "native-1");
  assert.equal(request.method, "claude/tool/requestApproval"); assert.deepEqual(request.availableDecisions, ["accept", "decline"]);
  assert.doesNotMatch(request.command, /private-fixture-token/); assert.match(request.command, /Fixture recipe/);
  assert.throws(() => responseFor(request, { decision: "acceptForSession" }), /not available/);
  await assert.rejects(f.requests.respond(request.requestId, { decision: "acceptForSession" }), /session-wide/);
  await f.requests.respond(request.requestId, { decision: "accept", updatedInput: { command: "different command" }, updatedPermissions: [{ destination: "userSettings" }] });
  assert.deepEqual(f.sent[0], { type: "control_response", response: { subtype: "success", request_id: "native-1", response: {
    behavior: "allow", updatedInput: { ...input, content: "Fixture recipe" } } } });
  await assert.rejects(f.requests.respond(request.requestId, { decision: "accept" }), /no longer active/);
  assert.equal(f.sent.length, 1);
});

test("parallel native permissions are displayed one at a time and cannot authorize another chat or queued request", async () => {
  const f = fixture(), other = fixture();
  f.requests.accept(packet()); f.requests.accept(packet("native-2")); other.requests.accept(packet()); await tick();
  assert.equal(f.shown.length, 1); const first = f.shown[0], queued = [...f.requests.requests.values()][1];
  await assert.rejects(other.requests.respond(first.requestId, { decision: "accept" }), /no longer active/);
  await assert.rejects(f.requests.respond(queued.requestId, { decision: "accept" }), /no longer active/);
  await f.requests.respond(first.requestId, { decision: "decline" });
  assert.equal(f.shown.length, 2); assert.equal(f.shown[1].requestId, queued.requestId);
  assert.equal(f.sent[0].response.response.behavior, "deny");
  await f.requests.respond(queued.requestId, { decision: "accept" });
  assert.equal(f.sent[1].response.request_id, "native-2"); assert.equal(other.sent.length, 0);
  other.requests.close();
});

test("cancellation before publication and Stop cannot resurrect stale approvals", async () => {
  const f = fixture(); f.requests.accept(packet()); f.requests.accept({ type: "control_cancel_request", request_id: "native-1" });
  await tick(); assert.deepEqual(f.shown, []); assert.deepEqual(f.sent, []);
  f.requests.accept(packet("first")); f.requests.accept(packet("second")); await tick();
  const id = f.shown[0].requestId; f.requests.cancel(); await tick();
  assert.equal(f.shown.length, 1, "Do not briefly publish the next request during Stop");
  assert(f.sent.every(message => message.response.response.behavior === "deny"));
  await assert.rejects(f.requests.respond(id, { decision: "accept" }), /no longer active/);
  f.requests.accept(packet("late")); await tick();
  assert.equal(f.shown.length, 1); assert.equal(f.sent.at(-1).response.response.behavior, "deny");
  f.requests.resume();
  f.requests.accept(packet("third")); f.child.emit("close"); await tick();
  assert.equal(f.shown.length, 1); assert.equal(f.requests.requests.size, 0);
});

test("concurrent responses and ambiguous delivery never replay an approval", async () => {
  const f = fixture(); f.requests.accept(packet()); await tick(); f.hold = true;
  const id = f.shown[0].requestId, first = f.requests.respond(id, { decision: "accept" });
  await assert.rejects(f.requests.respond(id, { decision: "accept" }), /no longer active/);
  f.release(); await first; assert.equal(f.sent.length, 1);
  const broken = fixture(); broken.requests.accept(packet()); await tick(); broken.fail = true;
  await assert.rejects(broken.requests.respond(broken.shown[0].requestId, { decision: "accept" }), /could not be confirmed/);
  await assert.rejects(broken.requests.respond(broken.shown[0].requestId, { decision: "accept" }), /no longer active/);
  assert.equal(broken.sent.length, 1);
});

test("native questions map single, multiple and free-text answers without accepting forged question IDs", async () => {
  const f = fixture(), questions = [
    { question: "Which sections?", header: "Sections", multiSelect: true, options: [{ label: "Intro" }, { label: "Conclusion" }] },
    { question: "Which name?", header: "Name", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
  ];
  f.requests.accept(packet("question", { questions, answers: { injected: "Do not retain this model-supplied answer" } }, "AskUserQuestion")); await tick();
  const request = f.shown[0]; assert.equal(request.method, "claude/tool/requestUserInput");
  assert.equal(request.questions[0].multiSelect, true);
  await assert.rejects(f.requests.respond(request.requestId, { answers: { forged: { answers: ["yes"] } } }), /requested question/);
  await assert.rejects(f.requests.respond(request.requestId, { answers: { question_2: { answers: ["A", "B"] } } }), /requested question/);
  await f.requests.respond(request.requestId, responseFor(request, { answers: { question_1: ["Intro", "Conclusion"], question_2: "ação\nKeep it literal" } }));
  assert.deepEqual(f.sent[0].response.response, { behavior: "allow", updatedInput: { questions, answers: { "Which sections?": "Intro, Conclusion", "Which name?": "ação\nKeep it literal" } } });
  f.requests.accept(packet("skip", { questions }, "AskUserQuestion")); await tick();
  await f.requests.respond(f.shown[1].requestId, responseFor(f.shown[1], { answers: {} }));
  assert.equal(f.sent[1].response.response.behavior, "deny"); assert.match(f.sent[1].response.response.message, /skipped/);
});

test("unsupported requests, malformed questions and failed display never grant permission", async () => {
  const f = fixture(); f.requests.accept({ type: "control_request", request_id: "unknown", request: { subtype: "request_user_dialog" } });
  f.requests.accept(packet("bad-question", { questions: [{ question: "Missing options" }] }, "AskUserQuestion"));
  await tick(); assert.equal(f.sent[0].response.subtype, "error"); assert.equal(f.sent[1].response.response.behavior, "deny"); assert.deepEqual(f.shown, []);
  const broken = fixture({ onRequest: async () => { throw Error("Fixture unavailable UI"); } });
  broken.requests.accept(packet()); await tick();
  assert.equal(broken.sent[0].response.response.behavior, "deny"); assert.equal(broken.requests.requests.size, 0);
});

test("controller resolves only its chat's current native request and preserves queued input through Stop", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize(); const runs = new Map();
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }), broker: new CapabilityBroker({ ttlMs: 60000 }),
    adapterFactory: ({ chat, hooks }) => {
      const f = fixture(hooks); runs.set(chat.id, f); let complete;
      return { start: async () => {}, send: async () => new Promise(resolve => { complete = resolve; f.requests.accept(packet()); }),
        respond: async (id, payload) => { await f.requests.respond(id, payload); complete({ text: "Native request resolved" }); },
        stop: async () => { f.requests.cancel(); f.requests.close(); complete?.({ text: "Stopped" }); } };
    } });
  t.after(() => manager.shutdown());
  const a = await manager.createChat({ agent: "claude", title: "A" }), b = await manager.createChat({ agent: "claude", title: "B" });
  const first = manager.send(a.id, "Task A"), second = manager.send(b.id, "Task B");
  await waitFor(() => store.get(a.id).pendingRequest && store.get(b.id).pendingRequest);
  const requestA = store.get(a.id).pendingRequest, requestB = store.get(b.id).pendingRequest;
  await manager.enqueue(a.id, "Retain this queued task"); await store.update(a.id, { queuePaused: true });
  await assert.rejects(manager.respond(b.id, requestA.requestId, { decision: "accept" }), /no longer active/);
  await assert.rejects(manager.respond(a.id, requestA.requestId, { decision: "acceptForSession" }), /not available/);
  await manager.respond(a.id, requestA.requestId, { decision: "accept" }); await first;
  assert.equal(store.get(a.id).pendingRequest, null); assert.equal(store.get(b.id).pendingRequest.requestId, requestB.requestId);
  assert.deepEqual(store.get(a.id).queuedMessages.map(item => item.text), ["Retain this queued task"]);
  await manager.stop(b.id); await second;
  await assert.rejects(manager.respond(b.id, requestB.requestId, { decision: "accept" }), /not active|no longer active/);
  assert.equal(runs.get(a.id).sent[0].response.response.behavior, "allow");
  assert(runs.get(b.id).sent.every(message => message.response.response.behavior === "deny"));
});
