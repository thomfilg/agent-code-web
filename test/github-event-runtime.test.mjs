import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { eventFixture, eventAccount, eventOwner, eventConnection } from "./fixtures/github-events.mjs";
import { testConfig, waitFor } from "./helpers.mjs";
import { searchMessages } from "../src/message-search.mjs";

async function runtimeFixture(t, options = {}) {
  const f = await eventFixture(t); await f.configure(); await f.monitor.stop(); await f.events.stop();
  const calls = []; let starts = 0, release;
  const manager = new RuntimeManager({ store: f.store, github: f.github, config: testConfig(f.root, { AGENT_IDLE_TIMEOUT_MS: "60000" }), broker: new CapabilityBroker({ ttlMs: 60000 }),
    agentAccounts: { assertConnected: (owner, id) => { assert.equal(owner, eventOwner); assert.equal(id, eventAccount); }, select: async () => f.records.get("agent-account", eventAccount) },
    models: options.models,
    adapterFactory: () => ({ start: async () => { starts++; await options.start?.(); }, stop: async () => { release?.({ text: "interrupted" }); await options.stop?.(); },
      send: async text => {
        calls.push(text.includes("[GitHub event") ? "github" : text.includes("hold user") ? "hold" : text.includes("queued user") ? "queued" : "user");
        if (text.includes("hold user")) return new Promise(resolve => { release = resolve; });
        return { text: "Fixture complete" };
      } }) });
  manager.browserExecutor = async () => null;
  t.after(async () => { release?.({ text: "cleanup" }); await manager.shutdown(); });
  await manager.githubEvents.initialize();
  const update = async (checks, patch = {}) => { Object.assign(f.canonical, { checks, run: f.canonical.run + 1 }, patch); await manager.pullRequests.refresh(f.chat.id, { force: true }); };
  return { ...f, manager, events: manager.githubEvents, update, calls, starts: () => starts, release: () => release?.({ text: "Done" }) };
}

test("failed checks stay pending while stopped; explicitly subscribed passing checks wake exact named chat", async t => {
  const f = await runtimeFixture(t);
  await f.update("failing"); assert.equal(f.starts(), 0); assert.deepEqual(f.calls, []);
  assert.equal((await f.events.state(f.chat.id)).events[0].status, "pending");
  await f.update("passing"); await waitFor(async () => (await f.events.state(f.chat.id)).events.some(event => event.status === "delivered"), { timeoutMs: 5000 });
  assert.equal(f.starts(), 1); assert.deepEqual(f.calls, ["github"]);
  const messages = f.store.get(f.chat.id).messages.filter(message => message.meta?.source === "github"); assert.equal(messages.length, 1); assert.match(messages[0].text, /Checks: passing/);
  assert.equal(messages[0].meta.authorship, undefined, "a generated event is not attributed to the user");
  assert.deepEqual(searchMessages([f.store.get(f.chat.id)], { query: "Checks: passing", role: "user" }).results, [], "delivered GitHub messages must stay outside authored-message search");
  await f.manager.send(f.chat.id, "Find this ordinary user message");
  const authored = f.store.get(f.chat.id).messages.find(message => message.text === "Find this ordinary user message");
  assert.equal(authored.meta.authorship, "user");
  assert.deepEqual(searchMessages([f.store.get(f.chat.id)], { query: "Find this ordinary", role: "user" }).results.map(match => match.messageId), [authored.id]);
});

test("busy delivery joins user FIFO without interruption or unpausing independent messages", async t => {
  const f = await runtimeFixture(t);
  const first = await f.manager.submit(f.chat.id, "hold user"); await waitFor(() => f.calls.length === 1);
  await f.manager.enqueue(f.chat.id, "queued user"); await f.update("failing");
  assert.deepEqual(f.calls, ["hold"]); assert.equal(f.store.get(f.chat.id).queuedMessages.length, 2);
  f.release(); await first.completion;
  await waitFor(async () => (await f.events.state(f.chat.id)).events[0].status === "delivered", { timeoutMs: 5000 });
  assert.deepEqual(f.calls, ["hold", "queued", "github"]);
});

