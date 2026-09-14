#!/usr/bin/env node

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  send({ type: "system", subtype: "init", session_id: "fixture" });
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
