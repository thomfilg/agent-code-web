const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (label, action) => { const item = node("button", label); item.type = "button"; item.addEventListener("click", action); return item; };
const label = action => ({ install: "Install", remove: "Remove", enable: "Enable", disable: "Disable" })[action];

export class NativePluginsPicker {
  constructor({ state, api, controls, changed }) { Object.assign(this, { state, api, controls, changed }); }
  async open() {
    const chat = this.state.active;
    if (chat?.agent !== "codex") throw new Error("Native plugins require Codex");
    const status = node("p", "Loading native plugins…", "muted"); status.setAttribute("role", "status");
    const search = node("input"); search.type = "search"; search.placeholder = "Find a plugin…"; search.setAttribute("aria-label", "Find a native plugin");
    const tabs = node("div", undefined, "native-plugin-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Plugin marketplaces");
    const results = node("div", undefined, "native-app-list native-plugin-list"); results.id = "native-plugin-results"; results.setAttribute("role", "tabpanel");
    const detail = node("section", undefined, "native-plugin-detail"); detail.hidden = true;
    const scope = node("p", "", "muted");
    const refresh = button("Refresh plugins", () => void load());
    this.controls.dialog("Codex plugins", node("p", "Inspect installed and available native plugins. Opening this picker may wake the worker, but never sends an agent message. Changes require an idle chat and explicit confirmation.", "muted"), scope, search, tabs, status, results, detail, refresh);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && this.state.active?.id === chat.id && this.state.active.agent === "codex";
    let catalog, marketplace = "", selected = null, pending = false, stale = false, confirmation = null;
    const renderDetails = () => {
      const plugin = catalog?.plugins.find(item => item.id === selected);
      detail.replaceChildren(); detail.hidden = !plugin;
      if (!plugin) return;
      detail.append(node("h3", plugin.name), node("p", plugin.id, "muted"), node("p", plugin.description || "No description supplied by the native marketplace.", "muted"),
        node("p", `Version: ${plugin.version || "not specified"} · Source: ${plugin.source || "native marketplace"}`, "muted"),
        node("p", plugin.capabilities.length ? `Capabilities: ${plugin.capabilities.join(", ")}` : "Plugins may add skills, tools, apps or hooks. Only install plugins you trust.", "muted"));
      if (plugin.reason) detail.append(node("p", plugin.reason, "muted"));
      const actions = node("div", undefined, "native-plugin-actions");
      for (const action of plugin.actions) {
        const control = button(`${label(action)} ${plugin.name}`, () => { confirmation = action; renderDetails(); detail.querySelector(".native-plugin-confirm button")?.focus(); });
        control.disabled = pending || stale || catalog.busy; actions.append(control);
      }
      detail.append(actions);
      if (confirmation && plugin.actions.includes(confirmation)) {
        const prompt = node("div", undefined, "native-plugin-confirm");
        prompt.append(node("p", `${label(confirmation)} ${plugin.name} in this chat’s private native profile? ${confirmation === "install" ? "This adds plugin code and may make new tools or hooks available to the agent. Account authentication, if needed, remains separate." : "This changes which plugin capabilities are available to this chat and its side agents."}`));
        const confirm = button(`Confirm ${confirmation} ${plugin.name}`, () => void change(plugin, confirmation)); confirm.disabled = pending || stale || catalog.busy;
        const cancel = button("Cancel plugin change", () => { confirmation = null; renderDetails(); detail.querySelector("button")?.focus(); }); cancel.disabled = pending;
        prompt.append(confirm, cancel); detail.append(prompt);
      }
    };
    const render = () => {
      if (!current() || !catalog) return;
      scope.textContent = catalog.mutable ? "Changes are limited to this chat’s private native profile. No host account settings are changed." : "Shared host profile: inspection only. Company-scoped native profiles are required before plugin changes can be enabled here.";
      tabs.replaceChildren();
      const markets = ["", ...new Set(catalog.plugins.map(plugin => plugin.marketplace))];
      if (!markets.includes(marketplace)) marketplace = "";
      markets.forEach((name, index) => {
        const tab = button(name || "All marketplaces", () => { marketplace = name; confirmation = null; render(); tabs.children[index]?.focus(); });
        tab.id = `native-plugin-tab-${index}`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", results.id); tab.setAttribute("aria-selected", String(name === marketplace)); tab.tabIndex = name === marketplace ? 0 : -1;
        tab.addEventListener("keydown", event => {
          const next = { ArrowRight: (index + 1) % markets.length, ArrowLeft: (index - 1 + markets.length) % markets.length, Home: 0, End: markets.length - 1 }[event.key];
          if (next !== undefined) { event.preventDefault(); tabs.children[next]?.click(); }
        });
        tabs.append(tab); if (name === marketplace) results.setAttribute("aria-labelledby", tab.id);
      });
      const query = search.value.trim().toLowerCase();
      const matching = catalog.plugins.filter(plugin => (!marketplace || plugin.marketplace === marketplace) && `${plugin.name} ${plugin.id} ${plugin.description}`.toLowerCase().includes(query));
      results.replaceChildren(...matching.map(plugin => {
        const row = node("section", undefined, "native-app-card native-plugin-card");
        const show = button(`Details for ${plugin.name}`, () => { selected = plugin.id; confirmation = null; renderDetails(); detail.scrollIntoView({ block: "nearest" }); });
        row.append(node("h3", plugin.name), node("small", `${plugin.marketplace} · ${plugin.installed ? plugin.enabled ? "Enabled" : "Disabled" : "Not installed"}`, "muted"), show); return row;
      }));
      if (!matching.length) results.append(node("p", query || marketplace ? "No matching plugins." : "No plugins found in this native profile’s configured marketplaces.", "muted"));
      refresh.disabled = pending; renderDetails();
    };
    const change = async (plugin, action) => {
      if (!current() || pending || stale) return;
      const input = { id: plugin.id, action, confirm: true, threadId: catalog.threadId, revision: catalog.revision };
      pending = true; status.textContent = `${label(action)} ${plugin.name}…`; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/plugins/change`, { method: "POST", body: JSON.stringify(input) });
        if (!current()) return;
        catalog = result; confirmation = null; status.textContent = "Plugin state and installed skills refreshed.";
      } catch (error) { if (current()) { stale = true; confirmation = null; status.textContent = `${error.message} Refresh before another change.`; } }
      finally { this.changed(chat.id); pending = false; if (current()) render(); }
    };
    const load = async () => {
      if (!current() || pending) return;
      pending = true; confirmation = null; refresh.disabled = true; status.textContent = "Loading native plugins…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/plugins`, { method: "POST", body: "{}" });
        if (!current()) return;
        catalog = result; stale = false; this.changed(chat.id);
        status.textContent = [catalog.busy ? "The agent is working. Refresh when idle to change plugins." : "Select a plugin to inspect its details and available actions.", catalog.truncated ? "Showing the first 200 plugins." : "", catalog.warning].filter(Boolean).join(" ");
      } catch (error) { if (current()) { stale = true; status.textContent = error.message; } }
      finally { pending = false; if (current()) { refresh.disabled = false; render(); } }
    };
    search.addEventListener("input", render); search.focus(); await load();
  }
}
