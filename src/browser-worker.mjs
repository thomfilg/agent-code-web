// Standalone worker: only Node built-ins, also sent over SSH to cloud workers.
// Chrome uses private pipe descriptors, never a remotely reachable debug port.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";

export class ChromeBrowser extends EventEmitter {
  constructor({ executable = "google-chrome", profile = null } = {}) {
    super(); this.executable = executable; this.profile = profile;
    this.pending = new Map(); this.sequence = 0; this.viewport = { width: 1280, height: 800 }; this.watching = false;
    this.layoutQueue = Promise.resolve(); this.captureVersion = 0; this.lastFrameAt = 0;
  }
  async start() {
    this.directory = this.profile || await mkdtemp(path.join(os.tmpdir(), "relay-chrome-"));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.temporary = !this.profile;
    this.child = spawn(this.executable, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${this.directory}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-dev-shm-usage", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: this.directory, LANG: "C.UTF-8" } });
    this.child.stdio[3].on("error", () => {});
    this.child.stderr.on("data", chunk => { this.diagnostics = ((this.diagnostics || "") + chunk).slice(-2000); });
    this.child.once("error", error => this.fail(error));
    this.child.once("exit", () => this.fail(new Error(this.closing ? "Browser stopped" : `Chrome exited. Check installation and sandbox support. ${this.diagnostics || ""}`)));
    let buffer = "";
    this.child.stdio[4].setEncoding("utf8");
    this.child.stdio[4].on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 48 * 1024 * 1024) { this.fail(new Error("Chrome response exceeded limit")); return; }
      let end;
      while ((end = buffer.indexOf("\0")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { this.receive(JSON.parse(frame)); } catch { /* Ignore malformed protocol messages. */ }
      }
    });
    await this.call("Browser.getVersion");
    await this.call("Browser.setDownloadBehavior", { behavior: "deny" });
    await this.call("Target.setDiscoverTargets", { discover: true });
    const tabs = await this.tabs();
    await this.select(tabs[0]?.id || (await this.call("Target.createTarget", { url: "about:blank" })).targetId);
    return this.status();
  }
  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    if (!this.failed) { this.failed = error; this.emit("closed", { message: this.closing ? "Browser stopped" : error.message }); }
  }
  receive(message) {
    if (message.id) {
      const item = this.pending.get(message.id); if (!item) return;
      this.pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result || {});
      return;
    }
    if (message.method === "Page.screencastFrame") {
      void this.call("Page.screencastFrameAck", { sessionId: message.params.sessionId }, message.sessionId).catch(() => {});
      if (this.watching && !this.dialogOpen && !this.capturing && message.sessionId === this.sessionId) {
        const { data, metadata } = message.params;
        // Frames from a stopped stream can arrive after a resize. Never label
        // an old bitmap with the new CSS viewport or draw over an idle refine.
        if (metadata?.timestamp < this.streamStartedAt || metadata?.deviceWidth !== this.viewport.width || metadata?.deviceHeight !== this.viewport.height) return;
        this.streamFrame(data);
      }
    }
    if (message.sessionId === this.sessionId) {
      if (message.method === "Page.javascriptDialogOpening") { this.dialogOpen = true; this.emit("dialog", message.params); }
      if (message.method === "Page.javascriptDialogClosed") { this.dialogOpen = false; this.requestFrame(); }
      if (["Page.loadEventFired", "Page.domContentEventFired", "Page.frameNavigated", "Page.navigatedWithinDocument"].includes(message.method)) this.requestFrame();
    }
    if (["Target.targetCreated", "Target.targetDestroyed", "Target.targetInfoChanged"].includes(message.method)) {
      clearTimeout(this.tabsTimer);
      this.tabsTimer = setTimeout(() => { void this.status().then(value => this.emit("status", value)).catch(() => {}); }, 50);
    }
  }
  call(method, params = {}, sessionId) {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome ${method} timed out`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }
  page(method, params) {
    if (!this.sessionId) throw new Error("Choose a browser tab first");
    return this.call(method, params, this.sessionId);
  }
  async tabs() {
    const { targetInfos } = await this.call("Target.getTargets");
    return targetInfos.filter(tab => tab.type === "page").map(tab => ({ id: tab.targetId, title: tab.title.slice(0, 300), url: tab.url.slice(0, 4000) }));
  }
  async status() { return { running: !this.failed, tabId: this.tabId, tabs: await this.tabs(), viewport: this.viewport, mode: "guest", captureVersion: 3 }; }
  updateLayout(action) {
    const pending = this.layoutQueue.then(action);
    this.layoutQueue = pending.catch(() => {}); return pending;
  }
  select(targetId) { return this.updateLayout(() => this.selectPage(targetId)); }
  async selectPage(targetId) {
    if (!(await this.tabs()).some(tab => tab.id === targetId)) throw new Error("Browser tab no longer exists");
    const wasWatching = this.watching;
    if (this.sessionId) {
      await this.setWatching(false);
      await this.call("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {});
    }
    this.sessionId = (await this.call("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    this.tabId = targetId;
    await this.page("Page.enable");
    await this.page("Runtime.enable");
    await this.page("Page.bringToFront");
    await this.setViewport(this.viewport);
    if (wasWatching) await this.setWatching(true);
    const status = await this.status(); this.emit("status", status); return status;
  }
  resize(params) { return this.updateLayout(() => this.setViewport(params)); }
  async setViewport({ width, height }) {
    if (!Number.isInteger(width) || width < 320 || width > 2560 || !Number.isInteger(height) || height < 240 || height > 1600) throw new Error("Viewport must be 320–2560 by 240–1600 pixels");
    const wasWatching = this.watching;
    await this.setWatching(false);
    // Retina-quality presets, with a bounded bitmap size for large custom views.
    const deviceScaleFactor = width * height <= 2097152 ? 2 : 1;
    await this.page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
    this.viewport = { width, height };
    if (wasWatching) await this.setWatching(true);
    this.emit("status", await this.status());
    return this.viewport;
  }
  watch(enabled) { return this.updateLayout(() => this.setWatching(enabled)); }
  streamFrame(data) {
    if (data === this.pendingStream?.data || !this.pendingStream && data === this.lastStreamData) return;
    this.pendingStream = { data, mimeType: "image/jpeg", ...this.viewport };
    this.requestFrame();
    if (this.streamTimer) return;
    const startedAt = this.streamStartedAt;
    const flush = () => {
      this.streamTimer = null; const frame = this.pendingStream; this.pendingStream = null;
      if (!frame || !this.watching || this.capturing || this.dialogOpen || this.streamStartedAt !== startedAt || frame.data === this.lastStreamData) return;
      this.lastFrameAt = Date.now(); this.lastStreamData = frame.data; this.emit("frame", frame);
    };
    const delay = Math.max(0, 32 - (Date.now() - this.lastFrameAt));
    if (delay) this.streamTimer = setTimeout(flush, delay); else flush();
  }
  async setWatching(enabled) {
    this.watching = Boolean(enabled);
    this.captureVersion++; clearTimeout(this.captureTimer); this.captureTimer = null;
    clearTimeout(this.streamTimer); this.streamTimer = null; this.pendingStream = null; this.lastStreamData = null;
    await this.page("Page.stopScreencast").catch(() => {});
    if (this.watching) {
      // Use Chrome's compressed stream while interacting. Full-resolution PNG
      // is an idle refinement, not a prerequisite for every input or repaint.
      this.lastFrameAt = 0; this.lastStreamData = null; this.streamStartedAt = Date.now() / 1000;
      await this.page("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1 });
      this.requestFrame();
    }
    return { watching: this.watching };
  }
  requestFrame() {
    if (!this.watching || this.closing || this.dialogOpen) return;
    const version = ++this.captureVersion;
    clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null;
      // Chrome temporarily adjusts its surface during capture. Serialize with
      // viewport changes and input so its cleanup cannot undo a later resize.
      void this.updateLayout(async () => {
        if (!this.watching || this.closing || this.dialogOpen || this.interactions || version !== this.captureVersion) return;
        const viewport = { ...this.viewport }; this.capturing = true;
        try {
          const { data } = await this.page("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          if (this.watching && !this.closing && version === this.captureVersion) { this.captureError = null; this.emit("frame", { data, mimeType: "image/png", ...viewport }); }
        } finally { this.capturing = false; }
      }).catch(error => { this.captureError = error.message; });
    }, 350);
  }
  async evaluate(expression) {
    if (typeof expression !== "string" || expression.length > 30000) throw new Error("Invalid browser expression");
    const result = await this.page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 10000 });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value ?? null;
  }
  async command(action, params = {}) {
    const input = ["mouse", "key", "text", "navigate", "reload", "back", "forward"].includes(action);
    if (input) { this.interactions = (this.interactions || 0) + 1; this.requestFrame(); }
    try { return await this.dispatchCommand(action, params); }
    finally { if (input) { this.interactions--; this.requestFrame(); } }
  }
  async dispatchCommand(action, params = {}) {
    switch (action) {
      case "status": return this.status();
      case "watch": return this.watch(params.enabled);
      case "resize": return this.resize(params);
      case "navigate": {
        const url = new URL(params.url);
        if (!["http:", "https:"].includes(url.protocol) && url.href !== "about:blank") throw new Error("Use an HTTP or HTTPS website address");
        if (url.username || url.password) throw new Error("Do not put credentials in browser addresses");
        const result = await this.updateLayout(() => this.page("Page.navigate", { url: url.href }));
        if (result.errorText) throw new Error(result.errorText);
        return { url: url.href };
      }
      case "reload": await this.updateLayout(() => this.page("Page.reload", { ignoreCache: params.ignoreCache === true })); return {};
      case "back": case "forward": {
        const history = await this.page("Page.getNavigationHistory");
        const entry = history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
        if (entry) await this.updateLayout(() => this.page("Page.navigateToHistoryEntry", { entryId: entry.id }));
        return {};
      }
      case "newTab": return this.updateLayout(async () => this.selectPage((await this.call("Target.createTarget", { url: "about:blank" })).targetId));
      case "selectTab": return this.select(params.id);
      case "closeTab": return this.updateLayout(async () => {
        if (!(await this.tabs()).some(tab => tab.id === params.id)) throw new Error("Unknown browser tab");
        const current = params.id === this.tabId;
        await this.call("Target.closeTarget", { targetId: params.id });
        if (current) { const tabs = await this.tabs(); return this.selectPage(tabs[0]?.id || (await this.call("Target.createTarget", { url: "about:blank" })).targetId); }
        return this.status();
      });
      case "mouse": {
        if (!["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(params.type)) throw new Error("Invalid pointer event");
        const { x, y } = params;
        if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > this.viewport.width || y > this.viewport.height) throw new Error("Pointer outside browser viewport");
        const button = ["left", "right", "middle"].includes(params.button) ? params.button : "none";
        await this.updateLayout(() => this.page("Input.dispatchMouseEvent", { type: params.type, x, y, button, buttons: Number(params.buttons) & 7, modifiers: Number(params.modifiers) & 15,
          ...(params.type === "mouseWheel" ? { deltaX: Math.max(-3000, Math.min(3000, Number(params.deltaX) || 0)), deltaY: Math.max(-3000, Math.min(3000, Number(params.deltaY) || 0)) } : { clickCount: Math.min(3, Math.max(0, Number(params.clickCount) || 0)) }) }));
        return {};
      }
      case "key": {
        if (!["keyDown", "keyUp", "rawKeyDown"].includes(params.type) || typeof params.key !== "string" || params.key.length > 40) throw new Error("Invalid key event");
        await this.updateLayout(() => this.page("Input.dispatchKeyEvent", { type: params.type, key: params.key, code: String(params.code || "").slice(0, 40), windowsVirtualKeyCode: Number(params.keyCode) & 255,
          modifiers: Number(params.modifiers) & 15, ...(typeof params.text === "string" && params.text.length <= 4 ? { text: params.text } : {}) })); return {};
      }
      case "text":
        if (typeof params.text !== "string" || params.text.length > 30000) throw new Error("Text exceeds 30,000 characters");
        await this.updateLayout(() => this.page("Input.insertText", { text: params.text })); return {};
      case "dialog": await this.page("Page.handleJavaScriptDialog", { accept: params.accept === true, promptText: String(params.text || "").slice(0, 4000) }); return {};
      case "screenshot": return this.updateLayout(async () => ({ ...(await this.page("Page.captureScreenshot", { format: "png" })), ...this.viewport }));
      case "evaluate": return this.evaluate(params.expression);
      case "snapshot": {
        const { nodes } = await this.page("Accessibility.getFullAXTree");
        return { url: await this.evaluate("location.href"), nodes: nodes.filter(node => !node.ignored).slice(0, 1200).map(node => ({ id: node.backendDOMNodeId,
          role: node.role?.value, name: node.name?.value, value: node.role?.value === "textbox" && node.properties?.some(p => p.name === "protected" && p.value.value) ? undefined : node.value?.value,
          children: node.childIds, properties: node.properties?.filter(p => ["checked", "disabled", "expanded", "level"].includes(p.name)) })) };
      }
      case "click": case "fill": {
        if (typeof params.selector !== "string" || params.selector.length > 2000) throw new Error("A CSS selector is required");
        const selector = JSON.stringify(params.selector);
        if (action === "fill") {
          await this.evaluate(`(() => {const e=document.querySelector(${selector});if(!e)throw Error('Element not found');e.focus();e.select?.();return true})()`);
          return this.command("text", { text: params.text });
        }
        const point = await this.evaluate(`(() => {const e=document.querySelector(${selector});if(!e)throw Error('Element not found');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await this.command("mouse", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
        await this.command("mouse", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 }); return {};
      }
      default: throw new Error("Unknown browser action");
    }
  }
  async stop() {
    if (this.closing) return this.stopping;
    this.closing = true;
    this.watching = false; this.captureVersion++; clearTimeout(this.captureTimer); clearTimeout(this.streamTimer); this.pendingStream = null; this.lastStreamData = null;
    this.stopping = (async () => {
      clearTimeout(this.tabsTimer);
      if (this.child?.pid && this.child.exitCode === null && !this.child.signalCode) {
        const ended = new Promise(resolve => this.child.once("exit", resolve));
        void this.call("Browser.close").catch(() => {});
        const kill = setTimeout(() => this.child.kill("SIGKILL"), 3000);
        await ended; clearTimeout(kill);
      }
      this.fail(new Error("Browser stopped"));
      if (this.temporary && this.directory) await rm(this.directory, { recursive: true, force: true });
    })();
    return this.stopping;
  }
}

