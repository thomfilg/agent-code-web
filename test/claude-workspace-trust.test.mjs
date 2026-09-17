import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, symlink } from "node:fs/promises";
import { ClaudeWorkspaceTrust, claudeTrustProbe } from "../src/claude-workspace-trust.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const workspace = "/fixture/workspace", binding = "owner/company/worker";
const needs = { status: "needs_trust", directory: workspace };
const trusted = { status: "ok", cwd: workspace, changed: true, transcript_relocated: true };
function fixture() {
  const f = { calls: [], opens: 0, closes: 0, now: 1000, accepted: false };
  f.service = new ClaudeWorkspaceTrust({ workspace, now: () => f.now, ttlMs: 5000, open: async signal => {
    f.opens++; f.signal = signal;
    return { close: async () => { f.closes++; }, request: async (subtype, fields = {}) => {
      f.calls.push({ subtype, ...fields }); await f.requested?.(subtype, fields);
      if (subtype === "initialize") return {};
      if (fields.trust_accepted) { f.accepted = true; return f.granted || trusted; }
      return f.snapshot || (f.accepted ? trusted : needs);
    } };
  } });
  f.inspect = () => f.service.run("inspect", {}, binding);
  f.confirm = (review, scope = binding, guard) => f.service.run("confirm", { reviewId: review.reviewId, confirm: true }, scope, guard);
  return f;
}

test("workspace trust never grants on inspection; only explicit bound confirmation calls the native attestation", async () => {
  const f = fixture(), review = await f.inspect();
  assert.equal(review.state, "needs_trust"); assert.equal(review.directory, workspace); assert.equal(review.expiresAt, 6000);
  assert.deepEqual(f.calls, [{ subtype: "initialize" }, { subtype: "set_cwd", path: workspace }]);
  for (const input of [{}, { reviewId: review.reviewId }, { reviewId: "wrong", confirm: true }]) await assert.rejects(f.service.run("confirm", input, binding), /stale/);
  await assert.rejects(f.confirm(review, "other-owner"), /stale/); assert.equal(f.opens, 1);
  assert.equal((await f.confirm(review)).state, "trusted");
  assert.deepEqual(f.calls.at(-1), { subtype: "set_cwd", path: workspace, trust_accepted: true, trusted_directory: workspace });
  await assert.rejects(f.confirm(review), /stale/); assert.equal(f.opens, f.closes);
  assert.equal((await f.inspect()).reviewId, null); assert.equal(f.calls.filter(call => call.trust_accepted).length, 1);
});

test("workspace trust refuses expired and replaced reviews, including expiration during native startup", async () => {
  const f = fixture(), first = await f.inspect(), second = await f.inspect();
  await assert.rejects(f.confirm(first), /stale/); f.now = second.expiresAt;
  await assert.rejects(f.confirm(second), /stale/);
  const fresh = await f.inspect(); f.requested = () => { f.now = fresh.expiresAt; };
  await assert.rejects(f.confirm(fresh), /expired/); assert(!f.accepted); assert.equal(f.opens, f.closes);
});

test("native trust scope, visible canonical paths and actual directory changes are mandatory", async () => {
  for (const snapshot of [null, {}, { ...needs, directory: "/outside" }, { ...needs, trust_root: "/fixture" }, { ...needs, trust_root: "/secret\npath" },
    { ...trusted, changed: false }, { ...trusted, transcript_relocated: false }, { ...trusted, cwd: "/outside" }, { status: "rejected", reason: "blocked_by_rule", message: "PRIVATE_TOKEN" }]) {
    const f = fixture(); f.snapshot = snapshot || {};
    await assert.rejects(f.inspect(), error => error.statusCode === 409 && !error.message.includes("PRIVATE_TOKEN"));
    assert(!f.accepted); assert.equal(f.opens, f.closes);
  }
  for (const path of ["/", "relative", "/fixture/../workspace", "/fixture\nworkspace", "/fixture\u200bworkspace", "/fixture\u00a0workspace"]) {
    const f = fixture(); f.service.workspace = path; await assert.rejects(f.inspect(), /safely reviewed/); assert.equal(f.opens, 0);
  }
  const f = fixture(), review = await f.inspect(); f.snapshot = { ...needs, trust_root: workspace };
  await assert.rejects(f.confirm(review), /scope changed/); assert(!f.accepted);
});

