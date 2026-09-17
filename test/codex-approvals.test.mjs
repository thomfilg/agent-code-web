import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CodexApprovals, guardianDeniedEvent } from "../src/codex-approvals.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { ChatStore } from "../src/store.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { webCommands } from "../public/web-commands.js";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const report = (threadId, action = { type: "command", source: "unifiedExec", command: "printf 'original exact arguments'", cwd: "/private/workspace" }) => ({
  threadId, turnId: randomUUID(), reviewId: randomUUID(), targetItemId: "tool-item", startedAtMs: Date.now() - 20, completedAtMs: Date.now(), decisionSource: "agent",
  review: { status: "denied", riskLevel: "low", userAuthorization: "low", rationale: "Review fixture" }, action,
});
const confirmation = (catalog, index = 0) => ({ id: catalog.reviews[index].id, revision: catalog.reviews[index].revision, threadId: catalog.threadId, confirm: true });

test("Guardian mapping retains exact payloads for every installed v2 action and rejects unknown shapes", () => {
  const base = report("root");
  assert.equal(guardianDeniedEvent(base).action.command, base.action.command);
  assert.equal(guardianDeniedEvent(base).action.source, "unified_exec");
  const actions = [
    { type: "execve", source: "shell", program: "/bin/printf", argv: ["a b", "$(not-executed)", ""], cwd: "/private/workspace" },
    { type: "writeStdin", approvalId: "approval", processId: "7", stdin: "verbatim\ninput", cwd: "/private/workspace" },
    { type: "applyPatch", cwd: "/private/workspace", files: ["a b.txt", "-file"] },
    { type: "networkAccess", target: "https://example.invalid/endpoint", host: "example.invalid", port: 443, protocol: "socks5Tcp" },
    { type: "mcpToolCall", server: "private-linear", toolName: "issue", connectorId: null, connectorName: null, toolTitle: "Issue" },
    { type: "requestPermissions", reason: "Fixture", permissions: { network: { enabled: false }, fileSystem: { read: ["/private/read"], write: null, globScanMaxDepth: 2,
      entries: [{ path: { type: "path", path: "/private/read" }, access: "read" }, { path: { type: "special", value: { kind: "project_roots", subpath: null } }, access: "read" }, { path: { type: "glob_pattern", pattern: "*.md" }, access: "deny" }] } } },
  ];
  const mapped = actions.map(action => guardianDeniedEvent({ ...base, action }).action);
  assert.deepEqual(mapped.map(action => action.type), ["execve", "write_stdin", "apply_patch", "network_access", "mcp_tool_call", "request_permissions"]);
  assert.deepEqual(mapped[0].argv, actions[0].argv); assert.equal(mapped[1].approval_id, "approval"); assert.equal(mapped[3].protocol, "socks5_tcp");
  assert.equal(mapped[4].tool_name, "issue"); assert.equal(mapped[5].permissions.file_system.glob_scan_max_depth, 2);
  assert.equal(mapped[1].cwd, "file:///private/workspace"); assert.ok(!Object.hasOwn(mapped[5].permissions.file_system, "read"));
  const ambiguous = structuredClone(actions.at(-1)); ambiguous.permissions.fileSystem.read = ["/different/path"];
  assert.throws(() => guardianDeniedEvent({ ...base, action: ambiguous }), /Ambiguous/);
  for (const invalid of [{ ...base, review: { ...base.review, status: "approved" } }, { ...base, action: { ...base.action, injected: "payload" } },
    { ...base, action: { type: "newUnknownAction" } }, { ...base, threadId: null }, { ...base, completedAtMs: -1 }, { ...base, action: { ...base.action, command: "x".repeat(130000) } }]) assert.throws(() => guardianDeniedEvent(invalid));
  assert.throws(() => messageCommand("codex", "/approve"), /confirm a specific/); assert.throws(() => messageCommand("codex", "/approve arbitrary payload"), /confirm a specific/);
  assert.equal(messageCommand("claude", "/approve"), null); assert.ok(webCommands("codex").some(item => item.name === "approve")); assert.ok(!webCommands("claude").some(item => item.name === "approve"));
});

async function ledger(t) {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize();
  const config = testConfig(root), created = await store.create({ agent: "codex", title: "Private approval fixture" });
  const chat = await store.update(created.id, { agentSessionId: randomUUID() });
  const approvals = new CodexApprovals(store, config), event = report(chat.agentSessionId);
  await approvals.capture(chat.id, event, approvals.binding(chat));
  return { root, store, records, config, chat, approvals, event };
}

