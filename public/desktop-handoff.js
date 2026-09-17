import { companyForChat } from "./company-scope.js";

const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (text, action) => { const item = node("button", text); item.type = "button"; item.addEventListener("click", action); return item; };
const link = (text, href) => { const item = node("a", text); item.href = href; item.rel = "noopener noreferrer"; item.referrerPolicy = "no-referrer"; if (href.startsWith("https:")) item.target = "_blank"; return item; };
const scope = chat => JSON.stringify(chat && [chat.id, chat.ownerId, chat.agent, chat.agentSessionId, chat.workspace, chat.environmentId, companyForChat(chat), chat.runtimeMetadata]);
const sessionUrl = id => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id || "") ? `codex://threads/${id}` : null;

export class DesktopHandoff {
  constructor({ state, api, controls }) { Object.assign(this, { state, api, controls }); }
  render() {
    document.querySelector("#desktop-app-button").hidden = this.state.active?.agent !== "codex";
    this.checkPanel?.();
  }
  resetIdentity() { this.invalidate?.("The Relay account changed. Close and reopen the desktop handoff."); }
  async open() {
    this.dispose?.();
    const chat = this.state.active;
    if (chat?.agent !== "codex") throw new Error("Desktop handoff requires a Codex chat");
    const initialScope = scope(chat), abort = new AbortController();
    const root = node("section", undefined, "desktop-handoff"), status = node("p", "Checking this session…", "muted"); status.setAttribute("role", "status");
    const details = node("div", undefined, "desktop-handoff-details"), actions = node("div", undefined, "desktop-handoff-actions");
    const refresh = button("Refresh session location", () => void load());
    root.append(node("p", "Continue the same native session in the desktop app. This does not copy a chat, send a prompt, change credentials, stop work, or wake a worker.", "muted"), status, details, actions, refresh);
    this.controls.dialog("Open in desktop app", root);
    const dialog = document.querySelector("#controls-dialog"), version = this.controls.dialogVersion;
    let invalidated = false, pending = false, accountScope;
    const current = () => !invalidated && dialog.open && version === this.controls.dialogVersion && scope(this.state.active) === initialScope;
    const dispose = () => { abort.abort(); if (this.dispose === dispose) { this.dispose = null; this.checkPanel = null; this.invalidate = null; } };
    const invalidate = message => {
      invalidated = true; dispose();
      details.replaceChildren(); actions.replaceChildren(); refresh.disabled = true; status.textContent = message;
    };
    this.dispose = dispose; this.invalidate = invalidate;
    this.checkPanel = () => { if (!current()) invalidate("The chat or its session changed. Close and reopen the desktop handoff."); };
    dialog.addEventListener("close", dispose, { once: true, signal: abort.signal });
    const copy = async (value, output) => {
      if (!current() || pending) return;
      try { await navigator.clipboard.writeText(value); if (current()) status.textContent = "Copied. No desktop handoff has been performed."; }
      catch { if (current()) { output.focus(); output.select(); status.textContent = "Clipboard access is unavailable. Copy the selected text manually."; } }
    };
    const field = (title, value) => {
      const label = node("label", title), output = node("textarea"); output.value = value; output.readOnly = true; output.rows = 2; output.setAttribute("aria-label", title);
      label.append(output); details.append(label, button(`Copy ${title.toLowerCase()}`, () => void copy(value, output)));
    };
    const render = info => {
      status.textContent = info.reason;
      if (info.threadId && sessionUrl(info.threadId)) field("Native session ID", info.threadId);
      if (info.workspace) field("Worker workspace", info.workspace);
      if (info.profile) field("Codex profile", info.profile);
      if (info.checkedAt) details.append(node("p", `${info.source === "saved" ? "Saved location — not rechecked in this request" : "Location checked with the connected worker"}. Last checked: ${new Date(info.checkedAt).toLocaleString()}.`, "muted"));
      if (info.busy) details.append(node("p", "Relay is still working. Opening the app will not pause this chat or its queue. Avoid sending competing instructions from both interfaces.", "desktop-handoff-warning"));
      if (info.url && info.url === sessionUrl(info.threadId) && info.backend === "local" && info.privateProfile === false) {
        const confirm = node("input"); confirm.type = "checkbox";
        const label = node("label", undefined, "desktop-handoff-confirm"); label.append(confirm, node("span", "My desktop app is on the worker's computer and uses the exact Codex profile shown above."));
        const open = node("a", "Open saved session", "secondary-button"); open.setAttribute("role", "link"); open.setAttribute("aria-disabled", "true"); open.tabIndex = -1; open.rel = "noopener noreferrer"; open.referrerPolicy = "no-referrer";
        confirm.addEventListener("change", () => {
          const enabled = confirm.checked && current() && !pending; open.setAttribute("aria-disabled", String(!enabled)); open.tabIndex = enabled ? 0 : -1;
          if (enabled) open.href = info.url; else open.removeAttribute("href");
        });
        open.addEventListener("click", event => {
          if (!current() || pending || !confirm.checked) { event.preventDefault(); return; }
          status.textContent = "Desktop open requested. Relay cannot verify that the app is installed or opened the session. If nothing happens, install/open the desktop app and check the profile. Your Relay chat stays here.";
        });
        actions.append(label, open, node("p", "The browser may ask before opening an external app. Relay cannot detect its installation or confirm a successful handoff. Signing in alone does not sync this local session.", "muted"));
      } else if (info.backend === "ec2" && !info.privateProfile) {
        actions.append(link("Open desktop SSH connections", "codex://settings/connections/ssh"), node("p", "This opens connection settings, not this remote chat. Configure the owning host yourself; Relay never reads your SSH keys or adds a host automatically.", "muted"));
      }
      actions.append(link("Desktop app setup", "https://learn.chatgpt.com/docs/app"), link("Remote connection guide", "https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host"));
    };
    const load = async () => {
      if (!current() || pending) return false;
      pending = true; refresh.disabled = true; details.replaceChildren(); actions.replaceChildren(); status.textContent = "Checking this session…";
      try {
        const result = await this.api(`/api/chats/${chat.id}/desktop-handoff`, { signal: abort.signal });
        if (!current()) return false;
        if (accountScope !== undefined && accountScope !== result.accountScope || chat.ownerId && result.accountScope !== chat.ownerId) { invalidate("The Relay account changed. Close and reopen the desktop handoff."); return false; }
        accountScope = result.accountScope;
        if (result.threadId && result.threadId !== (chat.agentSessionId || null)) { invalidate("The native session changed. Refresh the chat before reopening the desktop handoff."); return false; }
        render(result); return true;
      } catch (error) { if (current()) status.textContent = error.message; return false; }
      finally { pending = false; if (current()) refresh.disabled = false; }
    };
    // Recheck when returning from the desktop or another tab. Clear old links
    // before the request, including when a login changed in the other tab.
    window.addEventListener("focus", () => { if (current()) void load(); }, { signal: abort.signal });
    refresh.focus(); return load();
  }
}