test("Stop, revoked guards, concurrent calls and uncertain native grants cannot silently retry or reuse a review", async () => {
  const f = fixture(), review = await f.inspect(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.requested = async () => { entered.resolve(); await release.promise; };
  const pending = f.confirm(review); await entered.promise;
  await assert.rejects(f.inspect(), /another inspection/); f.service.close(); release.resolve(); await assert.rejects(pending);
  assert(f.signal.aborted); assert(!f.accepted); await assert.rejects(f.inspect(), /stopped/);
  const revoked = fixture(), consent = await revoked.inspect();
  await assert.rejects(revoked.confirm(consent, binding, () => { throw Error("Account revoked"); }), /revoked/); assert(!revoked.accepted);
  for (const outcome of [needs, { ...trusted, cwd: "/outside" }]) {
    const uncertain = fixture(), offered = await uncertain.inspect(); uncertain.granted = outcome;
    await assert.rejects(uncertain.confirm(offered), /may already have been saved/); await assert.rejects(uncertain.confirm(offered), /stale/);
    assert.equal(uncertain.calls.filter(call => call.trust_accepted).length, 1);
  }
  const late = fixture(), offered = await late.inspect(); let revokedAfterWrite = false;
  late.requested = (_subtype, fields) => { if (fields.trust_accepted) revokedAfterWrite = true; };
  await assert.rejects(late.confirm(offered, binding, () => { if (revokedAfterWrite) throw Error("Account revoked"); }), /may already have been saved/);
  assert(late.accepted); assert.equal(late.calls.filter(call => call.trust_accepted).length, 1);
});

function childFixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const f = { child, inputs: [], signals: [] };
  child.kill = signal => { f.signals.push(signal); setImmediate(() => { child.signalCode = signal; child.stdout.end(); child.stderr.end(); child.emit("exit", null, signal); child.emit("close", null, signal); }); };
  child.stdin.on("data", chunk => { f.inputs.push(...String(chunk).trim().split("\n").map(JSON.parse)); });
  return f;
}
test("the control-only transport aborts on malformed/oversized output, unsolicited tool approvals and cancellation", async () => {
  for (const invalid of ["not json\n", "null\n", JSON.stringify({ type: "control_request", request: { subtype: "can_use_tool" } }) + "\n", "x".repeat(2 * 1024 * 1024 + 1)]) {
    const f = childFixture(), probe = claudeTrustProbe(f.child, new AbortController().signal, 100);
    const pending = assert.rejects(probe.request("initialize"), /Cannot verify/); f.child.stdout.write(invalid); await pending; await probe.close();
    assert.equal(f.inputs.length, 1); assert.equal(f.inputs[0].type, "control_request"); assert(f.signals.length);
  }
  const f = childFixture(), abort = new AbortController(), probe = claudeTrustProbe(f.child, abort.signal, 100);
  const pending = assert.rejects(probe.request("initialize"), /Cannot verify/); abort.abort(); await pending; await probe.close();
  f.child.emit("error", Error("late spawn failure")); assert(f.signals.length);
});

