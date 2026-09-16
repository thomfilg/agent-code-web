export function messageCommand(agent, text) {
  if (agent === "codex" && text.trim() === "/compact") return { type: "compact" };
  const match = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const argument = (match[2] || "").trim();
  if (match[1] === "keymap") throw new Error("Open /keymap without arguments to remap Relay keyboard shortcuts. This is a web control, not agent input.");
  if (match[1] === "vim") throw new Error("Use /vim in the web composer to toggle Vim editing, not as agent input.");
  if (match[1] === "statusline") throw new Error("Open /statusline in the web composer to configure its footer, not as agent input.");
  if (match[1] === "title") throw new Error("Open /title in the web composer to configure the browser tab, not as agent input. Use /rename to rename the chat.");
  if (match[1] === "theme") throw new Error("Open /theme without arguments in the web composer to choose syntax colors, not as agent input.");
  if (["pets", "pet"].includes(match[1])) throw new Error("Use /pets in the web composer to choose a pet, or /pets off to hide it. This is not agent input.");
  if (match[1] === "plan") return { type: "plan", prompt: argument };
  if (["permissions", "mode"].includes(match[1]) && argument) {
    const mode = { auto: "auto", edits: "accept_edits", "accept-edits": "accept_edits", plan: "plan", "read-only": "plan" }[argument.toLowerCase()];
    if (!mode) throw new Error("Use /permissions auto, edits, or read-only");
    return { type: "settings", settings: { mode } };
  }
  if (["model", "effort", "reasoning"].includes(match[1]) && argument) {
    const key = match[1] === "model" ? "model" : "effort";
    return { type: "settings", settings: { [key]: argument === "default" ? null : argument } };
  }
  if (agent !== "codex") return null; // Preserve Claude's installed commands and plugin aliases.
  if (match[1] === "approve") throw new Error("Open /approve without arguments and confirm a specific denied action. Plain messages cannot grant approval.");
  if (match[1] === "feedback") throw new Error("Open /feedback without arguments to review and explicitly send a report. Plain messages cannot submit diagnostics.");
  if (match[1] === "logout") throw new Error("Open /logout without arguments, inspect the native account and confirm sign-out. Plain messages cannot clear credentials.");
  if (match[1] === "personality" && argument) return { type: "settings", settings: { personality: argument } };
  if (match[1] === "fast") {
    if (argument && !["on", "off"].includes(argument)) throw new Error("Use /fast, /fast on, or /fast off");
    return { type: "fast", action: argument || "toggle" };
  }
  if (match[1] === "init") return { type: "init", prompt: `Inspect this repository and create or improve its AGENTS.md contributor instructions. Preserve existing instructions and user edits. Describe only commands, conventions, tests and architecture you actually verify in the repository. Keep the document concise and specific. Do not overwrite unrelated files.${argument ? `\n\nAdditional instructions:\n${argument}` : ""}` };
  if (match[1] === "review") {
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
  if (match[1] !== "goal") return null;
  if (!argument) return { type: "goal", action: "get" };
  if (["pause", "resume", "clear"].includes(argument)) return { type: "goal", action: argument, prompt: argument === "resume" ? "Continue working toward the current goal." : "" };
  const objective = argument.replace(/^edit(?:\s+|$)/, "");
  if (!objective) throw new Error("Use /goal edit followed by the revised objective");
  if (objective.length > 4000) throw new Error("Goal objectives must be at most 4,000 characters");
  return { type: "goal", action: "set", objective, prompt: objective };
}
