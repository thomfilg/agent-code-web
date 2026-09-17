import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { claudeFastRequest, claudeFastState, claudeFastScope, claudeFastCredential, checkClaudeFastAvailability } from "../src/claude-fast.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { spawnWorker } from "../src/worker-process.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

test("Claude Fast parses only native controls and trusts structured allowlisted status", () => {
  assert.equal(claudeFastRequest("Explain /fast"), null); assert.equal(claudeFastRequest("/fast"), "toggle");
  assert.equal(claudeFastRequest("/fast\non"), "on"); assert.throws(() => claudeFastRequest("/fast yes"), /Use \/fast/);
  assert.equal(claudeFastState({ result: "Fast mode ON" }), null);
  assert.deepEqual(claudeFastState({ fast_mode_state: "cooldown", fast_mode_disabled_reason: "secret" }), { state: "cooldown" });
  assert.deepEqual(claudeFastState({ fast_mode_state: "off", fast_mode_disabled_reason: "model_not_allowed" }), { state: "off", disabledReason: "model_not_allowed" });
});

const account = { authMode: "gateway", providerKey: "private-controller-key", upstreamBaseUrl: "https://api.anthropic.com" };
test("availability uses a bounded authenticated controller lookup, with no reusable positive cache", async () => {
  let allowed = true, calls = 0;
  const fetchImpl = async (url, options) => {
    calls++; assert.equal(url, "https://api.anthropic.com/api/claude_code_penguin_mode");
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error"); assert(options.signal instanceof AbortSignal);
    assert.equal(options.headers["x-api-key"], account.providerKey);
    return Response.json({ enabled: allowed, disabled_reason: "preference", privateMetadata: "not returned" });
  };
  assert.deepEqual(await checkClaudeFastAvailability(account, { fetchImpl }), { enabled: true });
  allowed = false;
  assert.deepEqual(await checkClaudeFastAvailability(account, { fetchImpl }), { enabled: false, disabledReason: "preference" }); assert.equal(calls, 2);
});

test("redirects, malformed/oversized replies, authentication and network failures never grant access or leak responses", async () => {
  const replies = [() => Response.json({ enabled: "true" }), () => new Response("private upstream error", { status: 401 }),
    () => new Response("<html>block page</html>"), () => Response.json({ enabled: true, padding: "x".repeat(5000) }),
    () => new Response("private-controller-key", { status: 302, headers: { location: "https://elsewhere.example" } }),
    () => { throw new Error("private-controller-key"); }];
  for (const reply of replies) await assert.rejects(checkClaudeFastAvailability(account, { fetchImpl: async () => reply() }), error => /Could not verify/.test(error.message) && !/private-controller-key|upstream error|block page/.test(error.message));
  let called = false;
  for (const upstreamBaseUrl of ["http://api.anthropic.com", "https://foreign.example", "https://api.anthropic.com/custom", "https://user@api.anthropic.com/"]) {
    await assert.rejects(checkClaudeFastAvailability({ ...account, upstreamBaseUrl }, { fetchImpl: async () => { called = true; } }), /custom Claude upstream/);
  }
  assert.equal(called, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(checkClaudeFastAvailability(account, { signal: controller.signal, fetchImpl: async (_, { signal }) => { signal.throwIfAborted(); } }), /interrupted/);
});

async function fixture(t, { fake = false, host = false } = {}) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_BIN: path.resolve("test/fixtures/fake-claude.mjs"), ...(host ? { CLAUDE_AUTH_MODE: "host" } : {}) });
  const models = new ModelCatalog(config); models.claude = async () => ({ models: ["opus", "sonnet", "haiku", "default"].map(id => ({ id, efforts: ["auto", "high", "low"] })) });
  const broker = new CapabilityBroker({ ttlMs: 120000 }), f = { allowed: true, lookups: 0, launches: [], calls: [], env: {} };
  const manager = new RuntimeManager({ store, config, models, broker, gatewayOrigin: "http://127.0.0.1:9", adapterFactory: params => {
    if (fake) return { start: async () => {}, stop: async () => f.gate?.resolve(), send: async (text, settings) => {
      f.calls.push({ text, settings }); await f.gate?.promise;
      const command = claudeFastRequest(text), on = command === "on" || command === "toggle" && !settings.fastMode;
      return { text: "Native fixture completed", nativeFast: { state: command ? on ? "on" : "off" : settings.fastMode ? "on" : "off" }, ...(command ? { fastPreference: on, fastModel: /^opus/.test(settings.model) ? settings.model : "opus", fastCredential: claudeFastCredential(config.claude) } : {}) };
    } };
    const executor = { workspace: params.chat.workspace, runtimeHome: store.runtimeHome(params.chat.id), environmentVariables: f.env, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(command, args, options) {
        f.launches.push({ args, env: options.env });
        f.providerFeedback = broker.captureProviderObserver(options.env.ANTHROPIC_AUTH_TOKEN, "anthropic");
        if (f.feedbackOnSpawn) f.providerFeedback(f.feedbackOnSpawn);
        return spawnWorker(command, args, options);
      } };
    return new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin: "http://127.0.0.1:9", executor,
      fetchImpl: async (_, { signal }) => { f.lookups++; await f.lookupGate?.promise; signal.throwIfAborted(); return Response.json({ enabled: f.allowed, disabled_reason: "preference" }); } });
  } });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "claude", title: "Fast test" });
  return Object.assign(f, { root, store, config, models, manager, chat });
}

