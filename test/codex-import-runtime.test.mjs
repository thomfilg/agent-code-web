import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

async function fixture(t, overrides = {}) {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const f = { calls: [], histories: [], imports: [], adapters: [], before: async () => {}, badPolicy: false };
  const config = testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), AGENT_WEB_AUTH_TOKEN: "import-fixture", AGENT_IDLE_TIMEOUT_MS: "10000", ...overrides });
  const app = await createAgentWebServer({ config, records, models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, hooks, executor }) => {
      const adapter = new CodexAdapter({ chat, hooks, executor, store: app.store, config, broker: app.broker }); f.adapters.push(adapter);
      const start = adapter.start.bind(adapter);
      adapter.start = async () => {
        await mkdir(chat.workspace, { recursive: true }); await writeFile(path.join(chat.workspace, "CLAUDE.md"), "Fixture source instructions");
        await start(); const rpc = adapter.rpc, request = rpc.request.bind(rpc);
        rpc.request = async (method, params, timeout) => {
          f.calls.push({ method, params: structuredClone(params) }); await f.before(method, params);
          if (method === "externalAgentConfig/detect") return { items: [{ itemType: "AGENTS_MD", description: "Project fixture", cwd: chat.workspace, details: null }] };
          if (method === "externalAgentConfig/import") {
            const saved = await records.get("native-import", chat.id);
            assert.equal(saved.jobs.at(-1).providerId, params.providerId, "Intent precedes the external write");
            f.imports.push({ ...structuredClone(params), importId: randomUUID(), workspace: chat.workspace });
            return { importId: f.imports.at(-1).importId };
          }
          if (method === "externalAgentConfig/import/readHistories") return { data: structuredClone(f.histories) };
          if (method === "configRequirements/read") return f.badPolicy ? {} : { requirements: null };
          if (method === "config/batchWrite") { assert.deepEqual(params, { edits: [], reloadUserConfig: true }); return { status: "ok" }; }
          if (method === "hooks/list") return { data: [{ cwd: chat.workspace, hooks: [{ enabled: true, trustStatus: "untrusted", command: "must-not-execute" }], errors: [] }] };
          return request(method, params, timeout);
        };
      };
      return adapter;
    } });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "codex", title: "Scoped import fixture" });
  const request = (tail = "imports", body = {}) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method: "POST", headers: { authorization: "Bearer import-fixture", "content-type": "application/json" }, body: JSON.stringify(body) });
  const review = async () => { const response = await request(); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const input = catalog => ({ requestId: randomUUID(), source: catalog.source, revision: catalog.revision, threadId: catalog.threadId, ids: catalog.items.map(item => item.id), confirm: true });
  const complete = () => {
    const imported = f.imports.at(-1), success = { itemType: "AGENTS_MD", cwd: imported.workspace, source: path.join(imported.workspace, "CLAUDE.md"), target: path.join(imported.workspace, "AGENTS.md"), title: null };
    f.histories.push({ importId: imported.importId, providerId: imported.providerId, completedAtMs: Date.now(), successes: [success], failures: [] });
    f.adapters.at(-1).rpc.emit("notification", { method: "externalAgentConfig/import/completed", params: { importId: imported.importId, itemTypeResults: [{ itemType: "AGENTS_MD", successes: [success], failures: [] }] } });
  };
  return Object.assign(f, { app, records, chat, url, request, review, input, complete });
}