test("recorded denials survive controller restart, redact browser output, deduplicate events and bind to company/session", async t => {
  const f = await ledger(t); f.event.action.command = "TOKEN=fixture-review-secret printf sample"; f.event.reviewId = randomUUID(); f.event.completedAtMs += 10;
  await f.approvals.capture(f.chat.id, f.event, f.approvals.binding(f.chat));
  const publicView = await f.approvals.list(f.chat.id); assert.equal(publicView.reviews.length, 2); assert.doesNotMatch(JSON.stringify(publicView), /fixture-review-secret/);
  const restarted = new CodexApprovals(f.store, f.config); assert.deepEqual(await restarted.list(f.chat.id), publicView);
  await restarted.capture(f.chat.id, { ...f.event, action: { ...f.event.action, command: "DIFFERENT" } }, restarted.binding(f.chat));
  assert.equal((await restarted.list(f.chat.id)).reviews.length, 2);
  await f.store.update(f.chat.id, { repositories: [{ fullName: "g2i/other-project" }] });
  assert.deepEqual((await restarted.list(f.chat.id)).reviews, []);
  await assert.rejects(restarted.queue(f.chat.id, confirmation(publicView), async () => assert.fail("No enqueue")), /Confirm a current/);
  await assert.rejects(restarted.capture(f.chat.id, f.event, restarted.binding(f.chat)), /changed/);
});

test("a consumed approval queues and sends exactly once; removing it never grants native permission", async t => {
  const f = await ledger(t), input = confirmation(await f.approvals.list(f.chat.id)), queued = [], calls = [];
  const enqueue = async item => { if (!queued.some(entry => entry.id === item.id)) queued.push(item); };
  await Promise.all([f.approvals.queue(f.chat.id, input, enqueue), f.approvals.queue(f.chat.id, input, enqueue)]); assert.equal(queued.length, 1);
  const claim = await f.approvals.claim(f.chat.id, input.id);
  await f.approvals.retry(f.chat.id, claim, { threadId: input.threadId, approveDeniedAction: async event => calls.push(event) }, async () => { calls.push("input"); return "done"; }, () => {});
  assert.deepEqual(calls, [guardianDeniedEvent(f.event), "input"]);
  assert.equal((await f.approvals.queue(f.chat.id, input, async () => assert.fail("Do not enqueue again"))).state, "completed");
  await assert.rejects(f.approvals.claim(f.chat.id, input.id), /no longer queued/);
  await f.approvals.capture(f.chat.id, f.event, f.approvals.binding(f.chat)); assert.equal((await f.approvals.list(f.chat.id)).reviews[0].state, "completed");
  const next = { ...f.event, reviewId: randomUUID(), completedAtMs: f.event.completedAtMs + 1 }; await f.approvals.capture(f.chat.id, next, f.approvals.binding(f.chat));
  const cancel = confirmation(await f.approvals.list(f.chat.id)); await f.approvals.queue(f.chat.id, cancel, enqueue); await f.approvals.cancel(f.chat.id, cancel.id);
  assert.equal((await f.approvals.queue(f.chat.id, cancel, async () => assert.fail("Cancelled means cancelled"))).state, "cancelled");
});

test("lost native approval replies and uncertain input never replay after restart", async t => {
  for (const failure of ["approval", "input"]) {
    const f = await ledger(t), input = confirmation(await f.approvals.list(f.chat.id)); await f.approvals.queue(f.chat.id, input, async () => {});
    const claim = await f.approvals.claim(f.chat.id, input.id); let approvals = 0, sends = 0;
    await assert.rejects(f.approvals.retry(f.chat.id, claim, { threadId: input.threadId, approveDeniedAction: async () => { approvals++; if (failure === "approval") throw new Error("RPC reply lost"); } },
      async () => { sends++; throw new Error("Turn acknowledgement lost"); }, () => {}), /will not be repeated/);
    assert.equal(approvals, 1); assert.equal(sends, failure === "input" ? 1 : 0);
    const restarted = new CodexApprovals(f.store, f.config); assert.equal((await restarted.list(f.chat.id)).reviews[0].state, "uncertain");
    assert.equal((await restarted.queue(f.chat.id, input, async () => assert.fail("No replay"))).state, "uncertain");
  }
});

