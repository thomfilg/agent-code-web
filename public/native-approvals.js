const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (label, action) => { const item = node("button", label); item.type = "button"; item.addEventListener("click", action); return item; };
const labels = { available: "Denied by automatic review", queued: "Retry queued", preparing: "Preparing retry", applying: "Recording native approval", approved: "Native approval recorded", retrying: "Retry in progress", completed: "Retry turn completed", uncertain: "Interrupted or uncertain — not repeated", cancelled: "Retry cancelled" };

export class NativeApprovalControls {
  constructor({ state, api, controls, notify }) { Object.assign(this, { state, api, controls, notify }); }
  async open() {
    const chat = this.state.active;
    if (chat?.agent !== "codex") throw new Error("Automatic-review retries require Codex");
    const status = node("p", "Loading recorded denials…", "muted"); status.setAttribute("role", "status");
    const results = node("div", undefined, "native-app-list native-approval-list"), refresh = button("Refresh denied actions", () => void load());
    this.controls.dialog("Approve a denied action",
      node("p", "Opening this panel does not wake the worker, send input, change permissions or answer pending approval prompts.", "muted"),
      node("p", "Confirming queues a retry under current permissions. Codex may still deny it. Your draft and attachments are not sent.", "muted"), status, results, refresh);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && this.state.active?.id === chat.id && this.state.active.agent === "codex";
    let catalog, pending = false, stale = false, confirmation = null;
    const render = () => {
      if (!current() || !catalog) return;
      results.replaceChildren(...catalog.reviews.map(item => {
        const row = node("section", undefined, "native-app-card native-approval-card"); row.dataset.approvalId = item.id;
        row.append(node("h3", labels[item.state] || "Recorded review"), node("small", `${new Date(item.createdAt).toLocaleString()} · Risk: ${item.risk || "not reported"}`, "muted"), node("pre", item.action), node("p", item.rationale, "muted"));
        if (["applying", "approved", "retrying", "preparing", "uncertain"].includes(item.state)) row.append(node("p", "If this status persists after interruption, inspect the conversation. Relay will not automatically repeat an approval or a possibly-started retry.", "muted"));
        if (item.state === "available" || item.state === "queued") {
          const select = button(item.state === "queued" ? "Ensure retry is queued" : "Review retry", () => { confirmation = item.id; render(); results.querySelector(".native-approval-confirm button")?.focus(); });
          select.disabled = pending || stale; row.append(select);
          if (confirmation === item.id) {
            const prompt = node("div", undefined, "native-plugin-confirm native-approval-confirm");
            prompt.append(node("p", "Confirm the native review shown above and ask Codex to retry that same action once? This may execute the reviewed command or operation when the queue runs. It does not grant general access or turn off automatic review. A paused queue stays paused."));
            const confirm = button("Confirm approval & queue retry", () => void retry(item)), cancel = button("Cancel retry", () => { confirmation = null; render(); [...results.children].find(row => row.dataset.approvalId === item.id)?.querySelector("button")?.focus(); });
            confirm.disabled = pending || stale; cancel.disabled = pending; prompt.append(confirm, cancel); row.append(prompt);
          }
        }
        return row;
      }));
      refresh.disabled = pending;
    };
    const retry = async item => {
      if (!current() || pending || stale) return;
      pending = true; status.textContent = "Recording the confirmed retry…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/approvals/retry`, { method: "POST", body: JSON.stringify({ id: item.id, revision: item.revision, threadId: catalog.threadId, confirm: true }) });
        const message = result.state === "queued" ? result.queuePaused ? "Retry queued. Resume the paused message queue when ready." : "Retry queued for the next available turn." : `Retry status: ${labels[result.state] || result.state}. No duplicate retry was queued.`;
        if (!current()) { this.notify?.(`${chat.title}: ${message}`); return; }
        item.state = result.state; confirmation = null; status.textContent = message;
      } catch (error) {
        if (current()) { stale = true; confirmation = null; status.textContent = `${error.message} Refresh to check the recorded status before doing anything else.`; }
        else this.notify?.(`${chat.title}: ${error.message} Check /approve before retrying.`);
      } finally { pending = false; if (current()) { render(); refresh.focus(); } }
    };
    const load = async () => {
      if (!current() || pending) return;
      pending = true; confirmation = null; status.textContent = "Loading recorded denials…"; refresh.disabled = true; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/approvals`);
        if (!current()) return;
        catalog = result; stale = false;
        status.textContent = result.reviews.length ? "Choose a recorded denial. Native review metadata is shown with secret-looking values redacted." : "No retained automatic-review denials for this native session. Older denials from before this feature was enabled cannot be reconstructed safely.";
      } catch (error) { if (current()) { stale = true; status.textContent = error.message; } }
      finally { pending = false; if (current()) { refresh.disabled = false; render(); } }
    };
    refresh.focus(); await load(); return current();
  }
}
