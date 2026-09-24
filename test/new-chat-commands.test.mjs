import test from "node:test";
import assert from "node:assert/strict";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { firstChatCommand, newChatCommands } from "../public/new-chat-commands.js";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("draft controls distinguish providers and never turn session-only commands into prompts", () => {
  assert.equal(firstChatCommand("/goal", "codex").name, "goal");
  assert.equal(firstChatCommand("/goal build the app", "codex").name, "goal");
  assert.equal(firstChatCommand("/name New title", "codex").name, "rename");
  assert.equal(firstChatCommand("/plan inspect first", "claude").name, "plan");
  assert.equal(firstChatCommand("ordinary message", "codex"), null);
  assert.throws(() => firstChatCommand("/tmp/project is the folder", "codex"), /Invalid slash command/);
  for (const command of ["/", "/goal pause", "/goal resume", "/goal clear", "/compact", "/copy", "/approve", "/unknown-native", "/help arguments"]) assert.throws(() => firstChatCommand(command, "codex"));
  assert.throws(() => firstChatCommand("/goal build", "claude"), /Unknown command \/goal/);
  assert.equal(newChatCommands("codex").commands.find(c => c.name === "compact").disabled, true);
  const native = newChatCommands("claude", [{ name: "fixture-native" }]).commands.find(c => c.name === "fixture-native");
  assert.equal(native.disabled, false);
  assert.equal(firstChatCommand("/fixture-native exact args", "claude", [native]), native);
  assert.equal(newChatCommands(null).commands.length, 0);
});

test("draft discovery uses only selected-account cached metadata and never host/worker/model discovery", async () => {
  const calls = [], catalog = new CommandCatalog({ workerBackend: "local", google: { enabled: true } }, {
    selected: () => assert.fail("Model discovery forbidden"), accounts: {
      select: async (owner, id, context) => { calls.push([owner, id, context.agent]); if (owner !== "alice" || id !== "codex-a" || context.agent !== "codex") throw Error("Account unavailable"); },
      cachedCommands: async (owner, id, context) => { calls.push([owner, id, context.agent]); if (owner !== "alice" || id !== "claude-a" || context.agent !== "claude") throw Error("Account unavailable"); return { commands: [{ name: "account-plugin", description: "Verified metadata" }] }; },
    },
  });
  for (const name of ["discover", "codex", "claude"]) catalog[name] = () => assert.fail("Native discovery forbidden");
  const codex = await catalog.newChat({ agent: "codex", ownerId: "alice", agentAccountId: "codex-a" });
  assert(codex.commands.some(c => c.name === "goal" && !c.disabled));
  const claude = await catalog.newChat({ agent: "claude", ownerId: "alice", agentAccountId: "claude-a" });
  assert.equal(claude.commands.find(c => c.name === "account-plugin").disabled, false);
  assert(!claude.commands.some(c => c.name === "goal"));
  await assert.rejects(catalog.newChat({ agent: "claude", ownerId: "bob", agentAccountId: "claude-a" }), /unavailable/);
  await assert.rejects(catalog.newChat({ agent: "codex", ownerId: "alice" }), /Choose an agent account/);
  assert.deepEqual(calls, [["alice", "codex-a", "codex"], ["alice", "claude-a", "claude"], ["bob", "claude-a", "claude"]]);
});

test("new-chat command HTTP discovery creates no chat or worker and rejects unknown accounts", async t => {
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root), adapterFactory: () => assert.fail("Adapter startup forbidden") });
  const { url } = await app.start(); t.after(() => app.stop());
  app.manager.workerBackend.acquire = () => assert.fail("Worker startup forbidden");
  const before = app.store.list().length;
  const response = await fetch(`${url}/api/new-chat/commands?agent=codex`);
  assert.equal(response.status, 200); const result = await response.json();
  assert(result.commands.some(c => c.name === "goal"));
  const denied = await fetch(`${url}/api/new-chat/commands?agent=claude&agentAccountId=foreign-account`);
  assert(denied.status >= 400); assert.equal(app.store.list().length, before);
});
