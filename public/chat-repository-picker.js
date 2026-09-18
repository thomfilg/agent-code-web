import { companyForChat } from "./company-scope.js";
const el = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls || ""; if (text !== undefined) node.textContent = text; return node; };
const option = value => { const node = el("option", "", value); node.value = value; return node; };
const busy = chat => !chat || ["running", "starting", "stopping"].includes(chat.status) || chat.workflowState === "archived";

// The same compact workspace strip stays above the composer after creation.
// Every asynchronous result is tied to its original chat and picker opening.
export class ChatRepositoryPicker {
  constructor(options) {
    Object.assign(this, options); this.version = 0;
    this.chips = el("div", "selected-repositories");
    this.menu = el("details", "control-menu upward repository-picker-dropdown");
    const summary = el("summary", "", "+"); summary.setAttribute("role", "button"); summary.setAttribute("aria-label", "Add repository to chat"); summary.setAttribute("aria-expanded", "false"); summary.setAttribute("aria-controls", "chat-repository-popover"); summary.title = "Add repository";
    this.panel = el("div", "control-popover repository-popover"); this.panel.id = "chat-repository-popover"; this.menu.append(summary, this.panel);
    this.root.append(this.chips, this.menu);
    this.menu.addEventListener("toggle", () => { summary.setAttribute("aria-expanded", String(this.menu.open)); if (this.menu.open) void this.load(); else this.version++; });
  }
  render(chat) {
    if (this.chatId !== chat.id) { this.chatId = chat.id; this.menu.open = false; this.version++; }
    const signature = JSON.stringify([chat.id, chat.environmentId, chat.repositories, chat.gitBranches, chat.workspaceStatus?.branch, this.getEnvironments()]);
    if (signature !== this.signature) {
      this.signature = signature; this.chips.replaceChildren();
      const environment = this.getEnvironments()?.find(item => item.id === chat.environmentId);
      if (environment) {
        const chip = el("button", "environment-chip", `☁ ${environment.name}`); chip.type = "button";
        chip.title = "Environment settings"; chip.setAttribute("aria-label", `Environment: ${environment.name}`);
        chip.onclick = () => this.manageEnvironment(environment.id); this.chips.append(chip);
      }
      for (const [index, repo] of (chat.repositories || []).entries()) {
        const chip = el("div", "repository-chip"); chip.title = repo.fullName;
        const link = el("a", "repository-name", `‹/› ${repo.fullName.split("/").at(-1)}`);
        link.href = `https://github.com/${repo.fullName.split("/").map(encodeURIComponent).join("/")}`; link.target = "_blank"; link.rel = "noopener noreferrer";
        const observed = (index === 0 && chat.workspaceStatus?.branch) || chat.gitBranches?.find(ref => ref.repository === repo.fullName)?.branch;
        const branch = el("span", "repository-branch", `⑂ ${observed || repo.branch || "default"}`);
        branch.title = observed ? "Current reported branch" : "Selected branch · checkout not yet reported";
        chip.append(link, branch); this.chips.append(chip);
      }
    }
    this.menu.hidden = Boolean(chat.source);
    if (this.save) this.save.disabled = Boolean(this.pending) || busy(chat) || !this.branch?.value;
    if (this.status && !this.pending) this.status.textContent = busy(chat) ? "Wait for the agent to finish before adding a repository." : "";
  }
  async load(refresh = false) {
    const chat = this.getChat(); if (!chat) return;
    const version = ++this.version;
    const current = () => version === this.version && this.menu.open && this.getChat()?.id === chat.id;
    this.save = null; this.status = null; this.panel.replaceChildren(el("p", "muted", "Loading repositories…"));
    try {
      const { repositories } = await this.api(`/api/github/repositories${refresh ? "?refresh=1" : ""}`);
      if (!current()) return;
      const searchRow = el("div", "repository-search"), search = el("input"); search.type = "search";
      search.placeholder = "Search repositories…"; search.setAttribute("aria-label", "Search repositories to add");
      const reload = el("button", "small-icon", "↻"); reload.type = "button"; reload.setAttribute("aria-label", "Refresh chat repositories"); reload.onclick = () => this.load(true);
      searchRow.append(search, reload);
      const list = el("div", "repository-results"), selection = el("div", "repository-add-selection");
      const render = () => {
        const existing = this.getChat()?.repositories || [];
        const company = companyForChat(this.getChat() || {});
        const available = repositories.filter(repo => (!repo.companyId || repo.companyId === (company || repo.fullName.split("/")[0].toLowerCase())) && !existing.some(item => item.fullName.toLowerCase() === repo.fullName.toLowerCase()) && repo.fullName.toLowerCase().includes(search.value.toLowerCase()));
        list.replaceChildren(...available.map(repo => {
          const button = el("button", "repository-option", repo.fullName); button.type = "button";
          if (repo.connectionName) button.append(el("small", "", repo.connectionName));
          button.onclick = () => this.choose(repo, selection, chat.id, version); return button;
        }));
        if (!available.length) list.append(el("p", "muted", "No other matching repositories. Refresh or check your GitHub connection."));
      };
      search.oninput = render; this.panel.replaceChildren(searchRow, list, selection); render(); search.focus();
    } catch (error) {
      if (!current()) return;
      const retry = el("button", "secondary-button", "Retry loading repositories"); retry.type = "button"; retry.onclick = () => this.load(true);
      this.panel.replaceChildren(el("p", "form-error", error.message), retry);
    }
  }
  async choose(repo, root, chatId, version) {
    if (this.pending) return;
    const choice = this.choice = (this.choice || 0) + 1;
    const current = () => choice === this.choice && version === this.version && this.menu.open && this.getChat()?.id === chatId;
    this.branch = el("select"); this.branch.setAttribute("aria-label", `Branch for ${repo.fullName}`); this.branch.append(option(repo.defaultBranch));
    this.status = el("p", "muted"); this.status.setAttribute("role", "status");
    const error = el("p", "form-error"); error.setAttribute("role", "alert");
    this.save = el("button", "secondary-button", "Add repository"); this.save.type = "button";
    const save = this.save, branch = this.branch, status = this.status;
    root.replaceChildren(el("strong", "", repo.fullName), branch,
      el("p", "muted", "Adding restarts this workspace and stops its running services. Files and conversation are kept; cloning happens on the next wake or message."), status, error, save);
    this.render(this.getChat());
    save.onclick = async () => {
      if (!current() || this.pending || busy(this.getChat())) return;
      this.pending = true; save.disabled = true; branch.disabled = true; save.textContent = "Adding…"; status.textContent = "Updating workspace…"; error.textContent = "";
      try {
        const { chat } = await this.api(`/api/chats/${chatId}/repositories`, { method: "POST", body: JSON.stringify({ fullName: repo.fullName, branch: branch.value, githubConnectionId: repo.githubConnectionId }) });
        this.updated(chat); if (current()) this.menu.open = false;
      } catch (failure) { if (current()) error.textContent = failure.message; }
      finally { this.pending = false; if (current()) { branch.disabled = false; save.textContent = "Add repository"; this.render(this.getChat()); } }
    };
    try {
      const { branches } = await this.api(`/api/github/branches?repository=${encodeURIComponent(repo.fullName)}${repo.githubConnectionId ? `&connection=${encodeURIComponent(repo.githubConnectionId)}` : ""}&company=${encodeURIComponent(companyForChat(this.getChat() || {}) || "")}`);
      if (current() && !this.pending) { const selected = branch.value; branch.replaceChildren(...[...new Set([selected, ...branches])].map(option)); branch.value = selected; }
    } catch { if (current()) error.textContent = "Could not load other branches. You can use the default branch or select the repository again to retry."; }
  }
}
