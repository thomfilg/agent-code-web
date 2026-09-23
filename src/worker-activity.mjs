const ACTIVE_TOOL_STATES = new Set(["running", "stopping"]);

export function hasActiveTool(chat) {
  return Boolean(chat?.messages?.some(message => message.kind === "tool" && ACTIVE_TOOL_STATES.has(message.meta?.state)));
}

export function hasQueuedSystemWork(chat) {
  return Boolean(chat?.queuedMessages?.some(item => item.githubEventId || item.nativeApprovalId || item.relayGoalWake || item.systemWork));
}

// This is the single policy boundary for worker lifetime. UI observation is
// deliberately absent: opening or hiding a chat is never evidence of work.
export function workerActivity({ chat, runtime, controls = false, importing = false, forking = false,
  side = false, browser = false, preview = false, workspace = false } = {}) {
  const reasons = [];
  if (runtime?.busy || (!runtime && chat?.status === "running")) reasons.push("foreground");
  if (chat?.goal?.status === "active" || runtime?.adapter?.goal?.status === "active") reasons.push("goal");
  if (runtime?.adapter?.agents?.busy?.()) reasons.push("agents");
  if (runtime?.adapter?.isBackgroundBusy?.() || runtime?.adapter?.hasAwaitedBackgroundWork?.()) reasons.push("background");
  if (runtime?.adapter?.hasScheduledWork?.()) reasons.push("schedule");
  if (hasActiveTool(chat)) reasons.push("tool");
  if (hasQueuedSystemWork(chat)) reasons.push("queue");
  if (controls) reasons.push("control");
  if (importing) reasons.push("import");
  if (forking) reasons.push("fork");
  if (side) reasons.push("side");
  if (browser) reasons.push("browser");
  if (preview) reasons.push("preview");
  if (workspace) reasons.push("workspace");
  return { active: reasons.length > 0, reason: reasons[0] || null, reasons };
}

export function workerActivityDetail(reason) {
  return ({
    foreground: "Sleep paused while the agent is working",
    goal: "Sleep paused while the goal is active",
    agents: "Sleep paused while child agents are working",
    background: "Sleep paused while awaited background work is active",
    schedule: "Sleep paused while native scheduled tasks are active",
    tool: "Sleep paused while a tool or process is active",
    queue: "Sleep paused while queued system work is pending",
    control: "Sleep paused while a control action is pending",
    import: "Sleep paused until the import is reconciled",
    fork: "Creating an independent fork",
    side: "Sleep paused while the side chat is working",
    browser: "Sleep paused while Chrome is open",
    preview: "Sleep paused while an app preview is active",
    workspace: "Sleep paused while the workspace viewer is open",
  })[reason] || "Waiting for another message";
}
