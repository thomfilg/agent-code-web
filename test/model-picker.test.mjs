import assert from "node:assert/strict";
import test from "node:test";
import { ModelPicker } from "../public/model-picker.js";

function dom(t) {
  const old = globalThis.document;
  const element = () => ({ value: "", textContent: "", options: [], disabled: false, title: "", addEventListener() {},
    replaceChildren(...items) { this.options = items; }, append(item) { this.options.push(item); },
  });
  globalThis.document = { createElement: () => element() };
  const model = element(), effort = element(), note = element();
  const root = { dataset: {}, classList: { contains: () => false }, querySelector: selector => ({ ".model-select": model, ".effort-select": effort, ".model-note": note })[selector] || null };
  ModelPicker.clearCatalogs();
  t.after(() => { ModelPicker.clearCatalogs(); if (old === undefined) delete globalThis.document; else globalThis.document = old; });
  return { root, model, effort, note };
}
const models = [
  { id: "default", label: "Default (recommended)", isDefault: true, efforts: ["auto", "high"] },
  { id: "fixture-native", label: "Native model", efforts: ["auto", "high"] },
  { id: "fixture-disabled", label: "New native model", disabled: true, disabledReason: "Update the CLI to use this model", efforts: ["auto", "high"] },
];
const catalog = { models, source: "claude-account", note: "Account-native models", configuredDefault: "default", configuredDefaultEffort: "auto", defaults: { model: "default", effort: "auto" } };

test("Claude native default is one row and preserves both saved default and native null semantics", async t => {
  const ui = dom(t), writes = [];
  const picker = new ModelPicker({ root: ui.root, api: async () => catalog, onChange: value => writes.push(value) });
  for (const model of ["default", null]) {
    await picker.setAgent("claude", { agentAccountId: "fixture", model });
    assert.deepEqual(ui.model.options.map(option => option.value), models.map(model => model.id));
    assert.equal(ui.model.options.filter(option => /default/i.test(option.textContent)).length, 1);
    assert.equal(picker.value().model, "default");
  }
  assert.deepEqual(writes, []);
  ui.model.value = "fixture-native"; picker.changed(); await picker.saving;
  assert.equal(writes[0].model, "fixture-native");
  ui.model.value = "default"; picker.changed(); await picker.saving;
  assert.equal(writes[1].model, "default");
});

test("disabled native rows display the provider reason and saved unavailable models never become enabled", async t => {
  const ui = dom(t), picker = new ModelPicker({ root: ui.root, api: async () => catalog, onChange: () => assert.fail("No automatic write") });
  await picker.setAgent("claude", { agentAccountId: "fixture", model: "fixture-disabled" });
  const disabled = ui.model.options.find(option => option.value === "fixture-disabled");
  assert.equal(disabled.disabled, true); assert.match(disabled.textContent, /Update the CLI/); assert.match(ui.note.textContent, /Update the CLI/);
  assert.equal(ui.effort.disabled, true); assert.equal(ui.model.value, "fixture-disabled");
  await picker.setAgent("claude", { agentAccountId: "fixture", model: "removed-model" });
  assert.equal(ui.model.options.find(option => option.value === "removed-model").disabled, true);
  assert.equal(ui.model.value, "removed-model");
});

test("a configured non-native default stays distinct without losing the explicit account-default option", async t => {
  const ui = dom(t), picker = new ModelPicker({ root: ui.root, api: async () => ({ ...catalog, configuredDefault: "fixture-native" }), onChange() {} });
  await picker.setAgent("claude", { agentAccountId: "fixture" });
  assert.equal(ui.model.options[0].value, ""); assert.equal(ui.model.options[0].textContent, "Configured default · Native model");
  assert.equal(ui.model.options.filter(option => option.value === "default").length, 1); assert.equal(picker.value().model, null);
});

test("Codex picker retains its inherited default sentinel and never uses a different account catalog", async t => {
  const ui = dom(t), requests = [], picker = new ModelPicker({ root: ui.root, api: async route => {
    requests.push(route); return { models: [{ id: "fixture-codex", label: "Codex fixture", efforts: [] }], configuredDefault: "fixture-codex" };
  }, onChange() {} });
  await picker.setAgent("codex", { agentAccountId: "first" });
  assert.deepEqual(ui.model.options.map(option => option.value), ["", "fixture-codex"]);
  await picker.setAgent("codex", { agentAccountId: "second" });
  assert.deepEqual(requests, ["/api/models?agent=codex&account=first", "/api/models?agent=codex&account=second"]);
});

test("all-disabled and empty catalogs do not advertise a runnable default", async t => {
  const ui = dom(t); let rows = [models[2]];
  const picker = new ModelPicker({ root: ui.root, api: async () => ({ ...catalog, models: rows, configuredDefault: null }), onChange() {} });
  await picker.setAgent("claude", { agentAccountId: "disabled-only" });
  assert.equal(ui.model.disabled, true); assert.equal(ui.effort.disabled, true);
  assert.ok(ui.model.options.every(option => option.disabled));
  rows = []; await picker.setAgent("claude", { agentAccountId: "empty" });
  assert.equal(ui.model.disabled, true); assert.match(ui.model.options[0].textContent, /No available/);
  assert.match(ui.note.textContent, /No enabled/);
});
