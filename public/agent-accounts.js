import { CompanyPicker, knownCompanies } from "./company-picker.js";
import { scopeLabel, scopeAllows, companyForChat } from "./company-scope.js";

const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action) => { const element = node("button", text, "secondary-button"); element.type = "button"; element.onclick = action; return element; };

export class AgentAccountSettings {
  constructor({ api, state, changed, chatUpdated, toast }) {
    Object.assign(this, { api, state, changed, chatUpdated, toast });
    this.accounts = []; this.logins = new Map(); this.errors = new Map(); this.actions = new Map(); this.accountVersions = new Map(); this.generation = 0; this.listRequest = 0;
    this.companies = new CompanyPicker($("#agent-account-companies"), () => {}, { compact: true });
    $("#agent-accounts-button").onclick = () => this.open();
    $("#connect-codex-button").onclick = () => this.open();
    $("#chat-agent-account").onclick = () => this.open();
    $("#agent-account-new").onclick = () => {
      if (!$("#agent-account-form").hidden) this.showForm(false);
      else this.edit();
    };
    $("#agent-account-cancel").onclick = () => this.showForm(false);
    $("#agent-account-form").onsubmit = event => { event.preventDefault(); void this.connect(); };
    $("#agent-accounts-dialog").addEventListener("close", () => { this.generation++; clearTimeout(this.timer); });
    window.addEventListener("relay-agent-accounts-changed", () => { void this.refresh().catch(error => this.toast(error.message)); });
  }
  async open() {
    if (this.opening) return;
    this.opening = true;
    try {
      await this.refresh();
      this.generation++;
      this.showForm(Boolean(this.connecting));
      if (!$("#agent-accounts-dialog").open) $("#agent-accounts-dialog").showModal();
      this.schedulePoll(0);
    } catch (error) { this.toast(error.message); }
    finally { this.opening = false; }
  }
  notifyChanged() {
    const key = JSON.stringify(this.accounts);
    if (this.notified === key) return;
    this.notified = key;
    this.notifying = (this.notifying || Promise.resolve()).catch(() => {}).then(() => this.changed()).catch(error => this.toast(error.message));
  }
  renderList() {
    const chat = this.state.active;
    const key = JSON.stringify([this.accounts, [...this.logins], [...this.errors], [...this.actions], chat?.id, chat?.agentAccountId, chat?.status, chat?.archived, chat && companyForChat(chat)]);
    if (this.rendered === key) return;
    this.rendered = key;
    const list = $("#agent-account-list"); list.replaceChildren();
    for (const account of this.accounts) {
      const row = node("section", "", "agent-account-card"), heading = node("h3", `${account.name} · Codex`);
      row.dataset.accountId = account.id; heading.id = `heading-${account.id}`; row.setAttribute("aria-labelledby", heading.id);
      const status = account.status === "pending" ? this.logins.has(account.id) ? "Waiting for authorization" : "Connecting…" : account.status === "connected" ? "Connected" : "Not connected";
      row.append(heading);
      if (!this.actions.has(account.id)) row.append(node("p", account.email ? `${account.email} · ${status}` : status, "muted"));
      else if (account.email) row.append(node("p", account.email, "muted"));
      row.append(node("p", scopeLabel(account), "muted"));
      if (account.error && !this.actions.has(account.id) && !this.errors.has(account.id)) row.append(node("p", account.error, "form-error"));
      if (this.errors.has(account.id)) { const error = node("p", this.errors.get(account.id), "form-error"); error.setAttribute("role", "alert"); row.append(error); }
      if (this.actions.has(account.id)) {
        const progress = node("p", this.actions.get(account.id), "agent-account-progress"); progress.setAttribute("role", "status"); row.append(progress);
      } else {
        if (chat && account.status === "connected" && chat.agentAccountId !== account.id && !chat.archived && !["running", "starting", "stopping"].includes(chat.status) && scopeAllows(account, companyForChat(chat))) {
          row.append(button("Use in this chat", async () => {
            if (chat.agentAccountId && !confirm(`Use “${account.name}” for this chat? The conversation and files stay, but the agent session restarts with this account.`)) return;
            const generation = this.generation;
            await this.act(account, "Selecting account…", async () => {
              const result = await this.api(`/api/chats/${chat.id}/agent`, { method: "PATCH", body: JSON.stringify({ agent: account.provider, agentAccountId: account.id }) });
              this.chatUpdated(result.chat);
              if (generation === this.generation) $("#agent-accounts-dialog").close();
            });
          }));
        }
        if (account.status === "connected") row.append(button("Disconnect", () => {
          if (!confirm(`Disconnect “${account.name}”? Its running Codex chats will stop; conversations stay saved.`)) return;
          return this.act(account, "Disconnecting…", async () => this.accept(await this.api(`/api/agent-accounts/${account.id}/disconnect`, { method: "POST" })));
        }));
        else if (account.status === "pending") this.renderLogin(row, account);
        else row.append(button("Reconnect", () => this.reconnect(account)));
      }
      list.append(row);
    }
    if (!this.accounts.length) list.append(node("p", "No agent accounts yet. Add an account to sign in.", "muted"));
  }
  renderLogin(row, account) {
    const root = node("div", "", "agent-account-login"), login = this.logins.get(account.id);
    const status = node("p", login ? `Sign in to Codex for “${account.name}”. Open the link and enter this one-time code. Keep it private.` : `Connecting to Codex for “${account.name}”… Preparing your sign-in link. This may take a moment; this panel updates automatically.`);
    status.setAttribute("role", "status");
    if (!login) status.className = "agent-account-progress";
    root.append(status);
    if (login) {
      const link = node("a", "Open Codex sign-in", "primary-button");
      link.href = login.verificationUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `Open Codex sign-in for ${account.name}`);
      const code = node("code", login.userCode); code.setAttribute("aria-label", `Codex sign-in code for ${account.name}`);
      const copy = button("Copy code", async () => {
        try { await navigator.clipboard.writeText(login.userCode); if (copy.isConnected) copy.textContent = "Copied"; }
        catch { this.errors.set(account.id, "Select and copy the code above."); this.renderList(); }
      });
      root.append(code, link, copy);
    }
    root.append(button("Cancel sign-in", () => this.act(account, "Cancelling sign-in…", async () => this.accept(await this.api(`/api/agent-accounts/${account.id}/cancel`, { method: "POST" })))));
    row.append(root);
  }
  async act(account, label, action) {
    if (this.actions.has(account.id)) return;
    this.accountVersions.set(account.id, (this.accountVersions.get(account.id) || 0) + 1); this.listRequest++;
    this.actions.set(account.id, label); this.errors.delete(account.id); this.renderList();
    try { await action(); }
    catch (error) { this.errors.set(account.id, error.message); }
    finally { this.actions.delete(account.id); this.renderList(); this.schedulePoll(); }
  }
  async reconnect(account) {
    // Reconnection is not account creation: keep the saved name and exact
    // access scope, and show progress on this card without reopening a form.
    await this.act(account, `Connecting to Codex for “${account.name}”…`, async () => {
      this.accept(await this.api("/api/agent-accounts", { method: "POST", body: JSON.stringify({
        id: account.id, provider: account.provider, name: account.name,
        companies: account.companies, allowUnassigned: account.allowUnassigned,
      }) }));
    });
  }
  showForm(visible) {
    $("#agent-account-form").hidden = !visible;
    $("#agent-account-new").textContent = visible ? "− Close account form" : "＋ Add Codex account";
    $("#agent-account-new").setAttribute("aria-expanded", String(visible));
  }
  edit() {
    if (this.connecting) return;
    if (!this.formInitialized) {
      this.formInitialized = true;
      $("#agent-account-name").value = "";
      this.companies.set({}, knownCompanies(this.state, this.accounts));
      $("#agent-account-error").textContent = "";
    }
    this.showForm(true);
    $("#agent-account-form").scrollIntoView({ block: "nearest" }); $("#agent-account-name").focus({ preventScroll: true });
  }
  async refresh() {
    const request = ++this.listRequest;
    const data = await this.api("/api/agent-accounts");
    if (request !== this.listRequest) return;
    this.accounts = data.accounts;
    for (const id of this.logins.keys()) if (!this.accounts.some(account => account.id === id && account.status === "pending")) this.logins.delete(id);
    this.renderList(); this.notifyChanged(); this.schedulePoll(0);
  }
  accept(result) {
    // A slow POST response must not turn an already connected account back into
    // a pending one after a newer status request or event has completed it.
    const current = this.accounts.find(account => account.id === result.account.id);
    if (current?.status === "connected" && result.account.status === "pending") return;
    this.listRequest++;
    this.accounts = current ? this.accounts.map(account => account.id === result.account.id ? result.account : account) : [...this.accounts, result.account];
    if (result.account.status === "pending" && result.login) this.logins.set(result.account.id, result.login);
    else this.logins.delete(result.account.id);
    this.errors.delete(result.account.id); this.renderList(); this.notifyChanged();
  }
  setConnecting(name) {
    this.connecting = name;
    $("#agent-account-fields").disabled = Boolean(name);
    $("#agent-account-new").disabled = Boolean(name);
    $("#agent-account-form").setAttribute("aria-busy", String(Boolean(name)));
    $("#agent-account-submit").textContent = name ? "Connecting…" : "Sign in to Codex";
    $("#agent-account-progress").hidden = !name;
    $("#agent-account-progress").textContent = name ? `Connecting to Codex for “${name}”… Preparing your sign-in link. This may take a moment.` : "";
  }
  async connect() {
    if (this.connecting) return;
    const input = { provider: "codex", name: $("#agent-account-name").value,
      ...this.companies.value() };
    const generation = this.generation;
    this.setConnecting(input.name); $("#agent-account-error").textContent = "";
    try {
      const result = await this.api("/api/agent-accounts", { method: "POST", body: JSON.stringify(input) });
      this.accept(result); this.formInitialized = false; this.showForm(false);
      if (generation === this.generation && $("#agent-accounts-dialog").open) {
        const row = [...$("#agent-account-list").children].find(element => element.dataset.accountId === result.account.id);
        row?.scrollIntoView({ block: "nearest" }); row?.querySelector("a")?.focus({ preventScroll: true });
      }
    } catch (error) {
      $("#agent-account-error").textContent = error.message;
    } finally { this.setConnecting(null); this.schedulePoll(0); }
  }
  schedulePoll(delay = 1000) {
    clearTimeout(this.timer);
    if ($("#agent-accounts-dialog").open && this.accounts.some(account => account.status === "pending") && this.polling?.generation !== this.generation) {
      this.timer = setTimeout(() => { void this.pollPending(); }, delay);
    }
  }
  async pollPending() {
    const generation = this.generation;
    if (!$("#agent-accounts-dialog").open || this.polling?.generation === generation) return;
    const flight = { generation }; this.polling = flight;
    try {
      await Promise.all(this.accounts.filter(account => account.status === "pending").map(async account => {
        if (this.actions.has(account.id)) return;
        const version = this.accountVersions.get(account.id) || 0;
        try {
          const result = await this.api(`/api/agent-accounts/${account.id}`);
          if (generation === this.generation && version === (this.accountVersions.get(account.id) || 0) && !this.actions.has(account.id)) this.accept(result);
        } catch {
          if (generation === this.generation && version === (this.accountVersions.get(account.id) || 0)) { this.errors.set(account.id, "Could not load sign-in details. Retrying automatically…"); this.renderList(); }
        }
      }));
    } finally {
      if (this.polling === flight) this.polling = null;
      if (generation === this.generation) this.schedulePoll();
    }
  }
}
