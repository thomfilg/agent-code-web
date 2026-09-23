export function elapsedLabel(startedAt, now = Date.now()) {
  const start = Date.parse(startedAt);
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function activeToolCount(chat, liveTools = new Map()) {
  const tools = new Map();
  // Older turns may have no terminal tool event after interruption. Only the
  // current turn contributes, and final persisted events override live copies.
  for (const message of chat?.messages || []) {
    if (message.role === "user") tools.clear();
    if (message.kind === "tool") tools.set(message.meta?.itemId || message.id, message.meta?.state);
  }
  for (const [id, tool] of liveTools) if (!tools.has(id) || tools.get(id) === "running") tools.set(id, tool.state);
  return [...tools.values()].filter(state => state === "running").length;
}

export function workingStatus(chat, liveTools, now = Date.now()) {
  if (!chat || !["running", "starting"].includes(chat.status)) return "";
  const startupStartedAt = chat.status === "starting" && typeof chat.startupProgress?.startedAt === "string" && Number.isFinite(Date.parse(chat.startupProgress.startedAt)) ? chat.startupProgress.startedAt : null;
  const started = startupStartedAt || chat.workingStartedAt || chat.messages?.findLast(message => message.role === "user")?.createdAt || chat.lastActivityAt;
  const count = activeToolCount(chat, liveTools);
  return `${chat.status === "starting" ? "Starting" : "Working"} · ${elapsedLabel(started, now)} · Esc to interrupt · ${count} active ${count === 1 ? "tool" : "tools"}`;
}

export function canInterruptWithEscape(event) {
  if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if ([...document.querySelectorAll("dialog[open], details.control-menu[open], #repository-picker details[open], #tools-panel:not([hidden]), #side-panel:not([hidden]), #agents-panel:not([hidden]), #browser-panel:not([hidden])")].some(element => element.getClientRects().length)) return false;
  const editor = event.target?.closest?.("input, textarea, select, [contenteditable], canvas, [role=application], .CodeMirror");
  return !editor || editor.id === "message-input";
}
