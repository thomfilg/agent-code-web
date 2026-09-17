import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function fixture(t, nativeTier = null) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }), models = new ModelCatalog(config);
  models.codex = async () => ({ models: [
    { id: "gpt-5.6-sol", efforts: ["high"], defaultEffort: "high", supportsPersonality: true, serviceTiers: [{ id: "priority", name: "Fast" }] },
    { id: "plain", efforts: ["high"], defaultEffort: "high", supportsPersonality: false, serviceTiers: [] },
  ] });
  const calls = { starts: 0, inputs: [], stops: 0 };
  const manager = new RuntimeManager({ store, config, models, broker: new CapabilityBroker({ ttlMs: 60000 }),
    commands: new CommandCatalog({ workerBackend: "ec2" }, models), adapterFactory: ({ hooks }) => ({
      settings: { serviceTier: nativeTier }, start: async () => { calls.starts++; await hooks.onSessionId("native-model-fixture"); },
      send: async (text, settings) => { calls.inputs.push({ text, settings }); await calls.gate?.promise; return { text: "Local fixture response" }; },
      stop: async () => { calls.stops++; calls.gate?.resolve(); }, interrupt: async () => calls.gate?.resolve(),
    }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex", title: "Model control fixture" });
  return { root, store, config, models, calls, manager, chat };
}

test("Fast and personality command values stay native and preserve Claude command dispatch", () => {
  for (const text of ["/fast", "/fast on", "/fast off"]) assert.equal(messageCommand("codex", text).type, "fast");
  assert.throws(() => messageCommand("codex", "/fast turbo"), /Use \/fast/);
  for (const personality of ["friendly", "pragmatic", "none"]) assert.deepEqual(messageCommand("codex", `/personality ${personality}`), { type: "settings", settings: { personality } });
  assert.deepEqual(messageCommand("claude", "/fast"), { type: "claudeFast", prompt: "/fast" }); assert.equal(messageCommand("claude", "/personality friendly"), null);
});

test("settings commands persist, emit visible confirmation, and never become model prompts", async t => {
  const f = await fixture(t);
  await f.manager.send(f.chat.id, "/fast on"); await f.manager.send(f.chat.id, "/personality friendly");
  assert.equal(f.store.get(f.chat.id).serviceTier, "priority"); assert.equal(f.store.get(f.chat.id).personality, "friendly");
  assert.equal(f.calls.inputs.length, 0);
  assert(f.store.get(f.chat.id).messages.some(message => message.kind === "notice" && /personality: friendly/.test(message.text)));
  await f.manager.send(f.chat.id, "Actual task after settings");
  assert.equal(f.calls.inputs.length, 1); assert.equal(f.calls.inputs[0].settings.serviceTier, "priority"); assert.equal(f.calls.inputs[0].settings.personality, "friendly");
  assert.doesNotMatch(f.calls.inputs[0].text, /\/fast|\/personality/);
  await f.manager.send(f.chat.id, "/fast off"); await f.manager.send(f.chat.id, "/personality none");
  await f.manager.stop(f.chat.id);
  const restored = new ChatStore(f.root); await restored.initialize();
  assert.equal(restored.get(f.chat.id).serviceTier, null); assert.equal(restored.get(f.chat.id).personality, "none");
  await f.manager.send(f.chat.id, "After worker restart");
  assert.equal(f.calls.starts, 2); assert.equal(f.calls.inputs[1].settings.serviceTier, null); assert.equal(f.calls.inputs[1].settings.personality, "none");
  assert.equal(f.store.get(f.chat.id).agentSessionId, "native-model-fixture");
});

test("busy Fast/personality commands apply in FIFO order only before subsequent tasks", async t => {
  const f = await fixture(t); f.calls.gate = Promise.withResolvers();
  const running = f.manager.send(f.chat.id, "Already running"); await waitFor(() => f.calls.inputs.length === 1);
  await f.manager.enqueue(f.chat.id, "/fast on"); await f.manager.enqueue(f.chat.id, "/personality pragmatic"); await f.manager.enqueue(f.chat.id, "Queued actual task");
  assert.equal(f.store.get(f.chat.id).serviceTier, undefined); assert.equal(f.store.get(f.chat.id).personality, undefined);
  assert.equal(f.calls.inputs[0].settings.serviceTier, undefined); assert.equal(f.calls.inputs[0].settings.personality, undefined);
  f.calls.gate.resolve(); await running; await waitFor(() => !f.manager.isBusy(f.chat.id) && !f.store.get(f.chat.id).queuedMessages.length);
  assert.equal(f.calls.inputs.length, 2); assert.equal(f.calls.inputs[1].settings.serviceTier, "priority"); assert.equal(f.calls.inputs[1].settings.personality, "pragmatic");
  assert.deepEqual(f.store.get(f.chat.id).messages.filter(message => message.role === "user").map(message => message.text), ["Already running", "/fast on", "/personality pragmatic", "Queued actual task"]);
});

test("toggle starts from the native inherited tier and unsupported models never receive stale preferences", async t => {
  const f = await fixture(t, "priority");
  await f.manager.send(f.chat.id, "/fast"); assert.equal(f.store.get(f.chat.id).serviceTier, null);
  await f.manager.send(f.chat.id, "/fast"); assert.equal(f.store.get(f.chat.id).serviceTier, "priority");
  await f.manager.send(f.chat.id, "/personality pragmatic"); await f.manager.send(f.chat.id, "/model plain");
  const catalog = await f.manager.commands.list(f.store.get(f.chat.id));
  assert(!catalog.commands.some(item => ["fast", "personality"].includes(item.name)));
  await f.manager.send(f.chat.id, "Plain model task");
  assert.equal(f.calls.inputs[0].settings.model, "plain"); assert.equal(f.calls.inputs[0].settings.serviceTier, null); assert.equal(f.calls.inputs[0].settings.personality, "none");
  await f.manager.send(f.chat.id, "/fast on"); await f.manager.send(f.chat.id, "/personality friendly");
  assert.equal(f.calls.inputs.length, 1); assert.equal(f.store.get(f.chat.id).serviceTier, "priority"); assert.equal(f.store.get(f.chat.id).personality, "pragmatic");
  assert(f.store.get(f.chat.id).messages.filter(message => message.kind === "error").length >= 2);
});

test("stopping while Fast capability lookup is pending cannot apply a late setting", async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const selected = f.models.selected.bind(f.models);
  f.models.selected = async chat => { entered.resolve(); await gate.promise; return selected(chat); };
  const running = f.manager.send(f.chat.id, "/fast on"); await entered.promise;
  const stopped = f.manager.stop(f.chat.id); await waitFor(() => f.calls.stops > 0); gate.resolve();
  await Promise.all([running, stopped]);
  assert.equal(f.store.get(f.chat.id).status, "stopped"); assert.equal(f.store.get(f.chat.id).serviceTier, undefined);
  assert(!f.store.get(f.chat.id).messages.some(message => message.kind === "notice" && /serviceTier/.test(message.text)));
});

test("stopping during personality validation cannot save or confirm a cancelled change", async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const validate = f.models.validate.bind(f.models);
  f.models.validate = async (...args) => { entered.resolve(); await gate.promise; return validate(...args); };
  const running = f.manager.send(f.chat.id, "/personality friendly"); await entered.promise;
  const stopped = f.manager.stop(f.chat.id); await waitFor(() => f.calls.stops > 0); gate.resolve(); await Promise.all([running, stopped]);
  assert.equal(f.store.get(f.chat.id).personality, undefined); assert.equal(f.calls.inputs.length, 0);
  assert(!f.store.get(f.chat.id).messages.some(message => message.kind === "notice" && /personality/.test(message.text)));
});

