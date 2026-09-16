import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, symlink, link } from "node:fs/promises";
import { spawn } from "node:child_process";
import { CodexLogout, codexLogoutPolicy } from "../src/codex-logout.mjs";
import { codexAuthFileState, inspectCodexAuthFile } from "../src/codex-auth-files.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { webCommands } from "../public/web-commands.js";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const confirmation = review => ({ id: review.id, revision: review.revision, threadId: review.threadId, confirm: true });
const policy = (config = {}, requirements = null) => codexLogoutPolicy(async method => method === "config/read" ? { config } : { requirements }, "/private/workspace");

test("logout policy honors default and managed storage without silently overriding keyring or malformed responses", async () => {
  assert.equal((await policy()).storage, "file");
  assert.equal((await policy({ cli_auth_credentials_store: "ephemeral" })).storage, "ephemeral");
  assert.equal((await policy({ cli_auth_credentials_store: "file" }, { cliAuthCredentialsStore: "keyring" })).storage, "keyring");
  assert.notEqual((await policy()).revision, (await policy({}, { cliAuthCredentialsStore: "file" })).revision);
  for (const [config, requirements] of [[null, null], [{ cli_auth_credentials_store: "unknown" }, null], [{}, { cliAuthCredentialsStore: false }], [{}, []]]) await assert.rejects(policy(config, requirements), /Unsupported/);
  await assert.rejects(codexLogoutPolicy(async () => { throw new Error("PRIVATE_TOKEN=value"); }), error => /Cannot verify/.test(error.message) && !error.message.includes("PRIVATE_TOKEN"));
  for (const text of ["/logout", "/logout now", "/logout\nconfirm"]) assert.throws(() => messageCommand("codex", text), /confirm sign-out/);
  assert.equal(messageCommand("claude", "/logout"), null);
  assert.ok(webCommands("codex").some(item => item.name === "logout")); assert.ok(!webCommands("claude").some(item => item.name === "logout"));
});

test("credential inspection fingerprints only the private file and detects replacement without returning bytes", async t => {
  const home = await temporaryDirectory(t), nativeHome = `${home}/codex`; await mkdir(nativeHome);
  const empty = await codexAuthFileState({ home, nativeHome }); assert.equal(empty.present, false);
  await writeFile(`${nativeHome}/auth.json`, '{"OPENAI_API_KEY":"sk-private-one"}');
  const first = await codexAuthFileState({ home, nativeHome }); assert.equal(first.present, true); assert.notEqual(first.revision, empty.revision); assert.doesNotMatch(JSON.stringify(first), /sk-private/);
  assert.deepEqual(await codexAuthFileState({ home, nativeHome }), first);
  await writeFile(`${nativeHome}/auth.json`, '{"OPENAI_API_KEY":"sk-private-two"}'); assert.notEqual((await codexAuthFileState({ home, nativeHome })).revision, first.revision);
  assert.match(await readFile(`${nativeHome}/auth.json`, "utf8"), /sk-private-two/);
  for (const input of [{ home, nativeHome: `${home}/other` }, { home: "/", nativeHome: "/codex" }, { home: `${home}/../wrong`, nativeHome }]) await assert.rejects(codexAuthFileState(input), /private Codex profile/);
});

test("credential preflight rejects symlinks, hard links and oversized files, including linked parents", async t => {
  const root = await temporaryDirectory(t), home = `${root}/profile`, nativeHome = `${home}/codex`; await mkdir(nativeHome, { recursive: true });
  await writeFile(`${root}/unrelated`, "untouched"); await symlink(`${root}/unrelated`, `${nativeHome}/auth.json`);
  await assert.rejects(codexAuthFileState({ home, nativeHome }), /linked/); await unlink(`${nativeHome}/auth.json`);
  await link(`${root}/unrelated`, `${nativeHome}/auth.json`); await assert.rejects(codexAuthFileState({ home, nativeHome }), /hard links/); await unlink(`${nativeHome}/auth.json`);
  await writeFile(`${nativeHome}/auth.json`, "x".repeat(256 * 1024 + 1)); await assert.rejects(codexAuthFileState({ home, nativeHome }), /256 KiB/);
  await symlink(home, `${root}/linked`); await assert.rejects(codexAuthFileState({ home: `${root}/linked`, nativeHome: `${root}/linked/codex` }), /linked/);
  assert.equal(await readFile(`${root}/unrelated`, "utf8"), "untouched");
});

