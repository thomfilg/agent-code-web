#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", async () => {
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  send({ type: "system", subtype: "init", session_id: "fixture", model: "fixture-claude", claude_code_version: "2.1.0-fixture" });
  if (prompt === "wait for interruption") { setInterval(() => {}, 1000); return; }
  if (/^\/autocompact(?:\s|$)/.test(prompt)) {
    const filename = path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
    const settings = await readFile(filename, "utf8").then(JSON.parse).catch(() => ({}));
    const argument = prompt.slice("/autocompact".length).trim();
    const match = /^(\d+)([kKmM]?)$/.exec(argument);
    const count = match ? Number(match[1]) * (/m/i.test(match[2]) ? 1000000 : /k/i.test(match[2]) || Number(match[1]) <= 1000 ? 1000 : 1) : null;
    let result = `Auto-compact window: ${settings.autoCompactWindow || "auto"}`;
    if (argument === "auto" || count >= 100000 && count <= 1000000) {
      if (argument === "auto") delete settings.autoCompactWindow; else settings.autoCompactWindow = count;
      await writeFile(filename, JSON.stringify(settings)); result = `Auto-compact window set to ${argument}`;
    } else if (argument) result = `Couldn't parse '${argument}'. Expected auto or 100k–1M tokens`;
    send({ type: "result", subtype: "success", result }); return;
  }
  if (/^\/(?:config|settings)(?:\s|$)/.test(prompt)) {
    const filename = path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
    const settings = await readFile(filename, "utf8").then(JSON.parse).catch(() => ({}));
    const model = /\bmodel=([\w.\[\]-]+)/.exec(prompt)?.[1];
    const mode = /\bpermissionMode=(\w+)/.exec(prompt)?.[1];
    if (["opus", "sonnet", "haiku", "default", "best", "sonnet[1m]", "opus[1m]", "opusplan"].includes(model)) settings.model = model;
    if (["auto", "acceptEdits", "plan", "default", "dontAsk"].includes(mode)) settings.permissions = { ...settings.permissions, defaultMode: mode };
    const autoCompact = /\bautoCompact=(true|false)\b/.exec(prompt)?.[1];
    if (autoCompact) settings.autoCompactEnabled = autoCompact === "true";
    if (/\w+=/.test(prompt)) await writeFile(filename, JSON.stringify(settings));
    const failed = prompt.includes("failAfterWrite=true");
    send({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed, result: failed ? "Native fixture failed after writing settings" : "Native settings fixture completed" }); return;
  }
  if (prompt === "inspect-settings") {
    const flag = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
    send({ type: "result", subtype: "success", result: JSON.stringify({ model: flag("--model"), effort: flag("--effort"), mode: flag("--permission-mode"), environmentEffort: process.env.CLAUDE_CODE_EFFORT_LEVEL || null }) }); return;
  }
  if (prompt === "force failure") {
    send({ type: "result", subtype: "error_during_execution", is_error: true, result: "fixture failed" });
    return;
  }
  send({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool_fixture", name: "Read", input: {} }] } });
  send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool_fixture", content: "fixture.txt" }] } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "claude " } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `received ${prompt}` } } });
  send({ type: "result", subtype: "success", result: `claude received ${prompt}`, session_id: "fixture" });
});
