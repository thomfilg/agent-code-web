import { openSidePanel, closeSidePanel } from "./side-panels.js";
import { composerHasFocus, composerIsInserting } from "./vim-composer.js";

const $ = selector => document.querySelector(selector);
const button = (label, action) => { const element = document.createElement("button"); element.type = "button"; element.className = "secondary-button"; element.textContent = label; element.onclick = action; return element; };

export class WorkspaceContext {
  constructor({ api, state, controls, toast }) {
    Object.assign(this, { api, state, controls, toast }); this.clientId = crypto.randomUUID(); this.sessions = new Map(); this.version = 0; this.menuVersion = 0;
    this.input = $("#message-input"); this.panel = $("#workspace-panel"); this.editor = $("#workspace-code"); this.menu = $("#file-menu");
    $("#add-workspace-context").onclick = () => this.open().catch(error => toast(error.message));
    $("#close-workspace-context").onclick = () => closeSidePanel("workspace");
    $("#workspace-connect").onclick = () => this.connect().then(() => this.list()).catch(error => toast(error.message));
    $("#workspace-up").onclick = () => { this.session.directory = this.session.directory.split("/").slice(0, -1).join("/"); void this.list().catch(error => toast(error.message)); };
    $("#workspace-search").oninput = () => { clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => void this.list().catch(error => toast(error.message)), 180); };
    $("#workspace-tabs").onchange = event => this.showFile(event.target.value);
    $("#workspace-close-file").onclick = () => { this.session.files.delete(this.session.active); this.showFile(this.session.files.keys().next().value || null); };
    $("#workspace-attach-file").onclick = () => this.attachCurrent(false).catch(error => toast(error.message));
    $("#workspace-attach-selection").onclick = () => this.attachCurrent(true).catch(error => toast(error.message));
    $("#workspace-ide").onclick = () => this.prepareIde().catch(error => toast(error.message));
    this.editor.addEventListener("select", () => this.rememberSelection());
    this.editor.addEventListener("keyup", () => this.rememberSelection());
    document.addEventListener("relay-panel-changed", () => this.presence());
    document.addEventListener("visibilitychange", () => this.presence());
    window.addEventListener("pagehide", () => this.presence(false));
    setInterval(() => this.presence(), 15000);
    this.input.addEventListener("input", () => { clearTimeout(this.menuTimer); this.closeMenu(); this.menuTimer = setTimeout(() => void this.suggest(), 160); });
    this.input.addEventListener("click", () => void this.suggest());
    this.input.addEventListener("blur", () => { clearTimeout(this.blurTimer); this.blurTimer = setTimeout(() => { if (!composerHasFocus(this.input)) this.closeMenu(); }, 150); });
  }
  setChat(chat) {
    if (this.chatId === chat?.id) return;
    clearTimeout(this.searchTimer);
    this.presence(false); this.version++; this.closeMenu(); this.chatId = chat?.id;
    if (this.chatId && !this.sessions.has(this.chatId)) {
      if (this.sessions.size >= 8) this.sessions.delete(this.sessions.keys().next().value);
      this.sessions.set(this.chatId, { directory: "", connected: false, files: new Map(), active: null, entries: [] });
    }
    this.session = this.sessions.get(this.chatId); closeSidePanel("workspace"); this.showFile(this.session?.active || null);
    $("#workspace-search").value = "";
  }
  async call(action, input = {}, chatId = this.chatId) { return this.api(`/api/chats/${chatId}/workspace-files/${action}`, { method: "POST", body: JSON.stringify(input) }); }
  async connect(chatId = this.chatId) {
    const session = this.sessions.get(chatId);
    if (!chatId) throw new Error("Select a chat first");
    if (chatId !== this.chatId) throw new Error("Workspace action cancelled because the chat changed");
    if (session.connected) {
      const status = await this.api(`/api/chats/${chatId}/workspace-files`);
      session.connected = status.connected;
      if (chatId !== this.chatId) throw new Error("Workspace action cancelled because the chat changed");
      if (session.connected) return;
    }
    session.connecting ||= this.call("connect", { clientId: this.clientId }, chatId).then(() => { session.connected = true; }).finally(() => { session.connecting = null; });
    await session.connecting;
    if (this.chatId !== chatId) { await this.call("presence", { clientId: this.clientId, active: false }, chatId).catch(() => {}); throw new Error("Workspace action cancelled because the chat changed"); }
    this.render(); this.presence();
  }
  presence(force) {
    if (!this.chatId || !this.session?.connected) return;
    const chatId = this.chatId, session = this.session;
    const active = force ?? (document.visibilityState === "visible" && (!this.panel.hidden || !this.menu.hidden));
    void this.api(`/api/chats/${chatId}/workspace-files/presence`, { method: "POST", keepalive: true, body: JSON.stringify({ clientId: this.clientId, active }) })
      .then(result => { if (!result.connected) { session.connected = false; if (this.chatId === chatId) this.render(); } })
      .catch(() => { session.connected = false; if (this.chatId === chatId) this.render(); });
  }
  async open(query = "") {
    document.querySelectorAll(".control-menu[open]").forEach(menu => menu.open = false);
    openSidePanel("workspace"); $("#workspace-search").value = query;
    await this.connect(); await this.list(); $("#workspace-search").focus();
  }
  async list() {
    const chatId = this.chatId, version = ++this.version, session = this.session;
    await this.connect();
    if (chatId !== this.chatId || version !== this.version) return;
    const data = await this.call("list", { path: session.directory, query: $("#workspace-search").value }, chatId);
    if (chatId !== this.chatId || version !== this.version) return;
    session.entries = data.entries; session.truncated = data.truncated; session.searchSkips = data.searchSkips; this.render();
  }
  async read(path) {
    const chatId = this.chatId, version = ++this.version, session = this.session;
    await this.connect();
    if (chatId !== this.chatId || version !== this.version) return null;
    const file = await this.call("read", { path }, chatId);
    if (chatId !== this.chatId || version !== this.version) return null;
    if (!session.files.has(path) && session.files.size >= 8) throw new Error("Close an open workspace file before opening another (maximum 8)");
    session.files.set(path, file); this.showFile(path); return file;
  }
  showFile(path) {
    if (this.session) this.session.active = path;
    const file = this.session?.files.get(path);
    this.editor.value = file?.text ?? (file?.referenceOnly ? "This file is larger than the preview limit. Mentioning its path is still available." : file?.binary ? "Binary file. Mention it to attach a private snapshot." : "Open a file to inspect it. Selecting text does not send it to an agent.");
    if (file?.selection) this.editor.setSelectionRange(file.selection.start, file.selection.end);
    this.render();
  }
  rememberSelection() {
    const file = this.session?.files.get(this.session.active);
    if (!file || file.kind !== "file" || typeof file.text !== "string") return;
    const start = this.editor.selectionStart, end = this.editor.selectionEnd;
    file.selection = end > start ? { start, end } : null; this.renderSelection();
  }
  renderSelection() {
    const file = this.session?.files.get(this.session.active), selection = file?.selection;
    $("#workspace-attach-selection").disabled = !selection;
    $("#workspace-selection-status").textContent = selection ? `${selection.end - selection.start} selected characters` : "Select text to attach only that range.";
  }
  async stage(file, selection = null, chatId = this.chatId) {
    const key = JSON.stringify([file.path, file.version || file.sha256, selection]);
    const existing = (this.controls.drafts.get(chatId) || []).find(item => item.workspaceDraftKey === key);
    if (existing) return existing;
    if ((this.controls.drafts.get(chatId) || []).length >= 10) throw new Error("Attach up to 10 files per message");
    const { attachment } = await this.call("attach", { path: file.path, version: file.version || file.sha256, selection }, chatId);
    this.controls.addDraftAttachment(chatId, { ...attachment, workspaceDraftKey: key }); return attachment;
  }
  async attachCurrent(selection) {
    const file = this.session?.files.get(this.session.active), chatId = this.chatId;
    if (!file || this.staging) return;
    const range = selection && file.selection ? { ...file.selection } : null;
    if (selection && !range) throw new Error("Select text in the file first");
    this.staging = true;
    try { await this.controls.queueUpload(chatId, async () => { await this.connect(chatId); await this.stage(file, range, chatId); }); this.toast("Workspace context attached to the draft. It has not been sent."); }
    finally { this.staging = false; }
  }
  async prepareIde() {
    const session = this.session, chatId = this.chatId;
    if (!session?.files.size) { await this.open(); this.toast("Open workspace files and optionally select text, then use /ide again or choose Use open files as context."); return false; }
    if (this.staging) throw new Error("Wait for workspace context to finish attaching");
    this.staging = true;
    const selected = [...session.files.values()].map(file => ({ ...file, selection: file.path === session.active && file.selection ? { ...file.selection } : null }));
    try {
      await this.controls.queueUpload(chatId, async () => {
        await this.connect(chatId);
        for (const file of selected) await this.stage(file, file.selection, chatId);
      });
      return true;
    } finally { this.staging = false; }
  }
  query() {
    if (!this.chatId || !composerHasFocus(this.input) || !composerIsInserting(this.input) || this.input.selectionStart !== this.input.selectionEnd) return null;
    const end = this.input.selectionStart, prefix = this.input.value.slice(0, end);
    const command = /^\/mention ([^\n]*)$/.exec(prefix);
    if (command && end === this.input.value.length) return { query: command[1], start: 0, end, command: true };
    const mention = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
    return mention ? { query: mention[1], start: end - mention[1].length - 1, end, command: false } : null;
  }
  async suggest() {
    const query = this.query(), chatId = this.chatId, version = ++this.menuVersion;
    if (!query) { this.closeMenu(); return; }
    this.menu.hidden = false; this.index = 0; this.matches = []; $("#file-options").replaceChildren(); $("#file-status").textContent = "Finding workspace files…";
    this.input.setAttribute("aria-controls", "file-options"); this.input.setAttribute("aria-expanded", "true");
    try {
      await this.connect();
      const result = await this.call("list", { path: "", query: query.query }, chatId);
      if (version !== this.menuVersion || this.chatId !== chatId || JSON.stringify(this.query()) !== JSON.stringify(query)) return;
      this.matches = result.entries.slice(0, 30); this.matchedQuery = query;
      for (const [index, file] of this.matches.entries()) {
        const option = document.createElement("div"); option.id = `file-option-${index}`; option.className = "slash-option"; option.setAttribute("role", "option"); option.textContent = `${file.path}${file.kind === "directory" ? "/" : ""}`;
        option.onmousedown = event => event.preventDefault(); option.onclick = () => void this.choose(index).catch(error => this.toast(error.message)); $("#file-options").append(option);
      }
      $("#file-status").textContent = this.matches.length ? "Choose a workspace reference · only sent with your next message" : "No matching workspace paths. Use /mention to browse folders.";
      this.highlight();
    } catch (error) { if (version === this.menuVersion) $("#file-status").textContent = error.message; }
  }
  highlight() {
    [...$("#file-options").children].forEach((option, i) => option.setAttribute("aria-selected", String(i === this.index)));
    const option = $("#file-options").children[this.index]; if (option) { this.input.setAttribute("aria-activedescendant", option.id); option.scrollIntoView({ block: "nearest" }); }
  }
  keydown(event) {
    if (event.key === "Escape") clearTimeout(this.menuTimer);
    if (this.menu.hidden || event.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); this.closeMenu(); return true; }
    if (!["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) return false;
    event.preventDefault();
    if (!this.matches?.length) return true;
    if (event.key === "Enter" || event.key === "Tab") void this.choose(this.index).catch(error => this.toast(error.message));
    else { this.index = (this.index + (event.key === "ArrowDown" ? 1 : -1) + this.matches.length) % this.matches.length; this.highlight(); }
    return true;
  }
  async choose(index) {
    const selected = this.matches?.[index], query = this.matchedQuery, chatId = this.chatId, value = this.input.value;
    if (!selected || this.choosing) return;
    this.choosing = true;
    try {
      await this.controls.queueUpload(chatId, async () => {
        const file = await this.call("read", { path: selected.path }, chatId);
        if (chatId !== this.chatId || value !== this.input.value) return;
        await this.stage(file, null, chatId);
        if (chatId !== this.chatId || value !== this.input.value) return;
        const token = query.command ? "" : `@${/\s/.test(file.path) ? JSON.stringify(file.path) : file.path} `;
        this.input.value = value.slice(0, query.start) + token + value.slice(query.end);
        const cursor = query.start + token.length; this.input.setSelectionRange(cursor, cursor); this.closeMenu(); this.input.dispatchEvent(new Event("input"));
      });
    } finally { this.choosing = false; }
  }
  closeMenu() {
    clearTimeout(this.menuTimer);
    this.menuVersion++; this.menu.hidden = true; this.matches = []; this.input.setAttribute("aria-controls", "slash-options");
    if ($("#slash-menu").hidden) { this.input.setAttribute("aria-expanded", "false"); this.input.removeAttribute("aria-activedescendant"); }
    this.presence();
  }
  render() {
    const session = this.session, chatId = this.chatId;
    $("#workspace-status").textContent = session?.connected ? "Chat workspace · read-only viewer. Only attached files/selections go to the agent." : "Disconnected · cached views stay visible. Connecting may wake this chat's worker, but does not start an agent.";
    $("#workspace-directory").textContent = session?.directory || "Workspace root";
    $("#workspace-up").disabled = !session?.directory;
    $("#workspace-connect").hidden = Boolean(session?.connected);
    const entries = $("#workspace-files"); entries.replaceChildren();
    for (const entry of session?.entries || []) {
      const row = document.createElement("div"); row.className = "workspace-file-row";
      row.append(button(`${entry.kind === "directory" ? "▸ " : ""}${entry.path}`, () => {
        if (entry.kind === "directory") { session.directory = entry.path; $("#workspace-search").value = ""; void this.list().catch(error => this.toast(error.message)); }
        else void this.read(entry.path).catch(error => this.toast(error.message));
      }));
      row.append(button("Mention", () => { void this.controls.queueUpload(chatId, async () => {
        await this.connect(chatId); const file = await this.call("read", { path: entry.path }, chatId); await this.stage(file, null, chatId);
      }).catch(error => this.toast(error.message)); })); entries.append(row);
    }
    $("#workspace-files-note").textContent = `${session?.truncated ? "Results are bounded; refine the search or browse a folder. " : ""}${session?.searchSkips?.length ? "Recursive search skips dependency/cache folders; you can browse them directly." : ""}`;
    const picker = $("#workspace-tabs"); picker.replaceChildren();
    for (const file of session?.files.values() || []) picker.add(new Option(file.path || "Workspace root", file.path));
    picker.value = session?.active || ""; picker.disabled = !session?.files.size;
    $("#workspace-close-file").disabled = !session?.files.size;
    $("#workspace-attach-file").disabled = !session?.files.size;
    $("#workspace-ide").disabled = !session?.files.size;
    this.renderSelection();
  }
}
