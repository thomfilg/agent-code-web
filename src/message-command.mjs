import { parseSlashCommand } from "../public/slash-command.js";

export function messageCommand(agent, text) {
  if (text.trim() === "/compact") return agent === "codex" ? { type: "compact" } : { type: "nativeCommand", prompt: text };
  const parsed = parseSlashCommand(text);
  if (!parsed?.name) return null;
  const { name, argument } = parsed;
  if (agent === "claude" && ["config", "settings", "autocompact", "update-config", "fewer-permission-prompts", "doctor", "checkup"].includes(name)) return { type: "claudeConfig", prompt: text };
  if (agent === "claude" && name === "fast") {
    if (argument && !["on", "off"].includes(argument)) throw new Error("Use /fast, /fast on, or /fast off");
    return { type: "claudeFast", prompt: text };
  }
  if (agent === "claude" && name === "effort" && argument === "status") return null;
  if (name === "keymap") throw new Error("Open /keymap without arguments to remap Relay keyboard shortcuts. This is a web control, not agent input.");
  if (name === "vim") throw new Error("Use /vim in the web composer to toggle Vim editing, not as agent input.");
  if (name === "statusline") throw new Error("Open /statusline in the web composer to configure its footer, not as agent input.");
  if (name === "title") throw new Error("Open /title in the web composer to configure the browser tab, not as agent input. Use /rename to rename the chat.");
  if (name === "theme") throw new Error("Open /theme without arguments in the web composer to choose syntax colors, not as agent input.");
  if (["pets", "pet"].includes(name)) throw new Error("Use /pets in the web composer to choose a pet, or /pets off to hide it. This is not agent input.");
  if (name === "plan") return { type: "plan", prompt: argument };
  if (["permissions", "mode"].includes(name) && argument) {
    const mode = { auto: "auto", edits: "accept_edits", "accept-edits": "accept_edits", plan: "plan", "read-only": "plan" }[argument.toLowerCase()];
    if (!mode) throw new Error("Use /permissions auto, edits, or read-only");
    return { type: "settings", settings: { mode } };
  }
  if (["model", "effort", "reasoning"].includes(name) && argument) {
    const key = name === "model" ? "model" : "effort";
    return { type: "settings", settings: { [key]: argument === "default" && !(agent === "claude" && key === "model") ? null : argument } };
  }
  // Relay owns persistent goal state for every provider. Codex also mirrors it
  // into the native thread; Claude has no goal-state API, so forwarding its
  // reported /goal entry as ordinary prompt text silently loses the command.
  if (name === "goal") {
    if (!argument) return { type: "goal", action: "get", ...(agent === "claude" ? { prompt: text, nativeClaude: true } : {}) };
    const normalizedGoalAction = argument.toLowerCase();
    if (["pause", "resume", "clear", "stop", "off", "reset", "none", "cancel"].includes(normalizedGoalAction)) {
      const action = ["pause", "resume"].includes(normalizedGoalAction) ? normalizedGoalAction : "clear";
      return { type: "goal", action, prompt: agent === "claude" ? text : action === "resume" ? "Continue working toward the current goal." : "", ...(agent === "claude" ? { nativeClaude: true } : {}) };
    }
    const objective = argument.replace(/^edit(?:\s+|$)/, "");
    if (!objective) throw new Error("Use /goal edit followed by the revised objective");
    if (objective.length > 4000) {
      if (agent === "claude") return { type: "nativeCommand", prompt: text };
      throw new Error("Goal objectives must be at most 4,000 characters");
    }
    return { type: "goal", action: "set", objective, prompt: agent === "claude" ? text : objective, ...(agent === "claude" ? { nativeClaude: true } : {}) };
  }
  if (agent !== "codex") return null; // Preserve Claude's other installed commands and plugin aliases.
  if (name === "app") throw new Error("Open /app without arguments in the web composer to hand off the saved session. This is not agent input.");
  if (name === "approve") throw new Error("Open /approve without arguments and confirm a specific denied action. Plain messages cannot grant approval.");
  if (name === "feedback") throw new Error("Open /feedback without arguments to review and explicitly send a report. Plain messages cannot submit diagnostics.");
  if (name === "logout") throw new Error("Open /logout without arguments, inspect the native account and confirm sign-out. Plain messages cannot clear credentials.");
  if (name === "personality" && argument) return { type: "settings", settings: { personality: argument } };
  if (name === "fast") {
    if (argument && !["on", "off"].includes(argument)) throw new Error("Use /fast, /fast on, or /fast off");
    return { type: "fast", action: argument || "toggle" };
  }
  if (name === "init") return { type: "init", prompt: `Inspect this repository and create or improve its AGENTS.md contributor instructions. Preserve existing instructions and user edits. Describe only commands, conventions, tests and architecture you actually verify in the repository. Keep the document concise and specific. Do not overwrite unrelated files.${argument ? `\n\nAdditional instructions:\n${argument}` : ""}` };
  if (name === "review") {
    let target = { type: "uncommittedChanges" };
    if (argument.startsWith("--base")) {
      const branch = /^--base\s+(\S+)$/.exec(argument)?.[1];
      if (!branch || branch.startsWith("-")) throw new Error("Use /review --base <branch>");
      target = { type: "baseBranch", branch };
    } else if (argument.startsWith("--commit")) {
      const sha = /^--commit\s+([a-fA-F0-9]{4,64})$/.exec(argument)?.[1];
      if (!sha) throw new Error("Use /review --commit <commit SHA>");
      target = { type: "commit", sha, title: null };
    } else if (argument) target = { type: "custom", instructions: argument };
    return { type: "review", target };
  }
  return null;
}
