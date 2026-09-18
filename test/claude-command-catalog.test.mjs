import assert from "node:assert/strict";
import test from "node:test";
import { AgentAccounts } from "../src/agent-accounts.mjs";
import { CommandCatalog, claudeCommandMetadata } from "../src/command-catalog.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { claudeAccountFixture, claudeAuthFixture } from "./fixtures/claude-account.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const alice = `user_${"a".repeat(32)}`, bob = `user_${"b".repeat(32)}`;
const accountId = "account_00000000-0000-4000-8000-000000000001";
const nativeCommands = [{ name: "goal", description: "Set a native goal", argumentHint: "condition | clear", aliases: ["target"], privatePath: "/private/fixture", auth: "never-publish" }];
const chat = { id: "fixture", agent: "claude", ownerId: alice, agentAccountId: accountId, repositories: [{ fullName: "acme/relay" }] };
async function fixture(t) {
  const records = new MemoryRecords(), cli = claudeAccountFixture();
  await records.put("agent-account", accountId, { id: accountId, ownerId: alice, provider: "claude", name: "Fixture", companies: ["acme"], allowUnassigned: false,
    revision: 1, status: "connected", accountIdentity: "fixture-claude-company", subject: "fixture-claude-user", auth: claudeAuthFixture() });
  const accounts = new AgentAccounts({ records, clientFactory: () => {
    const client = cli.factory(); client.initialized = { commands: structuredClone(nativeCommands), privateAccount: "never-publish" }; return client;
  } });
  await accounts.initialize(); t.after(() => accounts.close());
  const catalog = new CommandCatalog({ workerBackend: "ec2" }, { accounts });
  catalog.claude = () => { throw Error("Must not start a command-discovery CLI"); };
  return { records, accounts, cli, catalog };
}

test("selected-account commands reuse verified model initialization without starting another CLI or worker", async t => {
  const { accounts, cli, catalog } = await fixture(t);
  assert.equal((await catalog.list(chat)).commands.some(item => item.name === "goal"), false, "No fabricated native /goal before any report");
  assert.equal(cli.clients.length, 0);
  await accounts.models(alice, accountId, "claude");
  const result = await catalog.list(chat);
  assert.equal(result.commands.find(item => item.name === "goal").web, false);
  assert.equal(result.commands.find(item => item.name === "target").aliasFor, "goal");
  assert.match(result.note, /selected account/);
  assert.doesNotMatch(JSON.stringify(result), /privatePath|never-publish|\/private\/fixture/);
  await catalog.list(chat); assert.equal(cli.clients.length, 1); assert.equal(cli.clients[0].closed, true);
  const copy = await accounts.cachedCommands(alice, accountId, chat); copy.commands[0].name = "mutated";
  assert.equal((await accounts.cachedCommands(alice, accountId, chat)).commands[0].name, "goal");
});

test("every cached catalog read revalidates owner, selected provider, company and revocation", async t => {
  const { accounts, catalog, records } = await fixture(t);
  await accounts.models(alice, accountId); await catalog.list(chat);
  await assert.rejects(catalog.list({ ...chat, ownerId: bob }), { statusCode: 404 });
  await assert.rejects(catalog.list({ ...chat, repositories: [{ fullName: "other/repo" }] }), { statusCode: 403 });
  await assert.rejects(accounts.cachedCommands(alice, accountId, { ...chat, agent: "codex" }), /selected agent/);
  const record = await records.get("agent-account", accountId);
  await records.put("agent-account", accountId, { ...record, revision: 2 });
  assert.equal((await catalog.list(chat)).commands.some(item => item.name === "goal"), false, "Old revision metadata is not returned from the outer cache");
  await accounts.models(alice, accountId); await catalog.list(chat);
  await accounts.disconnect(alice, accountId);
  await assert.rejects(catalog.list(chat), { statusCode: 409 });
  assert.equal(accounts.commandCatalogs.size, 0);
});

test("late model verification metadata cannot attach to a changed revision during persistence", async t => {
  const { accounts, records } = await fixture(t), put = records.put.bind(records);
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  records.put = async (...args) => { await put(...args); entered.resolve(); await gate.promise; };
  const loading = accounts.models(alice, accountId);
  await entered.promise;
  const current = await records.get("agent-account", accountId);
  await put("agent-account", accountId, { ...current, revision: current.revision + 1 });
  gate.resolve(); await loading;
  assert.equal(accounts.commandCatalogs.size, 0);
  assert.deepEqual((await accounts.cachedCommands(alice, accountId, chat)).commands, []);
});