test("scope revocation or Stop guards before native dispatch grant nothing", async t => {
  const f = await ledger(t), input = confirmation(await f.approvals.list(f.chat.id)); await f.approvals.queue(f.chat.id, input, async () => {});
  const claim = await f.approvals.claim(f.chat.id, input.id);
  await assert.rejects(f.approvals.retry(f.chat.id, claim, { threadId: input.threadId, approveDeniedAction: () => assert.fail("No approval") }, () => assert.fail("No input"), () => { throw new Error("Stopped"); }), /Stopped/);
  assert.equal((await f.approvals.list(f.chat.id)).reviews[0].state, "cancelled");
  await assert.rejects(f.approvals.retry(f.chat.id, claim, { threadId: input.threadId, approveDeniedAction: () => assert.fail("Do not resurrect cancelled claims") }, () => assert.fail("No input"), () => {}), /already consumed or cancelled/);
});

test("bounded reviews retain a queued selection when newer denials arrive, including same-millisecond events", async t => {
  const f = await ledger(t), input = confirmation(await f.approvals.list(f.chat.id)); await f.approvals.queue(f.chat.id, input, async () => {});
  for (let i = 0; i < 25; i++) await f.approvals.capture(f.chat.id, { ...f.event, reviewId: randomUUID(), action: { ...f.event.action, command: `newer-${i}` } }, f.approvals.binding(f.chat));
  const list = await f.approvals.list(f.chat.id); assert.equal(list.reviews.length, 21); assert.equal(list.reviews.find(item => item.id === input.id).state, "queued");
  const claim = await f.approvals.claim(f.chat.id, input.id), granted = [];
  await f.approvals.retry(f.chat.id, claim, { threadId: input.threadId, approveDeniedAction: async event => granted.push(event.action.command) }, async () => {}, () => {});
  assert.deepEqual(granted, [f.event.action.command]);
  await f.approvals.capture(f.chat.id, f.event, f.approvals.binding(f.chat)); assert.equal((await f.approvals.list(f.chat.id)).reviews.length, 21);
});

async function serverFixture(t) {
  const root = await temporaryDirectory(t), rootThreadId = randomUUID(), calls = { starts: 0, grants: [], inputs: [], gate: null, approvalGate: null, approvalFailure: false };
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "approve-fixture", AGENT_IDLE_TIMEOUT_MS: "60000" }),
    models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, hooks }) => ({
      threadId: chat.agentSessionId || rootThreadId,
      start: async () => { calls.starts++; await hooks.onSessionId(chat.agentSessionId || rootThreadId); }, stop: async () => { calls.gate?.resolve(); },
      approveDeniedAction: async (event, check) => { check(); calls.grants.push(event); await calls.approvalGate?.promise; if (calls.approvalFailure) throw new Error("Lost reply"); check(); },
      send: async (text, settings) => { calls.inputs.push({ text, settings });
        if (text.includes("CAPTURE_DENIAL")) await hooks.onEvent({ type: "native_approval_denied", report: report(chat.agentSessionId || rootThreadId) });
        if (text.includes("BLOCK_ACTIVE_TURN")) await calls.gate?.promise;
        return { text: "Fixture response" };
      },
    }) });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "codex", title: "Approval fixture" });
  const request = (tail, input) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method: input === undefined ? "GET" : "POST", headers: { authorization: "Bearer approve-fixture", "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  await app.manager.send(chat.id, "CAPTURE_DENIAL");
  const catalog = await (await request("approvals")).json(), input = confirmation(catalog);
  return { root, app, chat, calls, url, request, input, catalog };
}

test("authenticated API inspection never wakes workers; confirmations cannot substitute actions or cross owners", async t => {
  const f = await serverFixture(t); await f.app.manager.stop(f.chat.id); const starts = f.calls.starts, messages = f.app.store.get(f.chat.id).messages;
  assert.equal((await f.request("approvals")).status, 200); assert.equal(f.calls.starts, starts); assert.deepEqual(f.app.store.get(f.chat.id).messages, messages);
  assert.equal((await fetch(`${f.url}/api/chats/${f.chat.id}/approvals`)).status, 401);
  assert.equal((await fetch(`${f.url}/api/chats/${f.chat.id}/approvals/retry`, { method: "POST", headers: { authorization: "Bearer approve-fixture", "content-type": "application/json", origin: "https://foreign.invalid" }, body: JSON.stringify(f.input) })).status, 403);
  for (const input of [{ ...f.input, confirm: false }, { ...f.input, revision: "fake" }, { ...f.input, threadId: "other" }, { ...f.input, id: randomUUID() }]) assert.equal((await f.request("approvals/retry", input)).status, 409);
  assert.equal((await f.request("messages", { text: "/approve", nativeApprovalId: f.input.id })).status, 400); assert.deepEqual(f.calls.grants, []);
  await f.app.store.update(f.chat.id, { ownerId: "someone-else" }); assert.equal((await f.request("approvals/retry", f.input)).status, 404); assert.deepEqual(f.calls.grants, []);
});