test("import API uses guarded private storage, filtered payloads and native reconciliation without messages or grants", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/api/chats/${f.chat.id}/imports`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${f.url}/api/chats/${f.chat.id}/imports`, { method: "POST", headers: { authorization: "Bearer import-fixture", origin: "https://evil.invalid" } })).status, 403);
  const catalog = await f.review(), input = f.input(catalog);
  const response = await f.request("imports/start", { ...input, migrationItems: [{ itemType: "CONFIG", cwd: "/other/company" }], includeHome: false, method: "thread/start" });
  assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).operation.phase, "running");
  assert.equal(f.imports[0].migrationItems[0].cwd, f.chat.workspace); assert.equal(f.imports[0].migrationItems[0].itemType, "AGENTS_MD");
  assert.equal((await f.request("imports/start", input)).status, 200); assert.equal(f.imports.length, 1);
  f.complete(); const refreshed = await f.request("imports/refresh"), result = await refreshed.json();
  assert.equal(refreshed.status, 200, JSON.stringify(result)); assert.equal(result.needsRefresh, false); assert.equal(result.operations[0].phase, "completed");
  assert.ok(f.calls.some(call => call.method === "config/batchWrite"));
  assert.ok(!f.calls.some(call => /(?:turn\/start|review\/start|oauth|auth\/|login|hook.*trust)/i.test(call.method)));
  assert.deepEqual(f.app.store.get(f.chat.id).messages, []);
  assert.doesNotMatch(JSON.stringify(result), /never-expose|must-not-execute|CLAUDE\.md|relay-import:|\/other/);
  const stored = await f.records.get("native-import", f.chat.id); assert.match(stored.binding, /^[a-f0-9]{64}$/); assert.equal(stored.jobs[0].reconciled, true);
  await f.app.manager.stop(f.chat.id); assert.equal((await f.records.get("native-import", f.chat.id)).jobs[0].workerStopped, true);
  const restored = await f.review(); assert.equal(restored.operations[0].phase, "completed");
  assert.equal((await f.request("imports/start", input)).status, 200); assert.equal(f.imports.length, 1);
});

test("import keeps workers awake and blocks main, side, child, compact and goal input until reconciliation", async t => {
  const f = await fixture(t, { AGENT_IDLE_TIMEOUT_MS: "100" }), catalog = await f.review();
  assert.equal((await f.request("imports/start", f.input(catalog))).status, 200);
  const adapter = f.adapters[0], rpc = adapter.rpc;
  assert.equal(f.app.store.get(f.chat.id).idleKeepAwakeReason, "import");
  await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(adapter.rpc, rpc);
  for (const invoke of [() => adapter.send("no turn"), () => adapter.compact(), () => adapter.forkSide({}), () => adapter.forkSession(f.chat.workspace), () => adapter.goalAction("resume")]) await assert.rejects(invoke(), /Refresh \/import/);
  const child = Object.create(CodexAdapter.prototype); child.sharedParent = adapter; await assert.rejects(child.send("no side turn"), /Refresh \/import/);
  await assert.rejects(f.app.manager.agentThreadAction(f.chat.id, "messages", { rootThreadId: catalog.threadId, threadId: "child", text: "no child turn" }), /Refresh \/import/);
  await assert.rejects(f.app.manager.submit(f.chat.id, "no main turn"), /Refresh \/import/);
  assert.deepEqual(f.app.store.get(f.chat.id).messages, []);
  await f.app.manager.enqueue(f.chat.id, "Retain this queued input"); assert.equal(f.app.store.get(f.chat.id).queuedMessages.length, 1);
  f.complete(); assert.equal(adapter.importControls.needsRefresh, true);
  await assert.rejects(adapter.send("still blocked"), /Refresh \/import/);
  // Keep this fixture from dispatching an inference after reconciliation.
  await f.app.store.update(f.chat.id, { queuePaused: true });
  assert.equal((await f.request("imports/refresh")).status, 200);
  assert.equal(f.app.store.get(f.chat.id).queuedMessages.length, 1); assert.equal(adapter.importControls.needsRefresh, false);
});

test("worker stop is persisted and a new worker can acknowledge only that exact stopped import", async t => {
  const f = await fixture(t), input = f.input(await f.review());
  await f.request("imports/start", input); await f.app.manager.stop(f.chat.id);
  await assert.rejects(f.app.manager.submit(f.chat.id, "cannot bypass recovery by restarting"), /Refresh \/import/);
  assert.deepEqual(f.app.store.get(f.chat.id).messages, []);
  const restored = await f.review(); assert.equal(restored.operations[0].phase, "uncertain"); assert.equal(restored.operations[0].canAcknowledge, true);
  const response = await f.request("imports/acknowledge", { id: input.requestId, threadId: restored.threadId, confirm: true });
  assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).operations[0].phase, "acknowledged"); assert.equal(f.imports.length, 1);
});

