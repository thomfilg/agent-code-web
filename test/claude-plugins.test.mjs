import test from "node:test";
import assert from "node:assert/strict";
import { claudePluginReloadRequest, reloadClaudePlugins } from "../src/claude-plugins.mjs";

const inventory = () => ({ commands: [{ name: "fixture:stamp", description: "Write a fixture", aliases: ["fixture:write"], path: "/private/plugin" }],
  plugins: [{ name: "fixture", path: "/private/plugin", source: "https://user:credential@example.test/plugin" }], agents: [{ name: "fixture-agent" }],
  mcpServers: [{ name: "plugin:fixture:mcp", status: "connected", config: { token: "private-token" } }], error_count: 0 });

test("plugin reload recognizes only its exact slash command and supported force spelling", () => {
  for (const command of ["/reload-plugins", "/reload-plugins force", " /reload-plugins --force\n"]) assert.equal(claudePluginReloadRequest(command), true);
  for (const command of ["/fixture:reload-plugins", "/reload-skills", "Please /reload-plugins", "/reload-plugins-extra"]) assert.equal(claudePluginReloadRequest(command), false);
  for (const command of ["/reload-plugins unknown", "/reload-plugins --force extra"]) assert.throws(() => claudePluginReloadRequest(command), /Use \/reload-plugins/);
});

test("native plugin reload exposes verified component counts/catalog but never private paths, credentials or MCP config", async () => {
  const calls = [], data = inventory();
  const result = await reloadClaudePlugins({ request: async (...args) => { calls.push(args); return data; } });
  assert.deepEqual(calls, [["reload_plugins"]]);
  assert.deepEqual(result.commands, [{ name: "fixture:stamp", description: "Write a fixture", aliases: ["fixture:write"] }]);
  assert.deepEqual(result.connectors, [{ name: "plugin:fixture:mcp", status: "connected" }]);
  assert.match(result.text, /1 plugin\(s\), 1 command\(s\), 1 agent\(s\) and 1 MCP server\(s\)/);
  assert.doesNotMatch(JSON.stringify(result), /private|credential|token|example\.test/);
  data.error_count = 2; assert.equal((await reloadClaudePlugins({ request: async () => data })).errorCount, 2);
});

test("malformed native plugin reloads and raw control failures cannot masquerade as successful refreshes", async () => {
  for (const mutate of [data => delete data.commands, data => data.commands.push(data.commands[0]), data => data.commands[0].aliases = ["bad/name"],
    data => data.commands[0].description = null, data => data.plugins = {}, data => data.agents = Array(1001).fill({ name: "too-many" }),
    data => data.mcpServers[0].status = "invented", data => data.error_count = -1, data => data.error_count = "0"]) {
    const data = inventory(); mutate(data); await assert.rejects(reloadClaudePlugins({ request: async () => data }), /verify native plugin reload|duplicate commands/);
  }
  await assert.rejects(reloadClaudePlugins({ request: async () => { throw Error("https://user:secret@example.test/private failed"); } }), error => /Native plugin reload failed/.test(error.message) && !/secret|example/.test(error.message));
  await assert.rejects(reloadClaudePlugins({ request: async () => { throw Error("Blocked by managed policy"); } }), /blocked by managed policy/);
});