test("Fast preference is per-chat, opt-in only, persists through Stop/reload and never exposes controller credentials", async t => {
  const f = await fixture(t), other = await f.manager.createChat({ agent: "claude", title: "Other" });
  await f.manager.send(f.chat.id, "/fast"); assert.equal(f.store.get(f.chat.id).claudeFastMode, true);
  assert.equal(f.store.get(f.chat.id).claudeFastStatus.state, "on"); assert.equal(f.store.get(other.id).claudeFastMode, undefined);
  const session = f.store.get(f.chat.id).agentSessionId; await f.manager.stop(f.chat.id);
  const restored = new ChatStore(f.root); await restored.initialize(); assert.equal(restored.get(f.chat.id).claudeFastMode, true);
  await f.manager.send(f.chat.id, "inspect-settings"); assert.equal(JSON.parse(f.store.get(f.chat.id).messages.at(-1).text).fast, true);
  assert.equal(f.store.get(f.chat.id).agentSessionId, session); assert.equal(f.lookups, 2);
  assert(!JSON.stringify(f.launches).includes(f.config.claude.providerKey));
  await f.manager.send(f.chat.id, "/fast"); assert.equal(f.store.get(f.chat.id).claudeFastMode, false);
  const calls = f.lookups; await f.manager.send(f.chat.id, "inspect-settings"); assert.equal(f.lookups, calls);
  assert.equal(JSON.parse(f.store.get(f.chat.id).messages.at(-1).text).fast, false);
  assert.equal(f.launches.at(-1).env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, undefined);
});

test("account and native policy denials cannot claim success; disabling remains usable after revocation", async t => {
  const f = await fixture(t); f.allowed = false;
  await f.manager.send(f.chat.id, "/fast on"); assert.match(f.store.get(f.chat.id).messages.at(-1).text, /disabled by the organization/);
  assert.equal(f.launches.length, 0); assert.notEqual(f.store.get(f.chat.id).claudeFastMode, true);
  f.allowed = true; f.env.CLAUDE_CODE_DISABLE_FAST_MODE = "1";
  await f.manager.send(f.chat.id, "/fast on"); assert.match(f.store.get(f.chat.id).messages.at(-1).text, /disabled by worker policy/);
  assert.notEqual(f.store.get(f.chat.id).claudeFastMode, true);
  delete f.env.CLAUDE_CODE_DISABLE_FAST_MODE; await f.manager.send(f.chat.id, "/fast on"); assert.equal(f.store.get(f.chat.id).claudeFastMode, true);
  f.allowed = false; const before = f.launches.length; await f.manager.send(f.chat.id, "Must not use revoked Fast");
  assert.equal(f.launches.length, before + 1); assert.equal(f.store.get(f.chat.id).claudeFastMode, false);
  assert.equal(f.launches.at(-1).env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, undefined);
  assert(f.store.get(f.chat.id).messages.some(message => /Continuing at standard speed/.test(message.text)));
  assert.equal(f.store.get(f.chat.id).claudeFastStatus.state, "off"); assert.equal(f.store.get(f.chat.id).claudeFastStatus.disabledReason, "preference");
  assert.equal(f.store.get(f.chat.id).claudeFastStatus.selectionRevision, f.store.get(f.chat.id).modelSettingsRevision);
  const lookups = f.lookups; await f.manager.send(f.chat.id, "/fast off"); assert.equal(f.lookups, lookups); assert.equal(f.store.get(f.chat.id).claudeFastMode, false);
  await f.manager.send(f.chat.id, "inspect-settings"); assert.equal(JSON.parse(f.store.get(f.chat.id).messages.at(-1).text).fast, false);
});

