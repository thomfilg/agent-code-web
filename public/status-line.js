// Shared, allowlisted web-footer preferences. Values come from chat snapshots,
// never from preference text, shell commands or native configuration writes.
export const STATUS_ITEMS = [
  ["model-name", "Model", "Selected model, or the provider's last reported default."],
  ["model-with-reasoning", "Model and reasoning", "Model plus the selected reasoning effort."],
  ["context-remaining", "Context remaining", "Remaining percentage of the latest reported context window."],
  ["context-used", "Context used", "Latest request context, not cumulative session tokens."],
  ["context-window-size", "Context window size", "Provider-reported context capacity."],
  ["five-hour-limit", "5-hour limit", "Reported 5-hour account/model utilization, when available."],
  ["weekly-limit", "Weekly limit", "Reported weekly account/model utilization, when available."],
  ["git-branch", "Git branch", "Last observed branch of the primary repository, including main or detached HEAD."],
  ["total-tokens", "Total tokens", "Cumulative reported session tokens; cached input is not counted twice."],
  ["total-input-tokens", "Input tokens", "Cumulative reported input, including cache reads and writes."],
  ["total-output-tokens", "Output tokens", "Cumulative reported output; reasoning is already included."],
  ["session-id", "Session ID", "Native agent session ID, not the Relay chat ID."],
  ["current-dir", "Current directory", "Agent working directory reported by the worker."],
  ["project-root", "Project root", "Primary Git root observed on the worker, not a controller-side mirror."],
  ["codex-version", "Agent CLI version", "Version reported by this chat's Codex or Claude worker."],
].map(([id, label, help]) => ({ id, label, help }));
export const DEFAULT_STATUS_ITEMS = [];
const LEGACY_DEFAULT_STATUS_ITEMS = ["model-with-reasoning", "context-remaining", "git-branch"];
// Do not rewrite saved preferences. Only the old automatic footer is suppressed;
// custom selections remain an explicit /statusline option.
export function visibleStatusItems(items, revision = 0) {
  return revision === 0 && items.length === LEGACY_DEFAULT_STATUS_ITEMS.length && items.every((id, index) => id === LEGACY_DEFAULT_STATUS_ITEMS[index]) ? [] : [...items];
}
export function validateStatusItems(items) {
  if (items === null) return []; // Explicitly disable the footer.
  if (!Array.isArray(items) || items.length > STATUS_ITEMS.length || new Set(items).size !== items.length || items.some(id => !STATUS_ITEMS.some(item => item.id === id))) {
    throw Object.assign(new Error("Choose each available status-line item at most once."), { statusCode: 400 });
  }
  return [...items];
}
const known = value => Number.isFinite(value) && value >= 0;
const count = value => known(value) ? Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value) : null;
const text = value => typeof value === "string" && value.trim() ? value.trim().slice(0, 4096) : null;
export function statusItemValue(id, chat = {}, now = Date.now()) {
  const item = STATUS_ITEMS.find(item => item.id === id); if (!item) return null;
  const usage = chat.usage || {}, totals = usage.totals || {};
  const details = chat.sessionDetails && chat.sessionDetails.agent === chat.agent ? chat.sessionDetails : {};
  const model = text(chat.model) || (details.model ? `Default · ${text(details.model)}` : "Account default");
  const input = known(totals.inputTokens) ? totals.inputTokens + (totals.cacheReadTokens || 0) + (totals.cacheWriteTokens || 0) : null;
  const total = known(usage.totalTokens) ? usage.totalTokens : known(input) && known(totals.outputTokens) ? input + totals.outputTokens : null;
  const percentage = known(usage.contextTokens) && usage.contextWindow > 0 ? Math.min(100, usage.contextTokens / usage.contextWindow * 100) : null;
  const limit = minutes => (chat.rateLimits || []).flatMap(entry => (entry.windows || []).filter(window => window.minutes === minutes).map(window => {
    if (!known(window.usedPercent)) return null;
    const stale = window.resetsAt && window.resetsAt * 1000 <= now;
    return `${text(entry.name) || text(entry.id) || "Account"}: ${Math.round(window.usedPercent)}% used${stale ? " (awaiting refresh)" : ""}`;
  }).filter(Boolean)).join(" · ") || null;
  const values = {
    "model-name": model,
    "model-with-reasoning": `${model} · ${text(chat.effort) || "default effort"}`,
    "context-remaining": percentage === null ? null : `${Math.round(100 - percentage)}% left`,
    "context-used": count(usage.contextTokens) === null ? null : `${count(usage.contextTokens)}${percentage === null ? "" : ` (${Math.round(percentage)}%)`}`,
    "context-window-size": count(usage.contextWindow),
    "five-hour-limit": limit(300), "weekly-limit": limit(10080),
    "git-branch": text(chat.workspaceStatus?.branch),
    "total-tokens": count(total), "total-input-tokens": count(input), "total-output-tokens": count(totals.outputTokens),
    "session-id": text(chat.agentSessionId), "current-dir": text(details.cwd),
    "project-root": text(chat.workspaceStatus?.projectRoot), "codex-version": text(details.cliVersion),
  };
  const value = values[id];
  const exact = { "total-tokens": total, "total-input-tokens": input, "total-output-tokens": totals.outputTokens, "context-used": usage.contextTokens, "context-window-size": usage.contextWindow }[id];
  const timestamp = ["git-branch", "project-root"].includes(id) ? chat.workspaceStatus?.recordedAt : ["current-dir", "codex-version"].includes(id) ? details.recordedAt : usage.recordedAt;
  return { ...item, value: value ?? "Not reported", unavailable: value === null,
    title: `${item.label}: ${known(exact) ? exact.toLocaleString("en") : value ?? "Not reported by this worker"}. ${item.help}${usage.partial && id.includes("tokens") ? " Historical totals are partial." : ""}${timestamp ? ` Snapshot: ${timestamp}.` : ""}` };
}
