import { closeSidePanel } from "./side-panels.js";
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
export function groupTools(messages, live = []) {
  const ordered = [...messages], positions = new Map();
  ordered.forEach((message, index) => { if (message.role === "user") positions.clear(); if (message.kind === "tool") positions.set(message.meta?.itemId || message.id, index); });
  for (const meta of live) {
    const index = positions.get(meta.itemId);
    if (index !== undefined) {
      if (ordered[index].meta?.state !== "completed") ordered[index] = { ...ordered[index], meta: { ...ordered[index].meta, ...meta } };
    } else { positions.set(meta.itemId, ordered.length); ordered.push({ role: "tool", kind: "tool", id: meta.itemId, meta, text: meta.title }); }
  }
  const rows = [], groups = new Map(); let key = null;
  for (const message of ordered) {
    if (message.kind !== "tool") { rows.push(message); key = null; continue; }
    if (!key) { key = `tools-${message.id || message.meta?.itemId}`; groups.set(key, new Map()); rows.push({ kind: "tool_group", key }); }
    groups.get(key).set(message.meta?.itemId || message.id, message);
  }
  return { rows, groups };
}
export class ToolActivity {
  constructor() {
    this.openGroups = new Set(); this.openItems = new Set();
    this.panel = document.querySelector("#tools-panel");
    document.querySelector("#close-tools").onclick = () => this.close();
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !this.panel.hidden) this.close(); });
  }
  close() { if (closeSidePanel("tools")) this.trigger?.focus(); }
  update(chatId, groups) {
    if (this.chatId !== chatId) { this.close(); this.chatId = chatId; this.openGroups.clear(); this.openItems.clear(); this.inlineFocus = null; }
    this.groups = groups;
    if (!this.panel.hidden) this.render();
  }
  button(key) {
    const messages = [...(this.groups.get(key)?.values() || [])];
    const count = messages.length, running = messages.filter(message => message.meta?.state === "running").length;
    const commands = messages.every(message => ["command", "Bash", "bash", "shell"].includes(message.meta?.tool));
    const group = el("details", undefined, "inline-tool-group"); group.dataset.toolGroup = key; group.open = this.openGroups.has(key);
    const summary = el("summary", `${running ? "Running" : commands ? "Ran" : "Used"} ${count} ${commands ? count === 1 ? "command" : "commands" : count === 1 ? "tool" : "tools"}${running && running !== count ? ` · ${running} active` : ""}`);
    group.append(summary);
    const list = el("div", undefined, "inline-tool-list");
    for (const message of messages) {
      const meta = message.meta || {}, itemKey = `${key}:${meta.itemId || message.id}`;
      const details = el("details", undefined, "tool-details"); details.dataset.toolItem = itemKey; details.open = this.openItems.has(itemKey);
      const state = meta.state === "running" ? "Running" : meta.interrupted ? "Interrupted when worker stopped" : meta.failed || (meta.exitCode != null && meta.exitCode !== 0) ? "Failed" : meta.resultMissing ? "Result not reported" : "";
      const title = meta.title || message.text || meta.tool || "Tool";
      details.append(el("summary", `${title.length > 120 ? `${title.slice(0, 117)}…` : title}${state ? ` · ${state}` : ""}`));
      if (meta.input || commands) details.append(el("pre", meta.input || `$ ${title}`, "tool-input"));
      if (meta.output) details.append(el("pre", meta.output, "tool-output"));
      else details.append(el("p", meta.state === "running" ? "Waiting for tool result…" : "No output reported", "muted"));
      if (meta.exitCode != null) details.append(el("p", `Exit status ${meta.exitCode}`, "muted"));
      list.append(details);
    }
    group.append(list); return group;
  }
  captureExpanded() {
    const focused = document.activeElement?.closest?.(".inline-tool-group summary");
    this.inlineFocus = focused ? { group: focused.closest("[data-tool-group]").dataset.toolGroup, item: focused.closest("[data-tool-item]")?.dataset.toolItem } : null;
    for (const group of document.querySelectorAll("#messages [data-tool-group]")) {
      if (group.open) this.openGroups.add(group.dataset.toolGroup); else this.openGroups.delete(group.dataset.toolGroup);
      for (const item of group.querySelectorAll("[data-tool-item]")) {
        if (item.open) this.openItems.add(item.dataset.toolItem); else this.openItems.delete(item.dataset.toolItem);
      }
    }
  }
  restoreInlineFocus() {
    if (!this.inlineFocus || document.activeElement !== document.body) return;
    const group = [...document.querySelectorAll("#messages [data-tool-group]")].find(group => group.dataset.toolGroup === this.inlineFocus.group);
    const target = this.inlineFocus.item ? [...(group?.querySelectorAll("[data-tool-item]") || [])].find(item => item.dataset.toolItem === this.inlineFocus.item) : group;
    target?.querySelector(":scope > summary")?.focus({ preventScroll: true });
    this.inlineFocus = null;
  }
  render() {
    const body = document.querySelector("#tools-list");
    const opened = new Set([...body.querySelectorAll("details[open]")].map(n => n.dataset.id));
    body.replaceChildren();
    const messages = [...(this.groups.get(this.selected)?.values() || [])];
    document.querySelector("#tools-title").textContent = `Tools used: ${messages.length}`;
    for (const [index, message] of messages.entries()) {
      const meta = message.meta || {}, details = el("details", undefined, "tool-details"); details.dataset.id = meta.itemId || message.id; details.open = opened.has(details.dataset.id);
      const status = meta.state === "running" ? "Running" : meta.interrupted ? "Interrupted when worker stopped" : meta.failed || (meta.exitCode != null && meta.exitCode !== 0) ? "Failed / denied" : meta.resultMissing ? "Result not reported" : "Finished";
      details.append(el("summary", `${index + 1}. ${meta.tool || "Tool"} · ${status}`), el("p", meta.title || message.text));
      if (meta.input) details.append(el("h4", "Input"), el("pre", meta.input, "tool-output"));
      if (meta.output) details.append(el("h4", "Result"), el("pre", meta.output, "tool-output"));
      else details.append(el("p", status === "Running" ? "Waiting for tool result…" : "No output reported", "muted"));
      body.append(details);
    }
  }
}
