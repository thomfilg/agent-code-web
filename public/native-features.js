const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (label, action) => { const item = node("button", label); item.type = "button"; item.addEventListener("click", action); return item; };
const stateLabel = value => value === true ? "on" : value === false ? "off" : "unknown";

export class NativeFeaturesPicker {
  constructor({ state, api, controls, changed }) { Object.assign(this, { state, api, controls, changed }); }
  async open() {
    const chat = this.state.active;
    if (chat?.agent !== "codex") throw new Error("Native experimental features require Codex");
    const scope = node("p", "", "muted"), status = node("p", "Loading native features…", "muted"); status.setAttribute("role", "status");
    const search = node("input"); search.type = "search"; search.placeholder = "Find an experimental feature…"; search.setAttribute("aria-label", "Find an experimental feature");
    const results = node("div", undefined, "native-app-list native-feature-list");
    const restart = node("p", "", "muted"); restart.hidden = true;
    const refresh = button("Refresh features", () => void load());
    this.controls.dialog("Codex experimental features", node("p", "Beta features reported by this chat’s native Codex session. Opening this picker may wake the worker, but never sends a message. Changes require an idle chat and may need a native agent restart.", "muted"), scope, search, status, results, restart, refresh);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && this.state.active?.id === chat.id && this.state.active.agent === "codex";
    let catalog, pending = false, stale = false, confirmation = null;
    const focusFeature = id => [...results.children].find(row => row.dataset.featureId === id)?.querySelector("button")?.focus();
    const render = () => {
      if (!current() || !catalog) return;
      scope.textContent = catalog.mutable ? "Only this chat’s private native profile is changed. Managed, project and session overrides stay locked." : "Shared host profile: inspection only. Company-scoped native profiles are required before changing features here.";
      restart.hidden = !catalog.restartRequired;
      restart.textContent = "Some feature changes take full effect only after restarting the agent. When ready, stop this chat’s worker and send a new message to resume it. No restart was performed automatically.";
      const query = search.value.trim().toLowerCase(), matching = catalog.features.filter(feature => `${feature.name} ${feature.id} ${feature.description}`.toLowerCase().includes(query));
      results.replaceChildren(...matching.map(feature => {
        const row = node("section", undefined, "native-app-card native-feature-card"); row.dataset.featureId = feature.id;
        row.append(node("h3", feature.name), node("small", `${feature.id} · Configured ${stateLabel(feature.enabled)} · Default ${stateLabel(feature.defaultEnabled)}`, "muted"), node("p", feature.description, "muted"));
        if (feature.announcement) row.append(node("p", feature.announcement, "muted"));
        if (feature.id === "network_proxy") row.append(node("p", "This does not grant sandbox network access or replace MCP, browser or connector access controls.", "muted"));
        if (feature.id === "prevent_idle_sleep") row.append(node("p", "This concerns the worker computer’s sleep behavior, not Relay’s idle-container timer or your browser tab.", "muted"));
        if (feature.reason) row.append(node("p", feature.reason, "muted"));
        for (const action of feature.actions) {
          const control = button(`${action === "enable" ? "Enable" : "Disable"} ${feature.name}`, () => { confirmation = feature.id; render(); results.querySelector(".native-feature-confirm button")?.focus(); });
          control.disabled = pending || stale || catalog.busy; row.append(control);
          if (confirmation === feature.id) {
            const prompt = node("div", undefined, "native-plugin-confirm native-feature-confirm");
            prompt.append(node("p", `${action === "enable" ? "Enable" : "Disable"} ${feature.name} in this chat’s private native profile? This saves the native setting without restarting the worker, Chrome or ongoing background terminals.`));
            const confirm = button(`Confirm ${action} ${feature.name}`, () => void change(feature, action)); confirm.disabled = pending || stale || catalog.busy;
            const cancel = button("Cancel feature change", () => { confirmation = null; render(); focusFeature(feature.id); }); cancel.disabled = pending;
            prompt.append(confirm, cancel); row.append(prompt);
          }
        }
        return row;
      }));
      if (!matching.length) results.append(node("p", query ? "No matching experimental features." : "This native Codex version reports no beta features.", "muted"));
      refresh.disabled = pending;
    };
    const change = async (feature, action) => {
      if (!current() || pending || stale) return;
      const input = { id: feature.id, action, confirm: true, threadId: catalog.threadId, revision: catalog.revision };
      pending = true; status.textContent = "Saving native feature configuration…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/experimental/change`, { method: "POST", body: JSON.stringify(input) });
        if (!current()) return;
        catalog = result; confirmation = null; status.textContent = "Native feature configuration verified and saved.";
      } catch (error) { if (current()) { stale = true; confirmation = null; status.textContent = `${error.message} Refresh before another change.`; } }
      finally { this.changed(chat.id); pending = false; if (current()) { render(); if (!stale) focusFeature(feature.id); else refresh.focus(); } }
    };
    const load = async () => {
      if (!current() || pending) return;
      pending = true; confirmation = null; refresh.disabled = true; status.textContent = "Loading native features…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/experimental`, { method: "POST", body: "{}" });
        if (!current()) return;
        catalog = result; stale = false; this.changed(chat.id);
        status.textContent = [catalog.busy ? "The agent is working. Refresh when idle to change features." : "Select a beta feature to enable or disable.", catalog.truncated ? "The native catalog is incomplete; changes are unavailable." : "", catalog.warning].filter(Boolean).join(" ");
      } catch (error) { if (current()) { stale = true; status.textContent = error.message; } }
      finally { pending = false; if (current()) { refresh.disabled = false; render(); } }
    };
    search.addEventListener("input", () => { confirmation = null; render(); }); search.focus(); await load();
  }
}