test("the private adapter uses a neutral control-only worker without replacing capabilities, changing modes or granting linked profiles", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ agent: "claude" }), config = testConfig(root), broker = new CapabilityBroker({ ttlMs: 60000 }), launches = [];
  const executor = { workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id), metadata: { backend: "local" }, mkdir: directory => mkdir(directory, { recursive: true }),
    spawn(command, args, options) {
      const f = childFixture(); launches.push({ command, args, options });
      f.child.stdin.on("data", chunk => { const packet = JSON.parse(String(chunk)); setImmediate(() => f.child.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: packet.request_id, subtype: "success", response: packet.request.subtype === "initialize" ? {} : { status: "needs_trust", directory: chat.workspace } } }) + "\n")); });
      return f.child;
    } };
  const adapter = new ClaudeAdapter({ chat, store, config, broker, executor, gatewayOrigin: "http://fixture", hooks: {} }); t.after(() => adapter.stop()); await adapter.start();
  const capability = adapter.capability;
  const review = await adapter.workspaceTrust("inspect", {}, binding, () => {}); assert.equal(review.state, "needs_trust");
  assert.equal(adapter.capability, capability); assert(broker.validate(capability, "anthropic")); assert.equal(launches.length, 1);
  assert.notEqual(launches[0].options.cwd, chat.workspace); assert(!launches[0].args.includes("--resume")); assert(!launches[0].args.includes("--session-id"));
  assert(launches[0].args.includes('{"disableAllHooks":true}')); assert(launches[0].args.includes("--strict-mcp-config"));
  assert.equal(launches[0].options.env.CLAUDE_CONFIG_DIR, `${executor.runtimeHome}/claude`); assert(!JSON.stringify(launches).includes(config.claude.providerKey));
  assert.equal(store.get(chat.id).messages.length, 0); assert.equal(store.get(chat.id).agentSessionId, null);
  config.claude.authMode = "host"; await assert.rejects(adapter.workspaceTrust("confirm", { reviewId: review.reviewId, confirm: true }, binding, () => {}), /Shared host/); assert.equal(launches.length, 1);
  config.claude.authMode = "gateway"; adapter.hasScheduledWork = () => true;
  await assert.rejects(adapter.workspaceTrust("inspect", {}, binding, () => {}), /schedules/); adapter.hasScheduledWork = () => false;
  await symlink(root, `${executor.runtimeHome}/claude/.claude.json`);
  await assert.rejects(adapter.workspaceTrust("inspect", {}, binding, () => {}), error => /Cannot safely open/.test(error.message) && !error.message.includes(root)); assert.equal(launches.length, 1);
  config.claude.providerKey = "different-private-account";
  await assert.rejects(adapter.workspaceTrust("inspect", {}, binding, () => {}), /account\/profile changed/); assert.equal(launches.length, 1);
});

test("workspace trust HTTP operations protect ownership/origin, filter input and invalidate reviews on Stop or account revocation", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), calls = [], instances = [];
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" });
  let hold, entered, starts = 0;
  const app = await createAgentWebServer({ config, records, adapterFactory: ({ chat }) => {
    const f = fixture(); f.service.workspace = chat.workspace; f.snapshot = { ...needs, directory: chat.workspace }; instances.push(f);
    f.granted = { ...trusted, cwd: chat.workspace };
    return { start: async () => { starts++; }, stop: async () => f.service.close(), send: async () => ({ text: "Fixture" }),
      workspaceTrust: async (action, input, scope, check) => { calls.push({ action, input, scope }); entered?.resolve(); await hold?.promise; return f.service.run(action, input, scope, check); } };
  } });
  const { url } = await app.start(); t.after(() => app.stop());
  const req = async (tail, cookie, value = {}, headers = {}) => {
    const response = await fetch(url + tail, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(value) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const a = await req("/api/browser-account/register", null, { username: "trustalice", password: "private trust fixture a" });
  const b = await req("/api/browser-account/register", null, { username: "trustbobby", password: "private trust fixture b" });
  const chat = (await req("/api/chats", a.cookie, { agent: "claude" })).body.chat, endpoint = `/api/chats/${chat.id}/workspace-trust`;
  for (const cookie of [null, b.cookie]) assert.equal((await req(`${endpoint}/inspect`, cookie)).status, 404);
  assert.equal((await req(`${endpoint}/inspect`, a.cookie, {}, { Origin: "https://attacker.invalid" })).status, 403); assert.equal(starts, 0);
  config.claude.authMode = "host"; assert.equal((await req(`${endpoint}/inspect`, a.cookie)).status, 409); assert.equal(starts, 0); config.claude.authMode = "gateway";
  const reviewed = await req(`${endpoint}/inspect`, a.cookie, { workspace: "/", owner: "other", trust_accepted: true });
  assert.equal(reviewed.status, 200); assert.equal(reviewed.body.directory, chat.workspace); assert.deepEqual(calls[0].input, { reviewId: undefined, confirm: undefined }); assert.equal(starts, 1);
  assert.equal((await req(`${endpoint}/confirm`, a.cookie, { reviewId: reviewed.body.reviewId })).status, 409); assert(!instances[0].accepted);
  assert.equal((await req(`${endpoint}/confirm`, a.cookie, { reviewId: reviewed.body.reviewId, confirm: true, trust_accepted: false, workspace: "/outside" })).status, 200);
  assert(instances[0].accepted); assert.equal(instances[0].calls.at(-1).trusted_directory, chat.workspace);
  await app.manager.stop(chat.id);
  assert.equal((await req(`${endpoint}/confirm`, a.cookie, { reviewId: reviewed.body.reviewId, confirm: true })).status, 409); assert.equal(starts, 1);
  const next = await req(`${endpoint}/inspect`, a.cookie); assert.equal(next.status, 200); assert.equal(starts, 2);
  entered = Promise.withResolvers(); hold = Promise.withResolvers();
  const pending = req(`${endpoint}/confirm`, a.cookie, { reviewId: next.body.reviewId, confirm: true }); await entered.promise;
  await fetch(url + "/api/browser-account", { method: "DELETE", headers: { Cookie: a.cookie } }); hold.resolve();
  assert.equal((await pending).status, 409); assert(!instances[1].accepted); assert.equal(app.store.get(chat.id).messages.length, 0);
});

