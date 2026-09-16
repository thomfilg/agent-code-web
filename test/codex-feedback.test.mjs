import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CodexFeedback, codexFeedbackPolicy } from "../src/codex-feedback.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { webCommands } from "../public/web-commands.js";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const draft = { classification: "bug", reason: "A <literal> report\nwith a second line.", includeLogs: false };
const confirm = item => ({ id: item.id, revision: item.revision, threadId: item.threadId, confirm: true });
const policyArgs = { workspace: "/private/workspace", nativeHome: "/private/codex", privateProfile: true, threadId: "root", workerId: "worker" };
const readPolicy = (config = {}, requirements = null, args = {}) => codexFeedbackPolicy({ ...policyArgs, request: async method => method === "config/read" ? { config } : { requirements }, ...args });

test("feedback respects native defaults/admin policy and gates shared or external diagnostic roots", async () => {
  const normal = await readPolicy(); assert.equal(normal.enabled, true); assert.equal(normal.logsAllowed, true);
  assert.notEqual(normal.revision, (await readPolicy({}, null, { workerId: "replacement" })).revision);
  for (const result of [await readPolicy({ feedback: { enabled: false } }), await readPolicy({}, { feedback: { enabled: false } })]) {
    assert.equal(result.enabled, false); assert.equal(result.logsAllowed, false); assert.match(result.logsReason, /disabled/);
  }
  for (const args of [{ privateProfile: false }, { nativeHome: null }]) assert.equal((await readPolicy({}, null, args)).logsAllowed, false);
  for (const config of [{ log_dir: "/another-company/log" }, { sqlite_home: "file:///another-company/data" }, { log_dir: "relative" }, { log_dir: "ssh://remote/path" }, { log_dir: {} }]) {
    const policy = await readPolicy(config); assert.equal(policy.enabled, true); assert.equal(policy.logsAllowed, false);
  }
  assert.equal((await readPolicy({ sqlite_home: "file:///private/codex/db", log_dir: "/private/codex/log" })).logsAllowed, true);
  for (const requirements of [{ feedback: null, logDir: "file:///other-company/log" }, { feedback: null, sqliteHome: "/other-company/data" }]) assert.equal((await readPolicy({}, requirements)).logsAllowed, false);
  for (const [config, requirements] of [[{ feedback: "bad" }, null], [{ feedback: { enabled: "true" } }, null], [{}, {}], [{}, { feedback: { enabled: 1 } }]]) await assert.rejects(readPolicy(config, requirements), /unsupported feedback policy/);
  await assert.rejects(readPolicy({}, null, { request: async () => { throw new Error("TOKEN=private-diagnostic"); } }), error => !error.message.includes("private-diagnostic") && /Cannot verify/.test(error.message));
});

test("feedback is a Codex-only explicit control, never ordinary model input", () => {
  for (const text of ["/feedback", "/feedback upload logs", "/feedback\nprivate body"]) assert.throws(() => messageCommand("codex", text), /review and explicitly send/);
  assert.equal(messageCommand("claude", "/feedback"), null);
  assert.ok(webCommands("codex").some(item => item.name === "feedback")); assert.ok(!webCommands("claude").some(item => item.name === "feedback"));
});

async function fixture(t) {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize();
  const created = await store.create({ agent: "codex", title: "Feedback fixture" }), chat = await store.update(created.id, { agentSessionId: randomUUID() });
  const config = testConfig(root), service = new CodexFeedback(store, config), calls = [], flags = { enabled: true, logsAllowed: true, revision: "policy-one" };
  const adapter = { threadId: chat.agentSessionId, importWorkerId: randomUUID(), feedbackPolicy: async check => { check(); return { ...flags, threadId: chat.agentSessionId }; },
    uploadFeedback: async payload => { calls.push(payload); return { threadId: payload.threadId }; } };
  return { root, records, store, chat, config, service, adapter, flags, calls };
}

test("review persists exact text without uploading and confirmations send only server-selected fields once", async t => {
  const f = await fixture(t), report = await f.service.prepare(f.chat.id, { ...draft, extraLogFiles: ["/private/credentials"], tags: { token: "client-secret" } }, f.adapter);
  assert.equal(report.state, "prepared"); assert.equal(report.reason, draft.reason); assert.deepEqual(f.calls, []);
  assert.equal((await f.records.get("native-feedback", f.chat.id)).reports[0].reason, draft.reason);
  const input = { ...confirm(report), reason: "substituted", includeLogs: true, extraLogFiles: ["/elsewhere"] };
  const [first, second] = await Promise.all([f.service.send(f.chat.id, input, f.adapter), f.service.send(f.chat.id, input, f.adapter)]);
  assert.equal(first.state, "sent"); assert.deepEqual(first, second);
  assert.deepEqual(f.calls, [{ ...draft, threadId: f.chat.agentSessionId, extraLogFiles: [] }]);
  const restarted = new CodexFeedback(f.store, f.config); assert.equal((await restarted.send(f.chat.id, input, null)).state, "sent"); assert.equal(f.calls.length, 1);
});

