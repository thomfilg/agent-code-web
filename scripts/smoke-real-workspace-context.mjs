import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";
import { workspaceFileIO, workspaceContext, contextForTurn } from "../src/workspace-files.mjs";

// Only private, temporary sessions and a deterministic loopback Responses
// server. Never use a real model, live chat, host credential or Chrome profile.
const directory = await mkdtemp("/tmp/relay-workspace-context-smoke-");
const requests = [];
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  let body = ""; for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body)); const id = requests.length;
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `Workspace fixture response ${id}`, annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_${id}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused", CODEX_MODEL: "gpt-5.4" });
const store = new ChatStore(directory); await store.initialize();
const chat = await store.create({ agent: "codex", title: "Native explicit workspace context fixture" });
await mkdir(chat.workspace, { recursive: true });
const target = path.join(chat.workspace, "chosen-file.txt");
await writeFile(target, "UNSELECTED_BEFORE\nEXPLICIT_SELECTED_TEXT\nUNSELECTED_AFTER\n");
const adapter = new CodexAdapter({ chat, store, config, broker: new CapabilityBroker({ ttlMs: 120000 }), gatewayOrigin: `http://127.0.0.1:${server.address().port}`, hooks: { onFatal: () => {}, onRequest: () => assert.fail("No tools should be requested by the fixture model") } });
const timeout = setTimeout(() => { void adapter.stop(); server.closeAllConnections(); }, 60000);
try {
  await adapter.start();
  const file = await workspaceFileIO({ root: chat.workspace, action: "read", path: "chosen-file.txt" });
  await adapter.send("REFERENCE_ONLY", contextForTurn([{ ...workspaceContext(file), id: "fixture-reference" }], chat.workspace));
  assert.equal(requests.length, 1);
  const first = JSON.stringify(requests[0].input);
  // Codex's UserInput.mention targets app connectors, not filesystem paths.
  // Explicit files use untrusted additionalContext and snapshot references.
  assert.ok(first.includes("chosen-file.txt"), "Explicit file reference did not reach model input");
  const start = file.text.indexOf("EXPLICIT_SELECTED_TEXT"), end = start + "EXPLICIT_SELECTED_TEXT".length;
  const selected = { ...workspaceContext(file, { start, end }), id: "fixture-selection" };
  await adapter.send("EXPLAIN_SELECTION", contextForTurn([selected], chat.workspace));
  const second = JSON.stringify(requests[1].input);
  assert.match(second, /EXPLICIT_SELECTED_TEXT/);
  assert.ok(requests[1].input.some(item => item.role === "user" && JSON.stringify(item).includes("EXPLICIT_SELECTED_TEXT")), "Selected file text must not be elevated to system/developer instructions");
  assert.doesNotMatch(second, /UNSELECTED_BEFORE|UNSELECTED_AFTER/);
  assert.ok(second.includes(target));
  await writeFile(target, "CHANGED_AFTER_CAPTURE_NOT_ATTACHED");
  await adapter.send("NORMAL_NEXT_TURN");
  assert.equal(requests.length, 3); assert.doesNotMatch(JSON.stringify(requests.at(-1).input), /CHANGED_AFTER_CAPTURE_NOT_ATTACHED/);
  console.log("Native workspace context passed: explicit file references, untrusted selected text, real workspace paths, and no automatic file-content updates on the next turn.");
} finally {
  clearTimeout(timeout); await adapter.stop();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
