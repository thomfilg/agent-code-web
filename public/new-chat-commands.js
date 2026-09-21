import { webCommands, WEB_COMMAND_ALIASES } from "./web-commands.js";
import { invalidSlashCommandError, parseSlashCommand } from "./slash-command.js";

const initialControls = new Set(["goal", "init", "review", "plan", "model", "effort", "reasoning", "permissions", "mode", "mcp", "help", "skills", "rename", "keymap", "statusline", "title", "theme", "pets", "vim"]);
const existingSession = "Requires an existing chat or session. Open a conversation first.";
export function newChatCommands(agent, nativeCommands = []) {
  if (!["codex", "claude", "mock"].includes(agent)) return { commands: [], note: "Choose an agent account to see commands." };
  const commands = new Map();
  for (const item of nativeCommands) {
    for (const name of [item.name, ...(item.aliases || [])]) {
      if (typeof name !== "string" || !/^[\w:.-]+$/.test(name)) continue;
      commands.set(name, { name, kind: "CLI command", description: item.description || "Selected-account command", disabled: false });
    }
  }
  for (const item of webCommands(agent)) {
    const value = { ...item, disabled: !initialControls.has(item.name), ...(!initialControls.has(item.name) ? { disabledReason: existingSession } : {}) };
    commands.set(item.name, value);
    for (const alias of item.aliases) commands.set(alias, { ...value, name: alias, aliasFor: item.name });
  }
  return { commands: [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)), note: "Commands reported by the selected account can be the first message. Opening this menu alone does not create a chat or start an agent." };
}

// Preflight prevents session-only/unknown commands from accidentally becoming
// ordinary prompts. Accepted controls still use the active-chat dispatcher.
export function firstChatCommand(text, agent, availableCommands = null) {
  const slash = parseSlashCommand(text);
  if (!slash) return null;
  if (!slash.name) throw invalidSlashCommandError();
  const name = WEB_COMMAND_ALIASES[slash.name] || slash.name, argument = slash.argument;
  const commands = availableCommands || newChatCommands(agent).commands;
  const item = commands.find(item => item.name === name);
  if (!item) throw new Error(`Unknown command /${slash.name}. Choose a command from the / menu.`);
  if (item.disabled) throw new Error(`/${slash.name}: ${item.disabledReason}`);
  if (name === "goal" && ["pause", "resume", "clear"].includes(argument)) throw new Error(`/goal ${argument} needs an existing goal. Use /goal followed by an objective to start one.`);
  if (["mcp", "help", "skills", "keymap", "statusline", "title", "theme"].includes(name) && argument) throw new Error(`Use /${name} without arguments to open its control. Other forms require an existing chat.`);
  return item;
}
