import assert from "node:assert/strict";
import test from "node:test";
import { ultracodeDiscovery, ultracodeForModel, assertUltracodeApplied, applyUltracode } from "../src/claude-ultracode.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { ChatStore } from "../src/store.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { WorkspaceSettings } from "../public/workspace-settings.js";
import { testConfig, temporaryDirectory } from "./helpers.mjs";

const native = enabled => ({ applied: { model: "native-fixture", effort: "xhigh", ultracode: enabled } });
const discovery = () => ultracodeDiscovery({ commands: [{ name: "effort", argumentHint: "[low|high|xhigh|ultracode]" }] }, native(false));
const rawModels = () => Object.defineProperty([
  { value: "default", displayName: "Default", supportedEffortLevels: ["high", "xhigh"] },
  { value: "native-fixture", supportedEffortLevels: ["high", "xhigh"] },
  { value: "unobserved", supportedEffortLevels: ["high", "xhigh"] },
], "ultracodeDiscovery", { value: discovery() });
const modelCatalog = () => new ModelCatalog(testConfig("/tmp/unused-ultracode-models"), { models: async () => rawModels() });
const context = { agent: "claude", ownerId: "owner", agentAccountId: "personal", model: "default" };

test("Ultracode needs the actual dynamic effort hint, applied native contract and exact observed model", () => {
  const model = { id: "default", efforts: ["xhigh"] };
  assert.equal(ultracodeForModel(model, discovery()).supported, true);
  for (const value of [null, {}, { ...discovery(), advertised: false }, { ...discovery(), control: false }, { ...discovery(), model: null }]) assert.equal(ultracodeForModel(model, value).supported, false);
  assert.equal(ultracodeForModel({ ...model, id: "unobserved" }, discovery()).supported, false);
  assert.equal(ultracodeForModel({ ...model, efforts: ["high"] }, discovery()).supported, false);
  assert.equal(ultracodeForModel({ ...model, disabled: true }, discovery()).supported, false);
  for (const hint of ["xhigh", "not-ultracode", "ultracode".repeat(200)]) assert.equal(ultracodeDiscovery({ commands: [{ name: "effort", argumentHint: hint }] }, native(false)).advertised, false);
  assert.doesNotMatch(JSON.stringify(ultracodeDiscovery({ commands: [], credentials: "private" }, { ...native(false), sources: [{ secret: "private" }] })), /private|secret|credentials/);
});

test("native readback requires workflows AND effective xhigh, and errors remain fixed/redacted", async () => {
  assertUltracodeApplied(native(true), true);
  assertUltracodeApplied(native(false), false);
  for (const value of [{}, { applied: { effort: "xhigh" } }, native(false), { applied: { ...native(true).applied, effort: "high" } }, { ...native(true), errors: ["private-policy-detail"] }]) assert.throws(() => assertUltracodeApplied(value, true), /did not confirm/);
  await assert.rejects(applyUltracode({ request: async () => { throw new Error("PRIVATE bearer credential"); } }, true), error => /did not confirm/.test(error.message) && !/PRIVATE|bearer/.test(error.message));
});

test("model validation keeps ordinary xhigh separate, accepts explicit chat opt-in and clears it on choices", async () => {
  const catalog = modelCatalog();
  const list = await catalog.list("claude", context);
  assert.equal(list.models[0].ultracode.supported, true); assert.equal(list.models[2].ultracode.supported, false);
  assert.deepEqual(await catalog.validate("claude", { model: "default", effort: "xhigh" }, context), { model: "default", effort: "xhigh" });
  assert.deepEqual(await catalog.creationSettings("claude", { ...context, ultracode: true }), { model: "default", effort: "xhigh", ultracode: true });
  assert.deepEqual(await catalog.validate("claude", { model: "default", effort: "high" }, { ...context, ultracode: true }), { model: "default", effort: "high", ultracode: false });
  assert.equal((await catalog.turnSettings({ ...context, effort: "xhigh", ultracode: true })).ultracode, true);
  assert.equal((await catalog.turnSettings({ ...context, effort: "xhigh" })).ultracode, false);
  for (const input of [{ model: "unobserved", effort: "xhigh", ultracode: true }, { model: "default", effort: "high", ultracode: true }, { ultracode: "true" }]) await assert.rejects(catalog.validate("claude", input, context));
  await assert.rejects(catalog.validate("codex", { ultracode: true }), /Claude-only/);
  await assert.rejects(catalog.validate("codex", { ultracode: false }), /Claude-only/);
  await assert.rejects(catalog.turnSettings({ ...context, model: "unobserved", effort: "xhigh", ultracode: true }), /not verified/);
});

