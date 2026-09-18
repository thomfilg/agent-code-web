import assert from "node:assert/strict";
import test from "node:test";
import { ModelPicker, claudeCatalogMatchesChat } from "../public/model-picker.js";
import { SlashComposer } from "../public/slash-composer.js";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { waitFor } from "./helpers.mjs";

// Real picker, slash-composer and server catalog; only DOM/API/account discovery
// are disposable doubles. No provider, model input, worker or browser is started.
function fixture(t) {
  const previous = globalThis.document, nodes = new Map();
  const element = () => ({ value: "", textContent: "", hidden: false, children: [], options: [], disabled: false, title: "", selectedIndex: 0,
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, scrollIntoView() {},
    replaceChildren(...items) { this.children = items; this.options = items; }, append(...items) { this.children.push(...items); this.options = this.children; },
  });
  globalThis.document = { createElement: element, querySelectorAll: () => [], querySelector: selector => {
    if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector);
  } };
  ModelPicker.clearCatalogs();
  t.after(() => { ModelPicker.clearCatalogs(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const input = document.querySelector("#message-input"); input.value = "/goal"; input.selectionStart = input.value.length; document.activeElement = input;
  const state = { active: { id: "chat-a", ownerId: "owner-a", agent: "claude", agentAccountId: "account-a", model: "default", effort: "auto" } };
  let metadata = { commands: [], revision: "1:0" }, modelRequests = 0, commandRequests = 0, writes = 0;
  const gate = Promise.withResolvers(), notices = [], refreshes = [];
  const server = new CommandCatalog({ workerBackend: "ec2" }, { accounts: { cachedCommands: async () => structuredClone(metadata) } });
  const api = async route => {
    if (route.startsWith("/api/models?")) {
      modelRequests++; await gate.promise;
      metadata = { commands: [{ name: "goal", description: "Native reported command" }], revision: "1:1" };
      return { models: [{ id: "default", label: "Native default", efforts: ["auto", "high"] }], source: "claude-account", configuredDefault: "default" };
    }
    assert.equal(route, `/api/chats/${state.active.id}/commands`);
    commandRequests++; return server.list(state.active);
  };
  const composer = new SlashComposer({ api, state });
  const model = element(), effort = element(), note = element();
  const root = { dataset: {}, classList: { contains: () => false }, querySelector: selector => ({ ".model-select": model, ".effort-select": effort, ".model-note": note })[selector] || null };
  const picker = new ModelPicker({ root, api, onChange: () => { writes++; }, onCatalogReady: context => {
    notices.push(context);
    if (claudeCatalogMatchesChat(context, state.active)) { refreshes.push(context.chatId); composer.refresh(context.chatId); }
  } });
  return { state, picker, composer, server, gate, notices, refreshes, input, counts: () => ({ modelRequests, commandRequests, writes }) };
}

test("a cold account catalog refreshes the already-open native command menu without another model probe", async t => {
  const f = fixture(t), loading = f.picker.setAgent("claude", f.state.active);
  await f.composer.update(); assert.equal(f.composer.matches.length, 0);
  assert.deepEqual(f.counts(), { modelRequests: 1, commandRequests: 1, writes: 0 });
  const commandRevision = f.state.active.commandCatalogRevision;
  f.gate.resolve(); await loading;
  await waitFor(() => f.composer.matches.some(command => command.name === "goal"));
  assert.equal(f.state.active.commandCatalogRevision, commandRevision, "No worker event or revision bump is needed");
  assert.deepEqual(f.refreshes, ["chat-a"]);
  assert.deepEqual(f.counts(), { modelRequests: 1, commandRequests: 2, writes: 0 });
  assert.equal(f.input.value, "/goal", "Discovery does not compose or submit a prompt");
  assert.equal(f.composer.menu.hidden, false);
});

for (const [field, value] of [["id", "chat-b"], ["ownerId", "owner-b"], ["agent", "codex"], ["agentAccountId", "account-b"], ["model", "other-model"]]) {
  test(`late model metadata cannot invalidate a different active ${field}`, async t => {
    const f = fixture(t), loading = f.picker.setAgent("claude", f.state.active);
    await f.composer.update(); const oldKey = f.composer.key();
    f.state.active = { ...f.state.active, [field]: value };
    f.gate.resolve(); await loading;
    assert.equal(f.notices.length, 1); assert.deepEqual(f.refreshes, []);
    assert.equal(f.composer.cache.has(oldKey), true, "Do not invalidate another chat's cached menu");
    assert.equal(f.counts().commandRequests, 1);
  });
}

test("switching chats during a shared account/model request binds the completion only to the new chat", async t => {
  const f = fixture(t), first = f.picker.setAgent("claude", f.state.active);
  await f.composer.update(); const oldKey = f.composer.key();
  f.state.active = { ...f.state.active, id: "chat-b" };
  const second = f.picker.setAgent("claude", f.state.active);
  await f.composer.update();
  f.gate.resolve(); await Promise.all([first, second]);
  await waitFor(() => f.composer.matches.some(command => command.name === "goal"));
  assert.deepEqual(f.notices.map(context => context.chatId), ["chat-b"]);
  assert.deepEqual(f.refreshes, ["chat-b"]);
  assert.equal(f.composer.cache.has(oldKey), true);
  assert.deepEqual(f.counts(), { modelRequests: 1, commandRequests: 3, writes: 0 });
});

test("catalog completion respects a dismissed command menu", async t => {
  const f = fixture(t), loading = f.picker.setAgent("claude", f.state.active);
  await f.composer.update(); f.composer.close();
  f.gate.resolve(); await loading;
  assert.equal(f.composer.menu.hidden, true); assert.equal(f.counts().commandRequests, 1);
  await f.composer.update(); assert(f.composer.matches.some(command => command.name === "goal"));
  assert.equal(f.counts().modelRequests, 1);
});

test("Codex and shared-host catalogs never trigger the named Claude command refresh", () => {
  for (const [agent, agentAccountId] of [["codex", "account"], ["claude", null], ["mock", null]]) {
    const chat = { id: "chat", ownerId: "owner", agent, agentAccountId, model: "default" };
    assert.equal(claudeCatalogMatchesChat({ ...chat, chatId: chat.id }, chat), false);
  }
});
