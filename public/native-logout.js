const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (label, action) => { const item = node("button", label); item.type = "button"; item.addEventListener("click", action); return item; };
const accountName = account => account?.type === "chatgpt" ? `ChatGPT${account.email ? ` · ${account.email}` : ""}` : account?.type === "apiKey" ? "Stored OpenAI API key (value hidden)" : "Stored native credentials (no active native account)";
const states = { reviewed: "Reviewed — not cleared", signing_out: "Signing out — do not repeat", completed: "Native credentials cleared", uncertain: "Sign-out outcome uncertain", cancelled: "Cancelled before sign-out" };
const outcome = item => item.state === "completed" ? "Native credentials cleared and verified. Queued messages stay paused. Relay gateway access and your Relay login are unchanged."
  : item.state === "signing_out" ? "Sign-out is in progress. Refresh saved status; do not confirm again."
    : item.state === "uncertain" ? "Sign-out could not be verified. Credentials may already have been cleared. This confirmation will not be repeated; inspect the native account again to check its current state."
      : "Sign-out was cancelled before dispatch. Inspect the native account again before making another confirmation.";

export class NativeLogoutControls {
  constructor({ state, api, controls, notify, changed }) { Object.assign(this, { state, api, controls, notify, changed }); }
  async open() {
    const chat = this.state.active;
    if (chat?.agent !== "codex") throw new Error("Native sign-out requires Codex");
    const status = node("p", "Loading saved sign-out status…", "muted"); status.setAttribute("role", "status");
    const inspectButton = button("Inspect native account", () => void inspect());
    const refresh = button("Refresh saved status", () => void load());
    const details = node("section", undefined, "native-app-card native-logout-details"); details.hidden = true;
    const confirmation = node("section", undefined, "native-plugin-confirm native-logout-confirm"); confirmation.hidden = true;
    const history = node("div", undefined, "native-logout-history");
    this.controls.dialog("Sign out of native Codex",
      node("p", "Opening this panel changes nothing. Inspect native account may wake this chat's worker, but does not send an agent message or request a token refresh.", "muted"),
      node("p", "This clears only the reviewed private Codex profile's credentials. It does not sign you out of Relay or Chrome, disconnect GitHub/MCP accounts, revoke an API key, or remove server-managed gateway access. Chat history, drafts and files are kept.", "muted"),
      status, inspectButton, details, confirmation, node("h3", "Recent sign-out reviews"), history, refresh);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && this.state.active?.id === chat.id && this.state.active.agent === "codex";
    let pending = false, snapshot = null, reviews = [], submitted = false;
    const render = () => {
      if (!current()) return;
      inspectButton.disabled = refresh.disabled = pending;
      details.hidden = !snapshot; details.replaceChildren();
      if (snapshot) {
        if (snapshot.privateProfile) details.append(node("p", snapshot.account || snapshot.credentialPresent ? accountName(snapshot.account) : "No native account reported"), node("p", `Storage: ${snapshot.storage === "ephemeral" ? "In memory — this worker only" : snapshot.storage === "file" ? "Private Codex credential file" : snapshot.storage || "Not verified"}`));
        if (snapshot.gateway) details.append(node("p", "Relay gateway access remains available after native sign-out.", "muted"));
        if (snapshot.reason) details.append(node("p", snapshot.reason, "muted"));
        if (snapshot.busy) details.append(node("p", "Wait for the chat, side chats and native agents to become idle, then inspect again. Sign-out never stops their work for you.", "muted"));
      }
      confirmation.hidden = !snapshot?.review || submitted; confirmation.replaceChildren();
      if (snapshot?.review && !submitted) {
        confirmation.append(node("h3", "Confirm native credential removal"), node("p", `Clear ${accountName(snapshot.review.account)} from this private worker?`),
          node("p", "Queued messages will be paused. Saved credentials cannot be restored by Relay; sign in again through your native authentication flow if needed. This does not revoke the account or disable gateway access. The review expires in five minutes or when credentials, policy or the worker change."));
        const clear = button("Clear native credentials", () => void confirm()), cancel = button("Cancel sign-out", () => { snapshot = null; status.textContent = "Sign-out cancelled. Nothing was cleared."; render(); inspectButton.focus(); });
        clear.className = "danger"; clear.disabled = pending || snapshot.busy || !snapshot.canLogout; cancel.disabled = pending;
        confirmation.append(clear, cancel);
      }
      history.replaceChildren(...reviews.map(item => node("p", `${states[item.state] || "Unknown status"} · ${new Date(item.createdAt).toLocaleString()}`)));
      if (!reviews.length) history.append(node("p", "No retained sign-out reviews for this native session.", "muted"));
    };
    const fail = (error, uncertain = false) => {
      const message = uncertain ? `${error.message} Sign-out may already have happened. Refresh saved status or inspect the native account; this confirmation will not be retried.` : error.message;
      if (current()) status.textContent = message; else this.notify?.(`${chat.title}: ${message}`);
    };
    const inspect = async () => {
      if (!current() || pending) return;
      pending = true; snapshot = null; submitted = false; status.textContent = "Inspecting the native account and credential storage…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/logout/inspect`, { method: "POST", body: "{}" });
        if (!current()) return;
        snapshot = result;
        if (result.review) reviews = [result.review, ...reviews.filter(item => item.id !== result.review.id)];
        status.textContent = result.canLogout ? "Review the account below. Nothing has been cleared." : "No sign-out is available. See the reason below; no credentials were changed.";
      } catch (error) { fail(error); }
      finally { pending = false; render(); }
    };
    const confirm = async () => {
      if (!current() || pending || submitted || !snapshot?.canLogout || snapshot.busy || !snapshot.review) return;
      const selected = snapshot.review; submitted = true; pending = true; status.textContent = "Clearing the confirmed native credentials…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/logout/confirm`, { method: "POST", body: JSON.stringify({ id: selected.id, revision: selected.revision, threadId: selected.threadId, confirm: true }) });
        this.changed?.(chat.id);
        if (!current()) { this.notify?.(`${chat.title}: ${outcome(result)}`); return; }
        reviews = [result, ...reviews.filter(item => item.id !== result.id)]; status.textContent = outcome(result); snapshot = null;
      } catch (error) { fail(error, true); }
      finally { pending = false; if (current()) { render(); refresh.focus(); } }
    };
    const load = async () => {
      if (!current() || pending) return;
      pending = true; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/logout`);
        if (!current()) return;
        reviews = result.reviews; status.textContent = "Saved status refreshed. No credentials changed and no worker was started.";
      } catch (error) { fail(error); }
      finally { pending = false; render(); }
    };
    render(); inspectButton.focus(); await load(); return current();
  }
}
