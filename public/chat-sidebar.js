import { CHAT_STATES, SORT_OPTIONS, groupChats, repositoryGroup, stateLabel } from "./chat-organization.js";

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

export class ChatSidebar {
  constructor({ state, api, select, updated, toast, age, agentLabel }) {
    Object.assign(this, { state, api, select, updated, toast, age, agentLabel });
    this.groups = []; this.preferences = { sort: "updated_desc", collapsed: [] };
    this.dragging = false; this.pendingPreferences = 0;
    for (const [value, label] of SORT_OPTIONS) { const option = el("option", "", label); option.value = value; $("#chat-sort").append(option); }
    $("#chat-sort").addEventListener("change", () => { this.preferences.sort = $("#chat-sort").value; this.render(); this.savePreferences(); });
    $("#add-group-button").addEventListener("click", () => this.editGroup());
    $("#organize-chat-button").addEventListener("click", () => { if (state.active) this.editChat(state.active); });
    $("#group-form").addEventListener("submit", event => this.saveGroup(event));
    $("#organize-form").addEventListener("submit", event => this.saveChat(event));
    $("#remove-group-button").addEventListener("click", () => this.removeGroup());
    document.addEventListener("dragend", () => { this.dragging = false; document.querySelectorAll(".drop-over").forEach(item => item.classList.remove("drop-over")); this.scheduleRefresh(); });
    document.querySelectorAll("[data-close-dialog]").forEach(item => item.addEventListener("click", () => item.closest("dialog").close()));
  }
  async refresh() {
    if (this.dragging) return;
    const result = await this.api("/api/sidebar");
    this.state.chats = result.chats; this.groups = result.groups;
    if (!this.pendingPreferences) this.preferences = result.preferences;
    this.render();
    const active = result.chats.find(chat => chat.id === this.state.active?.id);
    if (active) this.updated(active);
  }
  connect() {
    this.events?.close();
    this.events = new EventSource("/api/sidebar/events");
    this.events.onmessage = () => this.scheduleRefresh();
    this.events.onerror = () => { $("#sidebar-sync").textContent = "Reconnecting…"; };
  }
  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh().then(() => { $("#sidebar-sync").textContent = ""; }).catch(() => { $("#sidebar-sync").textContent = "Updates unavailable"; }), 120);
  }
  async savePreferences() {
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
    const row = el("div", `chat-row${this.state.active?.id === chat.id ? " active" : ""}`);
    row.draggable = true; row.dataset.chatId = chat.id;
    row.addEventListener("dragstart", event => {
      this.dragging = true; event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-agent-relay-chat", chat.id);
      event.dataTransfer.setData("text/plain", chat.title);
    });
    const select = button("", `Open ${chat.title}`, () => this.select(chat.id), "chat-item");
    select.dataset.focusKey = `select-${chat.id}`;
    select.setAttribute("aria-current", String(this.state.active?.id === chat.id));
    const top = el("div", "chat-item-top");
    top.append(el("span", "agent-glyph", chat.agent === "claude" ? "C" : chat.agent === "mock" ? "M" : "X"), el("span", "chat-item-title", chat.title));
    const meta = el("div", "chat-item-meta");
    meta.append(el("span", `mini-status ${chat.workflowState || "idle"}`), el("span", "", stateLabel(chat.workflowState)), el("time", "chat-age", `· ${this.age(chat.updatedAt)}`));
    meta.lastChild.dateTime = chat.updatedAt;
    meta.lastChild.title = `Created: ${new Date(chat.createdAt).toLocaleString()}\nUpdated: ${new Date(chat.updatedAt).toLocaleString()}`;
    select.append(top, meta);
    const origin = repositoryGroup(chat);
    select.title = `${chat.title}\n${origin.company} / ${origin.repository}\n${this.agentLabel(chat.agent)}`;
    if (showOrigin) select.append(el("div", "chat-origin", `${origin.company} / ${origin.repository}${chat.pinned && chat.customGroupId ? ` · ${this.groups.find(g => g.id === chat.customGroupId)?.name || ""}` : ""}`));
    const controls = el("div", "chat-row-actions");
    const pin = button(chat.pinned ? "★" : "☆", `${chat.pinned ? "Unpin" : "Pin"} ${chat.title}`, () => this.patch(chat.id, { pinned: !chat.pinned }).catch(error => this.toast(error.message)));
    pin.setAttribute("aria-pressed", String(Boolean(chat.pinned))); pin.dataset.focusKey = `pin-${chat.id}`;
    const menu = button("⋯", `Organize ${chat.title}`, () => this.editChat(chat)); menu.dataset.focusKey = `organize-${chat.id}`;
    controls.append(pin, menu); row.append(select, controls);
    return row;
  }
  render() {
    const list = $("#chat-list");
    const signature = JSON.stringify({ chats: this.state.chats, groups: this.groups, preferences: this.preferences, active: this.state.active?.id });
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
      const section = this.section(key, company.name, company.repositories.reduce((sum, repo) => sum + repo.chats.length, 0), { className: "company-group" });
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
    $("#organize-state").replaceChildren();
    for (const [value, label] of CHAT_STATES) { const option = el("option", "", label); option.value = value; $("#organize-state").append(option); }
    $("#organize-state").value = chat.workflowState || "idle";
    $("#organize-error").textContent = "";
    $("#organize-dialog").showModal();
  }
  async saveChat(event) {
    event.preventDefault(); event.submitter.disabled = true;
    const before = this.editingChat;
    const values = { title: $("#organize-title").value, pinned: $("#organize-pinned").checked, customGroupId: $("#organize-group").value || null, workflowState: $("#organize-state").value };
    const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== before[key]));
    try { await this.patch(before.id, patch); $("#organize-dialog").close(); }
    catch (error) { $("#organize-error").textContent = error.message; }
    finally { event.submitter.disabled = false; }
  }
}
