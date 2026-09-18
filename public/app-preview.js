import { directBrowserLink } from "./browser-links.js";

const states = new Set(["none", "pending", "ready", "revoking", "deleted", "error", "unavailable"]);
const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (text, action, className = "secondary-button") => { const item = node("button", text, className); item.type = "button"; item.onclick = action; return item; };
const scope = chat => chat?.id ? JSON.stringify([chat.id, chat.ownerId || null]) : null;
const loopback = host => ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost");

export function previewTarget(port, path = "/") {
  if (!String(port).length || String(port).length > 5 || /[^0-9]/.test(String(port)) || !Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error("Choose a whole-number port from 1024 to 65535.");
  if (typeof path !== "string" || path.length > 4096 || !path.startsWith("/") || path.startsWith("//") || /[\x00-\x1f\x7f\\]/.test(path))
    throw new Error("Use an app path starting with /, without a hostname, backslash or control characters.");
  const url = new URL(path, "https://preview.invalid");
  if (url.origin !== "https://preview.invalid") throw new Error("Use a path within this app.");
  if (url.pathname.startsWith("/__relay_preview/") || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(url.pathname))
    throw new Error("Use an app path outside Relay’s reserved preview endpoints, without encoded control characters.");
  const normalized = url.pathname + url.search + url.hash;
  if (normalized.length > 4096) throw new Error("Use an app path of at most 4096 characters.");
  return { port: Number(port), path: normalized };
}

export function previewAddress(address) {
  try {
    const url = new URL(address);
    if (url.protocol !== "http:" || !loopback(url.hostname) || url.username || url.password) return null;
    return previewTarget(url.port || 80, url.pathname + url.search + url.hash);
  } catch { return null; }
}

function hostname(value) {
  if (typeof value !== "string" || value.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(value) || loopback(value) || value.endsWith(".local")) return false;
  try { return new URL(`https://${value}`).hostname === value; } catch { return false; }
}

export function previewState(payload, port, relayOrigin) {
  const value = payload?.preview;
  if (!value || !states.has(value.status) || value.port !== port || typeof value.retryable !== "boolean" || typeof value.canRevoke !== "boolean")
    throw new Error("Preview status could not be verified. Refresh and try again.");
  if (value.status === "ready" && (!value.id || typeof value.id !== "string" || !hostname(value.hostname) || `https://${value.hostname}` === relayOrigin))
    throw new Error("Preview address could not be verified. Refresh and try again.");
  return { id: value.id || null, status: value.status, port, hostname: value.status === "ready" ? value.hostname : null,
    message: typeof value.message === "string" ? value.message.slice(0, 500) : "", retryable: value.retryable, canRevoke: value.canRevoke,
    pendingStep: ["create", "deploy", "disable", "delete"].includes(value.pendingStep) ? value.pendingStep : null };
}

export function previewOpenUrl(value, relayOrigin) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Preview launch address could not be verified."); }
  const keys = [...url.searchParams.keys()], launch = url.searchParams.get("launch");
  if (url.origin !== relayOrigin || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash ||
      url.pathname !== "/app-preview/open" || keys.length !== 1 || keys[0] !== "launch" || !launch || launch.length > 256 || /[^a-zA-Z0-9_-]/.test(launch))
    throw new Error("Preview launch address could not be verified.");
  return url.href;
}

