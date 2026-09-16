// Shared by discovery and the composer: every advertised control has a handler.
export const WEB_COMMAND_ALIASES = { reset: "clear", name: "rename", cost: "usage", stats: "usage", subagents: "agent" };
export const WEB_COMMANDS = {
  usage: "Show detailed session usage", status: "Show session status and usage", context: "Show context usage",
  model: "Choose the agent model", effort: "Choose reasoning effort", plan: "Switch to Plan mode; optionally include a task",
  diff: "Open workspace changes", mcp: "Manage MCP connections", skills: "Browse installed commands and skills",
  stop: "Stop the agent and pause the queue", rename: "Rename or organize this chat", archive: "Archive this chat",
  new: "Create a new chat", compact: "Compact the current session", goal: "Set a persistent Codex goal, or view / pause / resume / clear it",
  permissions: "Choose Auto, Edits, or read-only Plan permissions", mode: "Choose the agent permission mode",
  reasoning: "Choose reasoning effort; optionally provide the level", copy: "Copy the latest completed assistant response",
  mention: "Mention workspace files or folders; optionally provide a path", ide: "Attach Relay's open workspace files and selected text; optionally include a task", raw: "Open the plain conversation transcript", transcript: "Open the plain conversation transcript",
  clear: "Start a fresh chat without deleting this one", resume: "Choose a saved conversation",
  delete: "Delete this chat after confirmation", quit: "Stop this chat's agent and pause its queue", exit: "Stop this chat's agent and pause its queue",
  help: "Browse commands and installed skills", init: "Create or improve this repository's AGENTS.md instructions",
  review: "Run a native code review; optionally use --base, --commit, or custom instructions",
  fast: "Toggle this model's Fast service tier; may change usage costs", personality: "Choose friendly, pragmatic, or no personality instructions",
  ps: "Inspect native background terminals and stop individual tasks", clean: "Stop this thread's background terminals after confirmation",
  "debug-config": "Inspect non-secret effective Codex configuration and its source layers",
  side: "Open a temporary side chat; optionally include a question", btw: "Ask a side question without interrupting the main chat",
  fork: "Fork this conversation into an independent chat and workspace; optionally provide a title",
  agent: "Choose a native child agent to inspect or continue; /subagents is an alias",
  apps: "Choose a connected native app to reference in your next message",
  plugins: "Inspect native plugins; manage installation and enablement in a private chat profile",
  hooks: "Review native lifecycle hooks; trust, disable or enable private-profile hooks",
  experimental: "Inspect native beta features and change private-profile settings",
  memories: "Control native memory use and generation; reset saved private-profile memories",
  import: "Review and import Claude Code or Cursor setup and conversations into this private chat profile",
  approve: "Confirm and queue one retry of a specific action denied by automatic review",
  feedback: "Review and explicitly send feedback to OpenAI, with optional native diagnostics",
  logout: "Inspect and confirm native Codex sign-out for this private profile",
  keymap: "Inspect, remap and save Relay web keyboard shortcuts",
};
export const webCommands = (agent, capabilities = {}) => Object.entries(WEB_COMMANDS)
  .filter(([name]) => !["goal", "init", "review", "fast", "personality", "ps", "clean", "debug-config", "side", "btw", "fork", "agent", "ide", "apps", "plugins", "hooks", "experimental", "memories", "import", "approve", "feedback", "logout"].includes(name) || agent === "codex")
  .filter(([name]) => !["fast", "personality"].includes(name) || capabilities[name])
  .map(([name, description]) => ({ name, description, aliases: Object.entries(WEB_COMMAND_ALIASES).filter(([, target]) => target === name).map(([alias]) => alias), kind: "Web control", web: true }));
