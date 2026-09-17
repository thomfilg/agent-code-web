import { CompanyPicker, knownCompanies } from "./company-picker.js";
import { scopeLabel, scopeAllows, companyForChat } from "./company-scope.js";

const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action) => { const element = node("button", text, "secondary-button"); element.type = "button"; element.onclick = action; return element; };

export class AgentAccountSettings {
  constructor({ api, state, changed, chatUpdated, toast }) {
    Object.assign(this, { api, state, changed, chatUpdated, toast }); this.accounts = []; this.generation = 0;
    this.companies = new CompanyPicker($("#agent-account-companies"));
    $("#agent-accounts-button").onclick = () => this.open();
    $("#connect-codex-button").onclick = () => this.open();
    $("#chat-agent-account").onclick = () => this.open();
    $("#agent-account-new").onclick = () => this.edit(null);
    $("#agent-account-form").onsubmit = event => { event.preventDefault(); void this.connect(); };
    $("#agent-accounts-dialog").addEventListener("close", () => { this.generation++; clearTimeout(this.timer); });
    window.addEventListener("relay-agent-accounts-changed", () => {
      if (!this.syncing) this.syncing = this.refresh().catch(error => this.toast(error.message)).finally(() => { this.syncing = null; });
    });
  }
  async open() {
    try {
      const data = await this.api("/api/agent-accounts"); this.accounts = data.accounts;
      this.renderList(); this.edit(null);
      $("#agent-accounts-dialog").showModal();
    } catch (error) { this.toast(error.message); }
  }
  renderList() {
    const list = $("#agent-account-list"); list.replaceChildren();
    for (const account of this.accounts) {
      const row = node("section", "", "agent-account-card");
      row.append(node("strong", `${account.name} · Codex`), node("p", `${account.email || "Not signed in"} · ${account.status}`, "muted"), node("p", scopeLabel(account), "muted"));
      if (account.error) row.append(node("p", account.error, "form-error"));
      const chat = this.state.active;
      if (chat && account.status === "connected" && chat.agentAccountId !== account.id && !chat.archived && !["running", "starting", "stopping"].includes(chat.status) && scopeAllows(account, companyForChat(chat))) {
        row.append(button("Use in this chat", async () => {
          if (chat.agentAccountId && !confirm(`Use “${account.name}” for this chat? The conversation and files stay, but the agent session restarts with this account.`)) return;
          try {
            const result = await this.api(`/api/chats/${chat.id}/agent`, { method: "PATCH", body: JSON.stringify({ agent: account.provider, agentAccountId: account.id }) });
            this.chatUpdated(result.chat); $("#agent-accounts-dialog").close();
          } catch (error) { $("#agent-account-error").textContent = error.message; }
        }));
      }
      if (account.status === "connected") row.append(button("Disconnect", async () => {
        if (!confirm(`Disconnect “${account.name}”? Its running Codex chats will stop; conversations stay saved.`)) return;
        try { await this.api(`/api/agent-accounts/${account.id}/disconnect`, { method: "POST" }); await this.refresh(); this.edit(account); }
        catch (error) { $("#agent-account-error").textContent = error.message; }
      }));
      else row.append(button(account.status === "pending" ? "Continue sign-in" : "Reconnect", async () => {
        this.edit(account);
        if (account.status === "pending") {
          try { this.renderLogin(await this.api(`/api/agent-accounts/${account.id}`)); this.poll(account.id, this.generation); }
          catch (error) { $("#agent-account-error").textContent = error.message; }
        }
      }));
      list.append(row);
    }
    if (!this.accounts.length) list.append(node("p", "No agent accounts connected. Sign in to Codex below.", "muted"));
  }
  edit(account) {
    this.generation++; clearTimeout(this.timer); this.editing = account;
    $("#agent-account-form").hidden = false;
    $("#agent-account-name").value = account?.name || "";
    this.companies.set(account || {}, knownCompanies(this.state, this.accounts));
    $("#agent-account-error").textContent = ""; $("#agent-account-login").replaceChildren();
    $("#agent-account-submit").disabled = account?.status === "pending";
  }
  async refresh() {
    this.accounts = (await this.api("/api/agent-accounts")).accounts;
    this.renderList(); await this.changed();
  }
  async connect() {
    const generation = ++this.generation; clearTimeout(this.timer);
    $("#agent-account-submit").disabled = true; $("#agent-account-error").textContent = "";
    try {
      const result = await this.api("/api/agent-accounts", { method: "POST", body: JSON.stringify({ provider: "codex", name: $("#agent-account-name").value,
        ...(this.editing ? { id: this.editing.id } : {}), ...this.companies.value() }) });
      if (generation !== this.generation) return;
      this.editing = result.account;
      this.accounts = this.accounts.filter(account => account.id !== result.account.id).concat(result.account); this.renderList();
      this.renderLogin(result); this.poll(result.account.id, generation);
    } catch (error) { if (generation === this.generation) { $("#agent-account-error").textContent = error.message; $("#agent-account-submit").disabled = false; } }
  }
  renderLogin(result) {
    const root = $("#agent-account-login"); root.replaceChildren();
    $("#agent-account-form").hidden = Boolean(result.login) || result.account.status === "connected";
    if (!result.login) { root.append(node("p", result.account.status === "connected" ? "Codex connected. You can select this account in a new chat." : result.account.error || "Sign-in is not pending.")); return; }
    const link = node("a", "Open Codex sign-in", "primary-button");
    link.href = result.login.verificationUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
    const code = node("code", result.login.userCode); code.setAttribute("aria-label", "Codex sign-in code");
    root.append(node("p", "Open the link and enter this one-time code. Keep it private."), code, link,
      button("Copy code", () => navigator.clipboard.writeText(result.login.userCode).catch(() => { $("#agent-account-error").textContent = "Select and copy the code above."; })),
      button("Cancel sign-in", async () => {
        try { this.generation++; clearTimeout(this.timer); this.renderLogin(await this.api(`/api/agent-accounts/${result.account.id}/cancel`, { method: "POST" })); $("#agent-account-submit").disabled = false; await this.refresh(); }
        catch (error) { $("#agent-account-error").textContent = error.message; }
      }));
    root.scrollIntoView({ block: "nearest" }); link.focus({ preventScroll: true });
  }
  poll(id, generation) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (generation !== this.generation || !$("#agent-accounts-dialog").open) return;
      try {
        const result = await this.api(`/api/agent-accounts/${id}`);
        if (generation !== this.generation) return;
        if (result.account.status === "pending") this.poll(id, generation);
        else { this.renderLogin(result); await this.refresh(); $("#agent-account-submit").disabled = false; this.editing = null; }
      } catch (error) { if (generation === this.generation) { $("#agent-account-error").textContent = error.message; $("#agent-account-submit").disabled = false; } }
    }, 1000);
  }
}