export async function runBrowserWorker() {
  const browser = new ChromeBrowser({ executable: process.env.AGENT_CHROME_BIN || "google-chrome" });
  const send = message => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(message) + "\n"); };
  let latestFrame = null, writingFrame = false;
  const flushFrame = () => {
    if (writingFrame || !latestFrame || process.stdout.destroyed) return;
    const value = latestFrame; latestFrame = null; writingFrame = true;
    process.stdout.write(JSON.stringify({ event: "frame", value }) + "\n", () => { writingFrame = false; flushFrame(); });
  };
  for (const type of ["status", "dialog", "closed"]) browser.on(type, value => send({ event: type, value }));
  browser.on("frame", value => { latestFrame = value; flushFrame(); });
  const close = async () => { await browser.stop(); process.exit(0); };
  process.once("SIGTERM", close); process.once("SIGINT", close);
  try { send({ event: "ready", value: await browser.start() }); }
  catch (error) { send({ event: "fatal", value: { message: error.message } }); await close(); return; }
  const input = createInterface({ input: process.stdin });
  input.on("line", line => {
    if (line.length > 100000) return;
    let message; try { message = JSON.parse(line); } catch { return; }
    if (!Number.isInteger(message.id)) return;
    void browser.command(message.action, message.params).then(value => send({ id: message.id, value }), error => send({ id: message.id, error: error.message }));
  });
  input.once("close", close);
}
