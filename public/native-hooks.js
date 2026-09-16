const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (label, action) => { const item = node("button", label); item.type = "button"; item.addEventListener("click", action); return item; };
const label = action => ({ trust: "Trust", enable: "Enable", disable: "Disable" })[action];
const eventName = value => value ? value[0].toUpperCase() + value.slice(1) : "Unknown event";
const name = hook => hook.statusMessage || `${eventName(hook.event)} · ${hook.source}`;

export class NativeHooksBrowser {
  constructor({ state, api, controls, changed }) { Object.assign(this, { state, api, controls, changed }); }
  async open() {
    const chat = this.state.active;
    if (chat?.agent !== "codex") throw new Error("Native hooks require Codex");
    const status = node("p", "Loading native hooks…", "muted"); status.setAttribute("role", "status");
    const search = node("input"); search.type = "search"; search.placeholder = "Find a hook…"; search.setAttribute("aria-label", "Find a native hook");
    const events = node("select"); events.setAttribute("aria-label", "Hook event");
    const results = node("div", undefined, "native-app-list native-hook-list");
    const detail = node("section", undefined, "native-hook-detail"); detail.hidden = true;
    const scope = node("p", "", "muted");
    const refresh = button("Refresh hooks", () => void load());
    this.controls.dialog("Codex hooks", node("p", "Review lifecycle hooks before trusting them. Hooks can run commands or MCP tools, access worker data and change agent behavior. Opening this browser may wake the worker, but never sends a message or grants trust.", "muted"), scope, events, search, status, results, detail, refresh);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && this.state.active?.id === chat.id && this.state.active.agent === "codex";
    let catalog, selected = null, pending = false, stale = false, confirmation = null;
    const renderDetails = () => {
      const hook = catalog?.hooks.find(item => item.id === selected);
      detail.replaceChildren(); detail.hidden = !hook;
      if (!hook) return;
      const heading = node("h3", name(hook)); heading.tabIndex = -1;
      detail.append(heading, node("p", `${eventName(hook.event)} · ${hook.type} · ${hook.managed ? "Managed" : hook.trust} · ${hook.enabled ? "Enabled" : "Disabled"}`, "muted"));
      if (catalog.mutable) {
        detail.append(node("p", `Source: ${hook.sourcePath || "Not provided"}${hook.pluginId ? ` · Plugin: ${hook.pluginId}` : ""}`, "muted"),
          node("p", `Matcher: ${hook.matcher || "All"} · Timeout: ${hook.timeoutSec ?? "Native default"}${typeof hook.timeoutSec === "number" ? "s" : ""}${hook.async ? " · Asynchronous" : ""}`, "muted"));
        if (hook.type === "command") detail.append(node("pre", hook.command, "native-hook-command"));
        if (hook.type === "mcpTool") detail.append(node("pre", `${hook.server} / ${hook.tool}`, "native-hook-command"), node("p", "MCP input templates are not included in native hook metadata. Review the source file, including its arguments, before trusting this hook.", "muted"));
        if (hook.currentHash) detail.append(node("p", `Definition: ${hook.currentHash}`, "muted"));
        if (hook.additionalContextLimit !== null) detail.append(node("p", `Additional context limit: ${hook.additionalContextLimit}`, "muted"));
      }
      if (hook.reason) detail.append(node("p", hook.reason, "muted"));
      const actions = node("div", undefined, "native-hook-actions");
      for (const action of hook.actions) {
        const control = button(`${label(action)} hook`, () => { confirmation = action; renderDetails(); detail.querySelector(".native-hook-confirm input, .native-hook-confirm button")?.focus(); });
        control.disabled = pending || stale || catalog.busy; actions.append(control);
      }
      detail.append(actions);
      if (confirmation && hook.actions.includes(confirmation)) {
        const prompt = node("div", undefined, "native-hook-confirm");
        prompt.append(node("p", confirmation === "trust" ? "Trust this exact definition in this chat’s private native profile? Referenced script contents are not covered by the definition hash. A disabled hook stays disabled until you enable it." : `${label(confirmation)} this hook for this chat and its side agents? Native policy still applies.`));
        const confirm = button(`Confirm ${confirmation} hook`, () => { if (reviewed && !reviewed.checked) return; void change(hook, confirmation); });
        let reviewed;
        if (confirmation === "trust") {
          reviewed = node("input"); reviewed.type = "checkbox";
          const reviewLabel = node("label", undefined, "native-hook-review"); reviewLabel.append(reviewed, node("span", "I reviewed this hook’s source, referenced scripts and MCP arguments, and trust it.")); prompt.append(reviewLabel);
          reviewed.addEventListener("change", () => { confirm.disabled = !reviewed.checked || pending || stale || catalog.busy; });
        }
        confirm.disabled = confirmation === "trust" || pending || stale || catalog.busy;
        const cancel = button("Cancel hook change", () => { confirmation = null; renderDetails(); detail.querySelector("button")?.focus(); }); cancel.disabled = pending;
        prompt.append(confirm, cancel); detail.append(prompt);
      }
    };
    const render = () => {
      if (!current() || !catalog) return;
      scope.textContent = catalog.mutable ? "Changes are limited to this chat’s private native profile. Refresh reloads definitions when idle. Shared host account settings are not changed." : "Shared host profile: inspection only, with definitions hidden. Company-scoped native profiles are required before managing hooks here.";
      const event = events.value;
      events.replaceChildren(...["", ...new Set(catalog.hooks.map(hook => hook.event))].map(value => { const option = node("option", value ? eventName(value) : "All events"); option.value = value; return option; })); events.value = event;
      const query = search.value.trim().toLowerCase();
      const matching = catalog.hooks.filter(hook => (!events.value || hook.event === events.value) && `${name(hook)} ${hook.event} ${hook.source} ${hook.sourcePath || ""} ${hook.command || ""} ${hook.server || ""} ${hook.tool || ""}`.toLowerCase().includes(query));
      results.replaceChildren(...matching.map(hook => {
        const row = node("section", undefined, "native-app-card native-hook-card");
        const show = button(`Details for ${name(hook)}`, () => { selected = hook.id; confirmation = null; renderDetails(); detail.querySelector("h3")?.focus(); });
        row.append(node("h3", name(hook)), node("small", `${eventName(hook.event)} · ${hook.source} · ${hook.managed ? "Managed" : hook.trust} · ${hook.enabled ? "Enabled" : "Disabled"}`, "muted"), show); return row;
      }));
      if (!matching.length) results.append(node("p", query || events.value ? "No matching hooks." : "No lifecycle hooks configured for this workspace.", "muted"));
      refresh.disabled = pending; renderDetails();
    };
    const change = async (hook, action) => {
      if (!current() || pending || stale) return;
      const input = { id: hook.id, action, confirm: true, threadId: catalog.threadId, revision: catalog.revision };
      pending = true; status.textContent = `${label(action)} hook…`; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/hooks/change`, { method: "POST", body: JSON.stringify(input) });
        if (!current()) return;
        catalog = result; confirmation = null; status.textContent = "Native hook state verified and refreshed.";
      } catch (error) { if (current()) { stale = true; confirmation = null; status.textContent = `${error.message} Refresh before another change.`; } }
      finally { this.changed(chat.id); pending = false; if (current()) render(); }
    };
    const load = async () => {
      if (!current() || pending) return;
      pending = true; confirmation = null; refresh.disabled = true; status.textContent = "Loading native hooks…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/hooks`, { method: "POST", body: "{}" });
        if (!current()) return;
        catalog = result; stale = false; this.changed(chat.id);
        status.textContent = [catalog.busy ? "The agent is working. Definitions are read from disk; refresh when idle to reload them and change hooks." : "Choose a hook to inspect its definition and available actions.", catalog.truncated ? "Showing the first 200 hooks." : "", catalog.warning].filter(Boolean).join(" ");
      } catch (error) { if (current()) { stale = true; status.textContent = error.message; } }
      finally { pending = false; if (current()) { refresh.disabled = false; render(); } }
    };
    search.addEventListener("input", render); events.addEventListener("change", () => { selected = null; confirmation = null; render(); }); search.focus(); await load();
  }
}
