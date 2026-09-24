import assert from "node:assert/strict";
import test from "node:test";
import { AgentAccounts } from "../src/agent-accounts.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { codexAccountFixture } from "./fixtures/codex-account.mjs";
import { claudeAccountFixture } from "./fixtures/claude-account.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const owner = `user_${"a".repeat(32)}`;
async function fixture(t, provider = "codex") {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize();
  const native = provider === "claude" ? claudeAccountFixture() : codexAccountFixture(), accounts = new AgentAccounts({ records, clientFactory: native.factory }); await accounts.initialize();
  const chats = [], calls = [], hooks = new Map();
  for (const name of ["Selected", "Other"]) {
    const { account } = await accounts.begin(owner, { provider, name }); native.clients.at(-1).approve();
    await waitFor(() => accounts.list(owner).find(item => item.id === account.id)?.status === "connected");
    const chat = await store.create({ ownerId: owner, agent: provider, agentAccountId: account.id, title: name });
    await store.update(chat.id, { agentSessionId: `session-${chat.id}` }); chats.push(store.get(chat.id));
  }
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }),
    broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://127.0.0.1:1", agentAccounts: accounts,
    workerBackend: { acquire: async () => ({ workspace: root }), sleep: async () => {} },
    adapterFactory: ({ chat, hooks: callbacks }) => {
      hooks.set(chat.id, callbacks);
      // Native child operations return a root-bound snapshot, not a bare ACK.
      const snapshot = () => ({ rootThreadId: chat.agentSessionId, threads: [] });
      return { start: async () => {}, stop: async () => { calls.push([chat.id, "stop"]); },
        send: async () => { calls.push([chat.id, "main-send"]); return { text: "fixture" }; },
        respond: async () => { calls.push([chat.id, "main-respond"]); },
        interrupt: async () => { calls.push([chat.id, "interrupt"]); },
        compact: async () => { calls.push([chat.id, "compact"]); },
        goalAction: async () => { calls.push([chat.id, "goal"]); },
        forkSession: async () => { calls.push([chat.id, "fork"]); throw Error("fixture fork must not be called after revocation"); },
        agents: { busy: () => false, refresh: async () => snapshot(),
          send: async () => { calls.push([chat.id, "send"]); return snapshot(); },
          respond: async () => { calls.push([chat.id, "respond"]); return snapshot(); } },
        forkSide: async () => ({ stop: async () => {}, send: async () => { calls.push([chat.id, "side-send"]); return { text: "fixture" }; } }),
      };
    } });
  accounts.onRevoke = async (_, id) => { for (const chat of chats) if (chat.agentAccountId === id) await manager.stop(chat.id, "account-disconnected"); };
  t.after(async () => { await manager.shutdown(); await accounts.close(); });
  for (const chat of chats) {
    if (provider === "codex") await manager.agentThreadAction(chat.id, "refresh");
    else await manager.send(chat.id, "synthetic adapter fixture; no CLI or provider");
  }
  calls.splice(0);
  const update = store.update.bind(store);
  const failStopPersistence = () => {
    let failOnce = true;
    store.update = async (id, patch) => { if (id === chats[0].id && failOnce) { failOnce = false; throw Error("fixture chat persistence failure"); } return update(id, patch); };
  };
  const action = (chat, name) => manager.agentThreadAction(chat.id, name, { rootThreadId: chat.agentSessionId, threadId: "child", requestId: "request", text: "counter only; no provider" });
  return { manager, accounts, native, records, store, chats, calls, hooks, failStopPersistence, action };
}

test("failed disconnect cannot reuse warmed native messages, approvals or side chats; another account still works", async t => {
  const f = await fixture(t), [selected, other] = f.chats;
  const side = (await f.manager.sideChats.open(selected.id)).side;
  f.failStopPersistence();
  await assert.rejects(() => f.accounts.disconnect(owner, selected.agentAccountId), { statusCode: 503 });
  for (const operation of [() => f.action(selected, "messages"), () => f.action(selected, "respond"),
    () => f.manager.respond(selected.id, "request", {}), () => f.manager.sideChats.open(selected.id),
    () => f.manager.sideChats.send(selected.id, side.id, { text: "must not dispatch" }),
    () => f.manager.sideChats.respond(selected.id, side.id, "request", {})]) await assert.rejects(operation, /Reconnect/);
  await assert.rejects(() => f.hooks.get(selected.id).accountCredentials({ refresh: true }), /Worker startup cancelled/);
  assert.deepEqual(f.calls, []);
  await f.action(other, "messages"); await f.action(other, "respond");
  assert.deepEqual(f.calls, [[other.id, "send"], [other.id, "respond"]]);
  // Retry completes native cleanup; the original named identity can reconnect.
  await f.accounts.disconnect(owner, selected.agentAccountId);
  await f.accounts.begin(owner, { id: selected.agentAccountId, provider: "codex", name: "Selected" });
  f.native.clients.at(-1).approve(); await waitFor(() => f.accounts.list(owner).find(item => item.id === selected.agentAccountId)?.status === "connected");
  // Account reconnection does not silently reconnect a child-agent process.
  await assert.rejects(() => f.action(selected, "messages"), /Connect explicitly/);
  assert.deepEqual(f.calls.slice(-1), [[selected.id, "stop"]]);
  await f.manager.agentThreadAction(selected.id, "refresh");
  await f.action(selected, "messages");
  assert.equal(f.store.get(selected.id).agentSessionId, selected.agentSessionId);
  assert.deepEqual(f.calls.slice(-2), [[selected.id, "stop"], [selected.id, "send"]]);
});

