import { webCommands, WEB_COMMAND_ALIASES } from "./web-commands.js";

const initialControls = new Set(["goal", "init", "review", "plan", "model", "effort", "reasoning", "permissions", "mode", "mcp", "help", "skills", "rename", "keymap", "statusline", "title", "theme", "pets", "vim"]);
const existingSession = "Requires an existing chat or session. Open a conversation first.";
export function newChatCommands(agent, nativeCommands = []) {
  if (!["codex", "claude", "mock"].includes(agent)) return { commands: [], note: "Choose an agent account to see commands." };
  const commands = new Map();
  for (const item of nativeCommands) {
    for (const name of [item.name, ...(item.aliases || [])]) {
      if (typeof name !== "string" || !/^[\w:.-]+$/.test(name)) continue;
      commands.set(name, { name, kind: "CLI command", description: item.description || "Selected-account command", disabled: true, disabledReason: "Reported by the selected account. Start a chat before using native commands or skills." });
    }
  }
  for (const item of webCommands(agent)) {
    const value = { ...item, disabled: !initialControls.has(item.name), ...(!initialControls.has(item.name) ? { disabledReason: existingSession } : {}) };
    commands.set(item.name, value);
    for (const alias of item.aliases) commands.set(alias, { ...value, name: alias, aliasFor: item.name });
  }
  return { commands: [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)), note: "Relay controls are available before the first message. Native commands and workspace skills require a chat; opening this menu does not start an agent." };
}

// Preflight prevents session-only/unknown commands from accidentally becoming
// ordinary prompts. Accepted controls still use the active-chat dispatcher.
export function firstChatCommand(text, agent) {
  if (text.trim() === "/") throw new Error("Choose a command from the / menu or describe a task before sending.");
  const match = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const name = WEB_COMMAND_ALIASES[match[1]] || match[1], argument = (match[2] || "").trim();
  const item = newChatCommands(agent).commands.find(item => item.name === name);
  if (!item) throw new Error(`/${match[1]} is not available before this agent has a chat. Start with a task, then use the chat's / menu.`);
  if (item.disabled) throw new Error(`/${match[1]}: ${item.disabledReason}`);
  if (name === "goal" && ["pause", "resume", "clear"].includes(argument)) throw new Error(`/goal ${argument} needs an existing goal. Use /goal followed by an objective to start one.`);
  if (["mcp", "help", "skills", "keymap", "statusline", "title", "theme"].includes(name) && argument) throw new Error(`Use /${name} without arguments to open its control. Other forms require an existing chat.`);
  return item;
}
