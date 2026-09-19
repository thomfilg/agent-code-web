import { openSidePanel, closeSidePanel } from "./side-panels.js";
const $ = selector => document.querySelector(selector);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
function button(label, action, cls) { const node = el("button", label, cls); node.type = "button"; node.addEventListener("click", action); return node; }
function link(label, url) { const node = el("a", label); node.href = url; node.target = "_blank"; node.rel = "noopener noreferrer"; return node; }
const ghUrl = (repo, suffix = "") => /^[\w.-]+\/[\w.-]+$/.test(repo || "") ? `https://github.com/${repo}${suffix}` : null;
const count = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value) : "Unavailable";

// Selected checkout defaults are not proof of the worker's current branch.
// Use observed snapshots only, and do not repeat a branch already shown by a PR.
export function branchesWithoutPullRequests(chat) {
  const observed = value => typeof value === "string" && value.trim() ? value.trim().slice(0, 4096) : null;
  const repositories = chat.repositories?.length ? chat.repositories : [{ fullName: null }];
  return repositories.flatMap((repository, index) => {
    const branch = (index === 0 ? observed(chat.workspaceStatus?.branch) : null)
      || observed(chat.gitBranches?.find(item => item.repository === repository.fullName)?.branch);
    if (!branch || (chat.pullRequests || []).some(pr => pr.repository?.toLowerCase() === repository.fullName?.toLowerCase() && pr.headRef === branch)) return [];
    return [{ repository: repository.fullName, branch }];
  });
}