test("credential rotation requires a fresh opt-in and never inherits Fast from the previous account", async t => {
  const f = await fixture(t); await f.manager.send(f.chat.id, "/fast on");
  const before = f.lookups; f.config.claude.providerKey = "rotated-private-controller-key";
  const launches = f.launches.length;
  await f.manager.send(f.chat.id, "inspect-settings");
  assert.equal(f.lookups, before); assert.equal(f.launches.length, launches);
  assert.match(f.store.get(f.chat.id).messages.at(-1).text, /account\/profile changed/);
  await f.manager.stop(f.chat.id);
  await f.manager.send(f.chat.id, "inspect-settings"); assert.equal(f.lookups, before);
  assert.equal(f.store.get(f.chat.id).claudeFastMode, false); assert.equal(JSON.parse(f.store.get(f.chat.id).messages.at(-1).text).fast, false);
  assert(f.store.get(f.chat.id).messages.some(message => /credentials changed/.test(message.text)));
  await f.manager.send(f.chat.id, "/fast on"); assert.equal(f.lookups, before + 1); assert.equal(f.store.get(f.chat.id).claudeFastMode, true);
});

test("a CLI prose acknowledgment without structured native state cannot enable Fast", async t => {
  const f = await fixture(t); f.env.CLAUDE_FIXTURE_OMIT_FAST_STATE = "1";
  await f.manager.send(f.chat.id, "/fast on"); assert.match(f.store.get(f.chat.id).messages.at(-1).text, /could not be confirmed/);
  assert.notEqual(f.store.get(f.chat.id).claudeFastMode, true);
});

test("model promotion retains effort and a profile/company change cannot reuse the previous opt-in", async t => {
  const f = await fixture(t);
  await f.manager.setModel(f.chat.id, { model: "sonnet", effort: "high" }); await f.manager.send(f.chat.id, "/fast on");
  assert.equal(f.store.get(f.chat.id).model, "opus"); assert.equal(f.store.get(f.chat.id).effort, "high");
  for (const patch of [{ ownerId: "other-user" }, { environmentId: "another-environment" }, { repositories: [{ fullName: "another-org/repo" }] }]) {
    const original = f.store.get(f.chat.id), changed = { ...original, ...patch };
    assert.notEqual(claudeFastScope(changed), original.claudeFastScope);
    assert.equal((await f.models.turnSettings(changed)).fastMode, false);
  }
});

test("invalid arguments, attached files and shared host writes are rejected before accepting or queueing", async t => {
  const f = await fixture(t), host = await fixture(t, { host: true });
  for (const method of ["submit", "enqueue"]) {
    await assert.rejects(f.manager[method](f.chat.id, "/fast invalid"), /Use \/fast/);
    await assert.rejects(f.manager[method](f.chat.id, "/fast on", ["file"]), /does not accept attachments/);
    await assert.rejects(host.manager[method](host.chat.id, "/fast on"), /private Claude profile/);
  }
  assert.equal(f.store.get(f.chat.id).messages.length, 0); assert.equal(host.store.get(host.chat.id).messages.length, 0);
  assert.equal(f.lookups + host.lookups + f.launches.length + host.launches.length, 0);
});

test("queued Fast changes run in FIFO order without turning controls into unrelated prompts", async t => {
  const f = await fixture(t, { fake: true }); f.gate = Promise.withResolvers();
  const current = f.manager.send(f.chat.id, "Current task"); await waitFor(() => f.calls.length === 1);
  await f.manager.enqueue(f.chat.id, "/fast on"); await f.manager.enqueue(f.chat.id, "Fast task"); await f.manager.enqueue(f.chat.id, "/fast off"); await f.manager.enqueue(f.chat.id, "Standard task");
  assert.notEqual(f.store.get(f.chat.id).claudeFastMode, true); f.gate.resolve(); await current;
  await waitFor(() => f.calls.length === 5 && !f.manager.isBusy(f.chat.id));
  assert.deepEqual(f.calls.map(call => call.text), ["Current task", "/fast on", "Fast task", "/fast off", "Standard task"]);
  assert.equal(f.calls[2].settings.fastMode, true); assert.equal(f.calls[4].settings.fastMode, false);
});

test("Stop, newer model choices (including same-value choices), and account changes defeat stale acknowledgments", async t => {
  for (const action of ["stop", "model", "owner"]) {
    const f = await fixture(t, { fake: true }); f.gate = Promise.withResolvers();
    const pending = f.manager.send(f.chat.id, "/fast on"); await waitFor(() => f.calls.length === 1);
    if (action === "stop") await f.manager.stop(f.chat.id);
    if (action === "model") await f.manager.setModel(f.chat.id, { model: f.chat.model, effort: f.chat.effort });
    if (action === "owner") await f.store.update(f.chat.id, { ownerId: "new-owner" });
    f.gate.resolve(); await pending; assert.notEqual(f.store.get(f.chat.id).claudeFastMode, true);
  }
});

test("Stop aborts an outstanding availability check without launching a worker or changing preference", async t => {
  const f = await fixture(t); f.lookupGate = Promise.withResolvers();
  const pending = f.manager.send(f.chat.id, "/fast on"); await waitFor(() => f.lookups === 1);
  await f.manager.stop(f.chat.id); f.lookupGate.resolve(); await pending;
  assert.equal(f.launches.length, 0); assert.notEqual(f.store.get(f.chat.id).claudeFastMode, true);
});

