import { openSidePanel, closeSidePanel } from "./side-panels.js";
import { directBrowserLink } from "./browser-links.js";
import { BrowserInputQueue } from "./browser-input.js";

const $ = selector => document.querySelector(selector);
const modifiers = event => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

export class SharedBrowserPanel {
  constructor({ api, getBackend = () => "local", openApp = () => {} }) {
    this.api = api; this.panel = $("#browser-panel"); this.canvas = $("#browser-canvas"); this.context = this.canvas.getContext("2d"); this.sequence = 0; this.frameVersion = 0;
    this.pendingCommands = new Map(); this.resizeQueue = Promise.resolve(); this.resizeVersion = 0;
    this.input = new BrowserInputQueue((action, params) => this.request(action, params));
    this.getBackend = getBackend;
    this.tools = $("#browser-tools");
    this.tools.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !this.tools.open) return;
      event.preventDefault(); event.stopPropagation(); this.tools.open = false; this.tools.querySelector("summary").focus();
    });
    document.addEventListener("pointerdown", event => { if (this.tools.open && !this.tools.contains(event.target)) this.tools.open = false; });
    this.tools.addEventListener("focusout", event => { if (event.relatedTarget && !this.tools.contains(event.relatedTarget)) this.tools.open = false; });
    $("#browser-open-app").onclick = () => openApp({ address: $("#browser-address").value });
    $("#browser-copy-text").onclick = () => this.copyText();
    $("#browser-paste-text").onclick = () => this.pasteText();
    $("#browser-address").addEventListener("input", () => this.updateDirectLink());
    $("#browser-copy-link").onclick = async () => {
      const link = this.directLink();
      if (!link.url) return this.status(link.reason);
      try { await navigator.clipboard.writeText(link.url); this.status("Direct preview URL copied. This does not enable agent access to your browser."); }
      catch { this.status("Clipboard unavailable. Right-click Open directly to copy the link."); }
    };
    $("#open-browser").onclick = () => this.open();
    $("#close-browser").onclick = () => { this.close(); $("#open-browser").focus(); };
    $("#expand-browser").onclick = () => { const expanded = this.panel.classList.toggle("expanded"); $("#expand-browser").setAttribute("aria-pressed", String(expanded)); };
    $("#browser-connect").onclick = () => this.connect();
    $("#browser-stop").onclick = async () => {
      const chatId = this.chatId, personal = this.mode === "personal"; this.disconnect();
      try { await this.api(`/api/chats/${chatId}/browser`, { method: "DELETE" }); if (this.chatId === chatId) this.status(personal ? "Chrome stopped. Signed-in access is off; your personal logins stay saved." : this.profile ? `Chrome stopped. This chat’s copy of “${this.profile.name}” is kept until the chat is deleted.` : "Chrome stopped. Its separate profile has been discarded."); }
      catch (error) { if (this.chatId === chatId) this.status(error.message); }
    };
    $("#browser-save-profile").onclick = async () => {
      const chatId = this.chatId, profile = this.profile; if (!profile) return;
      if (!confirm(`Save this chat’s browser as the next version of “${profile.name}”? Chrome restarts. New chats in this environment will start from it; existing chats keep their own copies.`)) return;
      this.disconnect(); this.status("Saving this browser to the profile…");
      try { const result = await this.api(`/api/chats/${chatId}/browser/profile`, { method: "POST", body: JSON.stringify({ confirm: true }) }); if (this.chatId === chatId) this.status(`Saved as version ${result.profile.currentVersion} of “${result.profile.name}”. Signed-in sites: ${result.profile.sites.slice(0, 8).join(", ") || "none"}.`); }
      catch (error) { if (this.chatId === chatId) this.status(error.message); }
    };
    $("#browser-address-form").onsubmit = event => { event.preventDefault(); this.navigate($("#browser-address").value.trim()); };
    $("#browser-localhost").onclick = () => this.navigate("http://localhost:3000");
    for (const action of ["back", "forward", "reload"]) $(`#browser-${action}`).onclick = () => this.interact(action);
    $("#browser-new-tab").onclick = () => this.interact("newTab");
    $("#browser-close-tab").onclick = () => this.interact("closeTab", { id: $("#browser-tabs").value });
    $("#browser-tabs").onchange = event => this.interact("selectTab", { id: event.target.value });
    $("#browser-viewport").onchange = event => {
      const custom = event.target.value === "custom"; $("#browser-size-form").hidden = !custom;
      if (custom) return $("#browser-width").focus();
      const [width, height] = event.target.value.split("x").map(Number); this.resize(width, height);
    };
    $("#browser-size-form").onsubmit = event => { event.preventDefault(); this.resize(Number($("#browser-width").value), Number($("#browser-height").value)); };
    $("#browser-dialog-accept").onclick = () => { this.send("dialog", { accept: true, text: $("#browser-dialog-input").value }); $("#browser-dialog").hidden = true; };
    $("#browser-dialog-dismiss").onclick = () => { this.send("dialog", { accept: false }); $("#browser-dialog").hidden = true; };
    for (const [eventName, type] of [["pointerdown", "mousePressed"], ["pointerup", "mouseReleased"], ["pointermove", "mouseMoved"]]) {
      this.canvas.addEventListener(eventName, event => {
        if (!this.connected) return;
        event.preventDefault();
        if (type !== "mouseMoved" || event.buttons) this.canvas.focus({ preventScroll: true });
        if (type === "mousePressed") this.canvas.setPointerCapture(event.pointerId);
        const point = this.point(event);
        this.interact("mouse", { type, ...point, button: ["left", "middle", "right"][event.button] || "none", buttons: event.buttons, clickCount: type === "mouseMoved" ? 0 : event.detail || 1, modifiers: modifiers(event) });
      });
    }
    this.canvas.addEventListener("wheel", event => {
      if (!this.connected) return;
      event.preventDefault(); const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? this.frameViewport?.height || this.canvas.height : 1;
      this.interact("mouse", { type: "mouseWheel", ...this.point(event), deltaX: event.deltaX * scale, deltaY: event.deltaY * scale, modifiers: modifiers(event) });
    }, { passive: false });
    this.canvas.addEventListener("contextmenu", event => event.preventDefault());
    this.canvas.addEventListener("paste", event => {
      if (!this.connected) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.clipboardData?.types.includes("text/plain")) return this.status("Shared Chrome currently pastes plain text. Use the page directly for files or images.");
      this.insertText(event.clipboardData.getData("text/plain"));
    });
    this.canvas.addEventListener("compositionend", event => { if (event.data && this.connected) this.insertText(event.data); });
    for (const type of ["keydown", "keyup"]) this.canvas.addEventListener(type, event => {
      if (!this.connected || event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (type === "keydown") $("#browser-address").focus(); return; }
      const key = event.key.toLowerCase(), shortcut = event.ctrlKey || event.metaKey;
      if (event.key === "F5" || shortcut && key === "r") {
        event.preventDefault(); event.stopPropagation();
        if (type === "keydown" && !event.repeat) this.interact("reload", { ignoreCache: event.shiftKey || event.ctrlKey && event.key === "F5" });
        return;
      }
      if (shortcut && key === "c") {
        event.preventDefault(); event.stopPropagation(); if (type === "keydown" && !event.repeat) this.copyText(); return;
      }
      // Native paste grants access only to the explicit paste event, including
      // browsers that deny the async clipboard-read permission.
      if (shortcut && ["v", "x"].includes(key)) { event.stopPropagation(); return; }
      event.preventDefault(); event.stopPropagation();
      this.interact("key", { type: type === "keydown" ? "keyDown" : "keyUp", key: event.key, code: event.code, keyCode: event.keyCode,
        modifiers: modifiers(event), ...(type === "keydown" && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 ? { text: event.key } : {}) });
    });
    document.addEventListener("relay-panel-changed", () => { if (this.panel.hidden) { this.tools.open = false; this.disconnect(); } });
    window.addEventListener("pagehide", () => this.disconnect());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { this.resumeVisible = Boolean(this.socket); this.disconnect(); }
      else if (this.resumeVisible && !this.panel.hidden) { this.resumeVisible = false; this.connect(); }
    });
  }
  status(message) { $("#browser-status").textContent = message; }
  setChat(chatId) { if (this.chatId !== chatId) { this.close(); this.chatId = chatId; } }
  open() {
    if (!this.chatId) return;
    openSidePanel("browser"); this.panel.classList.remove("expanded"); $("#expand-browser").setAttribute("aria-pressed", "false");
    this.connect();
  }
  close() { this.tools.open = false; closeSidePanel("browser"); this.disconnect(); }
  accessChanged() { this.disconnect(); if (!this.panel.hidden) this.connect(); }
  disconnect() {
    const socket = this.socket; this.socket = null; socket?.close(); this.connected = false;
    this.input.reset(); this.clipboard = false;
    for (const pending of this.pendingCommands.values()) { clearTimeout(pending.timer); pending.reject(new Error("Browser connection changed")); }
    this.pendingCommands.clear();
    this.frameVersion = (this.frameVersion || 0) + 1;
    this.pendingFrame = null; this.frameViewport = null;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height); this.canvas.hidden = true;
    $("#browser-connect").hidden = false; $("#browser-connect").disabled = false;
    $("#browser-dialog").hidden = true; $("#browser-dialog-input").value = "";
  }
  connect() {
    if (!this.chatId || this.socket) return;
    this.status("Connecting to this chat’s shared Chrome…"); $("#browser-connect").disabled = true;
    const url = new URL(`/api/chats/${this.chatId}/browser/live`, location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url); this.socket = socket;
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      const pending = this.pendingCommands.get(message.id);
      if (pending) {
        this.pendingCommands.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value);
        return;
      }
      if (message.error) { this.status(message.error); return; }
      if (message.event === "status") {
        this.connected = true; $("#browser-connect").hidden = true;
        this.clipboard = message.value.clipboard === true;
        this.mode = message.value.mode;
        this.captureVersion = message.value.captureVersion || 1;
        $("#browser-new-tab").disabled = this.mode === "personal"; $("#browser-close-tab").disabled = this.mode === "personal"; $("#browser-tabs").disabled = this.mode === "personal";
        this.profile = this.mode === "personal" ? null : message.value.profile || null;
        $("#browser-save-profile").hidden = !this.profile;
        $("#browser-profile-label").textContent = this.mode === "personal" ? "Your signed-in Chrome" : this.profile ? `Profile “${this.profile.name}” v${this.profile.version} · this chat’s copy` : "Separate profile";
        $("#browser-footnote").textContent = this.profile && this.mode !== "personal" ? `You and the agent share this page. It starts from a private copy of “${this.profile.name}”; changes stay in this chat and are deleted with it unless you choose Save to profile.` : this.mode === "personal" ? "Signed-in sharing is ON for this chat. Localhost is your computer, not a remote worker. Turn off the top-right switch to revoke access and close the automation tab." : "You and the agent share this page. Localhost reaches the chat’s worker. Your personal Chrome and its saved logins are not connected.";
        this.status("Live · click or type in the page. Chrome stays awake while this panel is connected.");
        this.renderTabs(message.value);
      }
      if (message.event === "frame") this.paint(message.value);
      if (message.event === "closed") { this.disconnect(); this.status(message.value.message); }
      if (message.event === "dialog") {
        $("#browser-dialog-text").textContent = `${message.value.type}: ${message.value.message}`;
        $("#browser-dialog-input").hidden = message.value.type !== "prompt";
        $("#browser-dialog-input").value = message.value.defaultPrompt || ""; $("#browser-dialog").hidden = false;
      }
    };
    socket.onerror = () => { if (this.socket === socket) this.status("Unable to connect. Check that Chrome is installed in the worker and that you are signed into Agent Relay."); };
    socket.onclose = event => { if (this.socket === socket) { this.disconnect(); if (event.code === 4001 && !this.panel.hidden) { this.connect(); return; } this.status("Browser connection closed. Reconnect when you’re ready."); } };
  }
  send(action, params = {}) {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) { this.status("Connect to Chrome before interacting with the page."); return; }
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, action, params })); return id;
  }
  request(action, params = {}) {
    const id = this.send(action, params);
    if (!id) return Promise.reject(new Error("Connect to Chrome before interacting with the page"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingCommands.delete(id); reject(new Error("Browser action timed out; reconnect and try again")); }, 30000);
      this.pendingCommands.set(id, { resolve, reject, timer });
    });
  }
  interact(action, params) {
    const socket = this.socket;
    if (!this.connected) { this.status("Connect to Chrome before interacting with the page."); return; }
    void this.input.push(action, params).catch(error => { if (this.socket === socket) this.status(error.message); });
  }
  insertText(text) {
    if (text.length > 30000) return this.status("Paste at most 30,000 characters at a time. Nothing was pasted.");
    if (text) this.interact("text", { text });
  }
  async copyText() {
    if (!this.connected) return this.status("Connect to Chrome before copying text.");
    if (!this.clipboard) return this.status("This Relay server needs an update to support copying remote text.");
    if (this.copying) return;
    const socket = this.socket; this.copying = true;
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw Error("Clipboard access is unavailable. Use HTTPS and allow clipboard access, or open the page directly.");
      const result = this.input.push("copy").then(value => {
        if (socket !== this.socket || !this.connected) throw Error("Browser connection changed");
        if (typeof value?.text !== "string" || !value.text || value.text.length > 30000) throw Error("No text selected in the remote page.");
        return new Blob([value.text], { type: "text/plain" });
      });
      // Start the write during the gesture, before waiting for the remote text.
      // This preserves transient activation; never poll either clipboard.
      result.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": result })]);
      if (socket === this.socket) this.status("Selected text copied.");
    } catch (error) { if (socket === this.socket) this.status(error.name === "NotAllowedError" ? "Clipboard access denied. Allow clipboard access for Relay, then try Copy text again." : error.message); }
    finally { this.copying = false; }
  }
  async pasteText() {
    if (!this.connected) return this.status("Connect to Chrome before pasting text.");
    const socket = this.socket;
    try {
      const text = await navigator.clipboard.readText();
      if (socket !== this.socket || !this.connected) return;
      this.canvas.focus({ preventScroll: true }); this.insertText(text);
    } catch { if (socket === this.socket) this.status("Clipboard access denied. Click the remote page, then press Ctrl+V (Cmd+V on Mac) to paste text."); }
  }
  navigate(value) {
    if (!value) return;
    const url = /^[a-z]+:\/\//i.test(value) || value === "about:blank" ? value : `http://${value}`;
    this.interact("navigate", { url });
  }
  resize(width, height) {
    if (!Number.isInteger(width) || width < 320 || width > 2560 || !Number.isInteger(height) || height < 240 || height > 1600) { this.status("Use a width of 320–2560 px and a height of 240–1600 px."); return; }
    const socket = this.socket, version = ++this.resizeVersion;
    // Apply changes in order even when connected to a pre-upgrade worker.
    this.resizeQueue = this.resizeQueue.catch(() => {}).then(async () => {
      if (socket !== this.socket || version !== this.resizeVersion) return;
      await this.input.push("resize", { width, height });
      if (socket !== this.socket || version !== this.resizeVersion) return;
      if (this.captureVersion < 2 && this.mode !== "personal" && this.tabId) {
        // Older workers kept the original screencast size until tab selection.
        // Reattach to the SAME tab: refresh capture without creating a tab,
        // navigating, reloading, or discarding form/cart state.
        await this.input.push("selectTab", { id: this.tabId });
      }
    }).catch(error => { if (socket === this.socket && version === this.resizeVersion) this.status(error.message); });
    return this.resizeQueue;
  }
  renderTabs(state) {
    this.tabId = state.tabId;
    const select = $("#browser-tabs"); select.replaceChildren();
    for (const tab of state.tabs || []) { const option = document.createElement("option"); option.value = tab.id; option.textContent = tab.title || tab.url || "New tab"; select.append(option); }
    select.value = state.tabId;
    if (document.activeElement !== $("#browser-address")) $("#browser-address").value = state.tabs?.find(tab => tab.id === state.tabId)?.url || "";
    this.updateDirectLink();
    if (state.viewport) {
      const { width, height } = state.viewport, value = `${width}x${height}`, select = $("#browser-viewport");
      select.value = [...select.options].some(option => option.value === value) ? value : "custom";
      if (document.activeElement !== $("#browser-width")) $("#browser-width").value = width;
      if (document.activeElement !== $("#browser-height")) $("#browser-height").value = height;
      $("#browser-size-form").hidden = select.value !== "custom";
    }
  }
  directLink() { return directBrowserLink({ address: $("#browser-address").value, chatId: this.chatId, backend: this.getBackend(), relayOrigin: location.origin, mode: this.mode }); }
  updateDirectLink() {
    const result = this.directLink(), link = $("#browser-open-direct");
    link.title = result.note || result.reason;
    link.setAttribute("aria-disabled", String(!result.url));
    if (result.url) link.href = result.url; else link.removeAttribute("href");
    $("#browser-copy-link").disabled = !result.url;
    $("#browser-open-app").hidden = Boolean(result.url) || this.getBackend() !== "ec2" || this.mode === "personal";
  }
  point(event) {
    const rect = this.canvas.getBoundingClientRect();
    // Pointer coordinates are CSS viewport pixels, not high-DPI bitmap pixels.
    const { width, height } = this.frameViewport || this.canvas;
    return { x: Math.max(0, Math.min(width - 1, (event.clientX - rect.left) * width / rect.width)), y: Math.max(0, Math.min(height - 1, (event.clientY - rect.top) * height / rect.height)) };
  }
  paint(frame) {
    if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1) return;
    this.pendingFrame = frame;
    if (this.decodingFrame) return; // One decoder and only the latest waiting frame.
    this.decodeFrame();
  }
  decodeFrame() {
    const frame = this.pendingFrame; this.pendingFrame = null;
    if (!frame || !this.connected) return;
    this.decodingFrame = true;
    const version = this.frameVersion, image = new Image();
    const finish = () => { this.decodingFrame = false; this.decodeFrame(); };
    image.onload = () => {
      if (this.frameVersion !== version || !this.connected) { finish(); return; }
      // CDP can briefly send an old surface after resizing, even when its
      // metadata already names the new viewport. Don't stretch that image or
      // map clicks against it. Allow at most one pixel of codec rounding.
      if (Math.abs(image.naturalWidth * frame.height - image.naturalHeight * frame.width) > Math.max(frame.width, frame.height)) { finish(); return; }
      // Keep the canvas/layout stable when switching between live 1x JPEG and
      // idle 2x PNG. Only the PNG supplies native high-DPI detail; upscaling the
      // live bitmap here does not claim to add detail.
      const scale = this.captureVersion >= 2 && frame.width * frame.height <= 2097152 ? 2 : 1;
      if (this.canvas.width !== frame.width * scale) this.canvas.width = frame.width * scale;
      if (this.canvas.height !== frame.height * scale) this.canvas.height = frame.height * scale;
      this.frameViewport = { width: frame.width, height: frame.height };
      this.canvas.dataset.viewportWidth = frame.width; this.canvas.dataset.viewportHeight = frame.height;
      this.canvas.style.width = `${frame.width}px`;
      this.canvas.dataset.frameFormat = frame.mimeType || "image/jpeg";
      this.canvas.hidden = false; this.context.drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
      finish();
    };
    image.onerror = finish;
    // Older paired extensions can still supply JPEG until they are reloaded.
    image.src = `data:${frame.mimeType === "image/png" ? "image/png" : "image/jpeg"};base64,${frame.data}`;
  }
}
