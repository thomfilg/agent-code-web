import { SORT_OPTIONS, groupChats, repositoryGroup, stateLabel } from "./chat-organization.js";

const $ = selector => document.querySelector(selector);
function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function button(text, label, action, className = "small-icon") {
  const item = el("button", className, text);
  item.type = "button"; item.title = label; item.setAttribute("aria-label", label);
  item.addEventListener("click", action);
  return item;
}

function statusIcon(chat) {
  const state = chat.workflowState || "idle";
  const icon = el("span", `chat-status-icon ${state}`);
  icon.setAttribute("role", "img"); icon.setAttribute("aria-label", stateLabel(state));
  icon.title = `${stateLabel(state)} · ${chat.stateDetail || "Automatically detected"}${chat.githubSyncWarning ? " · GitHub status may be stale" : ""}`;
  if (state.startsWith("pr_")) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.5"); svg.setAttribute("aria-hidden", "true");
    for (const [tag, attributes] of [
      ["circle", { cx: 4, cy: 3, r: 2 }], ["circle", { cx: 4, cy: 13, r: 2 }],
      ["circle", { cx: 12, cy: state === "pr_merged" ? 11 : 13, r: 2 }],
      ["path", { d: state === "pr_merged" ? "M4 5v6M6 4c0 4 6 2 6 5" : "M4 5v6M12 11V6a3 3 0 0 0-3-3H8m2-2L8 3l2 2" }],
    ]) {
      const part = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, String(value));
      svg.append(part);
    }
    icon.append(svg);
  } else icon.append(el("span", "status-dot"));
  return icon;
}

