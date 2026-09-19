// A real disposable controller process. No provider simulation or native history
// arrives over IPC. A replacement obtains conversational state only from PG.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { EncryptedRecords, RecordCipher } from "../../src/database.mjs";
import { ChatStore } from "../../src/store.mjs";
import { NativeSessionCheckpoints } from "../../src/native-session-checkpoints.mjs";
import { captureSessionBundle, workerSessionIO } from "../../src/codex-session-bundle.mjs";
import { JsonRpcProcess } from "../../src/json-rpc-process.mjs";
import { cliVersionFromUserAgent } from "../../src/session-info.mjs";
import { attachOciExecutor } from "./oci-executor.mjs";

export const scenario = Object.freeze({
  prompt: "OCI_NATIVE_USER_7493: preserve this exact original instruction and inspect the counted tool result.",
  policy: "OCI_NATIVE_POLICY_7493: private local checkpoint acceptance only.",
  result: "OCI_NATIVE_TOOL_RESULT_7493",
  answer: "OCI_NATIVE_ASSISTANT_7493: counted tool completed.",
  continuation: "OCI_NATIVE_CONTINUE_7493: inspect the retained context without rerunning the tool.",
});
const home = "/runtime-home/codex", workspace = "/workspace";
const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
let records, rpc, chatId, store, service, worker, threadId, journalPath, busy = false;
const observations = [];