test("removal invalidates cached commands synchronously and prevents publication from in-flight discovery", async t => {
  const { accounts, records, cli } = await fixture(t);
  await accounts.models(alice, accountId);
  const factory = accounts.clientFactory, gate = Promise.withResolvers(), entered = Promise.withResolvers();
  accounts.clientFactory = () => {
    const client = factory(), models = client.models.bind(client);
    client.models = async () => { entered.resolve(); await gate.promise; return models(); }; return client;
  };
  const loading = accounts.models(alice, accountId); loading.catch(() => {});
  await entered.promise; const removal = accounts.remove(alice, accountId);
  await assert.rejects(accounts.cachedCommands(alice, accountId, chat), { statusCode: 404 });
  assert.equal(accounts.commandCatalogs.size, 0);
  gate.resolve(); await assert.rejects(loading, { statusCode: 404 }); await removal;
  assert.equal(await records.get("agent-account", accountId), null);
  assert.equal(cli.clients.at(-1).closed, true); assert.equal(accounts.commandCatalogs.size, 0);
});

test("unverified identity and malformed initialization cannot supply a native command catalog", async t => {
  const { accounts, catalog } = await fixture(t), factory = accounts.clientFactory;
  accounts.clientFactory = () => { const client = factory(); client.organization = "different-identity"; return client; };
  await assert.rejects(accounts.models(alice, accountId), { statusCode: 409 });
  assert.equal(accounts.commandCatalogs.size, 0);
  await assert.rejects(catalog.list(chat), { statusCode: 409 });
  assert.equal(claudeCommandMetadata({ commands: nativeCommands }), null);
  assert.equal(claudeCommandMetadata(Array(5001).fill({ name: "goal" })), null);
  assert.deepEqual(claudeCommandMetadata([null, { name: "goal\n" }, { name: "__internal" }, { name: "x/y" }]), []);
  assert.deepEqual(claudeCommandMetadata([{ name: "goal", description: "x".repeat(700), aliases: ["valid", "bad\n"], path: "/private" }]),
    [{ name: "goal", description: "x".repeat(600), aliases: ["valid"], kind: "CLI command" }]);
});

test("empty legacy commandCatalog does not hide worker slash commands or invent Claude /goal", async () => {
  const catalog = new CommandCatalog({ workerBackend: "ec2" });
  assert.equal((await catalog.list({ id: "reported", agent: "claude", commandCatalog: [], slashCommands: ["goal"] })).commands.find(item => item.name === "goal").web, false);
  assert.equal((await catalog.list({ id: "unknown", agent: "claude", commandCatalog: [], slashCommands: [] })).commands.some(item => item.name === "goal"), false);
});

test("an authoritative empty worker inventory does not restore an account startup command", async t => {
  const { accounts, catalog } = await fixture(t); await accounts.models(alice, accountId);
  const result = await catalog.list({ ...chat, commandCatalog: [], slashCommands: [], commandCatalogRevision: 2 });
  assert.equal(result.commands.some(item => item.name === "goal"), false);
});

test("RuntimeManager replaces both native inventories atomically, including an empty plugin reload", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root), commands = new CommandCatalog({ workerBackend: "ec2" }); let hooks;
  const manager = new RuntimeManager({ store, config, commands, broker: new CapabilityBroker({ ttlMs: 10000 }),
    adapterFactory: options => { hooks = options.hooks; return { start: async () => {}, send: async () => ({ text: "Fixture only" }), stop: async () => {} }; } });
  try {
    const saved = await manager.createChat({ agent: "claude", title: "Command fixture" });
    await manager.send(saved.id, "Synthetic adapter only");
    await hooks.onEvent({ type: "command_catalog", commands: [{ name: "goal" }, { name: "plugin:hello" }] });
    assert.deepEqual(store.get(saved.id).slashCommands, ["goal", "plugin:hello"]);
    assert((await commands.list(store.get(saved.id))).commands.some(command => command.name === "plugin:hello"));
    await hooks.onEvent({ type: "command_catalog", commands: [] });
    assert.deepEqual(store.get(saved.id).slashCommands, []);
    assert.deepEqual(store.get(saved.id).commandCatalog, []);
    assert(!(await commands.list(store.get(saved.id))).commands.some(command => ["goal", "plugin:hello"].includes(command.name)));
  } finally { await manager.shutdown(); }
});
