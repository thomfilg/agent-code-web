import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function fixture(t) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }), commands = new CommandCatalog({ workerBackend: "ec2" });
  const f = { names: ["fixture-old"], discoveries: 0, inputs: [], events: [], hooks: new Map() };
  commands.discover = async () => { f.discoveries++; return { commands: f.names.map(name => ({ name, ...(f.description ? { description: f.description } : {}) })) }; };
  const manager = new RuntimeManager({ store, config, commands, broker: new CapabilityBroker({ ttlMs: 120000 }), adapterFactory: ({ chat, hooks }) => {
    f.hooks.set(chat.id, hooks);
    return { start: async () => {}, send: async text => { f.inputs.push({ chatId: chat.id, text }); await f.gate?.promise; if (f.error) throw Error(f.error); return { text: "Native fixture result" }; }, stop: async () => f.gate?.resolve() };
  } });
  manager.on("event", event => f.events.push(event)); t.after(() => manager.shutdown());
  f.chat = await manager.createChat({ agent: "claude", title: "Claude command refresh" });
  return Object.assign(f, { root, store, commands, manager });
}

test("successful native skill reload refreshes only that chat's catalog, including descriptions with unchanged names", async t => {
  const f = await fixture(t), other = await f.manager.createChat({ agent: "claude", title: "Other command scope" });
  const original = await f.commands.list(f.chat), foreign = await f.commands.list(other);
  f.names = ["fixture-new"];
  await f.manager.send(f.chat.id, "/reload-skills");
  const current = f.store.get(f.chat.id);
  assert.equal(f.inputs[0].text, "/reload-skills");
  assert.notDeepEqual(await f.commands.list(current), original);
  assert.equal(await f.commands.list(other), foreign, "A native reload must not refresh another chat's cached commands");
  assert(current.commandCatalogRevision > 0);
  assert(f.events.some(event => event.type === "chat_updated" && event.chat.commandCatalogRevision === current.commandCatalogRevision));
  const revision = current.commandCatalogRevision;
  f.description = "Edited command description";
  await f.manager.send(f.chat.id, "/reload-skills");
  assert(f.store.get(f.chat.id).commandCatalogRevision > revision, "Same command names may have edited descriptions or arguments");
  assert.equal((await f.commands.list(f.store.get(f.chat.id))).commands[0].description, f.description);
});

test("reported native commands invalidate cached discovery only when the catalog changes and persist the new version", async t => {
  const f = await fixture(t); await f.manager.send(f.chat.id, "Start the fixture");
  const hooks = f.hooks.get(f.chat.id); await f.commands.list(f.chat); f.names = ["fixture-plugin:new"];
  const event = { type: "session_capabilities", connectors: [], slashCommands: ["fixture-plugin:new"] };
  await hooks.onEvent(event);
  assert.deepEqual((await f.commands.list(f.store.get(f.chat.id))).commands, [{ name: "fixture-plugin:new" }]);
  const revision = f.store.get(f.chat.id).commandCatalogRevision; assert(revision > 0);
  await hooks.onEvent(event); assert.equal(f.store.get(f.chat.id).commandCatalogRevision, revision);
  const restored = new ChatStore(f.root); await restored.initialize();
  assert.equal(restored.get(f.chat.id).commandCatalogRevision, revision);
  await hooks.onEvent({ type: "command_catalog", commands: [{ name: "fixture-plugin:new", aliases: ["fresh"], description: "Changed native metadata" }] });
  assert(f.store.get(f.chat.id).commandCatalogRevision > revision);
});

test("failed and interrupted reloads cannot publish a successful catalog refresh", async t => {
  const f = await fixture(t); f.error = "Native reload failed";
  await f.manager.send(f.chat.id, "/reload-skills");
  assert.equal(f.store.get(f.chat.id).commandCatalogRevision || 0, 0);
  assert(f.store.get(f.chat.id).messages.some(message => message.kind === "error" && message.text === f.error));
  f.error = null; f.gate = Promise.withResolvers();
  const running = f.manager.send(f.chat.id, "/reload-skills"); await waitFor(() => f.inputs.length === 2);
  await f.manager.stop(f.chat.id); await running;
  assert.equal(f.store.get(f.chat.id).commandCatalogRevision || 0, 0);
});

test("busy native aliases retain their exact prefix and refresh only when the queued reload runs", async t => {
  const f = await fixture(t); f.gate = Promise.withResolvers();
  const running = f.manager.send(f.chat.id, "Current task"); await waitFor(() => f.inputs.length === 1);
  await f.manager.enqueue(f.chat.id, "/fixture-plugin:review Keep this argument\nand this line");
  await f.manager.enqueue(f.chat.id, "/reload-skills");
  assert.equal(f.store.get(f.chat.id).commandCatalogRevision || 0, 0);
  f.gate.resolve(); await running; await waitFor(() => !f.manager.isBusy(f.chat.id) && !f.store.get(f.chat.id).queuedMessages.length);
  assert.deepEqual(f.inputs.map(input => input.text), ["Current task", "/fixture-plugin:review Keep this argument\nand this line", "/reload-skills"]);
  assert.equal(f.store.get(f.chat.id).commandCatalogRevision, 1);
});