test("workspace trust holds idle timeout and queued input; Stop and workspace changes still invalidate consent", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "100" }), sent = [], services = []; let stopped = 0;
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 60000 }), gatewayOrigin: "http://fixture", adapterFactory: ({ chat }) => {
    const f = fixture(); f.service.workspace = chat.workspace; f.snapshot = { ...needs, directory: chat.workspace }; f.granted = { ...trusted, cwd: chat.workspace }; services.push(f);
    return { start: async () => {}, stop: async () => { stopped++; await f.service.close(); }, send: async text => { sent.push(text); return { text: "Kept queued" }; },
      workspaceTrust: (action, input, scope, check) => f.service.run(action, input, scope, check) };
  } }); t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "claude" }), review = await manager.nativeWorkspaceTrust(chat.id, "inspect");
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  services[0].requested = async () => { entered.resolve(); await release.promise; };
  const confirming = manager.nativeWorkspaceTrust(chat.id, "confirm", { reviewId: review.reviewId, confirm: true }); await entered.promise;
  await manager.enqueue(chat.id, "Wait until trust is resolved"); await manager.refreshActivity(chat.id);
  await new Promise(resolve => setTimeout(resolve, 175)); assert.equal(stopped, 0); assert.deepEqual(sent, []);
  await assert.rejects(manager.nativeWorkspaceTrust(chat.id, "inspect"), /idle/); await assert.rejects(manager.setMode(chat.id, "auto"), /switch/);
  release.resolve(); assert.equal((await confirming).state, "trusted"); await waitFor(() => sent.length === 1); await waitFor(() => !manager.isBusy(chat.id));
  config.idleTimeoutMs = 60000; await manager.refreshActivity(chat.id);
  services[0].requested = null;
  const next = await manager.nativeWorkspaceTrust(chat.id, "inspect"), stopEntered = Promise.withResolvers(), stopRelease = Promise.withResolvers();
  services[0].requested = async () => { stopEntered.resolve(); await stopRelease.promise; };
  const interrupted = manager.nativeWorkspaceTrust(chat.id, "confirm", { reviewId: next.reviewId, confirm: true }); const rejected = assert.rejects(interrupted);
  await stopEntered.promise; const stopping = manager.stop(chat.id); await waitFor(() => services[0].signal.aborted); stopRelease.resolve(); await stopping; await rejected;
  assert.equal(services[0].calls.filter(call => call.trust_accepted).length, 1);
  const fresh = await manager.nativeWorkspaceTrust(chat.id, "inspect");
  await store.update(chat.id, { repositories: [{ fullName: "Other/project" }] });
  await assert.rejects(manager.nativeWorkspaceTrust(chat.id, "confirm", { reviewId: fresh.reviewId, confirm: true }), /stale/); assert(!services[1].accepted);
});
