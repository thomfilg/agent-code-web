#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

let prompt = "";
let timer;
const streaming = process.argv[process.argv.indexOf("--input-format") + 1] === "stream-json";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  prompt += chunk;
  if (!streaming) return;
  const lines = prompt.split("\n"); prompt = lines.pop();
  for (const line of lines) {
    const packet = JSON.parse(line);
    if (packet.type === "control_request") {
      process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: packet.request_id, response: {} } })}\n`);
      if (packet.request.subtype === "interrupt") {
        clearInterval(timer);
        process.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Interrupted" })}\n`);
      }
    } else if (packet.type === "user") {
      process.stdout.write(`${JSON.stringify({ type: "command_lifecycle", state: "started", command_uuid: packet.uuid })}\n`);
      void run(packet.message.content);
    }
  }
});
process.stdin.on("end", () => { if (!streaming) void run(prompt); else clearInterval(timer); });
async function run(prompt) {
  const flag = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
  const fast = JSON.parse(flag("--settings") || "{}").fastMode;
  const fastAllowed = process.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK === "1" && process.env.CLAUDE_CODE_DISABLE_FAST_MODE !== "1";
  const send = (message) => process.stdout.write(`${JSON.stringify({ ...message, ...(message.type === "result" && typeof fast === "boolean" && !process.env.CLAUDE_FIXTURE_OMIT_FAST_STATE ? { fast_mode_state: fast && fastAllowed ? "on" : "off", ...(!fastAllowed && fast ? { fast_mode_disabled_reason: "disabled_by_env" } : {}) } : {}) })}\n`);
  send({ type: "system", subtype: "init", session_id: "fixture", model: "fixture-claude", claude_code_version: "2.1.0-fixture" });
  if (prompt === "wait for interruption") { timer = setInterval(() => {}, 1000); return; }
  if (prompt === "/fast on") { send({ type: "result", subtype: "success", result: fastAllowed ? "Fast mode ON (this session only)" : "Fast mode unavailable" }); return; }
  if (prompt === "goal hook error fixture") {
    for (let index = 0; index < 2; index++) send({ type: "system", subtype: "notification", key: "stop-hook-error", text: "Stop hook error occurred · ctrl+o to see" });
    send({ type: "result", subtype: "success", result: "The working turn ended without a successful goal evaluation." }); return;
  }
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
    send({ type: "result", subtype: "success", result: JSON.stringify({ model: flag("--model"), effort: flag("--effort"), mode: flag("--permission-mode"), environmentEffort: process.env.CLAUDE_CODE_EFFORT_LEVEL || null, fast }) }); return;
  }
  if (prompt === "force failure") {
    send({ type: "result", subtype: "error_during_execution", is_error: true, result: "fixture failed" });
    return;
  }
  if (prompt === "multiple native results after resume") {
    send({ type: "result", uuid: "empty-local-checkpoint", subtype: "success", result: "", usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, total_cost_usd: 0 });
    send({ type: "result", uuid: "actual-resumed-reply", subtype: "success", result: "Native application context retained.", usage: { input_tokens: 100, output_tokens: 10 }, modelUsage: { fixture: { inputTokens: 100, outputTokens: 10 } }, total_cost_usd: 0.1 });
    return;
  }
  send({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool_fixture", name: "Read", input: {} }] } });
  send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool_fixture", content: "fixture.txt" }] } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "claude " } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `received ${prompt}` } } });
  send({ type: "result", subtype: "success", result: `claude received ${prompt}`, session_id: "fixture" });
}
