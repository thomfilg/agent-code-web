import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { Attachments } from "../src/attachments.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";

// Actual native import + Relay adoption/resume. Only owned temporary profiles
// and deterministic loopback Responses events; no account or paid inference.
const directory = await mkdtemp("/tmp/relay-native-import-chat-"), requests = [];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5j8AAAAASUVORK5CYII=";
const server = http.createServer(async (request, response) => {
  let input = ""; for await (const chunk of request) input += chunk;
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  requests.push(JSON.parse(input));
  const n = requests.length, item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Imported conversation continued through the native session.", annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused", CODEX_MODEL: "gpt-5.4", ...(process.env.CODEX_BIN ? { CODEX_BIN: process.env.CODEX_BIN } : {}) });
const records = new MemoryRecords(), store = new ChatStore(directory, records); await store.initialize();
const broker = new CapabilityBroker({ ttlMs: 120000 }), attachments = new Attachments(records, store), adapters = new Map();
const manager = new RuntimeManager({ store, config, broker, attachments, gatewayOrigin: origin,
  adapterFactory: params => { const adapter = new CodexAdapter({ ...params, store, config, broker, gatewayOrigin: origin }); adapters.set(params.chat.id, adapter); return adapter; } });
const timeout = setTimeout(() => { void manager.shutdown(); server.closeAllConnections(); }, 60000);
try {
  const source = await manager.createChat({ agent: "codex", title: "Native import destination" });
  await writeFile(path.join(source.workspace, "CLAUDE.md"), "# Imported fixture instructions\nPreserve this fixture.\n");
  await writeFile(path.join(source.workspace, "uncommitted.txt"), "independent project copy");
  const sourceSessionId = randomUUID(), userId = randomUUID(), timestamp = new Date().toISOString();
  const sourceDirectory = path.join(store.runtimeHome(source.id), ".claude", "projects", source.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(sourceDirectory, { recursive: true });
  const sourceFile = path.join(sourceDirectory, `${sourceSessionId}.jsonl`), contents = [
    { type: "user", uuid: userId, parentUuid: null, sessionId: sourceSessionId, cwd: source.workspace, timestamp, isSidechain: false, isMeta: false,
      message: { role: "user", content: [{ type: "text", text: "REAL_IMPORTED_HISTORY_MARKER" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] } },
    { type: "assistant", uuid: randomUUID(), parentUuid: userId, sessionId: sourceSessionId, cwd: source.workspace, timestamp, isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "Original source assistant reply." }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  await writeFile(sourceFile, contents);
  const review = await manager.nativeImports(source.id);
  assert.deepEqual(review.items.map(item => item.itemType).sort(), ["AGENTS_MD", "SESSIONS"]);
  const input = { requestId: randomUUID(), source: review.source, revision: review.revision, ids: review.items.map(item => item.id), threadId: review.threadId, confirm: true };
  await manager.nativeImports(source.id, "start", input);
  let result;
  for (let attempt = 0; attempt < 100; attempt++) { result = await manager.nativeImports(source.id, "refresh"); if (!result.needsRefresh) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(result.operations[0].phase, "completed"); assert.equal(result.needsRefresh, false); assert.equal(result.operations[0].sessions.length, 1);
  const selection = { operationId: input.requestId, sessionId: result.operations[0].sessions[0].id, threadId: result.threadId, confirm: true };
  const { chat } = await manager.nativeImports(source.id, "open", selection);
  assert.equal(chat.status, "stopped"); assert.equal(requests.length, 0); assert.notEqual(chat.id, source.id);
  assert.equal(chat.messages.find(item => item.role === "user").text, "REAL_IMPORTED_HISTORY_MARKER\n\n[external unsupported block: image]");
  assert.equal(chat.messages.find(item => item.role === "assistant").text, "Original source assistant reply.");
  const images = chat.messages.flatMap(item => item.attachments || []);
  assert.equal(images.length, 0, "This native importer substitutes an unsupported-block marker for Claude images; do not claim image fidelity");
  assert.equal(chat.importWarnings.length, 1); assert.match(chat.importWarnings[0], /replaced unsupported source content/);
  assert.equal(await readFile(path.join(chat.workspace, "uncommitted.txt"), "utf8"), "independent project copy");
  assert.equal(await readFile(sourceFile, "utf8"), contents); assert.deepEqual(store.get(source.id).messages, []);
  assert.equal((await manager.nativeImports(source.id, "open", selection)).chat.id, chat.id); assert.equal(requests.length, 0);
  await manager.remove(source.id);
  await manager.send(chat.id, "REAL_IMPORTED_CONTINUE");
  let current = store.get(chat.id);
  assert.notEqual(current.status, "error", current.messages.at(-1)?.text); assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0].input), /REAL_IMPORTED_HISTORY_MARKER/); assert.match(JSON.stringify(requests[0].input), /Original source assistant reply/);
  assert.match(JSON.stringify(requests[0].input), /REAL_IMPORTED_CONTINUE/); assert.ok(JSON.stringify(requests[0].input).includes(chat.workspace));
  assert.equal((await records.get("native-fork", chat.id)).initialized, true); assert.equal(current.forkContextPending, false);
  await manager.stop(chat.id, "idle-timeout"); await manager.send(chat.id, "REAL_IMPORTED_AFTER_RESTART"); current = store.get(chat.id);
  assert.equal(current.agentSessionId, chat.agentSessionId); assert.equal(requests.length, 2); assert.match(JSON.stringify(requests[1].input), /REAL_IMPORTED_HISTORY_MARKER/);
  console.log("PASS: actual native Claude chat import, faithful text and unsupported-image markers, independent Relay workspace, idempotent open, source deletion, explicit native continuation and same-thread resume. Private fixtures and loopback responses only.");
} finally {
  clearTimeout(timeout); await manager.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
