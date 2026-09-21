import { randomUUID } from "node:crypto";

export function claudeMcpRequest(text) {
  const match = /^\/mcp(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const action = /^(reconnect|enable|disable)(?:\s+([\s\S]*))?$/i.exec((match[1] || "").trim());
  return action ? { action: action[1].toLowerCase(), server: (action[2] || "all").trim() } : {};
}

export const CLAUDE_MCP_PRIVATE_ERROR = "Native MCP controls require a private Claude profile. This worker uses a shared host profile; shared MCP changes remain locked until company/profile isolation is complete.";

// Claude's print-mode slash handler has no terminal callbacks in 2.1.222.
// Use its real SDK controls instead; never edit native MCP preferences ourselves.
export class ClaudeControlChannel {
  constructor(child, timeoutMs = 30000) {
    this.child = child; this.timeoutMs = timeoutMs; this.pending = new Map(); this.closed = false;
    this.onClose = () => this.close();
    child.once("close", this.onClose); child.once("error", this.onClose);
    child.stdin.on("error", this.onClose);
  }
  request(subtype, fields = {}, { onSuccess, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed || !this.child.stdin.writable) return Promise.reject(Error("Claude MCP control channel stopped"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Claude ${subtype} control timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, onSuccess, subtype });
      this.child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype, ...fields } })}\n`, error => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer); this.pending.delete(id); reject(Error("Claude MCP control channel stopped"));
      });
    });
  }
  cancel(subtype, message = `Claude ${subtype} control was interrupted`) {
    for (const [id, entry] of this.pending) {
      if (entry.subtype !== subtype) continue;
      clearTimeout(entry.timer); this.pending.delete(id); entry.reject(Error(message));
    }
  }
  accept(event) {
    if (event.type !== "control_response") return;
    const id = event.request_id || event.response?.request_id, pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(id);
    // Native connection errors can contain endpoint URLs or credentials. Expose
    // only known categories, followed by separately validated status metadata.
    if (event.response?.subtype === "error") pending.reject(Error(/managed policy/i.test(event.response.error || "") ? "Blocked by managed policy" : "Native MCP control failed"));
    else if (event.response?.subtype === "success") {
      const result = event.response.response || {};
      // Run before the next stdout frame, not in a promise continuation. A
      // permission status after this acknowledgement supersedes the selection.
      try { pending.onSuccess?.(result); pending.resolve(result); }
      catch (error) { pending.reject(error); }
    }
    else pending.reject(Error("Invalid Claude MCP control response"));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(Error("Claude MCP control channel stopped")); }
    this.pending.clear();
    this.child.removeListener("close", this.onClose); this.child.removeListener("error", this.onClose);
    // Keep the stdin error handler until the stream closes; late EPIPE must not
    // crash the controller during Stop.
  }
}

const statuses = new Set(["connected", "cached", "pending", "disabled", "failed", "needs-auth", "needs-approval"]);
export async function runClaudeMcpCommand(channel, command, { settleMs = 10000, initialize = true } = {}) {
  if (!["reconnect", "enable", "disable"].includes(command?.action) || typeof command.server !== "string") throw Error("Invalid native MCP action");
  const status = async () => {
    const result = await channel.request("mcp_status");
    if (!Array.isArray(result.mcpServers) || result.mcpServers.length > 1000) throw Error("Invalid native MCP server inventory");
    const names = new Set();
    return result.mcpServers.map(server => {
      if (!server || typeof server.name !== "string" || !server.name || server.name.length > 256 || /[\x00-\x1f\x7f]/.test(server.name) || !statuses.has(server.status) || names.has(server.name)) throw Error("Invalid native MCP server status");
      names.add(server.name);
      return { name: server.name, status: server.status };
    });
  };
  if (initialize) await channel.request("initialize");
  let servers = await status();
  const deadline = Date.now() + settleMs;
  while (servers.some(server => server.status === "pending" && server.name !== "ide" && (command.server === "all" || server.name === command.server)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    servers = await status();
  }
  const all = command.server === "all", selected = servers.filter(server => server.name !== "ide" && (all || server.name === command.server));
  if (!selected.length) return { text: all ? "No MCP servers are configured. Open MCP connections to add one to this chat's environment." : `There's no MCP server named ${JSON.stringify(command.server)}. Use /mcp verbose to inspect this chat's servers.`, connectors: servers };
  const outcomes = await Promise.all(selected.map(async server => {
    const name = JSON.stringify(server.name);
    if (server.status === "needs-approval" || server.status === "pending") return { name: server.name, error: `${name} is ${server.status}. Review MCP connections before retrying.` };
    if (command.action === "reconnect" && server.status === "disabled") return { name: server.name, text: `${name} is disabled. Use /mcp enable ${server.name} to bring it back.` };
    if (command.action === "reconnect" && all && ["connected", "cached"].includes(server.status)) return { name: server.name, text: `${name} is already connected or cached.` };
    if (command.action === "disable" && server.status === "disabled" || command.action === "enable" && server.status !== "disabled") return { name: server.name, text: `${name} is already ${command.action === "enable" ? "enabled" : "disabled"}${server.status === "failed" || server.status === "needs-auth" ? " but not connected; use /mcp reconnect to retry" : ""}.` };
    try {
      if (command.action === "reconnect") {
        // 2.1.222's reconnect control copies tools into a second cache that
        // native disable does not clear in a retained session. Reconnect via
        // the native toggle pair instead, so later disable actually removes
        // the tools from the next query. Never retry either write implicitly.
        await channel.request("mcp_toggle", { serverName: server.name, enabled: false });
        await channel.request("mcp_toggle", { serverName: server.name, enabled: true });
      } else await channel.request("mcp_toggle", { serverName: server.name, enabled: command.action === "enable" });
      return { name: server.name, changed: true };
    } catch (error) { return { name: server.name, error: `${name}: ${error.message}. Review MCP connections and retry.` }; }
  }));
  servers = await status();
  const verb = { enable: "Enabled", disable: "Disabled", reconnect: "Reconnected" }[command.action];
  for (const result of outcomes) {
    if (!result.changed) continue;
    const expected = command.action === "disable" ? "disabled" : "connected";
    const current = servers.find(server => server.name === result.name)?.status;
    if (current !== expected) result.error = `Could not verify ${command.action} for ${JSON.stringify(result.name)} (${current || "missing"}). Review MCP connections and retry.`;
    else result.text = `${verb} ${JSON.stringify(result.name)}.`;
  }
  const changed = outcomes.filter(result => result.changed && !result.error).length;
  const text = all && changed === outcomes.length ? `${verb} ${changed} MCP server(s).` : outcomes.map(result => result.error || result.text).join("\n");
  return { text, connectors: servers, failed: outcomes.some(result => result.error) };
}
