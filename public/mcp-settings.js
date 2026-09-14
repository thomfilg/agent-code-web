const $ = s => document.querySelector(s);
export class McpSettings {
  constructor({ api, toast }) {
    Object.assign(this, { api, toast });
    $("#mcps-button").onclick = () => this.open(); $("#mcp-close").onclick = () => $("#mcp-dialog").close();
    $("#mcp-new").onclick = () => this.edit(); $("#mcp-type").onchange = () => this.transport();
    $("#mcp-form").onsubmit = event => this.save(event);
    $("#mcp-delete").onclick = async () => {
      if (!this.current || !confirm(`Delete MCP connection “${this.current.name}”?`)) return;
      try { await this.api(`/api/mcps/${this.current.id}`, { method: "DELETE" }); await this.load(); this.edit(); } catch (error) { $("#mcp-error").textContent = error.message; }
    };
    $("#mcp-dialog").addEventListener("close", () => { $("#mcp-headers").value = ""; this.current = null; });
  }
  async load() {
    this.connections = (await this.api("/api/mcps")).connections;
    $("#mcp-list").replaceChildren(...this.connections.map(connection => {
      const b = document.createElement("button"); b.textContent = `${connection.name} · ${connection.type}`; b.className = "secondary-button"; b.type = "button"; b.onclick = () => this.edit(connection); return b;
    }));
  }
  async open() { try { await this.load(); this.edit(this.connections[0]); $("#mcp-dialog").showModal(); } catch (error) { this.toast(error.message); } }
  edit(connection = null) {
    this.current = connection; $("#mcp-error").textContent = ""; $("#mcp-save-status").textContent = "";
    $("#mcp-name").value = connection?.name || ""; $("#mcp-type").value = connection?.type || "http";
    $("#mcp-url").value = connection?.url || ""; $("#mcp-headers").value = "";
    $("#mcp-headers").placeholder = connection?.hasCredentials ? `Saved: ${connection.headerNames.join(", ")} · leave blank to keep` : '{"Authorization":"Bearer …"}';
    $("#mcp-command").value = connection?.command || ""; $("#mcp-args").value = JSON.stringify(connection?.args || []);
    $("#mcp-delete").hidden = !connection; this.transport();
  }
  transport() { const http = $("#mcp-type").value === "http"; $("#mcp-http").hidden = !http; $("#mcp-stdio").hidden = http; $("#mcp-url").required = http; $("#mcp-command").required = !http; }
  async save(event) {
    event.preventDefault(); event.submitter.disabled = true; $("#mcp-error").textContent = "";
    try {
      const type = $("#mcp-type").value, headers = $("#mcp-headers").value.trim();
      const data = { name: $("#mcp-name").value, type, revision: this.current?.revision,
        ...(type === "http" ? { url: $("#mcp-url").value, ...(headers ? { headers: JSON.parse(headers) } : {}) } : { command: $("#mcp-command").value, args: JSON.parse($("#mcp-args").value || "[]") }) };
      const { connection } = await this.api(this.current ? `/api/mcps/${this.current.id}` : "/api/mcps", { method: this.current ? "PATCH" : "POST", body: JSON.stringify(data) });
      await this.load(); this.edit(connection); $("#mcp-save-status").textContent = "Saved. Select this connection in an environment to enable it on the next worker start.";
    } catch (error) { $("#mcp-error").textContent = error.message; } finally { event.submitter.disabled = false; }
  }
}
