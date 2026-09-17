const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };

export class NativeAppsPicker {
  constructor({ state, api, controls, toast }) { Object.assign(this, { state, api, controls, toast }); }
  async open() {
    const chat = this.state.active;
    if (chat?.agent !== "codex") throw new Error("Native apps require Codex");
    const status = node("p", "Loading apps from this chat’s native session…", "muted"); status.setAttribute("role", "status");
    const search = node("input"); search.type = "search"; search.placeholder = "Find an app…"; search.setAttribute("aria-label", "Find a native app");
    const results = node("div", undefined, "native-app-list");
    const refresh = node("button", "Refresh apps"); refresh.type = "button";
    this.controls.dialog("Codex apps", node("p", "Choose an already connected app to reference in your next message. Opening this picker may wake the worker, but does not send an agent message or connect a new account.", "muted"),
      node("p", "Apps use the native Codex account and permissions. This picker does not isolate or change company credentials.", "muted"), search, status, results, refresh);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && version === this.controls.dialogVersion && this.state.active?.id === chat.id && this.state.active.agent === "codex";
    let catalog, selecting = false;
    const choose = async app => {
      if (!current() || selecting) return;
      if (this.controls.attachments().some(file => file.appReference?.id === app.id)) { this.toast("This app is already attached to the draft."); return; }
      selecting = true; render(); status.textContent = `Checking ${app.name}…`;
      try {
        await this.controls.queueUpload(chat.id, async () => {
          if (!current()) return;
          const result = await this.api(`/api/chats/${chat.id}/apps/select`, { method: "POST", body: JSON.stringify({ appId: app.id, threadId: catalog.threadId }) });
          if (!current()) return;
          this.controls.addDraftAttachment(chat.id, result.attachment);
          const input = document.querySelector("#message-input");
          const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
          const before = input.value.slice(0, start), after = input.value.slice(end);
          const insertion = `${before && !/\s$/.test(before) ? " " : ""}${result.token} `;
          input.value = before + insertion + after;
          dialog.close(); input.focus(); input.setSelectionRange(start + insertion.length, start + insertion.length); input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      } catch (error) { if (current()) status.textContent = error.message; }
      finally { selecting = false; if (current()) render(); }
    };
    const render = () => {
      if (!current() || !catalog) return;
      const query = search.value.trim().toLowerCase();
      const apps = catalog.apps.filter(app => `${app.name} ${app.description}`.toLowerCase().includes(query));
      results.replaceChildren(...apps.map(app => {
        const row = node("section", undefined, "native-app-card"), heading = node("h3", app.name), description = node("p", app.description, "muted");
        const state = app.callable ? "Available in this session" : !app.accessible ? "Not connected" : !app.enabled ? "Disabled in this session" : "Not callable under this session’s policy";
        const select = node("button", `Use ${app.name}`); select.type = "button"; select.disabled = !app.callable || selecting; select.addEventListener("click", () => void choose(app));
        row.append(heading, description, node("small", state, "muted"), select); return row;
      }));
      if (!apps.length) results.append(node("p", query ? "No matching apps." : "No native apps are available in this session.", "muted"));
      refresh.disabled = selecting;
    };
    const load = async () => {
      if (!current() || selecting) return;
      refresh.disabled = true; catalog = null; results.replaceChildren(); status.textContent = "Loading apps from this chat’s native session…";
      try {
        const result = await this.api(`/api/chats/${chat.id}/apps`, { method: "POST", body: "{}" });
        if (!current()) return;
        catalog = result; status.textContent = result.truncated ? "Showing the first 200 apps. Selections are checked again when sent." : "Selections are checked again when sent. Existing native approval rules still apply."; render();
      } catch (error) { if (current()) status.textContent = error.message; }
      finally { if (current()) refresh.disabled = false; }
    };
    refresh.addEventListener("click", () => void load()); search.addEventListener("input", render); search.focus();
    await load();
  }
}