export class ChatSidebar {
  constructor({ state, api, select, updated, remove, toast, agentLabel }) {
    Object.assign(this, { state, api, select, updated, remove, toast, agentLabel });
    this.groups = []; this.preferences = { sort: "updated_desc", collapsed: [] };
    this.dragging = false; this.pendingPreferences = 0; this.preferenceVersion = 0; this.refreshVersion = 0;
    for (const [value, label] of SORT_OPTIONS) { const option = el("option", "", label); option.value = value; $("#chat-sort").append(option); }
    $("#chat-sort").addEventListener("change", () => { this.preferences.sort = $("#chat-sort").value; this.render(); this.savePreferences(); });
    $("#add-group-button").addEventListener("click", () => this.editGroup());
    $("#organize-chat-button").addEventListener("click", () => { if (state.active) this.editChat(state.active); });
    $("#group-form").addEventListener("submit", event => this.saveGroup(event));
    $("#organize-form").addEventListener("submit", event => this.saveChat(event));
    $("#archive-chat-button").addEventListener("click", () => this.toggleArchive());
    $("#organize-delete-chat").addEventListener("click", async event => {
      const control = event.currentTarget;
      control.disabled = true; control.textContent = "Deleting…"; control.setAttribute("aria-busy", "true");
      try { if (await this.remove(this.editingChat)) $("#organize-dialog").close(); }
      catch (error) { $("#organize-error").textContent = error.message; }
      finally { control.disabled = false; control.textContent = "Delete chat"; control.setAttribute("aria-busy", "false"); }
    });
    $("#remove-group-button").addEventListener("click", () => this.removeGroup());
    document.addEventListener("dragend", () => { this.dragging = false; document.querySelectorAll(".drop-over").forEach(item => item.classList.remove("drop-over")); this.scheduleRefresh(); });
    document.querySelectorAll("[data-close-dialog]").forEach(item => item.addEventListener("click", () => item.closest("dialog").close()));
  }
  async refresh() {
    if (this.dragging) return;
    const version = ++this.refreshVersion, preferencesAtStart = this.preferenceVersion, savingAtStart = this.pendingPreferences > 0;
    const result = await this.api("/api/sidebar");
    if (version !== this.refreshVersion || this.dragging) return;
    this.state.chats = result.chats; this.groups = result.groups;
    if (!this.pendingPreferences && !savingAtStart && preferencesAtStart === this.preferenceVersion) this.preferences = result.preferences;
    this.render();
    const active = result.chats.find(chat => chat.id === this.state.active?.id);
    if (active && (active.revision || 0) >= (this.state.active?.revision || 0)) this.updated(active);
    if ($("#organize-dialog").open && this.editingChat) {
      const chat = result.chats.find(chat => chat.id === this.editingChat.id);
      if (chat) this.renderChatStatus(chat);
    }
  }
  connect() {
    this.events?.close();
    this.events = new EventSource("/api/sidebar/events");
    this.events.onmessage = event => {
      this.scheduleRefresh();
      try { if (JSON.parse(event.data).type === "agent_accounts_changed") window.dispatchEvent(new Event("relay-agent-accounts-changed")); } catch { /* Ignore malformed invalidations. */ }
    };
    this.events.onerror = () => { $("#sidebar-sync").textContent = "Reconnecting…"; };
  }
  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh().then(() => { $("#sidebar-sync").textContent = ""; }).catch(() => { $("#sidebar-sync").textContent = "Updates unavailable"; }), 120);
  }
  async savePreferences() {
    this.preferenceVersion++;
    this.pendingPreferences++;
    const value = structuredClone(this.preferences);
    this.preferenceQueue = (this.preferenceQueue || Promise.resolve()).catch(() => {}).then(() => this.api("/api/sidebar/preferences", { method: "PATCH", body: JSON.stringify(value) }));
    try { await this.preferenceQueue; } catch (error) { this.toast(`Could not save sidebar preferences: ${error.message}`); }
    finally { this.pendingPreferences--; }
  }
  async patch(id, input) {
    const { chat } = await this.api(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify(input) });
    this.updated(chat);
    await this.refresh();
    return chat;
  }
  dropTarget(item, patch, label) {
    item.dataset.dropTarget = label;
    item.addEventListener("dragover", event => {
      if (!event.dataTransfer.types.includes("application/x-agent-relay-chat")) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; item.classList.add("drop-over");
    });
    item.addEventListener("dragleave", event => { if (!item.contains(event.relatedTarget)) item.classList.remove("drop-over"); });
    item.addEventListener("drop", async event => {
      event.preventDefault(); event.stopPropagation(); item.classList.remove("drop-over"); this.dragging = false;
      const id = event.dataTransfer.getData("application/x-agent-relay-chat");
      if (!this.state.chats.some(chat => chat.id === id)) return;
      try { const chat = await this.patch(id, patch); $("#sidebar-announcement").textContent = `Moved ${chat.title} to ${label}${chat.pinned && label !== "Pinned" ? "; still pinned" : ""}`; }
      catch (error) { this.toast(error.message); }
    });
  }
  section(key, label, count, { className = "", group = null, drop = null } = {}) {
    const details = el("details", `chat-section ${className}`);
    details.dataset.section = key;
    details.open = !this.preferences.collapsed.includes(key);
    const heading = el("summary", "group-heading");
    heading.append(el("span", "group-name", label), el("span", "group-count", String(count)));
    if (group) heading.append(button("⋯", `Edit group ${group.name}`, event => { event.preventDefault(); event.stopPropagation(); this.editGroup(group); }));
    details.append(heading);
    details.addEventListener("toggle", () => {
      const collapsed = new Set(this.preferences.collapsed);
      if (details.open === !collapsed.has(key)) return;
      if (details.open) collapsed.delete(key); else collapsed.add(key);
      this.preferences.collapsed = [...collapsed]; this.savePreferences();
    });
    if (drop) this.dropTarget(details, drop, label);
    return details;
  }
  row(chat, showOrigin = false) {
    const deleting = this.state.deletingChats?.has(chat.id);
    const row = el("div", `chat-row${this.state.active?.id === chat.id ? " active" : ""}${deleting ? " deleting" : ""}`);
    row.draggable = !deleting; row.dataset.chatId = chat.id; row.setAttribute("aria-busy", String(Boolean(deleting)));
    row.addEventListener("dragstart", event => {
      this.dragging = true; event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-agent-relay-chat", chat.id);
      event.dataTransfer.setData("text/plain", chat.title);
    });
    const select = button("", `Open ${chat.title}`, () => this.select(chat.id), "chat-item");
    select.dataset.focusKey = `select-${chat.id}`;
    select.setAttribute("aria-current", String(this.state.active?.id === chat.id));
    const top = el("div", "chat-item-top");
    top.append(statusIcon(chat), el("span", "chat-item-title", deleting ? `Deleting… ${chat.title}` : chat.title));
    select.append(top);
    const origin = repositoryGroup(chat);
    select.title = `${chat.title}\n${origin.company} / ${origin.repository}\n${this.agentLabel(chat.agent)} · ${stateLabel(chat.workflowState)}\nUpdated: ${new Date(chat.updatedAt).toLocaleString()}${showOrigin && chat.customGroupId ? `\nGroup: ${this.groups.find(g => g.id === chat.customGroupId)?.name || ""}` : ""}`;
    const controls = el("div", "chat-row-actions");
    const pin = button(chat.pinned ? "★" : "☆", `${chat.pinned ? "Unpin" : "Pin"} ${chat.title}`, () => this.patch(chat.id, { pinned: !chat.pinned }).catch(error => this.toast(error.message)));
    pin.setAttribute("aria-pressed", String(Boolean(chat.pinned))); pin.dataset.focusKey = `pin-${chat.id}`;
    const menu = button("⋯", `Organize ${chat.title}`, () => this.editChat(chat)); menu.dataset.focusKey = `organize-${chat.id}`;
    pin.disabled = Boolean(deleting); menu.disabled = Boolean(deleting);
    controls.append(pin, menu); row.append(select, controls);
    return row;
  }
  render() {
    const list = $("#chat-list");
    const signature = JSON.stringify({ chats: this.state.chats, groups: this.groups, preferences: this.preferences, active: this.state.active?.id, deleting: [...(this.state.deletingChats || [])] });
    if (signature === this.renderedSignature || this.dragging) return;
    this.renderedSignature = signature;
    const focused = list.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : null;
    const scrollTop = list.scrollTop;
    const grouped = groupChats(this.state.chats, this.groups, this.preferences.sort);
    $("#chat-sort").value = this.preferences.sort;
    list.replaceChildren();
    const pinned = this.section("pinned", "Pinned", grouped.pinned.length, { drop: { pinned: true } });
    pinned.append(...grouped.pinned.map(chat => this.row(chat, true)));
    if (!grouped.pinned.length) pinned.append(el("p", "group-empty", "Pin a chat or drop it here"));
    list.append(pinned);
    for (const group of grouped.custom) {
      const section = this.section(group.id, group.name, group.chats.length, { group, drop: { customGroupId: group.id }, className: "custom-group" });
      section.append(...group.chats.map(chat => this.row(chat, true)));
      if (!group.chats.length) section.append(el("p", "group-empty", "Drop chats here · or use ⋯ → Move to group"));
      list.append(section);
    }
    const natural = el("div", "repository-groups");
    this.dropTarget(natural, { customGroupId: null, pinned: false }, "Company / repository");
    natural.append(el("div", "repository-groups-label", "Company / repository"));
    for (const company of grouped.companies) {
      const key = `company:${company.name.toLowerCase()}`;
      const label = this.state.companies?.find(entry => entry.id === company.name.toLowerCase())?.name || company.name;
      const section = this.section(key, label, company.repositories.reduce((sum, repo) => sum + repo.chats.length, 0), { className: "company-group" });
      for (const repo of company.repositories) {
        const repository = this.section(`${key}/${repo.name.toLowerCase()}`, repo.name, repo.chats.length, { className: "repository-group" });
        repository.append(...repo.chats.map(chat => this.row(chat)));
        section.append(repository);
      }
      natural.append(section);
    }
    if (!grouped.companies.length) natural.append(el("p", "group-empty", "Drop here to restore automatic grouping"));
    list.append(natural);
    list.scrollTop = scrollTop;
    if (focused) [...list.querySelectorAll("[data-focus-key]")].find(item => item.dataset.focusKey === focused)?.focus({ preventScroll: true });
  }
  editGroup(group = null) {
    this.editingGroup = group;
    $("#group-name").value = group?.name || "";
    $("#group-dialog-title").textContent = group ? "Edit group" : "Create a group";
    $("#group-error").textContent = "";
    $("#remove-group-button").hidden = !group;
    $("#group-dialog").showModal(); $("#group-name").focus();
  }
  async saveGroup(event) {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      await this.api(this.editingGroup ? `/api/groups/${this.editingGroup.id}` : "/api/groups", { method: this.editingGroup ? "PATCH" : "POST", body: JSON.stringify({ name: $("#group-name").value }) });
      await this.refresh(); $("#group-dialog").close();
    } catch (error) { $("#group-error").textContent = error.message; }
    finally { event.submitter.disabled = false; }
  }
  async removeGroup() {
    if (!this.editingGroup || !confirm(`Delete “${this.editingGroup.name}”? Its chats will return to company / repository groups. No chats will be deleted.`)) return;
    try { await this.api(`/api/groups/${this.editingGroup.id}`, { method: "DELETE" }); await this.refresh(); $("#group-dialog").close(); }
    catch (error) { $("#group-error").textContent = error.message; }
  }
  editChat(chat) {
    this.editingChat = structuredClone(chat);
    $("#organize-title").value = chat.title;
    $("#organize-pinned").checked = Boolean(chat.pinned);
    const origin = repositoryGroup(chat);
    $("#organize-origin").textContent = `Company: ${origin.company} · Repository: ${origin.repository}. Determined by the first selected repository.`;
    $("#organize-group").replaceChildren();
    for (const group of [{ id: "", name: "Automatic · company / repository" }, ...this.groups]) { const option = el("option", "", group.name); option.value = group.id; $("#organize-group").append(option); }
    $("#organize-group").value = chat.customGroupId || "";
    this.renderChatStatus(chat);
    $("#organize-error").textContent = "";
    $("#organize-dialog").showModal();
  }
  renderChatStatus(chat) {
    $("#organize-status").replaceChildren(statusIcon(chat), el("span", "", stateLabel(chat.workflowState)));
    $("#organize-status-detail").textContent = chat.stateDetail || "Detected automatically from the agent and GitHub.";
    $("#organize-sync-warning").textContent = chat.githubSyncWarning || "";
    const links = $("#organize-pull-requests"); links.replaceChildren();
    for (const pr of chat.pullRequests || []) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(pr.repository) || !Number.isSafeInteger(pr.number)) continue;
      const link = el("a", "", `${pr.repository} #${pr.number}${pr.checks === "pending" ? " · checks pending" : ""}`);
      link.href = `https://github.com/${pr.repository}/pull/${pr.number}`; link.target = "_blank"; link.rel = "noopener noreferrer";
      links.append(link);
    }
    const archive = $("#archive-chat-button");
    archive.textContent = chat.archived ? "Unarchive chat" : "Archive chat";
    archive.dataset.archived = String(Boolean(chat.archived));
    archive.disabled = ["starting", "running", "stopping"].includes(chat.status);
    archive.title = archive.disabled ? "Stop the working agent before archiving" : "";
  }
  async toggleArchive() {
    const archive = $("#archive-chat-button"); const archived = archive.dataset.archived !== "true";
    archive.disabled = true;
    try { await this.patch(this.editingChat.id, { archived }); $("#organize-dialog").close(); }
    catch (error) { $("#organize-error").textContent = error.message; }
    finally { archive.disabled = false; }
  }
  async saveChat(event) {
    event.preventDefault(); event.submitter.disabled = true;
    const before = this.editingChat;
    const values = { title: $("#organize-title").value, pinned: $("#organize-pinned").checked, customGroupId: $("#organize-group").value || null };
    const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== before[key]));
    try { await this.patch(before.id, patch); $("#organize-dialog").close(); }
    catch (error) { $("#organize-error").textContent = error.message; }
    finally { event.submitter.disabled = false; }
  }
}
