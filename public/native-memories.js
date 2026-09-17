const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (label, action) => { const item = node("button", label); item.type = "button"; item.addEventListener("click", action); return item; };
const descriptions = {
  feature: "Enable local Codex memories in this chat’s private profile. This is separate from ChatGPT memory and does not monitor your browser activity. Enabled profiles can spend quota consolidating existing memories on startup, even when new chat contributions are off.",
  use: "Use existing local memories in later native sessions. Turning this off does not erase memory already included in the current conversation.",
  generate: "Allow eligible chats in this private profile to contribute to future memories. This choice is also applied to the current chat. Background generation can use model quota; it is not immediate.",
};

export class NativeMemoriesControls {
  constructor({ state, api, controls, changed }) { Object.assign(this, { state, api, controls, changed }); }
  async open() {
    const chat = this.state.active;
    if (chat?.agent !== "codex") throw new Error("Native memory controls require Codex");
    const scope = node("p", "", "muted"), status = node("p", "Loading memory settings…", "muted"); status.setAttribute("role", "status");
    const results = node("div", undefined, "native-app-list native-feature-list native-memory-list");
    const notice = node("p", "", "muted"), refresh = button("Refresh memory settings", () => void load());
    this.controls.dialog("Codex memories", node("p", "Control native memory use, generation and saved memory files. Opening this panel may wake the worker but never sends a message. Changes require an idle chat.", "muted"), scope, status, results, notice, refresh);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && this.state.active?.id === chat.id && this.state.active.agent === "codex";
    let catalog, pending = false, stale = false, confirmation = null;
    const focusControl = id => [...results.children].find(row => row.dataset.memoryId === id)?.querySelector("button")?.focus();
    const appendAction = (row, item, action) => {
      const label = action === "reset" ? "Reset saved memories" : `${action === "enable" ? "Enable" : "Disable"} ${item.name}`;
      const control = button(label, () => { confirmation = item.id; render(); results.querySelector(".native-memory-confirm button")?.focus(); });
      control.disabled = pending || stale || catalog.busy; row.append(control);
      if (confirmation !== item.id) return;
      const prompt = node("div", undefined, "native-plugin-confirm native-feature-confirm native-memory-confirm");
      prompt.append(node("p", action === "reset"
        ? "Permanently delete saved memory files and rollout summaries from this chat’s private native profile? This cannot be undone. Chat messages and settings are kept. Memories may be recreated while Local memories is enabled or a background pass is still running."
        : `${label} in this chat’s private native profile? ${item.id === "use" ? "This affects later native sessions, not memory already in the conversation." : item.id === "generate" ? "The current chat’s contribution preference will also be updated." : "This uses the Use memories and Generate memories settings shown here; generation can use quota."} No message will be sent and no worker will be restarted.`));
      const confirm = button(action === "reset" ? "Confirm reset saved memories" : `Confirm ${action} ${item.name}`, () => void change(item.id, action)); confirm.disabled = pending || stale || catalog.busy;
      if (action === "reset") confirm.className = "danger";
      const cancel = button("Cancel memory change", () => { confirmation = null; render(); focusControl(item.id); }); cancel.disabled = pending;
      prompt.append(confirm, cancel); row.append(prompt);
    };
    const render = () => {
      if (!current() || !catalog) return;
      scope.textContent = catalog.mutable ? "Only this chat’s private native profile is changed. Other chats’ profiles and your host account stay untouched; managed settings remain locked." : "Shared host profile: inspection only. Company-scoped native profiles are required before changing or resetting memories here.";
      const feature = catalog.controls.find(item => item.id === "feature");
      results.replaceChildren(...catalog.controls.map(item => {
        const row = node("section", undefined, "native-app-card native-memory-card"); row.dataset.memoryId = item.id;
        row.append(node("h3", item.name), node("small", `Configured ${item.enabled === true ? "on" : item.enabled === false ? "off" : "unknown"}${item.id !== "feature" && feature?.enabled === false ? " · Inactive while Local memories is off" : ""}`, "muted"), node("p", descriptions[item.id], "muted"));
        if (item.reason) row.append(node("p", item.reason, "muted"));
        for (const action of item.actions) appendAction(row, item, action);
        return row;
      }));
      if (catalog.resetAllowed) {
        const row = node("section", undefined, "native-app-card native-memory-card"); row.dataset.memoryId = "reset";
        row.append(node("h3", "Reset saved memories"), node("p", "Delete generated memory files and summaries in this private profile, without deleting conversations.", "muted"));
        appendAction(row, { id: "reset" }, "reset"); results.append(row);
      }
      notice.textContent = [catalog.nextSessionRequired ? "Saved use/feature changes apply when a native session loads the updated settings. Existing conversation context is not erased. No restart was performed automatically." : "",
        typeof catalog.currentThreadGeneration === "boolean" ? `Current chat contribution was ${catalog.currentThreadGeneration ? "enabled" : "disabled"} through Codex’s native memory control.` : "",
        catalog.externalContextExcluded ? "Native settings exclude chats that use external context (such as MCP or web search) from memory generation." : "", catalog.warning].filter(Boolean).join(" ");
      notice.hidden = !notice.textContent; refresh.disabled = pending;
    };
    const change = async (id, action) => {
      if (!current() || pending || stale) return;
      const input = { id, action, confirm: true, threadId: catalog.threadId, revision: catalog.revision };
      pending = true; status.textContent = action === "reset" ? "Resetting this private profile’s saved memories…" : "Saving native memory choice…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/memories/change`, { method: "POST", body: JSON.stringify(input) });
        if (!current()) return;
        catalog = result; confirmation = null;
        status.textContent = action === "reset" ? "Saved memory files and summaries were removed. Chat messages and settings were retained." : "Native memory choice saved.";
      } catch (error) { if (current()) { stale = true; confirmation = null; status.textContent = `${error.message} Refresh before another change.`; } }
      finally { this.changed(chat.id); pending = false; if (current()) { render(); if (stale) refresh.focus(); else focusControl(id); } }
    };
    const load = async () => {
      if (!current() || pending) return;
      pending = true; confirmation = null; refresh.disabled = true; status.textContent = "Loading memory settings…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/memories`, { method: "POST", body: "{}" });
        if (!current()) return;
        catalog = result; stale = false; this.changed(chat.id);
        status.textContent = catalog.busy ? "The agent is working. Refresh when idle to change memory settings." : "Choose how Codex uses and generates local memories.";
      } catch (error) { if (current()) { stale = true; status.textContent = error.message; } }
      finally { pending = false; if (current()) { refresh.disabled = false; render(); } }
    };
    refresh.focus(); await load(); return current();
  }
}
