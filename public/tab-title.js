// Browser-tab equivalents of the native /title fields. Never use draft text,
// messages, tool arguments or arbitrary templates to construct a tab title.
export const TITLE_ITEMS = [
  ["app-name", "App name", "Agent Relay."],
  ["project", "Project", "Primary repository, or the worker's reported project directory."],
  ["spinner", "Activity indicator", "Animates only while this chat is working; respects reduced motion."],
  ["status", "Status", "Runtime status, with pending answers and approvals taking priority."],
  ["thread", "Chat name", "The saved name of the selected chat; this does not rename it."],
  ["git-branch", "Git branch", "Last observed primary-repository branch, including detached HEAD."],
  ["model", "Model", "Selected model, or the current agent's reported default."],
  ["task-progress", "Task progress", "Reported Codex goal state, or completed/total native plan steps when available. No guessed completion percentage."],
].map(([id, label, help]) => ({ id, label, help }));
export const DEFAULT_TITLE_ITEMS = ["spinner", "project"];
export const TITLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function validateTitleItems(items) {
  if (items === null) return [];
  if (!Array.isArray(items) || items.length > TITLE_ITEMS.length || new Set(items).size !== items.length || items.some(id => !TITLE_ITEMS.some(item => item.id === id))) {
    throw Object.assign(new Error("Choose each available tab-title item at most once."), { statusCode: 400 });
  }
  return [...items];
}
export const titleBusy = chat => Boolean(chat && !chat.archived && chat.workflowState !== "archived" && !chat.pendingRequest && !chat.awaitingUser && ["running", "starting"].includes(chat.status));
const clean = value => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim() : "";
const bounded = value => { const chars = Array.from(clean(value)); return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : chars.join(""); };
const leaf = value => clean(value).split(/[\\/]/).filter(Boolean).at(-1) || "";
export function titleItemValue(id, chat = {}, frame = 0) {
  const details = chat.sessionDetails?.agent === chat.agent ? chat.sessionDetails || {} : {};
  const progress = chat.taskProgress?.agent === chat.agent && chat.taskProgress?.sessionId === chat.agentSessionId ? chat.taskProgress : null;
  const validProgress = progress && Number.isSafeInteger(progress.total) && Number.isSafeInteger(progress.completed) && progress.total >= 0 && progress.completed >= 0 && progress.completed <= progress.total;
  const goalStatus = { active: "active", paused: "paused", complete: "complete", blocked: "blocked", usageLimited: "usage-limited", budgetLimited: "budget-limited" }[chat.goal?.status];
  const goal = chat.agent === "codex" && chat.agentSessionId && chat.goal?.threadId === chat.agentSessionId && typeof goalStatus === "string" ? `Goal ${goalStatus}` : null;
  const suspension = chat.suspension?.status;
  const runtimeStatus = suspension === "hibernating" ? "Hibernating" : suspension === "hibernated" && chat.status === "starting" ? "Resuming" : suspension === "hibernated" ? "Hibernated"
    : suspension === "failed" && chat.status === "error" ? "Hibernation failed"
    : ({ running: "Working", starting: "Starting", stopping: "Stopping", idle: "Ready", stopped: "Stopped", error: "Error" }[chat.status] || "Not reported");
  const status = chat.archived || chat.workflowState === "archived" ? "Archived" : chat.pendingRequest ? (chat.pendingRequest.method?.includes("requestUserInput") ? "Needs answer" : "Approval needed") : chat.awaitingUser ? "Needs reply" : runtimeStatus;
  const values = {
    "app-name": "Agent Relay", project: chat.repositories?.[0]?.fullName || leaf(chat.workspaceStatus?.projectRoot) || leaf(details.cwd),
    spinner: titleBusy(chat) ? (frame === null ? "◌" : TITLE_FRAMES[frame % TITLE_FRAMES.length]) : "",
    status, thread: chat.title || "Untitled chat", "git-branch": chat.workspaceStatus?.branch,
    model: chat.model || details.model || "Account default",
    "task-progress": goal || (validProgress ? `${progress.completed}/${progress.total} steps` : "Progress not reported"),
  };
  if (!TITLE_ITEMS.some(item => item.id === id)) return "";
  return bounded(values[id]) || (id === "spinner" ? "" : "Not reported");
}
export function formatTabTitle(items, chat, frame = 0) {
  if (!chat) return "Agent Relay";
  return Array.from(items.map(id => titleItemValue(id, chat, frame)).filter(Boolean).join(" · ") || "Agent Relay").slice(0, 512).join("");
}