test("a newer selection made during turn-settings resolution also defeats a stale Fast command", async t => {
  const f = await fixture(t, { fake: true }), lookup = Promise.withResolvers(), original = f.models.turnSettings.bind(f.models);
  let captured = false;
  f.models.turnSettings = async chat => { const settings = await original(chat); captured = true; await lookup.promise; return settings; };
  const pending = f.manager.send(f.chat.id, "/fast on"); await waitFor(() => captured);
  await f.manager.setModel(f.chat.id, { model: "sonnet", effort: "high" }); lookup.resolve(); await pending;
  assert.equal(f.store.get(f.chat.id).model, "sonnet"); assert.notEqual(f.store.get(f.chat.id).claudeFastMode, true);
  assert(f.store.get(f.chat.id).messages.some(message => /Newer model\/Fast choices were kept/.test(message.text)));
});

test("provider cooldowns survive an interrupted turn and newer model choices without affecting other chats", async t => {
  const f = await fixture(t), other = await f.manager.createChat({ agent: "claude", title: "Other" });
  await f.manager.send(f.chat.id, "/fast on");
  const launches = f.launches.length, pending = f.manager.send(f.chat.id, "wait for interruption");
  await waitFor(() => f.launches.length > launches);
  await f.manager.setModel(f.chat.id, { model: "sonnet", effort: "high" });
  const until = Date.now() + 600000, notify = f.providerFeedback;
  notify({ type: "cooldown", reason: "rate_limit", until, credential: claudeFastCredential(f.config.claude) });
  await waitFor(() => f.store.get(f.chat.id).claudeFastCooldown?.until === until);
  await f.manager.stop(f.chat.id); await pending;
  const state = f.store.get(f.chat.id); assert.equal(state.model, "sonnet"); assert.equal(state.claudeFastMode, true);
  assert.equal(f.store.get(other.id).claudeFastCooldown, undefined);
  const restored = new ChatStore(f.root); await restored.initialize(); assert.deepEqual(restored.get(f.chat.id).claudeFastCooldown, { until, reason: "rate_limit" });
  notify({ type: "disabled", reason: "preference", credential: state.claudeFastCredential });
  assert.equal(f.store.get(f.chat.id).claudeFastMode, true, "A response arriving after Stop cannot change state");
  const lookups = f.lookups; await f.manager.send(f.chat.id, "inspect-settings");
  assert.equal(JSON.parse(f.store.get(f.chat.id).messages.at(-1).text).fast, false); assert.equal(f.lookups, lookups);
  assert.equal(f.store.get(f.chat.id).claudeFastCooldown.until, until);
  await f.manager.send(f.chat.id, "/fast off"); assert.equal(f.store.get(f.chat.id).claudeFastCooldown, null); assert.equal(f.store.get(f.chat.id).claudeFastMode, false);
});

test("API entitlement denial overrides stale native success and remains saved after native failure", async t => {
  for (const text of ["inspect-settings", "force failure"]) {
    const f = await fixture(t); await f.manager.send(f.chat.id, "/fast on");
    f.feedbackOnSpawn = { type: "disabled", reason: "preference", credential: claudeFastCredential(f.config.claude) };
    await f.manager.send(f.chat.id, text);
    assert.equal(f.store.get(f.chat.id).claudeFastMode, false); assert.equal(f.store.get(f.chat.id).claudeFastStatus.state, "off");
    assert.equal(f.store.get(f.chat.id).claudeFastStatus.disabledReason, "preference");
    assert.equal(f.store.get(f.chat.id).claudeFastCooldown, null);
    assert(!f.store.get(f.chat.id).messages.some(message => /Newer model\/Fast choices were kept/.test(message.text)), "A provider denial is not a user-selection conflict");
  }
});

test("provider constraints cannot cross a changed credential, owner, environment or explicit Fast-off", async t => {
  for (const action of ["credential", "owner", "environment", "off"]) {
    const f = await fixture(t); await f.manager.send(f.chat.id, "/fast on");
    const credential = claudeFastCredential(f.config.claude), launches = f.launches.length;
    const pending = f.manager.send(f.chat.id, "wait for interruption"); await waitFor(() => f.launches.length > launches);
    if (action === "credential") f.config.claude.providerKey = "another-account";
    else await f.store.update(f.chat.id, action === "owner" ? { ownerId: "another-owner" } : action === "environment" ? { environmentId: "another-environment" } : { claudeFastMode: false });
    f.providerFeedback({ type: "cooldown", reason: "rate_limit", until: Date.now() + 600000, credential });
    await f.manager.stop(f.chat.id); await pending;
    assert.equal(f.store.get(f.chat.id).claudeFastCooldown, null); assert.equal(f.store.get(f.chat.id).claudeFastMode, action !== "off");
  }
});