test("invalid, disabled or shared-profile diagnostic selections cannot prepare an upload", async t => {
  const f = await fixture(t);
  for (const bad of [{ ...draft, reason: "" }, { ...draft, reason: "x".repeat(6001) }, { ...draft, includeLogs: "false" }, { ...draft, classification: "anything" }, { ...draft, reason: "a\u0000b" }]) await assert.rejects(f.service.prepare(f.chat.id, bad, f.adapter), /Choose a feedback type/);
  f.flags.enabled = false; await assert.rejects(f.service.prepare(f.chat.id, draft, f.adapter), /disabled/);
  f.flags.enabled = true; f.flags.logsAllowed = false;
  await assert.rejects(f.service.prepare(f.chat.id, { ...draft, includeLogs: true }, f.adapter), /not available/);
  assert.equal((await f.service.prepare(f.chat.id, draft, f.adapter)).state, "prepared"); assert.equal(f.calls.length, 0);
});

test("review identities cannot cross native roots, owners, companies, environments or workspaces", async t => {
  for (const change of [{ agentSessionId: "other-root" }, { ownerId: "other-owner" }, { repositories: [{ fullName: "g2i/private" }] }, { environmentId: "other-env" }, { workspace: "/another/workspace" }]) {
    const f = await fixture(t), report = await f.service.prepare(f.chat.id, draft, f.adapter); await f.store.update(f.chat.id, change);
    assert.deepEqual((await f.service.status(f.chat.id)).reports, []);
    await assert.rejects(f.service.send(f.chat.id, confirm(report), f.adapter), /no longer available/); assert.equal(f.calls.length, 0);
  }
});

test("expired, replaced-worker, changed-policy and revoked confirmations fail before upload", async t => {
  for (const failure of ["expired", "worker", "policy", "stopped", "archived"]) {
    const f = await fixture(t), report = await f.service.prepare(f.chat.id, draft, f.adapter);
    if (failure === "expired") { const saved = await f.records.get("native-feedback", f.chat.id); saved.reports[0].expiresAt = 1; await f.records.put("native-feedback", f.chat.id, saved); }
    if (failure === "worker") f.adapter.importWorkerId = randomUUID();
    if (failure === "policy") f.flags.revision = "changed";
    if (failure === "archived") await f.store.update(f.chat.id, { archived: true });
    const check = () => { if (failure === "stopped") throw new Error("Stopped"); };
    await assert.rejects(f.service.send(f.chat.id, confirm(report), f.adapter, check), /expired|changed|Stopped/); assert.equal(f.calls.length, 0);
  }
});

test("lost or malformed native acknowledgements never auto-retry, including after controller restart", async t => {
  for (const outcome of ["lost", "malformed", "foreign-thread"]) {
    const f = await fixture(t), report = await f.service.prepare(f.chat.id, draft, f.adapter);
    f.adapter.uploadFeedback = async payload => { f.calls.push(payload); if (outcome === "lost") throw new Error("API_KEY=must-not-leak"); return outcome === "malformed" ? {} : { threadId: "other-thread" }; };
    const result = await f.service.send(f.chat.id, confirm(report), f.adapter); assert.equal(result.state, "uncertain"); assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
    const restarted = new CodexFeedback(f.store, f.config); assert.equal((await restarted.send(f.chat.id, confirm(report), f.adapter)).state, "uncertain"); assert.equal(f.calls.length, 1);
  }
});

test("persisted upload intent is visible during native I/O; crash recovery treats it as uncertain", async t => {
  const f = await fixture(t), report = await f.service.prepare(f.chat.id, { ...draft, includeLogs: true }, f.adapter), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.adapter.uploadFeedback = async payload => { f.calls.push(payload); entered.resolve(); await release.promise; return { threadId: payload.threadId }; };
  const sending = f.service.send(f.chat.id, confirm(report), f.adapter); await entered.promise;
  assert.equal((await f.service.status(f.chat.id)).reports[0].state, "uploading"); assert.equal((await f.service.existing(f.chat.id, confirm(report))).state, "uploading");
  const restarted = new CodexFeedback(f.store, f.config); assert.equal((await restarted.status(f.chat.id)).reports[0].state, "uncertain");
  assert.equal((await restarted.send(f.chat.id, confirm(report), null)).state, "uncertain"); assert.equal(f.calls.length, 1);
  release.resolve(); assert.equal((await sending).state, "sent"); assert.equal(f.calls[0].includeLogs, true);
});