test("restoration without the matching exit observation cannot authorize acknowledgement", async t => {
  const f = await fixture(t), input = f.input(await f.review());
  await f.request("imports/start", input); await f.app.manager.stop(f.chat.id);
  const saved = await f.records.get("native-import", f.chat.id); saved.jobs[0].workerStopped = false; await f.records.put("native-import", f.chat.id, saved);
  const restored = await f.review(); assert.equal(restored.operations[0].canAcknowledge, false);
  assert.equal((await f.request("imports/acknowledge", { id: input.requestId, threadId: restored.threadId, confirm: true })).status, 409);
  assert.equal(f.imports.length, 1);
});

test("shared host import remains project-only and cannot write native setup", async t => {
  const f = await fixture(t, { CODEX_AUTH_MODE: "host" }), catalog = await f.review();
  assert.equal(catalog.mutable, false); assert.equal(f.calls.find(call => call.method === "externalAgentConfig/detect").params.includeHome, false);
  assert.equal((await f.request("imports/start", f.input(catalog))).status, 409); assert.equal(f.imports.length, 0);
});

test("import HTTP guards cancel delayed discovery after owner/company changes or Stop", async t => {
  for (const reason of ["owner", "company", "stop"]) {
    const f = await fixture(t), catalog = await f.review(), entered = Promise.withResolvers(), release = Promise.withResolvers();
    f.before = async method => { if (method === "externalAgentConfig/detect") { entered.resolve(); await release.promise; } };
    const pending = f.request("imports/start", f.input(catalog)); await entered.promise;
    if (reason === "owner") await f.app.store.update(f.chat.id, { ownerId: "different-owner" });
    else if (reason === "company") await f.app.store.update(f.chat.id, { repositories: [{ owner: "different-company", name: "repo", fullName: "different-company/repo" }] });
    else await f.app.manager.stop(f.chat.id);
    release.resolve(); assert.equal((await pending).status, reason === "owner" ? 404 : 409); assert.equal(f.imports.length, 0);
  }
});

test("reconciliation failure remains blocked, with no import retry or secret exposure", async t => {
  const f = await fixture(t), input = f.input(await f.review()); await f.request("imports/start", input); f.complete(); f.badPolicy = true;
  const failed = await f.request("imports/refresh"); assert.equal(failed.status, 409); assert.match((await failed.json()).error, /native policy/);
  assert.equal(f.adapters[0].importControls.needsRefresh, true); assert.equal(f.imports.length, 1);
  f.badPolicy = false; assert.equal((await f.request("imports/refresh")).status, 200); assert.equal(f.adapters[0].importControls.needsRefresh, false);
});

test("changed scope rejects restored import state and deleting a chat removes only its own import record", async t => {
  const f = await fixture(t); await f.request("imports/start", f.input(await f.review())); await f.app.manager.stop(f.chat.id);
  // Valid selected repository admission must reach the distinct native-import
  // scope guard; malformed GitHub metadata would fail earlier for another reason.
  await f.app.manager.github.companies.save({ id: "import-company", name: "Import company" });
  await f.records.put("connection", "github", { id: "github", token: "synthetic-import-scope-github", revision: 1, companyId: "import-company" });
  f.app.manager.github.fetch = async () => { throw Error("Unexpected external GitHub request in import scope fixture"); };
  await f.app.store.update(f.chat.id, { repositories: [{ id: 31, githubConnectionId: "github", companyId: "import-company", owner: "new-company", name: "repo", fullName: "new-company/repo" }] });
  const response = await f.request(); assert.equal(response.status, 409); assert.match((await response.json()).error, /another scope/);
  await f.records.put("native-import", "other-chat", { marker: "retain" });
  await f.app.manager.remove(f.chat.id); assert.equal(await f.records.get("native-import", f.chat.id), null); assert.deepEqual(await f.records.get("native-import", "other-chat"), { marker: "retain" });
});

test("remote import stop requires the backend's completed stop of the matching instance", async () => {
  const adapter = Object.create(CodexAdapter.prototype), observed = [];
  adapter.executor = { metadata: { backend: "ec2", instanceId: "i-own" } }; adapter.importWorkerId = "native-process-a";
  adapter.importControls = { workerStopped: async id => observed.push(id) };
  for (const value of [null, {}, { instanceId: "i-own", stopped: false }, { instanceId: "i-other", stopped: true }]) await adapter.confirmImportWorkerStopped(value);
  assert.deepEqual(observed, []);
  await adapter.confirmImportWorkerStopped({ instanceId: "i-own", stopped: true }); assert.deepEqual(observed, ["native-process-a"]);
});
