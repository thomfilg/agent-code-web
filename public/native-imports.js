const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (label, action) => { const item = node("button", label); item.type = "button"; item.addEventListener("click", action); return item; };
const sourceName = source => source === "cursor" ? "Cursor" : "Claude Code";
const phases = { starting: "Starting", running: "Importing", completed: "Completed", uncertain: "Outcome incomplete", cancelled: "Cancelled before import", acknowledged: "Incomplete outcome acknowledged" };

export class NativeImportsControls {
  constructor({ state, api, controls, changed, opened }) { Object.assign(this, { state, api, controls, changed, opened }); }
  async open() {
    this.dispose?.();
    const chat = this.state.active;
    if (chat?.agent !== "codex") throw new Error("Native import requires Codex");
    const source = node("select"); source.setAttribute("aria-label", "Import source");
    for (const value of ["claude-code", "cursor"]) { const option = node("option", sourceName(value)); option.value = value; source.append(option); }
    const scope = node("p", "", "muted"), status = node("p", "Loading import state…", "muted"); status.setAttribute("role", "status");
    const choices = node("div", undefined, "native-app-list native-import-list"), history = node("div", undefined, "native-import-history");
    const confirmArea = node("div"), review = button("Review selection", () => { confirmation = { type: "start" }; render(); confirmArea.querySelector("button")?.focus(); });
    const refresh = button("Refresh import", () => void load(true)), toolbar = node("div", undefined, "native-plugin-actions"); toolbar.append(source, refresh);
    this.controls.dialog("Import into Codex", node("p", "Import supported setup and recent conversations from this worker’s selected workspace and private profile. Your original source is retained. Opening this panel can wake the worker, but never sends a message.", "muted"), toolbar, scope, status, choices, review, confirmArea, history);
    const dialog = document.querySelector("#controls-dialog"), version = this.controls.dialogVersion;
    let catalog = null, snapshot = null, pending = false, stale = true, confirmation = null, timer;
    const selected = new Set(), abort = new AbortController();
    const current = () => !abort.signal.aborted && dialog.open && this.controls.dialogVersion === version && this.state.active?.id === chat.id && this.state.active.agent === "codex";
    const dispose = () => { clearTimeout(timer); abort.abort(); }; this.dispose = dispose;
    dialog.addEventListener("close", dispose, { once: true, signal: abort.signal });
    const ready = () => snapshot?.mutable && !snapshot.busy && !snapshot.changing && !snapshot.needsRefresh && !pending && !stale;
    const post = (tail, body = {}) => this.api(`/api/chats/${chat.id}/imports${tail}`, { method: "POST", body: JSON.stringify(body) });
    const schedule = () => {
      clearTimeout(timer);
      if (current() && snapshot?.operations.some(item => ["starting", "running"].includes(item.phase) || item.phase === "completed" && !item.reconciled)) timer = setTimeout(() => void load(false), 1500);
    };
    const render = () => {
      if (!current()) return;
      source.disabled = pending; refresh.disabled = pending;
      scope.textContent = snapshot?.mutable === false ? "Shared host profile: project inspection only. Importing requires a private chat profile; host credentials are not copied."
        : "Only this chat’s workspace and private profile are destinations. Review imported permissions, hooks and connections before use; importing does not authorize accounts or trust hooks.";
      choices.replaceChildren();
      for (const item of catalog?.items || []) {
        const row = node("section", undefined, "native-app-card native-import-item"); row.dataset.importId = item.id;
        const label = node("label"), checkbox = node("input"); checkbox.type = "checkbox"; checkbox.checked = selected.has(item.id); checkbox.disabled = !ready();
        checkbox.addEventListener("change", () => { checkbox.checked ? selected.add(item.id) : selected.delete(item.id); confirmation = null; updateConfirmation(); });
        label.append(checkbox, node("span", item.name));
        row.append(label, node("small", `${item.scope === "profile" ? "Private profile" : "Current project"} · ${item.count} ${item.itemType === "SESSIONS" ? "conversation" : "item(s), whole group"}`, "muted"), node("p", item.warning, "muted"));
        if (item.entries.length) { const details = node("details"), list = node("ul"); details.append(node("summary", `Review all ${item.entries.length} entries`)); for (const name of item.entries) list.append(node("li", name)); details.append(list); row.append(details); }
        choices.append(row);
      }
      if (catalog && !catalog.items.length) choices.append(node("p", "No remaining supported items found for this source in the selected workspace/profile.", "muted"));
      if (catalog?.excludedSessions || catalog?.excludedGroups) choices.append(node("p", "Items and conversations from other projects were excluded.", "muted"));
      history.replaceChildren();
      if (snapshot?.operations.length) history.append(node("h3", "Recent imports"));
      for (const operation of snapshot?.operations || []) {
        const row = node("section", undefined, "native-app-card native-import-result"); row.dataset.operationId = operation.id;
        row.append(node("h3", `${sourceName(operation.source)} · ${phases[operation.phase] || "Unknown"}`));
        if (operation.warning) row.append(node("p", operation.warning, "muted"));
        for (const result of operation.results) row.append(node("p", `${result.name}: ${result.imported} imported · ${result.failed} failed${result.notReported ? ` · ${result.notReported} not reported (not counted as successful)` : ""}`, "muted"));
        for (const session of operation.sessions) {
          const open = button(`Open chat: ${session.title}`, () => { confirmation = { type: "open", operation, session }; updateConfirmation(); confirmArea.querySelector("button")?.focus(); });
          open.disabled = !operation.reconciled || pending || snapshot.changing || snapshot.needsRefresh || snapshot.busy; row.append(open);
        }
        if (operation.canAcknowledge) { const acknowledge = button("Review incomplete outcome", () => { confirmation = { type: "acknowledge", operation }; updateConfirmation(); confirmArea.querySelector("button")?.focus(); }); acknowledge.disabled = pending || snapshot.busy; row.append(acknowledge); }
        history.append(row);
      }
      updateConfirmation();
    };
    const updateConfirmation = () => {
      review.disabled = !ready() || !selected.size; review.textContent = selected.size ? `Review ${selected.size} selection(s)` : "Review selection";
      confirmArea.replaceChildren();
      if (!confirmation) return;
      const panel = node("section", undefined, "native-plugin-confirm native-import-confirm");
      if (confirmation.type === "start") {
        panel.append(node("h3", "Confirm import"), node("p", "Import exactly the selected groups and conversations? Groups include every listed entry, including executable scripts or connection settings. Source files are retained; existing destinations may be skipped. No agent message or automatic restart will be sent."));
        const list = node("ul"); for (const item of catalog.items.filter(item => selected.has(item.id))) list.append(node("li", `${item.name} · ${item.scope === "profile" ? "private profile" : "project"}`)); panel.append(list);
      } else if (confirmation.type === "open") panel.append(node("h3", confirmation.session.title), node("p", "Open this conversation as an independent Relay chat with a copy of the current workspace? Its native history is retained; unsupported source content may appear as text markers instead of images or other blocks. The new chat starts stopped, with a new private profile; personal accounts and profile-level settings are not copied. No message is sent."));
      else panel.append(node("h3", "Acknowledge incomplete import"), node("p", "The original worker is confirmed stopped, but some results were not recorded. Files may already have changed. Acknowledging reconciles the current setup and unlocks agent work; it does not repeat the import or label unknown results successful."));
      const confirm = button(confirmation.type === "start" ? "Confirm import" : confirmation.type === "open" ? "Open independent chat" : "Acknowledge incomplete import", () => void act());
      confirm.disabled = pending || snapshot.busy || confirmation.type === "start" && !ready();
      const cancel = button("Cancel", () => { confirmation = null; updateConfirmation(); review.focus(); }); cancel.disabled = pending;
      panel.append(confirm, cancel); confirmArea.append(panel);
    };
    const act = async () => {
      if (!current() || pending || !confirmation) return;
      const action = confirmation;
      const input = action.type === "start" ? { requestId: crypto.randomUUID(), source: catalog.source, revision: catalog.revision, ids: [...selected], threadId: snapshot.threadId, confirm: true }
        : action.type === "open" ? { operationId: action.operation.id, sessionId: action.session.id, threadId: snapshot.threadId, confirm: true }
        : { id: action.operation.id, threadId: snapshot.threadId, confirm: true };
      pending = true; status.textContent = action.type === "open" ? "Preparing the independent chat…" : "Applying the confirmed import action…"; render();
      try {
        const result = await post(`/${action.type}`, input); this.changed(chat.id);
        if (action.type === "open") { const active = current(); if (active) dialog.close(); this.opened(result.chat, active); return; }
        if (!current()) return;
        snapshot = result; stale = true; selected.clear(); confirmation = null;
        status.textContent = action.type === "acknowledge" ? "Incomplete outcome acknowledged. No import was repeated. Refresh to review the available setup." : "Import action recorded. Checking results…";
      } catch (error) { if (current()) { stale = true; confirmation = null; status.textContent = `${error.message} Refresh to check the recorded outcome. Do not repeat the import blindly.`; } }
      finally { pending = false; if (current()) { render(); schedule(); refresh.focus(); } }
    };
    const load = async (reviewSource) => {
      if (!current() || pending) return;
      pending = true; clearTimeout(timer); confirmation = null; status.textContent = "Checking native import state…"; render(); let failed = false;
      try {
        let result = await post("/status"); if (!current()) return; snapshot = result;
        if (snapshot.needsRefresh) { result = await post("/refresh"); if (!current()) return; snapshot = result; }
        if (!snapshot.changing && !snapshot.needsRefresh && (reviewSource || stale || !catalog)) {
          result = await post("", { source: source.value }); if (!current()) return;
          catalog = result; snapshot = result; selected.clear(); stale = false;
        }
        status.textContent = snapshot.changing ? "Import in progress. Results update while this panel is open. Closing the panel does not cancel it."
          : snapshot.needsRefresh ? "Import needs review before agent work can continue. Refresh to recover recorded results."
          : snapshot.busy ? "The agent is working. Refresh when idle to import." : "Select setup groups or individual conversations to review.";
        this.changed(chat.id);
      } catch (error) { failed = true; if (current()) { stale = true; status.textContent = error.message; } }
      finally { pending = false; if (current()) { render(); if (!failed) schedule(); } else dispose(); }
    };
    source.addEventListener("change", () => { catalog = null; stale = true; selected.clear(); void load(true); });
    refresh.focus(); await load(true); return current();
  }
}