test("per-chat persistence defaults new/fork/import-style conversations to false", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const first = await store.create({ agent: "claude", title: "explicit", ultracode: true, effort: "xhigh" });
  const second = await store.create({ agent: "claude", title: "other", effort: first.effort });
  const codex = await store.create({ agent: "codex", title: "other provider", ultracode: true });
  assert.equal(first.ultracode, true); assert.equal(second.ultracode, false); assert.equal(codex.ultracode, false);
  const reloaded = new ChatStore(root); await reloaded.initialize();
  assert.equal(reloaded.get(first.id).ultracode, true); assert.equal(reloaded.get(second.id).ultracode, false);
});

test("late mode opt-in cannot overwrite newer settings", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const gate = Promise.withResolvers(); t.after(() => gate.resolve());
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    models: { validate: async () => { await gate.promise; return { model: "default", effort: "xhigh", ultracode: true }; } } });
  t.after(() => manager.shutdown());
  const chat = await store.create({ agent: "claude", title: "race", model: "default", effort: "high" });
  const pending = manager.setModel(chat.id, { ultracode: true }); pending.catch(() => {});
  await store.update(chat.id, { modelSettingsRevision: 1, ultracode: false }); gate.resolve();
  await assert.rejects(pending, /settings changed/); assert.equal(store.get(chat.id).ultracode, false);
});

test("queued persistence rechecks mode revision, account ownership and Stop lifecycle inside its updater", async t => {
  for (const mutation of ["revision", "account", "owner", "provider", "stop", "guard"]) {
    const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
    const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
      models: { validate: async () => ({ model: "default", effort: "xhigh", ultracode: true }) } });
    t.after(() => manager.shutdown());
    const chat = await store.create({ agent: "claude", title: "queued race", ownerId: "owner", agentAccountId: "first", model: "default", effort: "high" });
    const held = Promise.withResolvers(), entered = Promise.withResolvers(); t.after(() => held.resolve());
    const update = store.update.bind(store); let captured = false, admitted = true;
    store.update = async (id, patch) => {
      if (!captured && id === chat.id && typeof patch === "function") { captured = true; entered.resolve(); await held.promise; }
      return update(id, patch);
    };
    const pending = manager.setModel(chat.id, { ultracode: true }, () => { if (!admitted) throw Error("Admission changed"); }); pending.catch(() => {});
    await entered.promise;
    if (mutation === "revision") await update(chat.id, { modelSettingsRevision: 1 });
    if (mutation === "account") await update(chat.id, { agentAccountId: "other" });
    if (mutation === "owner") await update(chat.id, { ownerId: "other-owner" });
    if (mutation === "provider") await update(chat.id, { agent: "codex" });
    if (mutation === "stop") await manager.stop(chat.id);
    if (mutation === "guard") admitted = false;
    held.resolve(); await assert.rejects(pending, /settings changed|Admission changed/, mutation);
    assert.equal(store.get(chat.id).ultracode, false, mutation);
  }
});

test("optional ordinary discovery cannot turn an unsupported old CLI into a workflow opt-in", async () => {
  const calls = [], control = { request: async (...args) => { calls.push(args); return {}; } };
  await applyUltracode(control, false, () => {}, { allowUnsupported: true });
  assert.deepEqual(calls, [["get_settings", {}, { timeoutMs: 2000 }]]);
  await assert.rejects(applyUltracode(control, false), /did not confirm/);
  await assert.rejects(applyUltracode(control, true, () => {}, { allowUnsupported: true }), /did not confirm/);
});

test("new-chat preference saving strips Ultracode from picker and explicit overrides", async t => {
  const previous = globalThis.document;
  const values = { "#environment-select": "company-env", "#agent-select": "claude", "#new-agent-account": "personal" };
  globalThis.document = { querySelector: selector => ({ value: values[selector] }) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const writes = [], workspace = Object.assign(Object.create(WorkspaceSettings.prototype), {
    draftReady: true, selected: [{ fullName: "company/repo", branch: "main" }], state: { config: { features: { agentAccounts: true } } },
    modelPicker: { value: () => ({ model: "default", effort: "xhigh", ultracode: true }) },
    api: async (route, input) => { writes.push(JSON.parse(input.body)); }, toast: message => assert.fail(message), updateCreateAvailability() {},
  });
  await workspace.remember(); await workspace.remember({ ultracode: true });
  for (const saved of [...writes, workspace.preferences]) { assert.equal(saved.effort, "xhigh"); assert.equal(Object.hasOwn(saved, "ultracode"), false); }
});
