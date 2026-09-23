import { ProjectionPolicy } from './projection-policy.js';
// No content scripts, cookie API, profile export, or access to existing tabs.
// Only an explicitly authorized, extension-created automation tab is debugged.
let socket, saved, tabId = null, grantId = null, chatTitle = "", heartbeat, reconnectTimer, watching = false;
let viewport = { width: 1280, height: 800 };
let transition = 0, pendingAuthorization = null;
let projection = null;
let dialogOpen = false;
let interactions = 0;
let lastStreamData = null;
let pendingFrame = null, deliveryTimer;
let pendingStream = null, streamTimer;
let layoutQueue = Promise.resolve(), captureVersion = 0, captureTimer, capturing = false, lastFrameAt = 0, streamStartedAt = 0;
const pixelRatio = ({ width, height }) => width * height <= 2097152 ? 2 : 1;
function updateLayout(action) {
  const pending = layoutQueue.then(action); layoutQueue = pending.catch(() => {}); return pending;
}
function invalidateFrames() {
  captureVersion++; clearTimeout(captureTimer); captureTimer = null; lastStreamData = null;
  pendingFrame = null; clearTimeout(deliveryTimer); deliveryTimer = null;
  pendingStream = null; clearTimeout(streamTimer); streamTimer = null;
}
function streamFrame(data, expected) {
  if (data === pendingStream?.data || !pendingStream && data === lastStreamData) return;
  pendingStream = { data, mimeType: "image/jpeg", ...viewport }; requestFrame();
  if (streamTimer) return;
  const startedAt = streamStartedAt;
  const flush = () => {
    streamTimer = null; const frame = pendingStream; pendingStream = null;
    if (!frame || !watching || grantId !== expected || capturing || dialogOpen || streamStartedAt !== startedAt || frame.data === lastStreamData) return;
    lastFrameAt = Date.now(); lastStreamData = frame.data; deliverFrame(frame, expected);
  };
  const delay = Math.max(0, 32 - (Date.now() - lastFrameAt));
  if (delay) streamTimer = setTimeout(flush, delay); else flush();
}
function deliverFrame(value, expected) {
  if (!watching || grantId !== expected || socket?.readyState !== WebSocket.OPEN) return;
  pendingFrame = { value, expected };
  const flush = () => {
    deliveryTimer = null;
    if (!pendingFrame || !watching || grantId !== pendingFrame.expected || socket?.readyState !== WebSocket.OPEN) { pendingFrame = null; return; }
    if (socket.bufferedAmount >= 256 * 1024) { deliveryTimer = setTimeout(flush, 32); return; }
    const next = pendingFrame; pendingFrame = null;
    send({ event: "frame", grantId: next.expected, value: next.value });
  };
  if (!deliveryTimer) flush();
}
function requestFrame() {
  if (!watching || !grantId || dialogOpen) return;
  const version = ++captureVersion, expected = grantId;
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    void updateLayout(async () => {
      if (!watching || grantId !== expected || dialogOpen || interactions || version !== captureVersion) return;
      const size = { ...viewport }; capturing = true;
      try {
        const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, expected);
        if (watching && grantId === expected && captureVersion === version)
          deliverFrame({ data, mimeType: "image/png", ...size }, expected);
      } finally { capturing = false; }
    }).catch(() => {});
  }, 350);
}
async function setWatching(enabled, expected) {
  if (grantId !== expected) throw Error("Agent access changed");
  watching = enabled; invalidateFrames();
  await cdp("Page.stopScreencast", {}, expected).catch(() => {});
  if (watching) {
    lastFrameAt = 0; lastStreamData = null; streamStartedAt = Date.now() / 1000;
    await cdp("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 }, expected);
    if (grantId === expected) requestFrame();
  }
  return {};
}
// MV3 event listeners must register synchronously. Top-level await prevents
// Chrome's service worker from starting and leaves popup messages unanswered.
const initialized = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .then(() => chrome.storage.local.get("connection"))
  .then(value => { saved = value.connection; if (saved) void connect().catch(() => {}); });
const send = value => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
const safeUrl = value => {
  const url = new URL(value);
  if (url.href !== "about:blank" && !["http:", "https:"].includes(url.protocol)) throw Error("Only HTTP and HTTPS websites can be shared");
  if (url.username || url.password) throw Error("Do not include credentials in addresses");
  // Cookies are host-scoped, not port-scoped: protect the controller hostname
  // even on another port, including redirects and subresources (Fetch below).
  if (url.hostname && url.hostname === new URL(saved.url).hostname) throw Error("The Agent Relay hostname cannot be opened in signed-in sharing. Use guest Chrome for that host.");
  return url.href;
};
const cdp = (method, params = {}, expected = grantId) => {
  if (!expected || grantId !== expected || tabId === null) throw Error("Agent access is off or changed");
  return chrome.debugger.sendCommand({ tabId }, method, params);
};
async function state(expected = grantId) {
  if (tabId === null) return { running: false, mode: "personal", tabs: [] };
  const info = await evaluate("({title:document.title,url:location.href})", expected);
  if (expected !== grantId) throw Error("Agent access changed");
  return { running: true, mode: "personal", tabId: String(tabId), tabs: [{ id: String(tabId), title: info.title || "Signed-in Chrome", url: info.url || "about:blank" }], viewport, captureVersion: 3 };
}
async function revoke(notify = true, invalidate = true) {
  projection = null;
  const previousGrant = grantId || pendingAuthorization;
  if (invalidate) { transition++; pendingAuthorization = null; }
  const previous = tabId; grantId = null; tabId = null; watching = false; dialogOpen = false; chatTitle = "";
  invalidateFrames();
  await chrome.action.setBadgeText({ text: "" });
  if (previous !== null) {
    await chrome.debugger.detach({ tabId: previous }).catch(() => {});
    await chrome.tabs.remove(previous).catch(() => {});
  }
  if (notify && previousGrant) send({ type: "revoked", grantId: previousGrant });
}
async function authorize(id, params) {
  const version = ++transition; pendingAuthorization = id;
  await revoke(false, false);
  if (version !== transition) throw Error("Access cancelled");
  pendingAuthorization = null;
  grantId = id; chatTitle = String(params.chatTitle || "Chat").slice(0, 120);
  try {
    const tab = await chrome.tabs.create({ url: "about:blank", active: true });
    if (grantId !== id) { await chrome.tabs.remove(tab.id); throw Error("Access cancelled"); }
    tabId = tab.id;
    await chrome.debugger.attach({ tabId }, "1.3");
    if (grantId !== id) throw Error("Access cancelled");
    await cdp("Page.enable", {}, id); await cdp("Runtime.enable", {}, id);
    await cdp("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, id);
    await cdp("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: pixelRatio(viewport), mobile: false }, id);
    if (grantId !== id) throw Error("Access cancelled");
    await chrome.action.setBadgeText({ text: "ON" }); await chrome.action.setBadgeBackgroundColor({ color: "#d3992f" });
    return state(id);
  } catch (error) { if (grantId === id) await revoke(); throw error; }
}
async function evaluate(expression, expected = grantId) {
  if (typeof expression !== "string" || expression.length > 30000) throw Error("Invalid browser expression");
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 10000 }, expected);
  if (grantId !== expected) throw Error("Agent access changed");
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value ?? null;
}
async function command(action, params = {}, expected = grantId) {
  if (!expected || grantId !== expected || tabId === null) throw Error("Agent access is off or changed");
  const input = ["mouse", "key", "text", "navigate", "reload", "back", "forward"].includes(action);
  if (input) { interactions++; requestFrame(); }
  try { return await dispatchCommand(action, params, expected); }
  finally { if (input) { interactions--; if (grantId === expected) requestFrame(); } }
}
async function dispatchCommand(action, params, expected) {
  const call = (method, parameters) => cdp(method, parameters, expected);
  const read = expression => evaluate(expression, expected);
  switch (action) {
    case "status": return state(expected);
    case "navigate": { const result = await updateLayout(() => call("Page.navigate", { url: safeUrl(params.url) })); if (result.errorText) throw Error(result.errorText); return {}; }
    case "reload": return updateLayout(() => call("Page.reload", { ignoreCache: params.ignoreCache === true }));
    case "back": case "forward": { const h = await call("Page.getNavigationHistory"); const entry = h.entries[h.currentIndex + (action === "back" ? -1 : 1)]; if (entry) { safeUrl(entry.url); await updateLayout(() => call("Page.navigateToHistoryEntry", { entryId: entry.id })); } return {}; }
    case "resize": {
      const { width, height } = params;
      if (!Number.isInteger(width) || width < 320 || width > 2560 || !Number.isInteger(height) || height < 240 || height > 1600) throw Error("Invalid viewport");
      return updateLayout(async () => {
        const wasWatching = watching;
        await setWatching(false, expected);
        await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: pixelRatio(params), mobile: false });
        if (grantId !== expected) throw Error("Agent access changed");
        viewport = { width, height };
        if (wasWatching) await setWatching(true, expected);
        const resized = await state(expected); send({ event: "status", grantId: expected, value: resized }); return resized;
      });
    }
    case "watch": return updateLayout(() => setWatching(params.enabled === true, expected));
    case "screenshot": return updateLayout(async () => ({ ...await call("Page.captureScreenshot", { format: "png" }), ...viewport }));
    case "evaluate": return read(params.expression);
    case "snapshot": {
      const { nodes } = await call("Accessibility.getFullAXTree");
      return { nodes: nodes.filter(n => !n.ignored).slice(0, 1200).map(n => ({ id: n.backendDOMNodeId, role: n.role?.value, name: n.name?.value, children: n.childIds })) };
    }
    case "click": case "fill": {
      if (typeof params.selector !== "string" || params.selector.length > 2000) throw Error("Invalid selector");
      const selector = JSON.stringify(params.selector);
      if (action === "fill") { await read(`(()=>{const e=document.querySelector(${selector});if(!e)throw Error('Element not found');e.focus();e.select?.()})()`); return command("text", { text: params.text }, expected); }
      const point = await read(`(()=>{const e=document.querySelector(${selector});if(!e)throw Error('Element not found');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await command("mouse", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 }, expected);
      await command("mouse", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }, expected); return {};
    }
    case "text": if (typeof params.text !== "string" || params.text.length > 30000) throw Error("Invalid input text"); return updateLayout(() => call("Input.insertText", { text: params.text }));
    case "key": {
      if (!["keyDown", "keyUp", "rawKeyDown"].includes(params.type) || typeof params.key !== "string" || params.key.length > 40) throw Error("Invalid key");
      return updateLayout(() => call("Input.dispatchKeyEvent", { type: params.type, key: params.key, code: String(params.code || "").slice(0, 40), windowsVirtualKeyCode: Number(params.keyCode) & 255, modifiers: Number(params.modifiers) & 15, ...(typeof params.text === "string" && params.text.length <= 4 ? { text: params.text } : {}) }));
    }
    case "mouse": {
      if (!["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(params.type) || ![params.x, params.y].every(Number.isFinite)) throw Error("Invalid pointer event");
      return updateLayout(() => call("Input.dispatchMouseEvent", { type: params.type, x: Math.max(0, Math.min(viewport.width, params.x)), y: Math.max(0, Math.min(viewport.height, params.y)), button: ["left", "middle", "right"].includes(params.button) ? params.button : "none", buttons: Number(params.buttons) & 7, modifiers: Number(params.modifiers) & 15,
        ...(params.type === "mouseWheel" ? { deltaX: Math.max(-3000, Math.min(3000, Number(params.deltaX) || 0)), deltaY: Math.max(-3000, Math.min(3000, Number(params.deltaY) || 0)) } : { clickCount: Math.max(0, Math.min(3, Number(params.clickCount) || 0)) }) }));
    }
    case "dialog": return call("Page.handleJavaScriptDialog", { accept: params.accept === true, promptText: String(params.text || "").slice(0, 4000) });
    default: throw Error("Unsupported browser action");
  }
}
async function project(params, expected) {
  if (!expected || grantId !== expected || tabId === null) throw Error('Browser projection revoked');
  if (!params || Object.getPrototypeOf(params) !== Object.prototype || Object.keys(params).some(key => !(params.operation === 'command' ? ['operation','id','method','params'] : ['operation','id']).includes(key))) throw Error('Browser projection denied');
  if (params.operation === 'open') {
    if (projection || typeof params.id !== 'string' || !/^[a-f0-9-]{36}$/.test(params.id)) throw Error('Browser projection unavailable');
    const current = { id:params.id, policy:new ProjectionPolicy() }; projection = current;
    try {
      const tree = await cdp('Page.getFrameTree', {}, expected); current.policy.result('Page.getFrameTree', tree);
      await cdp('Runtime.disable', {}, expected);
      if (projection !== current || grantId !== expected) throw Error('Browser projection revoked');
      return { frame:tree.frameTree.frame };
    } catch (error) { if (projection === current) projection = null; throw error; }
  }
  if (!projection || params.id !== projection.id) throw Error('Browser projection unavailable');
  if (params.operation === 'close') { projection = null; return {}; }
  if (params.operation !== 'command') throw Error('Browser projection denied');
  const current = projection, method = params.method, input = current.policy.command(method, params.params);
  if (method === 'Page.navigate') input.url = safeUrl(input.url);
  if (method === 'Page.navigateToHistoryEntry') {
    const history = await cdp('Page.getNavigationHistory',{},expected);
    const entry = history.entries.find(entry => entry.id === input.entryId); if (!entry) throw Error('Unknown history entry'); safeUrl(entry.url);
  }
  const result = await cdp(method,input,expected);
  if (projection !== current || grantId !== expected) throw Error('Browser projection revoked');
  return current.policy.result(method,result);
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== tabId || !grantId) return;
  const expected = grantId;
  // No auto-attachment to child targets in this first slice. A foreign/debugger
  // child session cannot be promoted by presenting its ID in a request.
  if (projection && !source.sessionId) {
    try { const value = projection.policy.event(method,params); if (value) send({event:'projection',grantId:expected,value:{id:projection.id,method,params:value}}); }
    catch { projection = null; send({event:'projectionClosed',grantId:expected}); }
  }
  if (method === "Fetch.requestPaused") {
    let allowed = false; try { safeUrl(params.request.url); allowed = true; } catch {}
    void cdp(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => {});
  }
  if (method === "Page.screencastFrame") {
    void cdp("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    if (watching && !dialogOpen && !capturing && params.metadata?.timestamp >= streamStartedAt && params.metadata?.deviceWidth === viewport.width && params.metadata?.deviceHeight === viewport.height) {
      streamFrame(params.data, expected);
    }
  }
  if (method === "Page.javascriptDialogOpening") { dialogOpen = true; send({ event: "dialog", grantId, value: params }); }
  if (method === "Page.javascriptDialogClosed") { dialogOpen = false; requestFrame(); }
  if (["Page.frameNavigated", "Page.loadEventFired", "Page.domContentEventFired", "Page.navigatedWithinDocument"].includes(method)) requestFrame();
  if (["Page.frameNavigated", "Page.loadEventFired", "Page.navigatedWithinDocument"].includes(method)) void state(expected).then(value => { if (grantId === expected) send({ event: "status", grantId: expected, value }); }).catch(() => {});
});
chrome.debugger.onDetach.addListener(source => { if (source.tabId === tabId) void revoke(); });
chrome.tabs.onRemoved.addListener(id => { if (id === tabId) void revoke(); });
// Keep automation confined to one tab. Website sign-in popups should be used
// normally in personal Chrome before sharing, not left running after revoke.
chrome.tabs.onCreated.addListener(tab => { if (tabId !== null && tab.openerTabId === tabId) void chrome.tabs.remove(tab.id).catch(() => {}); });
async function connect(pairing) {
  clearTimeout(reconnectTimer); socket?.close(); clearInterval(heartbeat); await revoke(false);
  if (!saved?.url && !pairing) return;
  const origin = new URL(pairing?.url || saved.url);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) throw Error("Use HTTPS, or a loopback HTTP address");
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw Error("Enter only the Agent Relay origin, without a path or credentials");
  const wsUrl = new URL("/browser/connect", origin); wsUrl.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const current = new WebSocket(wsUrl); socket = current;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { current.close(); reject(Error("Pairing timed out")); }, 10000);
    current.onopen = () => current.send(JSON.stringify(pairing ? { type: "pair", code: pairing.code } : { type: "connect", id: saved.id, token: saved.token }));
    current.onmessage = async event => {
      if (socket !== current) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.event === "error") { clearTimeout(timer); reject(Error(message.message)); return; }
      if (message.event === "connected") {
        clearTimeout(timer);
        saved = { url: origin.origin, id: message.id, token: message.token || saved.token, name: message.name };
        await chrome.storage.local.set({ connection: saved });
        send({ type: "availability", tabSelected: true });
        heartbeat = setInterval(() => send({ type: "ping" }), 20000); resolve({ ok: true }); return;
      }
      if (!Number.isInteger(message.id)) return;
      try {
        let value;
        if (message.action === "revoke") { if (grantId === message.grantId || pendingAuthorization === message.grantId) await revoke(false); value = {}; }
        else if (message.action === "authorize") value = await authorize(message.grantId, message.params);
        else { if (!grantId || grantId !== message.grantId) throw Error("Agent access is off"); value = message.action === 'project' ? await project(message.params,message.grantId) : await command(message.action, message.params, message.grantId); if (grantId !== message.grantId) throw Error("Agent access revoked"); }
        send({ id: message.id, grantId: message.grantId, value });
      } catch (error) { send({ id: message.id, grantId: message.grantId, error: error.message }); }
    };
    current.onerror = () => { clearTimeout(timer); reject(Error("Could not reach Agent Relay")); };
    current.onclose = event => {
      clearTimeout(timer); if (socket !== current) return;
      socket = null; clearInterval(heartbeat); void revoke(false); reject(Error("Connection closed"));
      if (saved && event.code !== 1008) reconnectTimer = setTimeout(() => { void connect().catch(() => {}); }, 5000);
    };
  });
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return false;
  void (async () => {
    await initialized;
    switch (message.type) {
      case "status": return { name: saved?.name, online: socket?.readyState === WebSocket.OPEN, sharing: Boolean(grantId), chatTitle };
      case "pair": return connect({ url: message.url, code: message.code });
      case "reconnect": return connect();
      case "revoke": await revoke(); return {};
      case "disconnect": saved = null; clearTimeout(reconnectTimer); await chrome.storage.local.remove("connection"); await revoke(); socket?.close(); return {};
      default: throw Error("Unsupported action");
    }
  })().then(reply, error => reply({ error: error.message }));
  return true;
});