test("a failed durable intent never dispatches feedback and bounded review pruning cannot reactivate an old ID", async t => {
  const f = await fixture(t), report = await f.service.prepare(f.chat.id, draft, f.adapter), put = f.records.put.bind(f.records);
  f.records.put = async (kind, id, value) => { if (kind === "native-feedback" && value.reports.some(item => item.state === "uploading")) throw new Error("Storage unavailable"); return put(kind, id, value); };
  await assert.rejects(f.service.send(f.chat.id, confirm(report), f.adapter), /Storage unavailable/); assert.equal(f.calls.length, 0);
  f.records.put = put;
  for (let i = 0; i < 25; i++) await f.service.prepare(f.chat.id, { ...draft, reason: `new-${i}` }, f.adapter);
  assert.equal((await f.service.status(f.chat.id)).reports.length, 20);
  await assert.rejects(f.service.send(f.chat.id, confirm(report), f.adapter), /no longer available/); assert.equal(f.calls.length, 0);
  await f.store.remove(f.chat.id); assert.equal(await f.records.get("native-feedback", f.chat.id), null);
});

test("production adapter checks connection identity without interrupting an active turn", async () => {
  const adapter = Object.create(CodexAdapter.prototype), calls = [];
  Object.assign(adapter, { threadId: "root", importWorkerId: "worker", current: { text: "active" }, workspace: policyArgs.workspace, nativeHome: policyArgs.nativeHome,
    config: { codex: { authMode: "gateway" } }, rpc: { request: async (method, params) => { calls.push({ method, params }); return method === "config/read" ? { config: {} } : method === "configRequirements/read" ? { requirements: null } : { threadId: "root" }; } } });
  const policy = await adapter.feedbackPolicy(); assert.equal(policy.enabled, true);
  assert.equal(policy.logsAllowed, false); assert.match(policy.logsReason, /Startup/);
  adapter.feedbackStartupPolicy = await adapter.feedbackPolicy(() => {}, true);
  assert.equal((await adapter.feedbackPolicy()).logsAllowed, true);
  assert.deepEqual(await adapter.uploadFeedback({ ...draft, threadId: "root", extraLogFiles: [] }, () => {}), { threadId: "root" });
  assert.deepEqual(calls.map(call => call.method), ["config/read", "configRequirements/read", "config/read", "configRequirements/read", "config/read", "configRequirements/read", "feedback/upload"]);
  adapter.intentionalStop = true; await assert.rejects(adapter.feedbackPolicy(), /Connect/);
});

test("startup diagnostic policy remains binding after config reloads, including a previously disabled native handler", async () => {
  const adapter = Object.create(CodexAdapter.prototype), config = {};
  Object.assign(adapter, { threadId: "root", importWorkerId: "worker", workspace: policyArgs.workspace, nativeHome: policyArgs.nativeHome, config: { codex: { authMode: "gateway" } },
    rpc: { request: async method => method === "config/read" ? { config } : { requirements: null } } });
  adapter.feedbackStartupPolicy = await adapter.feedbackPolicy(() => {}, true);
  config.log_dir = "/private/codex/changed-log-dir";
  let policy = await adapter.feedbackPolicy(); assert.equal(policy.enabled, true); assert.equal(policy.logsAllowed, false); assert.match(policy.logsReason, /Startup diagnostic configuration/);
  config.feedback = { enabled: false }; assert.equal((await adapter.feedbackPolicy()).enabled, false);
  adapter.feedbackStartupPolicy = await adapter.feedbackPolicy(() => {}, true);
  config.feedback.enabled = true; policy = await adapter.feedbackPolicy(); assert.equal(policy.enabled, false); assert.match(policy.logsReason, /startup native configuration/);
});

async function serverFixture(t) {
  const root = await temporaryDirectory(t), calls = { starts: 0, sends: [], inputs: [], gate: null, policyGate: null, turnGate: null };
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "feedback-fixture", AGENT_IDLE_TIMEOUT_MS: "60000" }),
    models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, hooks }) => {
      const adapter = { threadId: chat.agentSessionId || randomUUID(), importWorkerId: randomUUID(),
        start: async () => { calls.starts++; await hooks.onSessionId(adapter.threadId); }, stop: async () => { calls.turnGate?.resolve(); },
        feedbackPolicy: async check => { await calls.policyGate?.promise; check(); return { threadId: adapter.threadId, enabled: true, logsAllowed: true, revision: "policy" }; },
        uploadFeedback: async (payload, check) => { check(); calls.sends.push(payload); await calls.gate?.promise; check(); return { threadId: adapter.threadId }; },
        send: async text => { calls.inputs.push(text); await calls.turnGate?.promise; return { text: "fixture" }; } };
      return adapter;
    } });
  const { url } = await app.start(); t.after(() => app.stop()); const chat = await app.manager.createChat({ agent: "codex", title: "Feedback API fixture" });
  const request = (tail, input) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method: input === undefined ? "GET" : "POST", headers: { authorization: "Bearer feedback-fixture", "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { app, root, url, chat, calls, request };
}

