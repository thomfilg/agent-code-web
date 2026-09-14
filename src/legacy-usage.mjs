import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { claudeContext } from "./session-info.mjs";

// Recover only the last main-agent request counters from this chat's exact
// native transcript. No provider call and no sleeping worker wake-up.
export async function legacyClaudeContext(chat, config) {
  if (chat.agent !== "claude" || chat.usage?.version === 2 || config.workerBackend !== "local" || !/^[a-f0-9-]{36}$/.test(chat.agentSessionId || "")) return null;
  const home = config.claude.authMode === "host" ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") : path.join(path.dirname(chat.workspace), "runtime-home", "claude");
  const base = path.join(home, "projects"), filename = path.join(base, chat.workspace.replace(/[^a-zA-Z0-9]/g, "-"), `${chat.agentSessionId}.jsonl`);
  let file;
  try {
    const resolvedBase = await realpath(base), resolvedFile = await realpath(filename);
    if (!resolvedFile.startsWith(`${resolvedBase}${path.sep}`) || resolvedFile !== path.join(resolvedBase, path.relative(base, filename))) return null;
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat(); if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return null;
    let context;
    for (const line of (await file.readFile("utf8")).split("\n")) {
      try { const event = JSON.parse(line); if (event.type === "assistant" && !event.isSidechain && !event.parent_tool_use_id) context = claudeContext(event.message) || context; } catch {}
    }
    return context ? { ...context, partial: true } : null;
  } catch { return null; } finally { await file?.close(); }
}