async function connect(providerPort) {
  rpc = new JsonRpcProcess({ command: "/bin/codex", spawnFn: worker.spawn.bind(worker), requestTimeoutMs: 15000,
    args: ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"', "-c", 'model_provider="fixture"', "-c", 'model="gpt-5.4"',
      "-c", 'model_providers.fixture.name="Local OCI fixture"', "-c", `model_providers.fixture.base_url="http://127.0.0.1:${providerPort}/v1"`,
      "-c", 'model_providers.fixture.wire_api="responses"', "-c", "model_providers.fixture.requires_openai_auth=false", "-c", 'web_search="disabled"'],
    spawnOptions: { cwd: workspace, env: { PATH: "/bin:/usr/bin", HOME: "/runtime-home", CODEX_HOME: home, LANG: "C.UTF-8", SHELL: "/bin/bash", NO_COLOR: "1" } } });
  rpc.on("error", () => {}); rpc.on("request", request => rpc.respondError(request.id, -32000, "No approvals or credentials in fixture"));
  rpc.on("notification", ({ method, params }) => {
    if (method !== "turn/completed" || params.threadId !== threadId) return;
    let marker = false;
    if (journalPath?.startsWith(home + "/sessions/")) {
      try { worker.validate(); marker = readFileSync(path.join(worker.rootfs, journalPath), "utf8").trimEnd().split("\n").some(line => {
        const row = JSON.parse(line); return row.type === "event_msg" && row.payload?.type === "task_complete" && row.payload.turn_id === params.turn.id;
      }); } catch {}
    }
    observations.push({ turnId: params.turn.id, marker });
  });
  rpc.start(); const initialized = await rpc.request("initialize", { clientInfo: { name: "relay_controller_loss_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  rpc.notify("initialized", {}); assert.equal(cliVersionFromUserAgent(initialized.userAgent), "0.155.0");
}
async function turn(text) {
  const done = Promise.withResolvers(), listener = ({ method, params }) => { if (method === "turn/completed" && params.threadId === threadId) done.resolve(params.turn); };
  rpc.on("notification", listener); const timer = setTimeout(() => done.reject(Error("Native controller turn timeout")), 20000);
  try {
    const started = await rpc.request("turn/start", { threadId, input: [{ type: "text", text }], approvalPolicy: "never" });
    const result = await done.promise; assert.equal(result.status, "completed"); assert.equal(result.id, started.turn.id); return result;
  } finally { clearTimeout(timer); rpc.off("notification", listener); }
}

async function action(message) {
  if (message.action === "initialize") {
    assert.deepEqual(Object.keys(message).sort(), ["action", "chatId", "connection", "directory", "encryptionKey", "id", "worker"].sort());
    records = new EncryptedRecords({ pool: new pg.Pool(message.connection), cipher: new RecordCipher(message.encryptionKey) });
    chatId = message.chatId; store = new ChatStore(message.directory, records); await store.initialize();
    service = new NativeSessionCheckpoints({ records }); worker = attachOciExecutor(message.worker);
    return { pid: process.pid, ready: true };
  }
  if (message.action === "capture") {
    assert.equal(store.get(chatId).agentSessionId, null); await connect(message.providerPort);
    const started = await rpc.request("thread/start", { cwd: workspace, model: "gpt-5.4", modelProvider: "fixture", approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: scenario.policy });
    threadId = started.thread.id; journalPath = started.thread.path;
    await store.update(chatId, { agentSessionId: threadId });
    await store.appendMessage(chatId, { role: "user", kind: "text", text: scenario.prompt });
    const finished = await turn(scenario.prompt);
    const completed = await rpc.request("thread/read", { threadId, includeTurns: true });
    const nativeTurn = completed.thread.turns.find(item => item.id === finished.id);
    assert.equal(nativeTurn?.status, "completed");
    const nativeReplies = nativeTurn.items.filter(item => item.type === "agentMessage");
    assert.equal(nativeReplies.length, 1, "Fixture must persist the actual native assistant answer, not scripted input");
    const nativeAnswer = nativeReplies[0].text; assert.equal(nativeAnswer, scenario.answer);
    await store.appendMessage(chatId, { role: "assistant", kind: "text", text: nativeAnswer });
    const bundle = await captureSessionBundle({ threadId, readThread: async id => { assert.equal(id, threadId); return started.thread; },
      readBytes: async (filename, boundary) => Buffer.from((await workerSessionIO(worker, { action: "readScoped", home, path: filename, boundary })).data, "base64") });
    const checkpoint = await service.save(store.get(chatId), bundle, 0, { boundary: "turn-completed", turnId: finished.id });
    const bytes = Buffer.from(checkpoint.value.bundle.files[0].data, "base64");
    for (const value of [scenario.prompt, scenario.policy, scenario.result, scenario.answer]) assert(bytes.includes(value));
    // Only irreversible COMMIT completion reaches this receipt. No bundle or
    // messages leave this process for the replacement to inherit.
    return { committed: true, revision: checkpoint.revision, pid: process.pid, threadId,
      bundleHash: digest(bundle), messagesHash: digest(store.get(chatId).messages), terminalMarkerObserved: observations.find(item => item.turnId === finished.id)?.marker === true };
  }
  if (message.action === "restore") {
    // No expected ID/history arguments are accepted; reopen durable state.
    assert.deepEqual(Object.keys(message).sort(), ["action", "id", "providerPort"].sort());
    const chat = store.get(chatId), durable = await service.read(chat);
    threadId = chat.agentSessionId; assert.equal(durable.value.bundle.threadId, threadId);
    const messagesHash = digest(chat.messages), bundleHash = digest(durable.value.bundle);
    const restored = await workerSessionIO(worker, { action: "restoreFresh", home, bundle: durable.value.bundle }); assert.equal(restored.restored, true);
    journalPath = restored.path;
    assert.equal((await workerSessionIO(worker, { action: "readScoped", home, path: journalPath })).data, durable.value.bundle.files[0].data);
    await connect(message.providerPort);
    const resumed = await rpc.request("thread/resume", { threadId, cwd: workspace, model: "gpt-5.4", modelProvider: "fixture", approvalPolicy: "never", sandbox: "danger-full-access" });
    assert.equal(resumed.thread.id, threadId);
    const read = await rpc.request("thread/read", { threadId, includeTurns: true });
    for (const item of chat.messages.filter(item => ["user", "assistant"].includes(item.role))) assert(JSON.stringify(read.thread.turns).includes(item.text));
    return { pid: process.pid, threadId, revision: durable.revision, messagesHash, bundleHash, resumed: true };
  }
  if (message.action === "continue") { await turn(scenario.continuation); return { continued: true, messagesHash: digest(store.get(chatId).messages) }; }
  if (message.action === "close") { await rpc?.stop(); await records?.close(); return { closed: true }; }
  throw Error("Unknown fixture controller action");
}

// Importing the public scenario from the supervisor installs no IPC handler.
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) process.on("message", message => {
  if (busy) { process.send({ id: message.id, error: "Concurrent fixture controller request" }); return; }
  busy = true;
  void action(message).then(result => process.send({ id: message.id, result }, () => { if (message.action === "close") process.disconnect(); }))
    .catch(error => process.send({ id: message.id, error: error.message })).finally(() => { busy = false; });
});
