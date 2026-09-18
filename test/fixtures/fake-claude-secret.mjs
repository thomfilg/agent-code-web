#!/usr/bin/env node
// No network/model access: emit only this test process's synthetic token.
import readline from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const delta = text => send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
let token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.RELAY_MCP_CAPABILITY_0, previous = token, pending;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const packet = JSON.parse(line);
  if (packet.type === "control_request") {
    send({ type: "control_response", response: { request_id: packet.request_id, subtype: "success", response: {} } });
    if (packet.request.subtype === "interrupt") send({ type: "result", subtype: "error_during_execution", is_error: true, result: "Interrupted" });
  } else if (packet.type === "control_response" && packet.response.request_id === "refresh-test") {
    previous = token; token = packet.response.response.accessToken; emit(pending);
  } else if (packet.type === "user") {
    send({ type: "command_lifecycle", command_uuid: packet.uuid, state: "started" });
    const mode = packet.message.content;
    if (mode === "refresh") { pending = mode; send({ type: "control_request", request_id: "refresh-test", request: { subtype: "oauth_token_refresh" } }); }
    else emit(mode);
  }
}

function emit(mode) {
  send({ type: "stream_event", event: { type: "message_start", message: { id: "message" } } });
  if (["partial", "error"].includes(mode)) {
    delta("before "); delta(token.slice(0, 12));
    if (mode === "error") {
      process.stderr.write(token.slice(0, 5));
      setTimeout(() => { process.stderr.write(token.slice(5) + "\n"); send({ type: "result", subtype: "error_during_execution", is_error: true, result: token }); }, 10);
    }
    return;
  }
  const tokens = mode === "refresh" ? [previous, token] : mode === "historical" ? ["sk-ant-historical-fixture-value"] : mode === "all-capabilities"
    ? Object.entries(process.env).filter(([key]) => /^RELAY_MCP_CAPABILITY_\d+$/.test(key)).map(([, value]) => value) : [token];
  let text = "";
  for (const value of tokens) for (let split = 1; split < value.length; split++) {
    delta(value.slice(0, split)); delta(value.slice(split) + " "); text += value + " ";
  }
  send({ type: "assistant", uuid: "full", message: { id: "message", content: [{ type: "text", text }] } });
  send({ type: "stream_event", event: { type: "message_stop" } });
  send({ type: "assistant", message: { id: "tool", content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: token } }] } });
  send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: token }] } });
  send({ type: "system", subtype: "notification", key: "fast-mode-cooldown-started", text: token });
  send({ type: "result", subtype: "success", result: text });
}