test("remote credential preflight stays in the worker profile and does not forward controller credentials", async t => {
  const home = await temporaryDirectory(t), nativeHome = `${home}/codex`; await mkdir(nativeHome); await writeFile(`${nativeHome}/auth.json`, "private-dummy"); let calls = 0;
  const executor = { metadata: { backend: "ec2" }, runtimeHome: home, workspace: home, spawn: (command, args, options) => {
    calls++; assert.deepEqual(Object.keys(options.env).sort(), ["LANG", "PATH"]); return spawn(command, args, options);
  } };
  assert.deepEqual(await inspectCodexAuthFile(executor, { home, nativeHome }), await codexAuthFileState({ home, nativeHome }));
  await assert.rejects(inspectCodexAuthFile(executor, { home: "/other", nativeHome: "/other/codex" }), /does not match/); assert.equal(calls, 1);
  await assert.rejects(inspectCodexAuthFile(executor, { home, nativeHome }, () => { throw new Error("Scope revoked"); }), /Scope revoked/); assert.equal(calls, 1);
});

async function fixture(t) {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize();
  const created = await store.create({ agent: "codex", title: "Sign-out fixture" }), chat = await store.update(created.id, { agentSessionId: randomUUID() });
  const config = testConfig(root), service = new CodexLogout(store, config), calls = [], flags = { revision: "credentials-one", storage: "file", privateProfile: true, gateway: true, canLogout: true, credentialPresent: true, account: { type: "apiKey", email: null }, busy: false };
  const adapter = { threadId: chat.agentSessionId, importWorkerId: randomUUID(), logoutSnapshot: async check => { check(); return { ...flags, threadId: adapter.threadId, workerId: adapter.importWorkerId }; },
    performLogout: async (revision, check, dispatched) => { check(); dispatched(); calls.push(revision); } };
  return { root, records, store, chat, config, service, adapter, flags, calls, review: async () => (await service.inspect(chat.id, adapter)).review };
}

test("native sign-out requires a persisted explicit review, is idempotent and exposes no credential fingerprint", async t => {
  const f = await fixture(t), review = await f.review(); assert.equal(review.state, "reviewed"); assert.deepEqual(f.calls, []); assert.equal(review.snapshotRevision, undefined);
  await assert.rejects(f.service.confirm(f.chat.id, { ...confirmation(review), confirm: false }, f.adapter), /explicitly confirm/);
  const [a, b] = await Promise.all([f.service.confirm(f.chat.id, confirmation(review), f.adapter), f.service.confirm(f.chat.id, confirmation(review), f.adapter)]);
  assert.equal(a.state, "completed"); assert.deepEqual(a, b); assert.deepEqual(f.calls, [f.flags.revision]);
  const restored = new CodexLogout(f.store, f.config); assert.equal((await restored.confirm(f.chat.id, confirmation(review), null)).state, "completed"); assert.equal(f.calls.length, 1);
});

test("sign-out reviews cannot cross owners, companies, repositories, environments, roots or auth modes", async t => {
  for (const change of [{ ownerId: "other-owner" }, { repositories: [{ fullName: "g2i/private" }] }, { environmentId: "other-env" }, { workspace: "/other/workspace" }, { agentSessionId: randomUUID() }, { authMode: "host" }]) {
    const f = await fixture(t), review = await f.review();
    if (change.authMode) f.config.codex.authMode = change.authMode; else await f.store.update(f.chat.id, change);
    assert.deepEqual((await f.service.status(f.chat.id)).reviews, []); await assert.rejects(f.service.confirm(f.chat.id, confirmation(review), f.adapter), /no longer available/); assert.equal(f.calls.length, 0);
  }
});

test("changed credentials, workers, expired reviews, active agents and revoked scope cancel before sign-out", async t => {
  for (const change of ["credentials", "worker", "expired", "busy", "archived", "revoked"]) {
    const f = await fixture(t), review = await f.review();
    if (change === "credentials") f.flags.revision = "replaced-key";
    if (change === "worker") f.adapter.importWorkerId = randomUUID();
    if (change === "expired") { const state = await f.records.get("native-logout", f.chat.id); state.reviews[0].expiresAt = 1; await f.records.put("native-logout", f.chat.id, state); }
    if (change === "busy") f.flags.busy = true;
    if (change === "archived") await f.store.update(f.chat.id, { archived: true });
    await assert.rejects(f.service.confirm(f.chat.id, confirmation(review), f.adapter, () => { if (change === "revoked") throw new Error("Revoked"); }), /changed|expired|idle|Revoked/); assert.equal(f.calls.length, 0);
  }
});

