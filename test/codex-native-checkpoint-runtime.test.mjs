import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, rm, readdir } from "node:fs/promises";
import { once } from "node:events";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { nativeFixture, nativeId } from "./fixtures/native-session.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("external native process loss and removal of its private journal restore the exact ID and private history without a prompt", async t => {
  const root = await temporaryDirectory(t), f = await nativeFixture();
  await f.records.put("chat", f.chat.id, { ...f.chat, agentSessionId: null, workspace: path.join(root, "workspace") });
  const store = new ChatStore(root, f.records); await store.initialize(); await mkdir(store.get(f.chat.id).workspace, { mode: 0o700 });
  const events = [], adapters = [], config = testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex-native-journal.mjs") });
  const make = () => {
    const adapter = new CodexAdapter({ chat: store.get(f.chat.id), store, config, nativeSessions: f.service, broker: new CapabilityBroker({ ttlMs: 10000 }),
      hooks: { onSessionId: id => store.update(f.chat.id, { agentSessionId: id }), onEvent: event => events.push(event),
        accountCredentials: async () => ({ accessToken: "synthetic-access-only", chatgptAccountId: "synthetic-identity" }) } });
    adapters.push(adapter); return adapter;
  };
  t.after(async () => { for (const adapter of adapters) await adapter.stop(); });
  const first = make(); await first.start(); await first.send("Preserve the original user instruction exactly");
  const original = await first.rpc.request("fixture/history", {}), checkpoint = await f.service.read(store.get(f.chat.id));
  assert.equal(checkpoint.value.boundary, "turn-completed");
  assert.equal(Buffer.from(checkpoint.value.bundle.files[0].data, "base64").toString(), original.data);
  assert.match(original.data, /second-private-native-record/);
  const child = first.rpc.child, exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  assert.ok(first.nativeHome.startsWith(root + path.sep));
  await rm(first.nativeHome, { recursive: true, force: true });
  const resumed = make(); await resumed.start();
  const recovered = await resumed.rpc.request("fixture/history", {});
  assert.equal(resumed.threadId, nativeId); assert.equal(recovered.data, original.data);
  assert.equal(recovered.calls.includes("thread/start"), false);
  assert.equal(recovered.calls.includes("turn/start"), false, "restore never replays a prompt");
  assert.deepEqual(await readdir(resumed.nativeHome), ["sessions"], "no auth or host configuration is copied");
  assert.equal(JSON.stringify(events).includes("second-private-native-record"), false, "private native records never enter UI events");
});

test("a delayed retired adapter Stop cannot publish after a newer runtime has also stopped", async t => {
  const root = await temporaryDirectory(t), f = await nativeFixture();
  await f.records.put("chat", f.chat.id, { ...f.chat, agentSessionId: null, environmentId: null, workspace: path.join(root, "workspace") });
  const store = new ChatStore(root, f.records); await store.initialize(); await mkdir(store.get(f.chat.id).workspace, { mode: 0o700 });
  const adapters = [], originalStart = CodexAdapter.prototype.start;
  CodexAdapter.prototype.start = async function () { adapters.push(this); return originalStart.call(this); };
  t.after(() => { CodexAdapter.prototype.start = originalStart; });
  const manager = new RuntimeManager({ store, broker: new CapabilityBroker({ ttlMs: 60000 }),
    config: testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex-native-journal.mjs"), AGENT_IDLE_TIMEOUT_MS: "60000" }),
    agentAccounts: { select: async () => f.records.get("agent-account", f.chat.agentAccountId), assertConnected: () => {},
      credentials: async () => ({ accessToken: "synthetic-only", chatgptAccountId: "synthetic-identity" }) } });
  // Already prepared, fixture-owned local workspace; no GitHub/worker access.
  manager.browserExecutor = async () => null; manager.nativeSessions = f.service;
  const gate = Promise.withResolvers(); t.after(async () => { gate.resolve(); await manager.shutdown(); });
  await (await manager.submit(f.chat.id, "First synthetic turn")).completion;
  const old = adapters[0]; await manager.stop(f.chat.id);
  old.nativeCapture = gate.promise;
  const retiredStop = old.stop({ checkpointVersion: 1 });
  await (await manager.submit(f.chat.id, "Second synthetic turn")).completion;
  assert.equal(adapters.length, 2); await manager.stop(f.chat.id);
  const newest = await f.service.read(store.get(f.chat.id));
  gate.resolve(); await retiredStop;
  assert.deepEqual(await f.service.read(store.get(f.chat.id)), newest, "old terminal token cannot overwrite a newer stopped checkpoint");
});