test("expired account metadata blocks warm native actions even before worker revocation starts", async t => {
  const f = await fixture(t), [selected] = f.chats;
  const record = await f.accounts.get(owner, selected.agentAccountId);
  await f.accounts.save({ ...record, status: "reconnect" });
  await assert.rejects(() => f.action(selected, "messages"), /Reconnect/);
  await assert.rejects(() => f.action(selected, "respond"), /Reconnect/);
  assert.deepEqual(f.calls, []);
});

test("Claude warmed main approval and turn stay blocked after failed selected-account disconnect", async t => {
  const f = await fixture(t, "claude"), [selected, other] = f.chats;
  f.failStopPersistence(); await assert.rejects(() => f.accounts.disconnect(owner, selected.agentAccountId), { statusCode: 503 });
  await assert.rejects(() => f.manager.respond(selected.id, "request", {}), /Reconnect/);
  await f.manager.send(selected.id, "must not reach the warmed Claude adapter");
  assert.deepEqual(f.calls, []);
  await f.manager.send(other.id, "unrelated selected account remains usable");
  assert.deepEqual(f.calls, [[other.id, "main-send"]]);
});

test("manual stop storage failure invalidates warm runtime without losing the reference needed for retry", async t => {
  const f = await fixture(t), [selected] = f.chats;
  f.failStopPersistence(); await assert.rejects(() => f.manager.stop(selected.id), /persistence/);
  await assert.rejects(() => f.action(selected, "messages"), /stopped or revoked/);
  await assert.rejects(() => f.action(selected, "respond"), /stopped or revoked/);
  assert.deepEqual(f.calls, []);
  await f.manager.stop(selected.id); assert.deepEqual(f.calls, [[selected.id, "stop"]]);
});

test("a warm native runtime cannot dispatch as another connected account after its chat binding changes", async t => {
  const f = await fixture(t), [selected, other] = f.chats;
  await f.store.update(selected.id, { agentAccountId: other.agentAccountId });
  await assert.rejects(() => f.action(selected, "messages"), /selected agent account changed/);
  await assert.rejects(() => f.action(selected, "respond"), /selected agent account changed/);
  assert.deepEqual(f.calls, []);
});

for (const operation of ["compact", "goal"]) for (const invalidation of ["expiry", "stop", "interrupt"]) test(`${invalidation} during ${operation} persistence cannot dispatch a later native command`, async t => {
  const f = await fixture(t), [selected] = f.chats, update = f.store.update.bind(f.store);
  const entered = Promise.withResolvers(), gate = Promise.withResolvers(); let gated = false;
  f.store.update = async (id, patch) => {
    // The compact status is a functional patch; observe the saved status after
    // applying it. The goal control has its own forkGoalPending update.
    const result = await update(id, patch);
    if (!gated && id === selected.id && (operation === "compact" ? result.statusDetail === "Compacting context" : patch?.forkGoalPending === false)) {
      gated = true; entered.resolve(); await gate.promise;
    }
    return result;
  };
  const turn = await f.manager.submit(selected.id, operation === "compact" ? "/compact" : "/goal pause");
  turn.completion.catch(() => {}); await entered.promise;
  let interrupt;
  if (invalidation === "interrupt") { interrupt = f.manager.interrupt(selected.id); await new Promise(resolve => setImmediate(resolve)); }
  else if (invalidation === "stop") await f.manager.stop(selected.id);
  else {
    const record = await f.accounts.get(owner, selected.agentAccountId);
    await f.accounts.save({ ...record, status: "reconnect" });
  }
  gate.resolve(); await turn.completion; await interrupt;
  assert.equal(f.calls.some(([id, action]) => id === selected.id && action === operation), false);
});

test("native fork rechecks account after the target chat creation await", async t => {
  const f = await fixture(t), [selected] = f.chats, create = f.store.create.bind(f.store);
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  f.store.create = async (...args) => { entered.resolve(); await gate.promise; return create(...args); };
  const fork = f.manager.forkChat(selected.id, { requestId: "fixture-native-fork" }, owner); fork.catch(() => {});
  await entered.promise;
  const record = await f.accounts.get(owner, selected.agentAccountId);
  await f.accounts.save({ ...record, status: "reconnect" }); gate.resolve();
  await assert.rejects(fork, /Reconnect/);
  assert.equal(f.calls.some(([, action]) => action === "fork"), false);
});
