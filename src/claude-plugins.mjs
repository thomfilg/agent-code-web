export const CLAUDE_PLUGIN_PRIVATE_ERROR = "Plugin reload requires a private Claude profile; shared host profiles remain locked until company/profile isolation is complete.";

export function claudePluginReloadRequest(text) {
  const match = /^\/reload-plugins(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return false;
  if (match[1] && !["force", "--force"].includes(match[1].trim())) throw Error("Use /reload-plugins or /reload-plugins --force");
  return true;
}

// Print-mode's terminal slash callback is absent in Claude 2.1.222. Its SDK
// reload_plugins control reloads the actual owning session instead. Do not
// return native paths, configuration, raw errors or fabricated plugin state.
export async function reloadClaudePlugins(channel) {
  let data;
  try { data = await channel.request("reload_plugins"); }
  catch (error) { throw Error(`Native plugin reload failed${error.message === "Blocked by managed policy" ? " (blocked by managed policy)" : ""}. Review the private plugin configuration and retry /reload-plugins.`); }
  const list = (value, limit) => Array.isArray(value) && value.length <= limit;
  const name = value => typeof value === "string" && value.length > 0 && value.length <= 160 && /^[\w:.-]+$/.test(value);
  const statuses = new Set(["connected", "cached", "pending", "disabled", "failed", "needs-auth", "needs-approval"]);
  if (!data || !list(data.commands, 5000) || !list(data.plugins, 500) || !list(data.agents, 1000) || !list(data.mcpServers, 1000)
    || !Number.isSafeInteger(data.error_count) || data.error_count < 0 || data.error_count > 10000
    || !data.commands.every(command => command && name(command.name) && typeof command.description === "string"
      && (command.aliases === undefined || list(command.aliases, 100) && command.aliases.every(name)))
    || !data.plugins.every(plugin => plugin && typeof plugin.name === "string")
    || !data.agents.every(agent => agent && typeof agent.name === "string")
    || !data.mcpServers.every(server => server && typeof server.name === "string" && server.name.length <= 256 && !/[\x00-\x1f\x7f]/.test(server.name) && statuses.has(server.status))) {
    throw Error("Could not verify native plugin reload. Review the private plugin configuration and retry /reload-plugins.");
  }
  const commands = data.commands.map(command => ({ name: command.name, description: command.description.slice(0, 600), aliases: command.aliases || [] }));
  if (new Set(commands.map(command => command.name)).size !== commands.length) throw Error("Native plugin reload returned duplicate commands; retry after checking the plugin configuration.");
  const connectors = data.mcpServers.map(server => ({ name: server.name, status: server.status }));
  const text = `Reloaded ${data.plugins.length} plugin(s), ${commands.length} command(s), ${data.agents.length} agent(s) and ${connectors.length} MCP server(s).`;
  return { commands, connectors, text, errorCount: data.error_count };
}
