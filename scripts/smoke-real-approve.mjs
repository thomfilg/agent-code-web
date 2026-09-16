import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { guardianDeniedEvent } from "../src/codex-approvals.mjs";

// Real installed Codex, isolated temporary profiles, deterministic loopback
// main/reviewer responses. The only executed command prints a fixture marker.
// No account credentials, live databases, paid inference or live approvals.
const directory = await mkdtemp("/tmp/relay-native-approve-"), requests = [];
let mains = 0, reviews = 0, permissionTurn = false;
const server = http.createServer(async (request, response) => {
  let data = ""; for await (const chunk of request) data += chunk;
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  const body = JSON.parse(data), n = requests.push(body), reviewer = body.model === "codex-auto-review";
  if (reviewer) reviews++; else mains++;
  const allow = reviewer && reviews === 2 && /manually approved a specific action/.test(JSON.stringify(body.input));
  const item = !reviewer && mains % 2 === 1
    ? { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: permissionTurn ? "request_permissions" : "exec_command", arguments: JSON.stringify(permissionTurn ? { permissions: { file_system: { write: [`${directory}/extra`] } }, reason: "Private permission fixture" } : { cmd: "printf RELAY_NATIVE_APPROVAL_OK", sandbox_permissions: "require_escalated", justification: "Private harmless fixture command" }) }
    : { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", annotations: [],
      text: reviewer ? JSON.stringify({ risk_level: "low", user_authorization: allow ? "high" : "low", outcome: allow ? "allow" : "deny", rationale: "Deterministic private fixture review." }) : "Private fixture turn finished." }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `r_${n}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `r_${n}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused", CODEX_MODEL: "gpt-5.4", ...(process.env.CODEX_BIN ? { CODEX_BIN: process.env.CODEX_BIN } : {}) });
const records = new MemoryRecords(), store = new ChatStore(directory, records); await store.initialize();
const broker = new CapabilityBroker({ ttlMs: 120000 }), adapters = new Map();
const manager = new RuntimeManager({ store, config, broker, gatewayOrigin: origin,
  adapterFactory: params => { const adapter = new CodexAdapter({ ...params, store, config, broker, gatewayOrigin: origin }); adapters.set(params.chat.id, adapter); return adapter; } });
const timeout = setTimeout(() => { void manager.shutdown(); server.closeAllConnections(); }, 60000);
async function waitFor(predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error("Private native approval fixture timed out");
}
try {
  const chat = await manager.createChat({ agent: "codex", title: "Native approval fixture" }); await store.update(chat.id, { mode: "auto" });
  await manager.send(chat.id, "Run the private harmless fixture command once.");
  assert.equal(reviews, 1); let catalog = await manager.nativeApprovals(chat.id);
  assert.equal(catalog.reviews.length, 1, JSON.stringify(store.get(chat.id).messages)); assert.equal(catalog.reviews[0].state, "available");
  const rootThreadId = catalog.threadId, input = { threadId: rootThreadId, id: catalog.reviews[0].id, revision: catalog.reviews[0].revision, confirm: true };
  await manager.stop(chat.id); const before = requests.length;
  assert.equal((await manager.nativeApprovals(chat.id)).reviews.length, 1); assert.equal(requests.length, before);
  const queued = await manager.nativeApprovals(chat.id, input); assert.equal(queued.state, "queued"); assert.equal(queued.queuePaused, true); assert.equal(requests.length, before);
  await manager.editQueue(chat.id, { resume: true });
  await waitFor(async () => (await manager.nativeApprovals(chat.id)).reviews[0].state === "completed");
  await waitFor(() => !manager.isBusy(chat.id));
  assert.equal(reviews, 2); assert.equal(store.get(chat.id).agentSessionId, rootThreadId); assert.equal(store.get(chat.id).mode, "auto");
  const reviewInputs = requests.filter(body => body.model === "codex-auto-review");
  assert.match(JSON.stringify(reviewInputs[1].input), /manually approved a specific action/);
  assert.ok(store.get(chat.id).messages.some(message => message.role === "tool" && message.meta?.exitCode === 0 && message.meta?.output === "RELAY_NATIVE_APPROVAL_OK"), JSON.stringify(store.get(chat.id).messages));
  const completedRequests = requests.length; assert.equal((await manager.nativeApprovals(chat.id, input)).state, "completed"); assert.equal(requests.length, completedRequests);
  await manager.send(chat.id, "Another explicit fixture request; current policy must still review it.");
  assert.equal(reviews, 3); catalog = await manager.nativeApprovals(chat.id); assert.equal(catalog.reviews.filter(item => item.state === "available").length, 1);
  assert.equal(store.get(chat.id).messages.filter(message => message.role === "tool" && message.meta?.exitCode === 0).length, 1, "Later denied command must not bypass review");

  // Exercise the installed core deserializer for every action mapping without
  // starting a turn or running those operations. Use a separate empty thread.
  const adapter = adapters.get(chat.id), { thread } = await adapter.rpc.request("thread/start", { cwd: chat.workspace, model: "gpt-5.4", approvalPolicy: "on-request", sandbox: "workspace-write", config: { "features.request_permissions_tool": true } });
  const source = (await records.get("native-approvals", chat.id)).reviews[0].event;
  const actions = [
    { type: "command", source: "shell", command: "printf parser_only", cwd: chat.workspace },
    { type: "execve", source: "unifiedExec", program: "/bin/printf", argv: ["parser_only", "a b"], cwd: chat.workspace },
    { type: "writeStdin", approvalId: "fixture", processId: "123", stdin: "parser_only", cwd: chat.workspace },
    { type: "applyPatch", cwd: chat.workspace, files: ["parser-only.txt"] },
    { type: "networkAccess", target: "https://example.invalid/fixture", host: "example.invalid", protocol: "socks5Tcp", port: 443 },
    { type: "mcpToolCall", server: "fixture", toolName: "noop", connectorId: null, connectorName: null, toolTitle: null },
    { type: "requestPermissions", reason: "Parser fixture only", permissions: { network: { enabled: false }, fileSystem: { read: [chat.workspace], write: null } } },
    { type: "requestPermissions", reason: "Canonical parser fixture only", permissions: { network: null, fileSystem: { read: [chat.workspace], write: null, globScanMaxDepth: 2, entries: [
      { path: { type: "path", path: chat.workspace }, access: "read" }, { path: { type: "special", value: { kind: "project_roots", subpath: null } }, access: "read" },
    ] } } },
  ];
  const prior = requests.length;
  for (const action of actions) {
    const event = guardianDeniedEvent({ threadId: thread.id, reviewId: source.id, turnId: source.turn_id, targetItemId: null, startedAtMs: source.started_at_ms, completedAtMs: source.completed_at_ms,
      decisionSource: "agent", review: { status: "denied", riskLevel: "low", userAuthorization: "low", rationale: "Parser fixture only" }, action });
    try { assert.deepEqual(await adapter.rpc.request("thread/approveGuardianDeniedAction", { threadId: thread.id, event }), {}); }
    catch (error) { throw new Error(`Native ${action.type} parser fixture: ${error.message}`); }
  }
  assert.equal(requests.length, prior, "Native approval RPC records context; it does not start a turn");
  permissionTurn = true; let permissionReport, permissionCompleted = false;
  const observePermission = message => {
    if (message.params?.threadId !== thread.id) return;
    if (message.method === "item/autoApprovalReview/completed") permissionReport = message.params;
    if (message.method === "turn/completed") permissionCompleted = true;
  };
  adapter.rpc.on("notification", observePermission);
  await adapter.rpc.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Private fixture: request the listed permissions without using them." }], approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
  await waitFor(() => permissionCompleted); adapter.rpc.off("notification", observePermission);
  assert.equal(permissionReport?.action?.type, "requestPermissions");
  assert.deepEqual(permissionReport.action.permissions.fileSystem.write, [`${directory}/extra`]);
  const permissionEvent = guardianDeniedEvent(permissionReport);
  assert.ok(permissionEvent.action.permissions.file_system.entries); assert.ok(!Object.hasOwn(permissionEvent.action.permissions.file_system, "write"));
  assert.deepEqual(await adapter.rpc.request("thread/approveGuardianDeniedAction", { threadId: thread.id, event: permissionEvent }), {});
  await adapter.rpc.request("thread/unsubscribe", { threadId: thread.id });
  console.log("PASS: native denial capture, sleeping-worker inspection, explicit FIFO confirmation, same-thread resume, reviewed exact retry, successful harmless command, no duplicate input, unchanged Auto policy, actual filesystem-permission denial and seven installed action formats. Private loopback fixtures only.");
} finally {
  clearTimeout(timeout); await manager.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