test("durable intent precedes sign-out and unknown outcomes never replay across restart", async t => {
  const f = await fixture(t), review = await f.review(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.adapter.performLogout = async (revision, check, dispatched) => { dispatched(); f.calls.push(revision); entered.resolve(); await release.promise; throw new Error("PRIVATE_KEY=never-return"); };
  const action = f.service.confirm(f.chat.id, confirmation(review), f.adapter); await entered.promise;
  assert.equal((await f.service.status(f.chat.id)).reviews[0].state, "signing_out"); assert.equal((await f.service.existing(f.chat.id, confirmation(review))).state, "signing_out");
  const restored = new CodexLogout(f.store, f.config); assert.equal((await restored.confirm(f.chat.id, confirmation(review), null)).state, "uncertain"); assert.equal(f.calls.length, 1);
  release.resolve(); const result = await action; assert.equal(result.state, "uncertain"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEY/);
  assert.equal((await restored.confirm(f.chat.id, confirmation(review), null)).state, "uncertain"); assert.equal(f.calls.length, 1);
});

test("failed intent never dispatches and bounded reviews cannot authorize pruned IDs", async t => {
  const f = await fixture(t), review = await f.review(), put = f.records.put.bind(f.records);
  f.records.put = async (kind, key, value) => { if (value.reviews?.some(item => item.state === "signing_out")) throw new Error("Storage unavailable"); return put(kind, key, value); };
  await assert.rejects(f.service.confirm(f.chat.id, confirmation(review), f.adapter), /Storage unavailable/); assert.equal(f.calls.length, 0); f.records.put = put;
  for (let i = 0; i < 22; i++) await f.review();
  assert.equal((await f.service.status(f.chat.id)).reviews.length, 20); await assert.rejects(f.service.confirm(f.chat.id, confirmation(review), f.adapter), /no longer available/);
  await f.store.remove(f.chat.id); assert.equal(await f.records.get("native-logout", f.chat.id), null);
});

async function adapterFixture(t) {
  const runtimeHome = await temporaryDirectory(t), nativeHome = `${runtimeHome}/codex`; await mkdir(nativeHome); await writeFile(`${nativeHome}/auth.json`, "private-key-one");
  const calls = [], config = {}, info = { account: { type: "apiKey" }, requiresOpenaiAuth: false }, adapter = Object.create(CodexAdapter.prototype);
  Object.assign(adapter, { runtimeHome, nativeHome, workspace: runtimeHome, config: { codex: { authMode: "gateway" } }, children: new Set(), hooks: { onEvent: async () => {} }, threadId: "native-root", importWorkerId: "native-worker", accountEpoch: 0,
    rpc: { request: async (method, params) => { calls.push({ method, params });
      if (method === "config/read") return { config }; if (method === "configRequirements/read") return { requirements: null };
      if (method === "account/read") return info; if (method === "account/logout") { await unlink(`${nativeHome}/auth.json`); info.account = null; return {}; }
      throw new Error(`Unexpected ${method}`);
    } } });
  adapter.logoutStartupPolicy = await policy(); return { adapter, calls, config, info };
}

test("production adapter checks file identity and native account without refresh, then verifies removal", async t => {
  const f = await adapterFixture(t), before = await f.adapter.logoutSnapshot(); assert.equal(before.canLogout, true); assert.equal(before.storage, "file");
  assert.ok(f.calls.filter(call => call.method === "account/read").every(call => call.params.refreshToken === false));
  await writeFile(`${f.adapter.nativeHome}/auth.json`, "private-key-two"); await assert.rejects(f.adapter.performLogout(before.revision, () => {}, () => {}), /changed/);
  const fresh = await f.adapter.logoutSnapshot(); let dispatched = 0; await f.adapter.performLogout(fresh.revision, () => {}, () => dispatched++);
  assert.equal(dispatched, 1); assert.equal(f.calls.filter(call => call.method === "account/logout").length, 1);
  const after = await f.adapter.logoutSnapshot(); assert.equal(after.canLogout, false); assert.equal(after.account, null); assert.equal(after.credentialPresent, false);
  f.adapter.logoutChanging = true; assert.throws(() => f.adapter.assertImportReady(), /sign-out/);
  const child = Object.create(CodexAdapter.prototype); child.sharedParent = f.adapter; assert.throws(() => child.assertImportReady(), /sign-out/);
});

test("adapter gates host, keyring, startup changes and ambiguous credentials before touching authentication", async t => {
  const f = await adapterFixture(t);
  f.adapter.config.codex.authMode = "host"; assert.equal((await f.adapter.logoutSnapshot()).canLogout, false); assert.equal(f.calls.length, 0);
  f.adapter.config.codex.authMode = "gateway";
  for (const storage of ["auto", "keyring"]) {
    f.config.cli_auth_credentials_store = storage; f.adapter.logoutStartupPolicy = await policy(f.config);
    assert.match((await f.adapter.logoutSnapshot()).reason, /keyring/); assert.equal(f.calls.filter(call => call.method.startsWith("account/")).length, 0);
  }
  f.config.cli_auth_credentials_store = "file"; assert.match((await f.adapter.logoutSnapshot()).reason, /storage changed/);
  f.config.cli_auth_credentials_store = "ephemeral"; f.adapter.logoutStartupPolicy = await policy(f.config); assert.match((await f.adapter.logoutSnapshot()).reason, /coexists/);
});

test("an account update during native inspection cannot produce consent for stale in-memory credentials", async t => {
  const f = await adapterFixture(t), request = f.adapter.rpc.request;
  f.adapter.rpc.request = async (method, params) => { const result = await request(method, params); if (method === "account/read") f.adapter.accountEpoch++; return result; };
  await assert.rejects(f.adapter.logoutSnapshot(), /account changed during inspection/);
  assert.equal(f.calls.filter(call => call.method === "account/logout").length, 0);
});

async function serverFixture(t, env = {}) {
  const root = await temporaryDirectory(t), calls = { starts: 0, logout: 0, inputs: [], snapshotGate: null, logoutGate: null, inspectGate: null, turnGate: null, entered: null }, adapters = new Map();
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "logout-fixture", AGENT_IDLE_TIMEOUT_MS: "60000", ...env }),
    models: { creationSettings: async () => ({}), turnSettings: async () => ({}) }, adapterFactory: ({ chat, hooks }) => {
      const adapter = { threadId: chat.agentSessionId || randomUUID(), importWorkerId: randomUUID(), accountEpoch: 0,
        start: async () => { calls.starts++; await hooks.onSessionId(adapter.threadId); }, stop: async () => { calls.turnGate?.resolve(); },
        inspect: async () => { calls.entered?.resolve(); await calls.inspectGate?.promise; return { account: { email: "outdated@fixture.invalid" }, rateLimits: [{ id: "stale" }] }; },
        logoutSnapshot: async check => { calls.entered?.resolve(); await calls.snapshotGate?.promise; check(); return { threadId: adapter.threadId, workerId: adapter.importWorkerId, revision: "credential-one", canLogout: !calls.logout, gateway: true, privateProfile: true, account: { type: "apiKey" }, storage: "file", busy: false }; },
        performLogout: async (revision, check, dispatched) => { check(); dispatched(); calls.logout++; adapter.accountEpoch++; await hooks.onEvent({ type: "native_account_updated" }); await calls.logoutGate?.promise; check(); },
        send: async text => { calls.inputs.push(text); await calls.turnGate?.promise; return { text: "Private fixture" }; } };
      adapters.set(chat.id, adapter); return adapter;
    } });
  const { url } = await app.start(); t.after(() => app.stop()); const chat = await app.manager.createChat({ agent: "codex", title: "Sign-out API fixture" });
  const request = (tail, body) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer logout-fixture", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { root, app, url, chat, calls, request, adapters };
}

