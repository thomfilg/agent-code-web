const $ = selector => document.querySelector(selector);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
function button(label, action, cls) { const node = el("button", label, cls); node.type = "button"; node.addEventListener("click", action); return node; }
function link(label, url) { const node = el("a", label); node.href = url; node.target = "_blank"; node.rel = "noopener noreferrer"; return node; }
const ghUrl = (repo, suffix = "") => /^[\w.-]+\/[\w.-]+$/.test(repo || "") ? `https://github.com/${repo}${suffix}` : null;
const count = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value) : "Unavailable";

export class ChatControls {
  constructor(options) {
    Object.assign(this, options); this.drafts = new Map(); this.hiddenPRs = new Set();
    $("#copy-chat-link").addEventListener("click", () => this.copy(`${location.origin}/#chat=${this.state.active.id}`, "Private chat link copied"));
    $("#view-changes").addEventListener("click", () => this.showChanges());
    $("#close-diff").addEventListener("click", () => { $("#diff-panel").hidden = true; $(".main").classList.remove("diff-open"); });
    $("#expand-diff").addEventListener("click", () => $("#diff-panel").classList.toggle("expanded"));
    $("#diff-search").addEventListener("input", () => this.filterDiff());
    $("#diff-selection").addEventListener("change", event => this.showChanges(event.target.value === "workspace" ? null : this.state.active.pullRequests[Number(event.target.value)]));
    $("#transcript-view").addEventListener("click", () => this.transcript());
    $("#edit-chat-environment").addEventListener("click", () => this.openEnvironment());
    $("#archive-current-chat").addEventListener("click", () => this.patch({ archived: !this.state.active.archived }));
    $("#background-tasks").addEventListener("click", () => this.tasks());
    $("#open-workspace").addEventListener("click", () => this.workspace());
    $("#show-connectors").addEventListener("click", () => this.connectors());
    document.querySelectorAll("[data-agent-mode]").forEach(node => node.addEventListener("click", async () => {
      try { const { chat } = await this.api(`/api/chats/${this.state.active.id}/mode`, { method: "PATCH", body: JSON.stringify({ mode: node.dataset.agentMode }) }); this.updated(chat); $("#mode-menu").open = false; }
      catch (error) { this.toast(error.message); }
    }));
    $("#add-attachments").addEventListener("click", () => $("#attachment-input").click());
    $("#attachment-input").addEventListener("change", event => this.attach(event.target.files));
    document.addEventListener("click", event => document.querySelectorAll(".control-menu[open]").forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }));
    document.addEventListener("keydown", event => { if (event.key === "Escape") document.querySelectorAll(".control-menu[open]").forEach(menu => menu.open = false); });
  }
  async copy(text, message = "Copied") { try { await navigator.clipboard.writeText(text); this.toast(message); } catch { this.dialog("Copy", el("pre", text)); } }
  dialog(title, ...content) {
    document.querySelectorAll(".control-menu[open]").forEach(menu => menu.open = false);
    $("#controls-title").textContent = title; $("#controls-content").replaceChildren(...content);
    $("#controls-dialog").showModal();
  }
  async patch(input) {
    try { const { chat } = await this.api(`/api/chats/${this.state.active.id}`, { method: "PATCH", body: JSON.stringify(input) }); this.updated(chat); }
    catch (error) { this.toast(error.message); }
  }
  render(chat) {
    if (this.chatId !== chat.id) {
      this.chatId = chat.id; this.diffVersion = (this.diffVersion || 0) + 1;
      $("#diff-panel").hidden = true; $("#diff-panel").classList.remove("expanded"); $(".main").classList.remove("diff-open");
      document.querySelectorAll(".control-menu[open]").forEach(menu => menu.open = false);
    }
    $("#mode-label").textContent = { auto: "Auto", accept_edits: "Edits", plan: "Plan" }[chat.mode || "accept_edits"];
    $("#mode-provider-note").textContent = chat.agent === "codex" ? "Codex keeps on-request approvals in Auto and Accept edits. Plan uses a read-only sandbox." : "Claude uses its native permission modes. Your CLI/account may restrict availability.";
    const percentage = Number.isFinite(chat.usage?.contextTokens) && chat.usage?.contextWindow ? Math.min(100, chat.usage.contextTokens / chat.usage.contextWindow * 100) : 0;
    $("#usage-ring").style.setProperty("--usage", `${percentage}%`);
    $("#archive-current-chat").textContent = chat.archived ? "Unarchive" : "Archive";
    $("#edit-chat-environment").disabled = !chat.environmentId;
    const signature = JSON.stringify([chat.id, chat.repositories, chat.gitBranches, chat.pullRequests, chat.githubSyncWarning]);
    if (signature !== this.signature) { this.signature = signature; this.repositories(chat); this.pullRequests(chat); }
    this.renderAttachments();
  }
  repositories(chat) {
    const root = $("#chat-repositories"); root.replaceChildren();
    for (const repo of chat.repositories || []) {
      const branch = chat.gitBranches?.find(ref => ref.repository === repo.fullName)?.branch || repo.branch;
      root.append(el("p", repo.fullName, "menu-caption"));
      const url = ghUrl(repo.fullName); if (url) root.append(link("Open repository on GitHub ↗", url));
      if (branch) root.append(button(`Copy branch · ${branch}`, () => this.copy(branch, "Branch name copied")));
    }
    if (!chat.repositories?.length) root.append(el("p", "No GitHub repositories selected", "muted"));
    root.append(button("Add repository…", () => this.addRepository()));
  }
  async addRepository() {
    const chatId = this.state.active.id;
    this.dialog("Add repository", el("p", "Loading your GitHub repositories…"));
    try {
      const { repositories } = await this.api("/api/github/repositories");
      const select = el("select"); select.setAttribute("aria-label", "Repository to add");
      for (const repo of repositories.filter(repo => !this.state.active.repositories?.some(existing => existing.fullName === repo.fullName))) { const option = el("option", repo.fullName); option.value = repo.fullName; select.append(option); }
      const branch = el("input"); branch.placeholder = "Default branch"; branch.setAttribute("aria-label", "Branch to add");
      const save = button("Add repository", async () => {
        save.disabled = true;
        try { const { chat } = await this.api(`/api/chats/${chatId}/repositories`, { method: "POST", body: JSON.stringify({ fullName: select.value, branch: branch.value || undefined }) }); this.updated(chat); $("#controls-dialog").close(); }
        catch (error) { this.toast(error.message); }
        finally { save.disabled = false; }
      }); save.disabled = !select.options.length;
      $("#controls-content").replaceChildren(el("p", "Stop active work first. Your original primary repository and company grouping stay unchanged. New repositories clone on the next message.", "muted"), select, branch, save);
    } catch (error) { $("#controls-content").replaceChildren(el("p", error.message, "form-error")); }
  }
  pullRequests(chat) {
    const root = $("#pull-request-bars"); root.replaceChildren();
    for (const pr of chat.pullRequests || []) {
      if (this.hiddenPRs.has(`${chat.id}:${pr.repository}:${pr.number}`)) continue;
      const url = ghUrl(pr.repository, `/pull/${pr.number}`); if (!url) continue;
      const row = el("div", undefined, "pull-request-bar");
      const status = pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.conflicts || pr.checks === "failing" ? "failing" : "open";
      const prLink = link(`⑂ #${pr.number}`, url); prLink.className = `pr-${status}`; prLink.title = "Open pull request on GitHub";
      const branch = el("span", `${pr.repository.split("/")[1]}${pr.headRef ? ` · ${pr.headRef}` : ""}`, "pr-branch"); branch.title = `${pr.repository} · ${pr.headRef || "Branch unavailable"}`;
      row.append(prLink, branch);
      const changes = button("", () => this.showChanges(pr), "pr-change-count"); changes.append(el("span", `+${count(pr.additions)} `), el("span", `−${count(pr.deletions)}`, "pr-deletions")); changes.setAttribute("aria-label", `View changes for PR ${pr.number}`); row.append(changes);
      const ci = el("details", undefined, "control-menu upward ci-menu"); const summary = el("summary", pr.conflicts ? "Conflict" : pr.checks === "pending" ? "◌ CI" : pr.checks === "failing" ? "× CI" : "CI⌄");
      const body = el("div", undefined, "control-popover"); body.append(link("CI monitoring ↗", `${url}/checks`));
      if (pr.ci) for (const [key, label] of [["inProgress", "In progress"], ["passed", "Passed"], ["skipped", "Skipped"], ["failed", "Failed"]]) {
        const line = el("div", undefined, `ci-count ${key}`); line.append(el("span", label), el("strong", String(pr.ci[key]))); body.append(line);
      } else body.append(el("p", "Check counts unavailable", "muted"));
      if (pr.conflicts) body.append(el("p", "Merge conflicts detected. Resolve them before merging.", "form-error"));
      else if (pr.conflicts === null && pr.state === "open") body.append(el("p", "GitHub is checking mergeability.", "muted"));
      if (pr.checksStale || chat.githubSyncWarning) body.append(el("p", chat.githubSyncWarning || "Checks are stale", "form-error"));
      const auto = el("label", undefined, "checkbox-label"); const input = document.createElement("input"); input.type = "checkbox"; input.checked = pr.autoMerge; input.disabled = pr.state !== "open"; input.setAttribute("aria-label", `Auto-merge PR ${pr.number}`);
      input.addEventListener("change", async () => {
        const enabled = input.checked;
        if (enabled && !confirm(`Enable GitHub auto-merge for ${pr.repository} #${pr.number}? GitHub will merge it when its branch requirements pass.`)) { input.checked = pr.autoMerge; return; }
        input.disabled = true;
        try { const { chat: updated } = await this.api(`/api/chats/${chat.id}/pull-requests/auto-merge`, { method: "PATCH", body: JSON.stringify({ repository: pr.repository, number: pr.number, enabled }) }); this.updated(updated); }
        catch (error) { input.checked = pr.autoMerge; body.append(el("p", error.message, "form-error")); }
        finally { input.disabled = pr.state !== "open"; }
      });
      auto.append(input, el("span", "Auto-merge when ready")); body.append(auto);
      const fix = el("label", undefined, "checkbox-label"); const fixing = document.createElement("input"); fixing.type = "checkbox"; fixing.disabled = true;
      fix.append(fixing, el("span", "Auto-fix CI & comments · not available")); body.append(fix, el("p", "CI checks refresh every minute. Auto-merge follows GitHub repository rules; no admin bypass.", "muted"));
      ci.append(summary, body); row.append(ci, button("×", () => { this.hiddenPRs.add(`${chat.id}:${pr.repository}:${pr.number}`); this.pullRequests(chat); }, "small-icon")); root.append(row);
    }
  }
  async showChanges(pr = this.state.active?.pullRequests?.at(-1)) {
    $("#tools-panel").hidden = true; $(".main").classList.remove("tools-open");
    const chat = this.state.active; if (!chat) return;
    const version = this.diffVersion = (this.diffVersion || 0) + 1;
    const selection = $("#diff-selection"); selection.replaceChildren();
    const workspace = el("option", "Workspace · last local snapshot"); workspace.value = "workspace"; selection.append(workspace);
    (chat.pullRequests || []).forEach((item, index) => { const option = el("option", `${item.repository} #${item.number} · GitHub PR`); option.value = index; selection.append(option); });
    selection.value = pr ? String(chat.pullRequests.indexOf(pr)) : "workspace";
    $("#diff-panel").hidden = false; $(".main").classList.add("diff-open"); $("#diff-search").value = "";
    $("#diff-title").textContent = pr ? `${pr.baseRef || "base"} → ${pr.headRef || `PR #${pr.number}`}` : "Workspace changes";
    $("#diff-files").replaceChildren(el("p", "Loading changes…", "muted"));
    try {
      const result = pr ? await this.api(`/api/chats/${chat.id}/pull-requests/files?repository=${encodeURIComponent(pr.repository)}&number=${pr.number}`) : await this.api(`/api/chats/${chat.id}/changes`);
      if (this.state.active?.id !== chat.id || this.diffVersion !== version) return;
      $("#diff-source").textContent = result.note || result.source;
      $("#diff-files").replaceChildren(...result.files.map(file => this.diffFile(file)));
      if (!result.files.length) $("#diff-files").append(el("p", "No changes to display", "muted"));
    } catch (error) { if (this.diffVersion === version) $("#diff-files").replaceChildren(el("p", error.message, "form-error")); }
  }
  diffFile(file) {
    const block = el("details", undefined, "diff-file"); block.open = true; block.dataset.filename = file.filename.toLowerCase();
    block.append(el("summary", `${file.filename}${file.additions !== undefined ? `  +${file.additions} −${file.deletions}` : ""}`));
    const pre = el("pre", undefined, "diff-code"); let oldLine = 0, newLine = 0;
    for (const line of (file.patch || "Patch unavailable for this file. Open the PR on GitHub to see it.").split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
      const cls = hunk ? "hunk" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context";
      const row = el("div", undefined, `diff-line ${cls}`);
      const number = hunk ? "" : cls === "removed" ? oldLine++ : newLine++;
      if (!hunk && cls === "context") oldLine++;
      row.append(el("span", String(number), "line-number"), el("span", line)); pre.append(row);
    }
    block.append(pre); return block;
  }
  filterDiff() { for (const file of $("#diff-files").children) file.hidden = !file.dataset.filename?.includes($("#diff-search").value.toLowerCase()); }
  transcript() {
    const text = (this.state.active.messages || []).map(message => `${message.role.toUpperCase()}\n${message.text || ""}${message.meta?.output ? `\n${message.meta.output}` : ""}`).join("\n\n");
    this.dialog("Transcript", button("Copy transcript", () => this.copy(text)), el("pre", text || "No messages yet", "transcript"));
  }
  tasks() {
    const live = [...this.state.liveTools.values()];
    this.dialog("Background tasks", el("p", "Tools reported by this chat. Detached processes outside the CLI are not tracked here.", "muted"), ...live.map(tool => el("p", `${tool.title} · ${tool.state}`)), ...(!live.length ? [el("p", "No active tool calls")] : []));
  }
  workspace() {
    const chat = this.state.active;
    this.dialog("Open in…", el("p", "Workspace path", "muted"), el("code", chat.workspace), button("Copy workspace path", () => this.copy(chat.workspace)),
      ...(chat.repositories || []).filter(repo => ghUrl(repo.fullName)).map(repo => link(`${repo.fullName} ↗`, ghUrl(repo.fullName))));
  }
  async connectors() {
    this.dialog("Connectors", el("p", "Loading connected tools…"));
    try { const info = await this.api(`/api/chats/${this.state.active.id}/session-info`); $("#controls-content").replaceChildren(el("p", "Worker-reported MCP status. Save connections in the sidebar’s MCP connections section, then select them in this chat’s environment. Changes apply on the next worker start.", "muted"), ...(info.connectors?.length ? info.connectors.map(server => el("p", `${server.name} · ${server.status}`)) : [el("p", "No connector information reported yet.")])); }
    catch (error) { $("#controls-content").replaceChildren(el("p", error.message, "form-error")); }
  }
  attachments() { return this.drafts.get(this.state.active?.id) || []; }
  renderAttachments() {
    const root = $("#attachment-chips"); root.replaceChildren(...this.attachments().map(file => {
      const chip = el("span", undefined, "attachment-chip"); chip.append(el("span", file.name), button("×", () => { this.drafts.set(this.state.active.id, this.attachments().filter(item => item.id !== file.id)); this.renderAttachments(); }, "small-icon")); return chip;
    }));
  }
  clearAttachments(chatId) { this.drafts.delete(chatId); this.renderAttachments(); }
  async attach(files) {
    const chatId = this.state.active?.id; if (!chatId) return;
    for (const file of files) {
      const draft = this.drafts.get(chatId) || [];
      if (draft.length >= 10 || draft.reduce((sum, item) => sum + item.size, 0) + file.size > 20 * 1024 * 1024) { this.toast("Attach up to 10 files and 20 MB per message"); break; }
      if (file.size > 5 * 1024 * 1024) { this.toast(`${file.name}: maximum file size is 5 MB`); continue; }
      try {
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file); });
        const result = await this.api(`/api/chats/${chatId}/attachments`, { method: "POST", body: JSON.stringify({ name: file.name, mime: file.type, data }) });
        this.drafts.set(chatId, [...(this.drafts.get(chatId) || []), result.attachment]); this.renderAttachments();
      } catch (error) { this.toast(error.message); }
    }
    $("#attachment-input").value = "";
  }
}
