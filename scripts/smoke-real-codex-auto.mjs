import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { ChatStore } from "../src/store.mjs";

// Installed Codex + deterministic loopback inference. The native shell runs a
// read-only workspace-root search under Relay's real Auto turn settings. No
// account credentials, paid inference, external network or user files are used.
const root = await mkdtemp("/tmp/relay-codex-auto-"), workspaceRoot = path.join(root, "workspace"), repository = path.join(workspaceRoot, "repo");
await mkdir(repository, { recursive: true });
await writeFile(path.join(workspaceRoot, "task-001.md"), "fixture\n");
let mainRequests = 0, reviewRequests = 0, approvalRequests = 0, toolIssued = false;
const server = http.createServer(async (request, response) => {
  let data = ""; for await (const chunk of request) data += chunk;
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  const body = JSON.parse(data), reviewer = body.model === "codex-auto-review";
  if (reviewer) reviewRequests++; else mainRequests++;
  const item = !reviewer && !toolIssued
    ? (toolIssued = true, { type: "function_call", id: "fc_read", call_id: "call_read", name: "exec_command", arguments: JSON.stringify({
      cmd: `/bin/bash -lc \"rg --files -g 'task-*.md' -g '!node_modules' '${workspaceRoot}'\"`,
      description: "Locate the mandatory playbook in the workspace",
    }) })
    : { type: "message", id: `msg_${mainRequests + reviewRequests}`, role: "assistant", status: "completed", content: [{
      type: "output_text", text: reviewer ? JSON.stringify({ risk_level: "low", user_authorization: "low", outcome: "deny", rationale: "Reviewer must not run in never mode." }) : "Read-only search completed.", annotations: [],
    }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `response_${mainRequests + reviewRequests}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `response_${mainRequests + reviewRequests}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize();
const saved = await store.create({ title: "Auto read fixture", agent: "codex", mode: "auto" });
const chat = { ...saved, workspace: repository };
const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused", CODEX_MODEL: "gpt-5.4" });
const events = []; let adapter;
try {
  adapter = new CodexAdapter({ chat, store, config, broker: new CapabilityBroker({ ttlMs: 120000 }), gatewayOrigin: origin, hooks: {
    onEvent: event => events.push(event),
    onRequest: () => { approvalRequests++; throw Error("Auto surfaced a manual approval"); },
    onFatal: error => { throw error; },
  } });
  const result = await adapter.send("Locate the mandatory playbook in the workspace.", { mode: "auto", model: "gpt-5.4" });
  assert.equal(result.text, "Read-only search completed.");
  assert.equal(approvalRequests, 0); assert.equal(reviewRequests, 0); assert.equal(mainRequests, 2);
  const completed = events.find(event => event.type === "tool" && event.state === "completed");
  assert.equal(completed?.exitCode, 0); assert.match(completed?.output || "", /task-001\.md/);
  console.log("PASS: installed Codex Auto completed the workspace-root rg search with approvalPolicy=never, zero manual approvals and the existing no-network/workspace-write sandbox.");
} finally {
  await adapter?.stop().catch(() => {}); await records.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