export class ChatControls {
  constructor(options) {
    Object.assign(this, options); this.drafts = new Map(); this.hiddenPRs = new Set(); this.uploads = new Map();
    $("#copy-chat-link").addEventListener("click", () => this.copy(`${location.origin}/#chat=${this.state.active.id}`, "Private chat link copied"));
    $("#view-changes").addEventListener("click", () => this.showChanges());
    $("#close-diff").addEventListener("click", () => closeSidePanel("diff"));
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
      if (this.modeChanging) return;
      const chatId = this.state.active.id;
      this.modeChanging = true;
      document.querySelectorAll("[data-agent-mode]").forEach(button => { button.disabled = true; });
      try {
        const { chat } = await this.api(`/api/chats/${chatId}/mode`, { method: "PATCH", body: JSON.stringify({ mode: node.dataset.agentMode }) });
        if (this.state.active?.id === chatId) { this.updated(chat); $("#mode-menu").open = false; }
      }
      catch (error) { this.toast(error.message); }
      finally { this.modeChanging = false; document.querySelectorAll("[data-agent-mode]").forEach(button => { button.disabled = false; }); }
    }));
    $("#add-attachments").addEventListener("click", () => $("#attachment-input").click());
    $("#attachment-input").addEventListener("change", event => this.attach(event.target.files));
    $("#message-input").addEventListener("paste", event => {
      const files = [...(event.clipboardData?.files || [])];
      if (!files.length) for (const item of event.clipboardData?.items || []) if (item.kind === "file") { const file = item.getAsFile(); if (file) files.push(file); }
      if (!files.length) return; // Leave text and unsupported OS file paths alone.
      event.preventDefault(); void this.attach(files);
    });
    // An action may replace its own DOM before the click bubbles here. The
    // dispatch path still identifies the menu that was actually clicked.
    document.addEventListener("click", event => document.querySelectorAll(".control-menu[open]").forEach(menu => { if (!event.composedPath().includes(menu)) menu.open = false; }));
    document.addEventListener("keydown", event => { if (event.key === "Escape") document.querySelectorAll(".control-menu[open]").forEach(menu => menu.open = false); });
  }
  async copy(text, message = "Copied") { try { await navigator.clipboard.writeText(text); this.toast(message); } catch { this.dialog("Copy", el("pre", text)); } }
  dialog(title, ...content) {
    this.dialogVersion = (this.dialogVersion || 0) + 1;
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
      closeSidePanel("diff");
      document.querySelectorAll(".control-menu[open]").forEach(menu => menu.open = false);
    }
    $("#mode-label").textContent = { auto: "Auto", accept_edits: "Edits", plan: "Plan", default: "Manual", dont_ask: "Deny prompts" }[chat.mode || "accept_edits"];
    document.querySelectorAll("[data-claude-mode]").forEach(button => { button.hidden = chat.agent !== "claude"; });
    $("#mode-provider-note").textContent = chat.agent === "codex" ? "Auto routes eligible approvals through Codex's automatic safety reviewer (uses model tokens). Edits asks you. Plan uses a read-only sandbox." : "Claude uses its native permission modes; account restrictions still apply. Private Claude profiles support Approve once and Deny here. Shared host profiles do not support approval replies.";
    const percentage = Number.isFinite(chat.usage?.contextTokens) && chat.usage?.contextWindow ? Math.min(100, chat.usage.contextTokens / chat.usage.contextWindow * 100) : 0;
    $("#usage-ring").style.setProperty("--usage", `${percentage}%`);
    $("#archive-current-chat").textContent = chat.archived ? "Unarchive" : "Archive";
    $("#edit-chat-environment").disabled = !chat.environmentId;
    const signature = JSON.stringify([chat.id, chat.repositories, chat.gitBranches, chat.workspaceStatus?.branch, chat.pullRequests, chat.githubSyncWarning, chat.githubEvents]);
    if (signature !== this.signature) { this.signature = signature; this.repositories(chat); this.pullRequests(chat); }
    this.renderAttachments();
    const goalStatus = $("#goal-status"); goalStatus.replaceChildren();
    if (chat.agent === "codex" && chat.goal) {
      goalStatus.append(button(`Goal · ${chat.goal.status} · ${chat.goal.objective}`, () => this.goal(), "goal-summary"));
      if (chat.mode === "plan" && chat.goal.status === "active") goalStatus.append(el("small", "Plan mode: planning only; automatic goal continuation is disabled.", "muted"));
    }
  }
  async goal(action = null, { throwErrors = false } = {}) {
    const chatId = this.state.active.id;
    if (action === "edit") {
      const input = el("textarea"); input.value = this.state.active.goal?.objective || ""; input.maxLength = 4000; input.rows = 5; input.setAttribute("aria-label", "Goal objective");
      const error = el("p", "", "form-error"); error.setAttribute("role", "alert");
      const save = button("Save goal", async () => {
        if (!input.value.trim()) { error.textContent = "Enter a goal objective."; return; }
        save.disabled = true;
        try { await this.submitCommand(chatId, `/goal edit ${input.value.trim()}`); $("#controls-dialog").close(); }
        catch (failure) { error.textContent = failure.message; }
        finally { save.disabled = false; }
      }, "primary-button");
      this.dialog("Edit Codex goal", input, error, save); input.focus(); return;
    }
    if (action === "clear" && !confirm("Clear this goal? The conversation and workspace will be kept.")) return;
    try {
      if (action) {
        const { chat } = await this.api(`/api/chats/${chatId}/goal`, { method: "PATCH", body: JSON.stringify({ action }) });
        if (this.state.active?.id !== chatId) return;
        this.updated(chat);
      }
      const goal = this.state.active.goal;
      this.dialog("Codex goal", ...(goal ? [
        el("p", goal.objective), el("p", `Status: ${goal.status}`, "muted"),
        el("p", `${count(goal.tokensUsed)} tokens used${goal.tokenBudget ? ` / ${count(goal.tokenBudget)} budget` : " · no token budget set"} · ${Math.round(goal.timeUsedSeconds || 0)} seconds`),
        button(goal.status === "active" ? "Pause goal" : "Resume goal", () => this.goal(goal.status === "active" ? "pause" : "resume"), "secondary-button"),
        button("Clear goal", () => this.goal("clear"), "secondary-button"),
        button("Edit goal", () => this.goal("edit"), "secondary-button"),
      ] : [el("p", "No goal is set. Type /goal followed by the objective to start one.")]),
      el("p", "Goals use Codex's persisted thread state and respect the selected Plan / Edits mode. No budget is imposed unless you set one in Codex.", "muted"));
    } catch (error) { if (throwErrors) throw error; this.toast(error.message); }
  }
  async submitCommand(chatId, text) {
    if (this.state.active?.id !== chatId) throw new Error("The active chat changed. Reopen this control in its chat.");
    const chat = this.state.active, queued = ["starting", "running", "stopping"].includes(chat.status) || chat.queuedMessages?.length;
    return this.api(`/api/chats/${chatId}/${queued ? "queue" : "messages"}`, { method: "POST", body: JSON.stringify({ text, attachments: [] }) });
  }
  savedChats(chats, select) {
    const search = el("input"); search.type = "search"; search.placeholder = "Find a conversation"; search.setAttribute("aria-label", "Find a conversation");
    const list = el("div", undefined, "saved-chat-choices");
    const render = () => { const matches = chats.filter(chat => !chat.archived && chat.title.toLowerCase().includes(search.value.toLowerCase())); list.replaceChildren(...matches.map(chat => button(chat.title, () => { $("#controls-dialog").close(); select(chat); }, "secondary-button"))); if (!matches.length) list.append(el("p", "No matching conversations.")); };
    search.addEventListener("input", render); render(); this.dialog("Resume conversation", search, list); search.focus();
  }
  personality() {
    const chat = this.state.active, chatId = chat.id, dialog = $("#controls-dialog");
    const scope = item => JSON.stringify(item && [item.id, item.ownerId, item.agent, item.model]);
    const original = scope(chat), error = el("p", "", "form-error"); error.setAttribute("role", "alert");
    let pending = false;
    const current = () => dialog.open && this.dialogVersion === version && scope(this.state.active) === original;
    const choices = ["friendly", "pragmatic", "none"].map(value => {
      const choice = button(value[0].toUpperCase() + value.slice(1), async () => {
        if (pending) return;
        if (!current()) { error.textContent = "The chat or model changed. Reopen the personality picker."; choices.forEach(item => item.disabled = true); return; }
        pending = true; error.textContent = ""; choices.forEach(item => item.disabled = true);
        try { await this.submitCommand(chatId, `/personality ${value}`); if (current()) dialog.close(); }
        catch (failure) { if (current()) error.textContent = failure.message; }
        finally {
          pending = false;
          if (current()) choices.forEach(item => item.disabled = false);
          else if (dialog.open && this.dialogVersion === version) error.textContent = "The chat or model changed. Reopen the personality picker.";
        }
      }, "secondary-button");
      choice.setAttribute("aria-pressed", String(chat.personality === value)); return choice;
    });
    this.dialog("Codex personality", el("p", "Applied to later turns in this chat, when supported by its model. Queues behind running work."), ...choices, error);
    const version = this.dialogVersion;
  }
  async inspectCommand(command, terminate = null) {
    const chatId = this.state.active.id;
    if (terminate && !confirm(terminate === "all" ? "Stop all background terminals tracked by this Codex thread? Other chats and the agent itself are kept." : "Stop this background terminal? The agent and other tasks will keep running.")) return;
    const version = this.inspectionVersion = (this.inspectionVersion || 0) + 1;
    this.dialog(command === "ps" ? "Background terminals" : "Codex configuration", el("p", "Loading…"));
    const dialogVersion = this.dialogVersion;
    const result = await this.api(`/api/chats/${chatId}/commands/inspect${terminate ? "" : `?command=${command}`}`, terminate ? { method: "POST", body: JSON.stringify({ terminate, confirm: true }) } : {});
    if (this.inspectionVersion !== version || this.dialogVersion !== dialogVersion || this.state.active?.id !== chatId || !$("#controls-dialog").open) return;
    const refresh = button("Refresh", () => this.inspectCommand(command).catch(error => this.toast(error.message)), "secondary-button");
    const items = result.items.map(item => {
      const row = el("div", undefined, "native-command-item"); row.append(el("pre", item.title), el("p", item.detail, "muted"));
      if (command === "ps" && result.awake) row.append(button(`Stop task ${item.id}`, () => this.inspectCommand("ps", item.id).catch(error => this.toast(error.message)), "secondary-button"));
      return row;
    });
    if (!items.length) items.push(el("p", command === "ps" ? "No tracked background terminals." : "No configuration reported."));
    $("#controls-content").replaceChildren(el("p", result.note, "muted"), ...items, refresh);
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
    root.append(button("Add repository…", () => {
      $("#repositories-menu").open = false;
      const picker = $("#chat-workspace-strip details"); picker.open = true; picker.querySelector("summary").focus();
    }));
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
      const subscription = chat.githubEvents?.subscriptions?.find(item => item.repository === pr.repository.toLowerCase() && item.number === pr.number);
      const choices = [];
      for (const [field, label] of [["notifyFailures", "Notify agent when checks fail"], ["wakePassing", "Wake this chat when checks pass"]]) {
        const row = el("label", undefined, "checkbox-label"), control = document.createElement("input"); control.type = "checkbox";
        control.checked = Boolean(subscription?.[field]); control.disabled = !chat.ownerId || !control.checked && (!chat.agentAccountId || pr.state !== "open");
        control.setAttribute("aria-label", `${label} for PR ${pr.number}`); choices.push(control);
        control.addEventListener("change", async () => {
          if (field === "wakePassing" && control.checked && !confirm(`Allow verified passing checks for ${pr.repository} #${pr.number} to start this chat's worker and send an agent message? This may use worker time and model tokens. It does not enable merging or resume other paused messages.`)) { control.checked = Boolean(subscription?.[field]); return; }
          for (const choice of choices) choice.disabled = true;
          try {
            const { chat: updated } = await this.api(`/api/chats/${chat.id}/pull-requests/subscription`, { method: "PATCH", body: JSON.stringify({ repository: pr.repository, number: pr.number,
              notifyFailures: Boolean(subscription?.notifyFailures), wakePassing: Boolean(subscription?.wakePassing), [field]: control.checked, revision: chat.githubEvents?.revision || 0 }) });
            if (this.state.active?.id === chat.id) this.updated(updated);
          } catch (error) { control.checked = Boolean(subscription?.[field]); if (this.state.active?.id === chat.id) body.append(el("p", error.message, "form-error")); }
          finally { for (const choice of choices) choice.disabled = !chat.ownerId || !choice.checked && (!chat.agentAccountId || pr.state !== "open"); }
        });
        row.append(control, el("span", label)); body.append(row);
      }
      body.append(el("p", chat.githubEvents?.configured ? "Signed event receiver configured; polling reconciles every minute. GitHub webhook registration is managed separately." : "Polling every minute. Live events require an operator-configured GitHub webhook.", "muted"));
      for (const event of chat.githubEvents?.deliveries?.filter(item => item.repository === pr.repository.toLowerCase() && item.number === pr.number).slice(-3) || []) {
        body.append(el("p", `GitHub notification: ${event.checks} · ${event.status}`, event.status === "uncertain" || event.status === "blocked" ? "form-error" : "muted"));
        if (["uncertain", "blocked", "pending"].includes(event.status)) {
          for (const [action, label] of [["retry", "Review and retry notification"], ["discard", "Discard notification"]]) body.append(button(label, async () => {
            if (action === "retry" && !confirm("Review the conversation first: this notification may already have reached the agent. Retry may repeat work. Send it again only if appropriate?")) return;
            try { const { chat: updated } = await this.api(`/api/chats/${chat.id}/pull-requests/event`, { method: "PATCH", body: JSON.stringify({ id: event.id, action }) }); if (this.state.active?.id === chat.id) this.updated(updated); }
            catch (error) { if (this.state.active?.id === chat.id) body.append(el("p", error.message, "form-error")); }
          }, "secondary-button"));
        }
      }
      body.append(el("p", "GitHub events grant no merge or permission changes. Auto-merge follows existing repository rules; no admin bypass.", "muted"));
      ci.append(summary, body); row.append(ci, button("×", () => { this.hiddenPRs.add(`${chat.id}:${pr.repository}:${pr.number}`); this.pullRequests(chat); }, "small-icon")); root.append(row);
    }
    for (const ref of branchesWithoutPullRequests(chat)) {
      const row = el("div", undefined, "pull-request-bar branch-only"); row.setAttribute("role", "group"); row.setAttribute("aria-label", `Git branch for ${ref.repository || "workspace"}`);
      const icon = el("span", "⑂"); icon.setAttribute("aria-hidden", "true");
      const branch = el("span", `${ref.repository?.split("/")[1] || "Workspace"} · ${ref.branch}`, "pr-branch");
      branch.title = `${ref.repository || "Workspace"} · ${ref.branch}`;
      row.append(icon, branch); root.append(row);
    }
  }
  async showChanges(pr = this.state.active?.pullRequests?.at(-1)) {
    const chat = this.state.active; if (!chat) return;
    openSidePanel("diff");
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
    this.preview.open({ title: "Transcript", source: text || "No messages yet", format: "text" });
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
  addDraftAttachment(chatId, file) {
    const draft = this.drafts.get(chatId) || [];
    if (draft.some(item => item.id === file.id)) return;
    if (draft.length >= 10 || draft.reduce((sum, item) => sum + item.size, 0) + file.size > 20 * 1024 * 1024) throw new Error("Attach up to 10 files and 20 MB per message");
    this.drafts.set(chatId, [...draft, file]); this.renderAttachments();
  }
  attachmentButton(file, { chatId = this.state.active?.id, messageId } = {}) {
    const label = file.workspaceContext ? `${file.workspaceContext.path || "Workspace"}${file.workspaceContext.range ? `:${file.workspaceContext.range.start.line}–${file.workspaceContext.range.end.line}` : ""}` : file.name;
    const open = button(label, () => this.openAttachment(file, { chatId, messageId, trigger: open }), "attachment-open");
    open.setAttribute("aria-label", `Preview ${file.name}`); open.title = `Preview ${file.name}`; return open;
  }
  async openAttachment(file, context) {
    if (file.appReference) {
      const app = file.appReference;
      this.dialog(app.name, el("p", `Native app reference · ${app.token}`), el("p", `Company: ${app.company || "Unassigned"}`, "muted"), el("p", app.inactive ? "Historical reference. Select the app again to use it in this chat." : "Saved reference only, not a copy of account credentials. Access is rechecked when this input runs.", "muted"));
      return;
    }
    const version = this.attachmentPreviewVersion = (this.attachmentPreviewVersion || 0) + 1;
    try {
      const attachment = file.previewSource ? file : (await this.api(`/api/chats/${context.chatId}/attachments/${file.id}`)).attachment;
      if (this.state.active?.id !== context.chatId || this.attachmentPreviewVersion !== version) return;
      const image = /^image\/(png|jpeg|webp|gif|avif)$/.test(attachment.mime || "");
      let source;
      if (image) source = attachment.previewSource || `data:${attachment.mime};base64,${attachment.data}`;
      else if (/^(?:text\/|application\/(?:json|xml))/.test(attachment.mime || "") || /\.(?:txt|md|json|csv|log|html|svg|js|ts|css)$/i.test(attachment.name)) {
        source = new TextDecoder().decode(Uint8Array.from(atob(attachment.data), char => char.charCodeAt(0)));
      } else { this.toast("Preview is available for images and text files."); return; }
      this.preview.open({ ...context, source, format: image ? "image" : "text", title: attachment.name });
    } catch (error) { this.toast(error.message); }
  }
  renderAttachments() {
    const root = $("#attachment-chips"); root.replaceChildren(...this.attachments().map(file => {
      const chip = el("span", undefined, "attachment-chip"), remove = button("×", () => { this.drafts.set(this.state.active.id, this.attachments().filter(item => item.id !== file.id)); this.renderAttachments(); }, "small-icon");
      remove.setAttribute("aria-label", `Remove ${file.name}`); chip.append(this.attachmentButton(file), remove); return chip;
    }));
    if (this.uploads.has(this.state.active?.id)) root.append(el("span", "Uploading…", "muted"));
  }
  clearAttachments(chatId, sentIds) { if (sentIds) this.drafts.set(chatId, (this.drafts.get(chatId) || []).filter(file => !sentIds.includes(file.id))); else this.drafts.delete(chatId); this.renderAttachments(); }
  async waitForUploads(chatId) { while (this.uploads.has(chatId)) await this.uploads.get(chatId); }
  attach(files) {
    const chatId = this.state.active?.id; if (!chatId) return;
    const list = [...files];
    return this.queueUpload(chatId, () => this.uploadFiles(chatId, list));
  }
  queueUpload(chatId, action) {
    const pending = (this.uploads.get(chatId) || Promise.resolve()).catch(() => {}).then(action);
    this.uploads.set(chatId, pending); this.renderAttachments();
    const clear = () => { if (this.uploads.get(chatId) === pending) this.uploads.delete(chatId); this.renderAttachments(); };
    void pending.then(clear, clear);
    return pending;
  }
  async uploadFiles(chatId, files) {
    for (const file of files) {
      const draft = this.drafts.get(chatId) || [];
      if (draft.length >= 10 || draft.reduce((sum, item) => sum + item.size, 0) + file.size > 20 * 1024 * 1024) { this.toast("Attach up to 10 files and 20 MB per message"); break; }
      if (file.size > 5 * 1024 * 1024) { this.toast(`${file.name}: maximum file size is 5 MB`); continue; }
      try {
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file); });
        const result = await this.api(`/api/chats/${chatId}/attachments`, { method: "POST", body: JSON.stringify({ name: file.name, mime: file.type, data }) });
        const previewSource = /^image\/(png|jpeg|webp|gif|avif)$/.test(file.type) ? `data:${file.type};base64,${data}` : undefined;
        this.drafts.set(chatId, [...(this.drafts.get(chatId) || []), { ...result.attachment, ...(previewSource ? { previewSource } : {}) }]); this.renderAttachments();
      } catch (error) { this.toast(error.message); }
    }
    $("#attachment-input").value = "";
  }
}
