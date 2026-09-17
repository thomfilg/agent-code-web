import { companyForChat } from "./company-scope.js";

const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (label, action) => { const item = node("button", label); item.type = "button"; item.addEventListener("click", action); return item; };
const scope = chat => JSON.stringify(chat && [chat.id, chat.agent, chat.ownerId, chat.workspace, chat.environmentId, chat.repositories, companyForChat(chat), chat.archived]);

export class ClaudeWorkspaceTrustControls {
  constructor({ state, api, controls }) { Object.assign(this, { state, api, controls }); }
  render() {
    document.querySelector("#workspace-trust-button").hidden = this.state.active?.agent !== "claude";
    this.checkPanel?.();
  }
  resetIdentity() { this.invalidate?.("The Relay account changed. Close and reopen workspace trust."); }
  async open() {
    this.dispose?.();
    const chat = this.state.active;
    if (chat?.agent !== "claude") throw Error("Workspace trust requires a Claude chat.");
    const initialScope = scope(chat), abort = new AbortController();
    const status = node("p", "Inspect the workspace before granting trust.", "muted"); status.setAttribute("role", "status");
    const details = node("section", undefined, "native-app-card"), actions = node("div", undefined, "native-hook-actions"); details.hidden = true;
    const inspect = button("Inspect workspace trust", () => void run("inspect"));
    const cancel = button("Cancel workspace trust", () => document.querySelector("#controls-dialog").close());
    this.controls.dialog("Claude workspace trust",
      node("p", "Review this chat’s private Claude workspace. Inspecting may wake the worker, but sends no prompt and grants no trust. Shared host profiles cannot be changed here.", "muted"),
      node("p", "Trust can enable project permission grants, hooks and other project code. Only trust a workspace whose contents and source you trust. Existing native deny rules, managed policy and the selected permission mode still apply.", "muted"),
      status, details, actions, inspect, cancel);
    const dialog = document.querySelector("#controls-dialog"), version = this.controls.dialogVersion;
    let pending = false, invalidated = false, review = null, expiry;
    const current = () => !invalidated && dialog.open && this.controls.dialogVersion === version && scope(this.state.active) === initialScope;
    const dispose = () => {
      clearTimeout(expiry); abort.abort();
      if (this.dispose === dispose) { this.dispose = null; this.invalidate = null; this.checkPanel = null; }
    };
    const invalidate = message => { invalidated = true; dispose(); review = null; actions.replaceChildren(); details.replaceChildren(); details.hidden = true; inspect.disabled = true; status.textContent = message; };
    this.dispose = dispose; this.invalidate = invalidate;
    this.checkPanel = () => { if (!current()) invalidate("The chat or workspace changed. Close and reopen workspace trust."); };
    dialog.addEventListener("close", dispose, { once: true, signal: abort.signal });
    const render = result => {
      details.hidden = false; details.replaceChildren(node("h3", "Exact worker workspace"), node("code", result.directory)); actions.replaceChildren();
      if (result.trustRoot) details.append(node("p", "Native trust root"), node("code", result.trustRoot));
      if (result.state === "trusted") {
        review = null;
        cancel.textContent = "Close review";
        status.textContent = "Native workspace trust is saved in this chat’s private profile. No agent or application was restarted. Claude still enforces managed policy, ask/deny rules and the selected permission mode on subsequent tool calls.";
        return;
      }
      review = result;
      status.textContent = "Not trusted. Review the exact path above and confirm only if you trust this project. This review expires in five minutes.";
      const accepted = node("input"); accepted.type = "checkbox";
      const label = node("label", undefined, "native-hook-review"); label.append(accepted, node("span", "I trust the workspace shown above and authorize its project configuration in this chat’s private Claude profile."));
      const confirm = button("Trust this workspace", () => { if (accepted.checked) void run("confirm"); }); confirm.disabled = true;
      accepted.addEventListener("change", () => { confirm.disabled = pending || !current() || !review || !accepted.checked; });
      actions.append(label, confirm);
      clearTimeout(expiry); expiry = setTimeout(() => {
        review = null; if (current()) { actions.replaceChildren(); status.textContent = "The review expired. Inspect the workspace again before confirming."; inspect.focus(); }
      }, Math.max(0, result.expiresAt - Date.now()));
    };
    const run = async action => {
      if (!current() || pending || action === "confirm" && !review) return;
      const input = action === "confirm" ? { reviewId: review.reviewId, confirm: true } : {};
      pending = true; review = null; clearTimeout(expiry); actions.replaceChildren(); inspect.disabled = true;
      cancel.textContent = action === "confirm" ? "Close review" : "Cancel workspace trust";
      status.textContent = action === "confirm" ? "Verifying and saving explicit native trust… Closing this dialog does not cancel or undo the submitted confirmation." : "Inspecting the exact native workspace…";
      try {
        const result = await this.api(`/api/chats/${chat.id}/workspace-trust/${action}`, { method: "POST", body: JSON.stringify(input) });
        if (current()) render(result);
      } catch (error) { if (current()) { status.textContent = `${error.message} No automatic retry or restart was performed. Inspect again before another confirmation.`; } }
      finally { pending = false; if (current()) { inspect.disabled = false; inspect.focus(); } }
    };
    inspect.focus();
  }
}