test("authenticated feedback API only wakes on explicit policy/review and ignores arbitrary paths and body substitution", async t => {
  const f = await serverFixture(t);
  assert.equal((await fetch(`${f.url}/api/chats/${f.chat.id}/feedback`)).status, 401);
  assert.equal((await fetch(`${f.url}/api/chats/${f.chat.id}/feedback/policy`, { method: "POST", headers: { authorization: "Bearer feedback-fixture", origin: "https://foreign.invalid", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await f.request("feedback")).status, 200); assert.equal(f.calls.starts, 0);
  const policy = await f.request("feedback/policy", {}); assert.equal(policy.status, 200); assert.equal(f.calls.starts, 1);
  const report = await (await f.request("feedback/prepare", { ...draft, extraLogFiles: ["/other-company/private"], tags: { secret: "ignored" } })).json();
  assert.equal(report.state, "prepared"); assert.equal(f.calls.sends.length, 0);
  assert.equal((await f.request("feedback/send", { ...confirm(report), confirm: false })).status, 409);
  const result = await (await f.request("feedback/send", { ...confirm(report), reason: "REPLACED", includeLogs: true, threadIdOverride: "foreign" })).json();
  assert.equal(result.state, "sent"); assert.deepEqual(f.calls.sends, [{ ...draft, threadId: report.threadId, extraLogFiles: [] }]);
  assert.deepEqual(f.calls.inputs, []); assert.equal(f.app.store.get(f.chat.id).messages.length, 0);
  await f.app.manager.stop(f.chat.id); assert.equal((await (await f.request("feedback/send", confirm(report))).json()).state, "sent"); assert.equal(f.calls.starts, 1);
  await f.app.store.update(f.chat.id, { ownerId: "another-user" }); assert.equal((await f.request("feedback")).status, 404);
});

test("duplicate in-flight HTTP confirmation returns status; feedback can run while the main agent works", async t => {
  const f = await serverFixture(t); f.calls.turnGate = Promise.withResolvers(); const turn = f.app.manager.send(f.chat.id, "Keep working");
  await waitFor(() => f.calls.inputs.length); f.calls.gate = Promise.withResolvers();
  const report = await (await f.request("feedback/prepare", draft)).json(), sending = f.request("feedback/send", confirm(report));
  await waitFor(() => f.calls.sends.length); assert.equal((await (await f.request("feedback/send", confirm(report))).json()).state, "uploading");
  assert.equal((await (await f.request("feedback")).json()).reports[0].state, "uploading"); assert.equal(f.calls.sends.length, 1);
  f.calls.gate.resolve(); assert.equal((await (await sending).json()).state, "sent");
  f.calls.turnGate.resolve(); await turn; assert.equal(f.calls.inputs.length, 1); assert.match(f.calls.inputs[0], /Keep working/);
});

test("Stop and scope changes during policy review prevent dispatch and confirmation never silently wakes a stopped worker", async t => {
  const f = await serverFixture(t), report = await (await f.request("feedback/prepare", draft)).json();
  await f.app.manager.stop(f.chat.id); assert.equal((await f.request("feedback/send", confirm(report))).status, 409); assert.equal(f.calls.starts, 1);
  const fresh = await (await f.request("feedback/prepare", draft)).json(); f.calls.policyGate = Promise.withResolvers();
  const sending = f.request("feedback/send", confirm(fresh)); await waitFor(() => f.app.manager.isBusy(f.chat.id));
  await f.app.manager.stop(f.chat.id); f.calls.policyGate.resolve(); assert.equal((await sending).status, 409); assert.equal(f.calls.sends.length, 0);
});

test("HTTP Stop after dispatch preserves an uncertain record and cannot repeat the upload", async t => {
  const f = await serverFixture(t), report = await (await f.request("feedback/prepare", draft)).json(); f.calls.gate = Promise.withResolvers();
  const sending = f.request("feedback/send", confirm(report)); await waitFor(() => f.calls.sends.length);
  await f.app.manager.stop(f.chat.id); f.calls.gate.resolve(); assert.equal((await sending).status, 409);
  assert.equal((await (await f.request("feedback")).json()).reports[0].state, "uncertain");
  assert.equal((await (await f.request("feedback/send", confirm(report))).json()).state, "uncertain"); assert.equal(f.calls.sends.length, 1); assert.equal(f.calls.starts, 1);
});