export class AppPreviewDialog {
  constructor({ api, getChat, getBackend, openWindow = () => window.open("about:blank", "_blank"), pollMs = 2500, requestTimeoutMs = 30000 }) {
    Object.assign(this, { api, getChat, getBackend, openWindow, pollMs, requestTimeoutMs }); this.version = 0;
    this.dialog = node("dialog"); this.dialog.id = "app-preview-dialog"; this.dialog.setAttribute("aria-labelledby", "app-preview-title");
    const card = node("section", undefined, "dialog-card app-preview-card"), heading = node("div", undefined, "dialog-heading");
    const title = node("h2", "Open app"); title.id = "app-preview-title";
    const close = button("×", () => this.dialog.close(), "icon-button"); close.setAttribute("aria-label", "Close app preview"); heading.append(title, close);
    this.summary = node("p", "", "muted"); this.status = node("p", "", "app-preview-status"); this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    this.error = node("p", "", "app-preview-error"); this.error.setAttribute("role", "alert");
    const fields = node("div", undefined, "app-preview-fields");
    const portLabel = node("label"), pathLabel = node("label");
    this.port = node("input"); this.port.type = "number"; this.port.min = "1024"; this.port.max = "65535"; this.port.step = "1"; this.port.value = "3000"; this.port.setAttribute("aria-label", "App port");
    this.path = node("input"); this.path.type = "text"; this.path.value = "/"; this.path.maxLength = 4096; this.path.autocomplete = "off"; this.path.spellcheck = false; this.path.setAttribute("aria-label", "App path");
    portLabel.append(node("span", "App port"), this.port); pathLabel.append(node("span", "Path, query and fragment"), this.path); fields.append(portLabel, pathLabel);
    this.host = node("p", "", "muted app-preview-host");
    this.prepare = button("Set up preview", () => void this.mutate("POST"), "primary-button");
    this.launch = button("Open app ↗", () => void this.launchApp(), "primary-button");
    this.local = node("a", "Open app ↗", "primary-button"); this.local.target = "_blank"; this.local.rel = "noopener noreferrer"; this.local.referrerPolicy = "no-referrer";
    this.refresh = button("Refresh status", () => void this.load());
    this.revoke = button("Revoke preview", () => void this.mutate("DELETE"));
    const actions = node("div", undefined, "dialog-actions app-preview-actions"); actions.append(this.refresh, this.revoke, this.prepare, this.launch, this.local);
    this.note = node("p", "Opening a preview does not send an agent prompt. Start your app on the selected port first.", "muted app-preview-note");
    card.append(heading, this.summary, fields, this.status, this.host, this.error, actions, this.note); this.dialog.append(card); document.body.append(this.dialog);
    this.port.addEventListener("input", () => {
      this.invalidate(); this.info = null; this.error.textContent = ""; this.render();
      if (this.remote && this.validPort()) this.timer = setTimeout(() => void this.load(), 300);
    });
    this.path.addEventListener("input", () => { this.error.textContent = ""; this.render(); });
    this.dialog.addEventListener("close", () => { this.invalidate(); this.info = null; });
    window.addEventListener("pagehide", () => this.invalidate());
    window.addEventListener("relay-auth-required", () => this.resetIdentity());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { clearTimeout(this.timer); }
      else if (this.dialog.open && this.remote) void this.load();
    });
    window.addEventListener("focus", () => { if (this.dialog.open && this.remote && !this.operation) void this.load(); });
  }
  invalidate() {
    this.version++; clearTimeout(this.timer); this.request?.abort(); this.request = null; this.operation = null;
    try { this.pendingWindow?.close(); } catch { /* Only our still-blank pending tab. */ }
    this.pendingWindow = null;
  }
  resetIdentity() { this.invalidate(); this.chatScope = null; this.port.value = "3000"; this.path.value = "/"; this.info = null; if (this.dialog.open) this.dialog.close(); }
  setChat(chat) { if (this.chatScope && this.chatScope !== scope(chat)) this.resetIdentity(); }
  validTarget() { try { return previewTarget(this.port.value, this.path.value); } catch { return null; } }
  validPort() { try { return previewTarget(this.port.value).port; } catch { return null; } }
  current(version) { return version === this.version && this.dialog.open && this.chatScope === scope(this.getChat()); }
  endpoint() { return `/api/chats/${encodeURIComponent(this.chatId)}/app-preview`; }
  open({ address } = {}) {
    const chat = this.getChat(); if (!chat?.id) return;
    const changed = this.chatScope !== scope(chat); this.invalidate(); this.chatScope = scope(chat); this.chatId = chat.id;
    if (changed) { this.port.value = "3000"; this.path.value = "/"; }
    const target = previewAddress(address); if (target) { this.port.value = String(target.port); this.path.value = target.path; }
    this.remote = this.getBackend() === "ec2"; this.info = null; this.error.textContent = "";
    this.summary.textContent = this.remote ? "A separate, private app origin for this chat and port. First setup may take several minutes and uses AWS resources." : "Open this chat’s local app in a separate browser tab. This is not remote port forwarding.";
    this.note.textContent = this.remote ? "Each port gets a separate hostname. Opening can start this chat’s worker and incur AWS cost, but sends no agent prompt. Your app must already be configured to run on that port." : "Local workers share this computer’s ports. The chat hostname is not access control. No worker or agent prompt is started here.";
    if (!this.dialog.open) this.dialog.showModal(); this.render(); this.port.focus();
    if (this.remote) void this.load();
  }
  render() {
    const target = this.validTarget(), port = this.validPort(), busy = Boolean(this.operation), info = this.info;
    this.port.disabled = busy && this.operation !== "loading"; this.path.disabled = busy && this.operation !== "loading";
    this.local.hidden = this.remote; this.refresh.hidden = !this.remote; this.prepare.hidden = true; this.launch.hidden = true; this.revoke.hidden = true;
    this.host.textContent = ""; this.local.removeAttribute("href");
    if (!port || !this.remote && !target) {
      try { previewTarget(this.port.value, this.path.value); } catch (error) { this.status.textContent = error.message; }
      this.local.setAttribute("aria-disabled", "true"); this.refresh.disabled = true; return;
    }
    if (!this.remote) {
      const link = directBrowserLink({ address: `http://localhost:${target.port}${target.path}`, chatId: this.chatId, backend: this.getBackend(), relayOrigin: location.origin });
      this.status.textContent = link.note || link.reason; this.local.setAttribute("aria-disabled", String(!link.url));
      if (link.url) this.local.href = link.url; return;
    }
    this.refresh.disabled = busy;
    if (busy) this.status.textContent = ({ loading: "Checking preview status…", POST: "Starting preview setup…", DELETE: "Revoking preview access…", opening: "Preparing a secure app tab…" })[this.operation];
    else if (!info) this.status.textContent = "Choose a port, then refresh its preview status.";
    else this.status.textContent = info.message || ({ none: `No preview is set up for port ${port}.`, pending: "Preparing the isolated app origin. First setup can take several minutes; you can close this dialog and return.", ready: "Ready to open in a separate tab. The app must be listening on this port.", revoking: "Access revoked. Preview infrastructure cleanup is still running.", deleted: "Preview revoked. Set it up again to get a new private origin.", error: "Preview setup failed. Retry if available, or ask the operator to check the deployment.", unavailable: "Remote app previews are unavailable on this deployment." })[info.status];
    if (!info) return;
    this.prepare.hidden = !["none", "deleted"].includes(info.status) && !(info.status === "error" && info.retryable);
    this.prepare.textContent = info.status === "error" ? "Retry setup" : "Set up preview"; this.prepare.disabled = busy;
    this.launch.hidden = info.status !== "ready"; this.launch.disabled = busy || !target;
    if (!target && !busy && info.status === "ready") { try { previewTarget(this.port.value, this.path.value); } catch (error) { this.status.textContent = error.message; } }
    this.revoke.hidden = !info.canRevoke; this.revoke.disabled = busy;
    if (info.hostname) this.host.textContent = `Port ${info.port} · ${info.hostname}`;
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.dialog.open && this.remote && document.visibilityState !== "hidden" && ["pending", "ready", "revoking"].includes(this.info?.status))
      this.timer = setTimeout(() => void this.load(), this.pollMs);
  }
  async load() { return this.update("GET"); }
  async mutate(method) {
    if (this.operation || !this.info) return;
    if (method === "DELETE" && !this.info.canRevoke || method === "POST" && !["none", "deleted"].includes(this.info.status) && !(this.info.status === "error" && this.info.retryable)) return;
    return this.update(method);
  }
  async update(method) {
    if (!this.dialog.open || !this.remote || this.operation) return;
    const port = this.validPort(); if (!port) return this.render();
    clearTimeout(this.timer); const version = this.version, controller = new AbortController(); this.request = controller;
    this.operation = method === "GET" ? "loading" : method; this.error.textContent = ""; this.render();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const result = await this.api(this.endpoint() + (method === "GET" ? `?port=${port}` : ""), { method, signal: controller.signal,
        ...(method === "GET" ? {} : { body: JSON.stringify({ port }) }) });
      if (!this.current(version)) return;
      this.info = previewState(result, port, location.origin);
    } catch {
      if (this.current(version)) { this.info = null; this.error.textContent = method === "DELETE" ? "Revocation could not be confirmed. Refresh status before trying again." : method === "POST" ? "Setup could not be confirmed. Refresh status before retrying; provisioning may still be running." : "Preview status is unavailable. Check your sign-in or deployment, then refresh."; }
    } finally {
      clearTimeout(timeout);
      if (this.current(version)) { this.request = null; this.operation = null; this.render(); this.schedule(); }
    }
  }
  async launchApp() {
    if (this.operation || this.info?.status !== "ready" || !this.dialog.open) return;
    const target = this.validTarget(); if (!target) return this.render();
    const version = this.version, controller = new AbortController();
    let popup;
    try {
      popup = this.openWindow(); if (!popup) throw new Error("blocked");
      popup.opener = null;
      const referrer = popup.document.createElement("meta"); referrer.name = "referrer"; referrer.content = "no-referrer"; popup.document.head.append(referrer);
      popup.document.title = "Opening app preview"; popup.document.body.textContent = "Preparing your private app preview…";
    } catch { try { popup?.close(); } catch {} this.error.textContent = "Allow popups for Relay, then choose Open app again. No preview access was issued."; return; }
    this.pendingWindow = popup; this.request = controller; this.operation = "opening"; clearTimeout(this.timer); this.error.textContent = ""; this.render();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const result = await this.api(this.endpoint() + "/open", { method: "POST", body: JSON.stringify(target), signal: controller.signal });
      if (!this.current(version) || popup.closed) { popup.close(); return; }
      const url = previewOpenUrl(result.url, location.origin);
      // Navigate from a no-referrer anchor in the new document. Calling its
      // Location from Relay can still use the opener document's referrer policy.
      const link = popup.document.createElement("a"); link.href = url; link.rel = "noreferrer"; link.referrerPolicy = "no-referrer";
      popup.document.body.append(link); link.click(); this.pendingWindow = null;
      this.status.textContent = "App tab opened. Access expires automatically; open again here to reconnect.";
    } catch {
      try { popup.close(); } catch {}
      if (this.current(version)) this.error.textContent = "The app tab could not be opened. Refresh preview status and try again; the worker or your access may have changed.";
    } finally {
      clearTimeout(timeout);
      if (this.pendingWindow === popup) this.pendingWindow = null;
      if (this.current(version)) { this.request = null; this.operation = null; this.render(); this.schedule(); }
    }
  }
}
