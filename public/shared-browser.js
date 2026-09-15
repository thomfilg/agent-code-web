import { openSidePanel, closeSidePanel } from "./side-panels.js";

const $ = selector => document.querySelector(selector);
const modifiers = event => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

export class SharedBrowserPanel {
  constructor({ api }) {
    this.api = api; this.panel = $("#browser-panel"); this.canvas = $("#browser-canvas"); this.context = this.canvas.getContext("2d"); this.sequence = 0; this.frameVersion = 0;
    $("#open-browser").onclick = () => this.open();
    $("#close-browser").onclick = () => { this.close(); $("#open-browser").focus(); };
    $("#expand-browser").onclick = () => { const expanded = this.panel.classList.toggle("expanded"); $("#expand-browser").setAttribute("aria-pressed", String(expanded)); };
    $("#browser-connect").onclick = () => this.connect();
    $("#browser-stop").onclick = async () => {
      const chatId = this.chatId, personal = this.mode === "personal"; this.disconnect();
      try { await this.api(`/api/chats/${chatId}/browser`, { method: "DELETE" }); if (this.chatId === chatId) this.status(personal ? "Chrome stopped. Signed-in access is off; your personal logins stay saved." : "Chrome stopped. Its separate profile has been discarded."); }
      catch (error) { if (this.chatId === chatId) this.status(error.message); }
    };
    $("#browser-address-form").onsubmit = event => { event.preventDefault(); this.navigate($("#browser-address").value.trim()); };
    $("#browser-localhost").onclick = () => this.navigate("http://localhost:3000");
    for (const action of ["back", "forward", "reload"]) $(`#browser-${action}`).onclick = () => this.send(action);
    $("#browser-new-tab").onclick = () => this.send("newTab");
    $("#browser-close-tab").onclick = () => this.send("closeTab", { id: $("#browser-tabs").value });
    $("#browser-tabs").onchange = event => this.send("selectTab", { id: event.target.value });
    $("#browser-viewport").onchange = event => { const [width, height] = event.target.value.split("x").map(Number); this.send("resize", { width, height }); };
    $("#browser-dialog-accept").onclick = () => { this.send("dialog", { accept: true, text: $("#browser-dialog-input").value }); $("#browser-dialog").hidden = true; };
    $("#browser-dialog-dismiss").onclick = () => { this.send("dialog", { accept: false }); $("#browser-dialog").hidden = true; };
    for (const [eventName, type] of [["pointerdown", "mousePressed"], ["pointerup", "mouseReleased"], ["pointermove", "mouseMoved"]]) {
      this.canvas.addEventListener(eventName, event => {
        if (!this.connected || (type === "mouseMoved" && !event.buttons)) return;
        event.preventDefault(); this.canvas.focus({ preventScroll: true });
        if (type === "mousePressed") this.canvas.setPointerCapture(event.pointerId);
        const point = this.point(event);
        this.send("mouse", { type, ...point, button: ["left", "middle", "right"][event.button] || "none", buttons: event.buttons, clickCount: type === "mouseMoved" ? 0 : event.detail || 1, modifiers: modifiers(event) });
      });
    }
    this.canvas.addEventListener("wheel", event => {
      if (!this.connected) return;
      event.preventDefault(); const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? this.canvas.height : 1;
      this.send("mouse", { type: "mouseWheel", ...this.point(event), deltaX: event.deltaX * scale, deltaY: event.deltaY * scale, modifiers: modifiers(event) });
    }, { passive: false });
    this.canvas.addEventListener("contextmenu", event => event.preventDefault());
    this.canvas.addEventListener("paste", event => {
      if (!this.connected) return;
      event.preventDefault(); this.send("text", { text: event.clipboardData.getData("text/plain").slice(0, 30000) });
    });
    this.canvas.addEventListener("compositionend", event => { if (event.data) this.send("text", { text: event.data }); });
    for (const type of ["keydown", "keyup"]) this.canvas.addEventListener(type, event => {
      if (!this.connected || event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (type === "keydown") $("#browser-address").focus(); return; }
      if ((event.ctrlKey || event.metaKey) && ["v", "c", "x"].includes(event.key.toLowerCase())) return;
      event.preventDefault(); event.stopPropagation();
      this.send("key", { type: type === "keydown" ? "keyDown" : "keyUp", key: event.key, code: event.code, keyCode: event.keyCode,
        modifiers: modifiers(event), ...(type === "keydown" && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 ? { text: event.key } : {}) });
    });
    document.addEventListener("relay-panel-changed", () => { if (this.panel.hidden) this.disconnect(); });
    window.addEventListener("pagehide", () => this.disconnect());
  }
  status(message) { $("#browser-status").textContent = message; }
  setChat(chatId) { if (this.chatId !== chatId) { this.close(); this.chatId = chatId; } }
  open() {
    if (!this.chatId) return;
    openSidePanel("browser"); this.panel.classList.remove("expanded"); $("#expand-browser").setAttribute("aria-pressed", "false");
    this.connect();
  }
  close() { closeSidePanel("browser"); this.disconnect(); }
  accessChanged() { this.disconnect(); if (!this.panel.hidden) this.connect(); }
  disconnect() {
    const socket = this.socket; this.socket = null; socket?.close(); this.connected = false;
    this.frameVersion = (this.frameVersion || 0) + 1;
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
      if (message.error) { this.status(message.error); return; }
      if (message.event === "status") {
        this.connected = true; $("#browser-connect").hidden = true;
        this.mode = message.value.mode;
        $("#browser-new-tab").disabled = this.mode === "personal"; $("#browser-close-tab").disabled = this.mode === "personal"; $("#browser-tabs").disabled = this.mode === "personal";
        $("#browser-profile-label").textContent = this.mode === "personal" ? "Your signed-in Chrome" : "Separate profile";
        $("#browser-footnote").textContent = this.mode === "personal" ? "Signed-in sharing is ON for this chat. Localhost is your computer, not a remote worker. Turn off the top-right switch to revoke access and close the automation tab." : "You and the agent share this page. Localhost reaches the chat’s worker. Your personal Chrome and its saved logins are not connected.";
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
    this.socket.send(JSON.stringify({ id: ++this.sequence, action, params }));
  }
  navigate(value) {
    if (!value) return;
    const url = /^[a-z]+:\/\//i.test(value) || value === "about:blank" ? value : `http://${value}`;
    this.send("navigate", { url });
  }
  renderTabs(state) {
    const select = $("#browser-tabs"); select.replaceChildren();
    for (const tab of state.tabs || []) { const option = document.createElement("option"); option.value = tab.id; option.textContent = tab.title || tab.url || "New tab"; select.append(option); }
    select.value = state.tabId;
    if (document.activeElement !== $("#browser-address")) $("#browser-address").value = state.tabs?.find(tab => tab.id === state.tabId)?.url || "";
    if (state.viewport) $("#browser-viewport").value = `${state.viewport.width}x${state.viewport.height}`;
  }
  point(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(this.canvas.width - 1, (event.clientX - rect.left) * this.canvas.width / rect.width)), y: Math.max(0, Math.min(this.canvas.height - 1, (event.clientY - rect.top) * this.canvas.height / rect.height)) };
  }
  paint(frame) {
    const version = ++this.frameVersion; const image = new Image();
    image.onload = () => {
      if (this.frameVersion !== version || !this.connected) return;
      this.canvas.width = frame.width; this.canvas.height = frame.height;
      this.canvas.hidden = false; this.context.drawImage(image, 0, 0, frame.width, frame.height);
    };
    image.src = `data:image/jpeg;base64,${frame.data}`;
  }
}