test("passing-check wake preserves a manually paused ordinary queue", async t => {
  const f = await runtimeFixture(t);
  await f.store.update(f.chat.id, { queuePaused: true }); await f.manager.enqueue(f.chat.id, "queued user");
  await f.update("passing");
  await waitFor(async () => (await f.events.state(f.chat.id)).events[0].status === "delivered", { timeoutMs: 5000 });
  assert.deepEqual(f.calls, ["github"]); assert.equal(f.store.get(f.chat.id).queuePaused, true);
  assert.equal(f.store.get(f.chat.id).queuedMessages[0].text, "queued user");
});

test("manual Stop in flight cancels a newly passing event rather than resurrecting a worker afterward", async t => {
  const gate = Promise.withResolvers(); let stopping = false;
  t.after(() => gate.resolve());
  const f = await runtimeFixture(t, { stop: async () => { stopping = true; await gate.promise; } });
  await f.manager.send(f.chat.id, "ordinary user"); assert.equal(f.starts(), 1);
  const stop = f.manager.stop(f.chat.id); await waitFor(() => stopping);
  await f.update("passing"); assert.deepEqual(f.calls, ["user"]);
  gate.resolve(); await stop; await f.manager.pullRequests.refresh(f.chat.id, { force: true });
  assert.equal(f.starts(), 1); assert.deepEqual(f.calls, ["user"]);
  assert.equal((await f.events.state(f.chat.id)).events[0].status, "cancelled");
});

test("connection revoked while native setup awaits prevents late event dispatch", async t => {
  const gate = Promise.withResolvers(); let entered = false;
  t.after(() => gate.resolve());
  const f = await runtimeFixture(t, { start: async () => { entered = true; await gate.promise; } });
  await f.update("passing"); await waitFor(() => entered);
  await f.records.delete("github_connection", eventConnection); gate.resolve();
  await waitFor(async () => (await f.events.state(f.chat.id)).events[0].status === "uncertain", { timeoutMs: 5000 });
  assert.deepEqual(f.calls, []);
});

test("Stop while event preparation awaits preserves native context and blocks late GitHub send", async t => {
  const gate = Promise.withResolvers(); let entered = false;
  t.after(() => gate.resolve());
  const f = await runtimeFixture(t, { models: { turnSettings: async () => { entered = true; await gate.promise; return {}; } } });
  await f.update("passing"); await waitFor(() => entered);
  await f.manager.stop(f.chat.id); gate.resolve();
  await waitFor(() => !f.manager.isBusy(f.chat.id), { timeoutMs: 5000 });
  assert.deepEqual(f.calls, []); assert.equal(f.store.get(f.chat.id).status, "stopped");
});

test("Stop completed while enqueue validation awaited cannot become a new passing-check wake", async t => {
  const f = await runtimeFixture(t), gate = Promise.withResolvers(); let entered = false;
  t.after(() => gate.resolve());
  const validate = f.events.validate.bind(f.events);
  f.events.validate = async (...args) => { const event = await validate(...args); entered = true; await gate.promise; return event; };
  const refresh = f.update("passing"); await waitFor(() => entered);
  await f.manager.stop(f.chat.id); gate.resolve(); await refresh;
  assert.deepEqual(f.calls, []); assert.equal(f.starts(), 0); assert.equal((f.store.get(f.chat.id).queuedMessages || []).length, 0);
  await f.manager.pullRequests.refresh(f.chat.id, { force: true });
  assert.equal((await f.events.state(f.chat.id)).events[0].status, "cancelled");
});

test("removing a queued GitHub event durably dismisses it and polling cannot re-enqueue it", async t => {
  const f = await runtimeFixture(t), first = await f.manager.submit(f.chat.id, "hold user");
  await waitFor(() => f.calls.length === 1); await f.update("failing");
  const item = f.store.get(f.chat.id).queuedMessages.find(item => item.githubEventId);
  assert(item); await f.manager.editQueue(f.chat.id, { removeId: item.id });
  await f.manager.pullRequests.refresh(f.chat.id, { force: true });
  assert.equal(f.store.get(f.chat.id).queuedMessages.length, 0);
  assert.equal((await f.events.state(f.chat.id)).events[0].status, "cancelled");
  f.release(); await first.completion; assert.deepEqual(f.calls, ["hold"]);
});