test("scoped HTTP sign-out requires confirmation, never sends model input and pauses queued work", async t => {
  const f = await serverFixture(t);
  assert.equal((await fetch(`${f.url}/api/chats/${f.chat.id}/logout`)).status, 401);
  assert.equal((await fetch(`${f.url}/api/chats/${f.chat.id}/logout/inspect`, { method: "POST", headers: { authorization: "Bearer logout-fixture", origin: "https://foreign.invalid", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.deepEqual(await (await f.request("logout")).json(), { reviews: [] }); assert.equal(f.calls.starts, 0);
  const { review } = await (await f.request("logout/inspect", {})).json(); assert.equal(f.calls.starts, 1); assert.equal(f.calls.logout, 0);
  assert.equal((await f.request("logout/confirm", { ...confirmation(review), confirm: false })).status, 409);
  const result = await (await f.request("logout/confirm", { ...confirmation(review), credentialPath: "/another/company/auth.json" })).json(); assert.equal(result.state, "completed");
  assert.equal(f.app.store.get(f.chat.id).queuePaused, true); assert.deepEqual(f.calls.inputs, []); assert.equal(f.app.store.get(f.chat.id).messages.length, 0);
  await f.app.manager.stop(f.chat.id); assert.equal((await (await f.request("logout/confirm", confirmation(review))).json()).state, "completed"); assert.equal(f.calls.starts, 1); assert.equal(f.calls.logout, 1);
  await f.app.store.update(f.chat.id, { ownerId: "other-user" }); assert.equal((await f.request("logout")).status, 404);
});

test("shared host sign-out is blocked without waking the worker or inspecting credentials", async t => {
  const f = await serverFixture(t, { CODEX_AUTH_MODE: "host" }), result = await (await f.request("logout/inspect", {})).json();
  assert.equal(result.canLogout, false); assert.match(result.reason, /Shared host/); assert.equal(f.calls.starts, 0); assert.equal(f.calls.logout, 0);
});

test("busy agents and stopped/replaced workers reject sign-out without an automatic stop or wake", async t => {
  const f = await serverFixture(t), { review } = await (await f.request("logout/inspect", {})).json();
  f.calls.turnGate = Promise.withResolvers(); const turn = f.app.manager.send(f.chat.id, "Fixture work"); await waitFor(() => f.calls.inputs.length);
  assert.equal((await f.request("logout/confirm", confirmation(review))).status, 409); assert.equal(f.calls.logout, 0); f.calls.turnGate.resolve(); await turn;
  await f.app.manager.stop(f.chat.id); assert.equal((await f.request("logout/confirm", confirmation(review))).status, 409); assert.equal(f.calls.starts, 1);
  await f.request("logout/inspect", {}); assert.equal((await f.request("logout/confirm", confirmation(review))).status, 409); assert.equal(f.calls.logout, 0);
});

test("Stop during inspection prevents native dispatch and in-flight sign-out outcomes remain uncertain", async t => {
  const f = await serverFixture(t); let { review } = await (await f.request("logout/inspect", {})).json();
  f.calls.snapshotGate = Promise.withResolvers(); f.calls.entered = Promise.withResolvers(); const stale = f.request("logout/confirm", confirmation(review)); await f.calls.entered.promise;
  await f.app.manager.stop(f.chat.id); f.calls.snapshotGate.resolve(); assert.equal((await stale).status, 409); assert.equal(f.calls.logout, 0);
  f.calls.snapshotGate = null; ({ review } = await (await f.request("logout/inspect", {})).json()); f.calls.logoutGate = Promise.withResolvers();
  const pending = f.request("logout/confirm", confirmation(review)); await waitFor(() => f.calls.logout);
  assert.equal((await (await f.request("logout/confirm", confirmation(review))).json()).state, "signing_out");
  await f.app.manager.stop(f.chat.id); f.calls.logoutGate.resolve(); assert.equal((await pending).status, 409);
  assert.equal((await (await f.request("logout")).json()).reviews[0].state, "uncertain");
  assert.equal((await (await f.request("logout/confirm", confirmation(review))).json()).state, "uncertain"); assert.equal(f.calls.logout, 1); assert.equal(f.calls.starts, 2);
});

test("late account inspection cannot restore logged-out account details or rate limits", async t => {
  const f = await serverFixture(t), { review } = await (await f.request("logout/inspect", {})).json();
  await f.app.store.update(f.chat.id, { usageAccount: { email: "old@fixture.invalid" }, rateLimits: [{ id: "old" }] });
  f.calls.inspectGate = Promise.withResolvers(); f.calls.entered = Promise.withResolvers(); const inspecting = f.app.manager.sessionInfo(f.chat.id); await f.calls.entered.promise;
  assert.equal((await (await f.request("logout/confirm", confirmation(review))).json()).state, "completed"); f.calls.inspectGate.resolve();
  const result = await inspecting; assert.equal(result.account, null); assert.equal(result.rateLimits, null);
  assert.equal(f.app.store.get(f.chat.id).usageAccount, null); assert.equal(f.app.store.get(f.chat.id).rateLimits, null);
});