test("confirmed retries obey FIFO and paused queues, ignore browser payloads and preserve permission mode", async t => {
  const f = await serverFixture(t); await f.app.manager.stop(f.chat.id); await f.app.store.update(f.chat.id, { mode: "plan" });
  await f.app.manager.enqueue(f.chat.id, "First queued message");
  const input = { ...f.input, event: { action: { command: "SUBSTITUTED" } } };
  const responses = await Promise.all([f.request("approvals/retry", input), f.request("approvals/retry", input)]); assert.ok(responses.every(response => response.status === 202));
  assert.equal(f.app.store.get(f.chat.id).queuedMessages.length, 2); assert.equal(f.calls.grants.length, 0);
  await f.app.manager.editQueue(f.chat.id, { resume: true });
  await waitFor(async () => (await f.app.manager.approvals.list(f.chat.id)).reviews[0].state === "completed");
  assert.equal(f.calls.grants.length, 1); assert.equal(f.calls.grants[0].action.command, "printf 'original exact arguments'");
  assert.match(f.calls.inputs[1].text, /First queued message/); assert.match(f.calls.inputs[2].text, /Retry that exact action once/); assert.equal(f.calls.inputs[2].settings.mode, "plan");
  assert.equal(f.app.store.get(f.chat.id).mode, "plan"); assert.equal(f.app.store.get(f.chat.id).queuedMessages.length, 0);
  assert.equal((await (await f.request("approvals/retry", f.input)).json()).state, "completed"); assert.equal(f.calls.grants.length, 1);
  await f.app.manager.remove(f.chat.id); assert.equal(await f.app.records.get("native-approvals", f.chat.id), null);
});

test("busy chats queue a reviewed action and removing it grants nothing", async t => {
  const f = await serverFixture(t); f.calls.gate = Promise.withResolvers(); const active = await f.app.manager.submit(f.chat.id, "BLOCK_ACTIVE_TURN");
  await waitFor(() => f.calls.inputs.length === 2);
  assert.equal((await f.request("approvals/retry", f.input)).status, 202); assert.equal(f.calls.grants.length, 0);
  const item = f.app.store.get(f.chat.id).queuedMessages[0]; await f.app.manager.editQueue(f.chat.id, { removeId: item.id });
  f.calls.gate.resolve(); await active.completion; await waitFor(() => !f.app.manager.isBusy(f.chat.id));
  assert.deepEqual(f.calls.grants, []); assert.equal((await f.app.manager.approvals.list(f.chat.id)).reviews[0].state, "cancelled");
});

test("Stop during native approval cannot send a late retry; uncertain results remain consumed", async t => {
  const f = await serverFixture(t); f.calls.approvalGate = Promise.withResolvers();
  assert.equal((await f.request("approvals/retry", f.input)).status, 202);
  await waitFor(() => f.calls.grants.length === 1); await f.app.manager.stop(f.chat.id); f.calls.approvalGate.resolve();
  await waitFor(async () => (await f.app.manager.approvals.list(f.chat.id)).reviews[0].state === "uncertain");
  assert.equal(f.calls.inputs.length, 1); assert.equal((await (await f.request("approvals/retry", f.input)).json()).state, "uncertain");
  assert.equal(f.calls.grants.length, 1);
});

test("queued retries cannot cross companies or providers and stale entries can still be removed", async t => {
  for (const patch of [{ repositories: [{ fullName: "g2i/other-project" }] }, { agent: "claude", agentSessionId: null }]) {
    const f = await serverFixture(t); await f.app.manager.stop(f.chat.id);
    assert.equal((await f.request("approvals/retry", f.input)).status, 202);
    const queued = f.app.store.get(f.chat.id).queuedMessages[0]; await f.app.store.update(f.chat.id, patch);
    await f.app.manager.editQueue(f.chat.id, { resume: true });
    await waitFor(() => f.app.store.get(f.chat.id).queueError);
    assert.deepEqual(f.calls.grants, []); assert.equal(f.calls.inputs.length, 1);
    await f.app.manager.editQueue(f.chat.id, { removeId: queued.id }); assert.equal(f.app.store.get(f.chat.id).queuedMessages.length, 0);
    assert.equal((await f.app.records.get("native-approvals", f.chat.id)).reviews[0].state, "cancelled");
  }
});
