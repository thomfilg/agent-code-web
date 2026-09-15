import { openSidePanel, closeSidePanel } from "./side-panels.js";
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
export function groupTools(messages, live = []) {
  const rows = [], groups = new Map(); let key = "initial";
  for (const message of [...messages, ...live.map(meta => ({ role: "tool", kind: "tool", id: meta.itemId, meta, text: meta.title }))]) {
    if (message.role === "user") key = message.id;
    if (message.kind !== "tool") { rows.push(message); continue; }
    if (!groups.has(key)) { groups.set(key, new Map()); rows.push({ kind: "tool_group", key }); }
    groups.get(key).set(message.meta?.itemId || message.id, message);
  }
  return { rows, groups };
}
export class ToolActivity {
  constructor() {
    this.panel = document.querySelector("#tools-panel");
    document.querySelector("#close-tools").onclick = () => this.close();
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !this.panel.hidden) this.close(); });
  }
  close() { if (closeSidePanel("tools")) this.trigger?.focus(); }
  update(chatId, groups) {
    if (this.chatId !== chatId) { this.close(); this.chatId = chatId; }
    this.groups = groups;
    if (!this.panel.hidden) this.render();
  }
  button(key) {
    const count = this.groups.get(key)?.size || 0;
    const b = el("button", `Tools used: ${count} ›`, "tool-group-button"); b.type = "button"; b.setAttribute("aria-controls", "tools-panel");
    b.onclick = () => {
      this.selected = key; this.trigger = b;
      openSidePanel("tools"); this.render(); document.querySelector("#close-tools").focus();
    }; return b;
  }
  render() {
    const body = document.querySelector("#tools-list");
    const opened = new Set([...body.querySelectorAll("details[open]")].map(n => n.dataset.id));
    body.replaceChildren();
    const messages = [...(this.groups.get(this.selected)?.values() || [])];
    document.querySelector("#tools-title").textContent = `Tools used: ${messages.length}`;
    for (const [index, message] of messages.entries()) {
      const meta = message.meta || {}, details = el("details", undefined, "tool-details"); details.dataset.id = meta.itemId || message.id; details.open = opened.has(details.dataset.id);
      const status = meta.state === "running" ? "Running" : meta.failed || (meta.exitCode != null && meta.exitCode !== 0) ? "Failed / denied" : meta.resultMissing ? "Result not reported" : "Finished";
      details.append(el("summary", `${index + 1}. ${meta.tool || "Tool"} · ${status}`), el("p", meta.title || message.text));
      if (meta.input) details.append(el("h4", "Input"), el("pre", meta.input, "tool-output"));
      if (meta.output) details.append(el("h4", "Result"), el("pre", meta.output, "tool-output"));
      else details.append(el("p", status === "Running" ? "Waiting for tool result…" : "No output reported", "muted"));
      body.append(details);
    }
  }
}