test("a concurrent model-picker change is not overwritten by a late Fast command", async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const selected = f.models.selected.bind(f.models);
  f.models.selected = async chat => { entered.resolve(); await gate.promise; return selected(chat); };
  const running = f.manager.send(f.chat.id, "/fast on"); await entered.promise;
  await f.manager.setModel(f.chat.id, { model: "plain", effort: "high" }); gate.resolve(); await running;
  assert.equal(f.store.get(f.chat.id).model, "plain"); assert.equal(f.store.get(f.chat.id).serviceTier, undefined);
  assert(f.store.get(f.chat.id).messages.some(message => message.kind === "error" && /settings changed/.test(message.text)));
  assert.equal(f.calls.inputs.length, 0);
});

test("explicit Fast off is distinct from an inherited tier during a pending settings command", async t => {
  const f = await fixture(t, "priority"), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const selected = f.models.selected.bind(f.models);
  f.models.selected = async chat => { entered.resolve(); await gate.promise; return selected(chat); };
  const running = f.manager.send(f.chat.id, "/fast on"); await entered.promise;
  await f.manager.setModel(f.chat.id, { model: f.chat.model, effort: f.chat.effort, serviceTier: null }); gate.resolve(); await running;
  assert.equal(f.store.get(f.chat.id).serviceTier, null); assert.equal(f.calls.inputs.length, 0);
  assert(f.store.get(f.chat.id).messages.some(message => message.kind === "error" && /settings changed/.test(message.text)));
});
