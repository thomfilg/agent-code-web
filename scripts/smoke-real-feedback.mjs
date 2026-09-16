import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Never run feedback/upload against a public receiver in a test. The inner
// process has a new network namespace with ONLY loopback enabled, no external
// routes, a private profile, a temporary TLS CA and an allowlisted local proxy.
// The PID namespace also contains every worker if the outer timeout fires.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  if (process.platform !== "linux") throw new Error("This feedback fixture requires Linux network/PID namespaces; no unsafe fallback is provided");
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], "--network-isolated"], { timeout: 90000, maxBuffer: 500000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  // Refuse accidental direct invocation of the internal entry point.
  const interfaces = JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout);
  assert.deepEqual(interfaces.map(item => item.ifname), ["lo"], "The native feedback fixture requires a loopback-only network namespace");
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const directory = await mkdtemp("/tmp/relay-native-feedback-"), envelopes = [], sockets = new Set(), nativeCalls = [], modelCalls = [];
  let manager, failUpload = false;
  const feedbackHost = "o33249.ingest.us.sentry.io";
  await exec("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${directory}/key.pem`, "-out", `${directory}/cert.pem`, "-days", "1", "-subj", "/CN=Relay private native feedback fixture",
    "-addext", `subjectAltName=DNS:${feedbackHost}`, "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth"]);
  function envelope(data) {
    let position = 0;
    const line = () => { const end = data.indexOf(10, position); assert.ok(end >= position); const value = JSON.parse(data.subarray(position, end)); position = end + 1; return value; };
    const header = line(), items = [];
    while (position < data.length) {
      if (data[position] === 10) { position++; continue; }
      const item = line(); assert.ok(Number.isInteger(item.length) && item.length >= 0 && position + item.length <= data.length);
      items.push({ ...item, content: data.subarray(position, position + item.length).toString("utf8") }); position += item.length;
    }
    return { header, items };
  }
  const receiver = https.createServer({ key: await readFile(`${directory}/key.pem`), cert: await readFile(`${directory}/cert.pem`) }, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let body = Buffer.concat(chunks); if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
    assert.ok(request.url.endsWith("/envelope/")); envelopes.push(envelope(body));
    response.writeHead(failUpload ? 500 : 200, { "content-type": "application/json" }); response.end(failUpload ? '{"error":"private fixture failure"}' : '{"id":"private-receiver"}');
  });
  const proxy = http.createServer((request, response) => { response.writeHead(502); response.end(); });
  proxy.on("connect", (request, socket, head) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    if (request.url !== `${feedbackHost}:443`) { socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) socket.unshift(head); receiver.emit("connection", socket);
  });
  const model = http.createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
    let data = ""; for await (const chunk of request) data += chunk;
    modelCalls.push(JSON.parse(data)); const n = modelCalls.length;
    const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Private feedback fixture response.", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [{ type: "response.created", response: { id: `response_${n}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `response_${n}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve)); await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`, origin = `http://127.0.0.1:${model.address().port}`;
  const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "unused-private-fixture", CODEX_MODEL: "gpt-5.4" });
  const records = new MemoryRecords(), store = new ChatStore(directory, records); await store.initialize();
  const broker = new CapabilityBroker({ ttlMs: 120000 }), adapters = new Map();
  manager = new RuntimeManager({ store, config, broker, gatewayOrigin: origin, adapterFactory: params => {
    const executor = { workspace: params.chat.workspace, runtimeHome: store.runtimeHome(params.chat.id), mkdir: target => mkdir(target, { recursive: true, mode: 0o700 }),
      spawn: (command, args, options) => spawnWorker(command, args[0] === "app-server" ? [...args, "-c", "analytics.enabled=false", "-c", "check_for_update_on_startup=false"] : args,
        { ...options, env: { ...options.env, SSL_CERT_FILE: `${directory}/cert.pem`, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1,localhost" } }) };
    const adapter = new CodexAdapter({ ...params, store, config, broker, gatewayOrigin: origin, executor });
    const upload = adapter.uploadFeedback.bind(adapter); adapter.uploadFeedback = (payload, check) => { nativeCalls.push(payload); return upload(payload, check); };
    adapters.set(params.chat.id, adapter); return adapter;
  } });
  const confirmation = report => ({ id: report.id, revision: report.revision, threadId: report.threadId, confirm: true });
  const text = "PRIVATE_FEEDBACK_REASON_721", conversation = "PRIVATE_CONVERSATION_CANARY_721";
  try {
    const chat = await manager.createChat({ agent: "codex", title: "Network-isolated feedback fixture" });
    await manager.send(chat.id, `Reply to this fixture marker: ${conversation}`); assert.equal(modelCalls.length, 1);
    const messages = store.get(chat.id).messages.length, adapter = adapters.get(chat.id);
    const policy = await manager.nativeFeedback(chat.id, "policy"); assert.equal(policy.enabled, true); assert.equal(policy.logsAllowed, true);
    let review = await manager.nativeFeedback(chat.id, "prepare", { classification: "bug", reason: text, includeLogs: false });
    assert.equal(envelopes.length, 0); let sent = await manager.nativeFeedback(chat.id, "send", confirmation(review)); assert.equal(sent.state, "sent");
    assert.equal(sent.reference, adapter.threadId); assert.equal(envelopes.length, 1); assert.deepEqual(envelopes[0].items.map(item => item.type), ["event"]);
    const event = JSON.parse(envelopes[0].items[0].content); assert.equal(event.tags.reason, text); assert.equal(event.tags.classification, "bug");
    assert.equal(event.tags.thread_id, adapter.threadId); assert.doesNotMatch(JSON.stringify(envelopes), new RegExp(conversation));
    assert.equal((await manager.nativeFeedback(chat.id, "send", confirmation(review))).state, "sent"); assert.equal(nativeCalls.length, 1);

    const beforeLogs = envelopes.length;
    review = await manager.nativeFeedback(chat.id, "prepare", { classification: "other", reason: `${text}_LOGS`, includeLogs: true });
    sent = await manager.nativeFeedback(chat.id, "send", confirmation(review)); assert.equal(sent.state, "sent");
    const diagnostics = envelopes.slice(beforeLogs).flatMap(entry => entry.items), filenames = diagnostics.map(item => item.filename).filter(Boolean);
    assert.ok(filenames.includes("codex-logs.log")); assert.ok(filenames.includes("feedback-thread-index.json")); assert.ok(filenames.includes("codex-doctor-report.json"));
    assert.match(JSON.stringify(diagnostics), new RegExp(conversation), "Opted-in native diagnostics include this fixture's persisted conversation");
    assert.equal(nativeCalls.at(-1).includeLogs, true); assert.deepEqual(nativeCalls.at(-1).extraLogFiles, []);

    for (const classification of ["good", "bad"]) {
      review = await manager.nativeFeedback(chat.id, "prepare", { classification, reason: text, includeLogs: false });
      assert.equal((await manager.nativeFeedback(chat.id, "send", confirmation(review))).state, "sent");
      assert.equal(JSON.parse(envelopes.at(-1).items[0].content).tags.classification, classification);
    }
    failUpload = true;
    review = await manager.nativeFeedback(chat.id, "prepare", { classification: "bug", reason: `${text}_FAILURE`, includeLogs: false });
    assert.equal((await manager.nativeFeedback(chat.id, "send", confirmation(review))).state, "uncertain");
    const previousCalls = nativeCalls.length; assert.equal((await manager.nativeFeedback(chat.id, "send", confirmation(review))).state, "uncertain"); assert.equal(nativeCalls.length, previousCalls);
    failUpload = false;
    const stale = await manager.nativeFeedback(chat.id, "prepare", { classification: "bug", reason: text, includeLogs: false });
    // 0.154.0's feedback handler retains its startup config even after a config
    // reload. Relay's fresh pre-dispatch policy check enforces a newly disabled
    // setting immediately; do not rely solely on the upload handler's cache.
    await adapter.rpc.request("config/batchWrite", { edits: [{ keyPath: "feedback.enabled", value: false, mergeStrategy: "replace" }], reloadUserConfig: true });
    assert.equal((await manager.nativeFeedback(chat.id, "policy")).enabled, false);
    await assert.rejects(manager.nativeFeedback(chat.id, "prepare", { classification: "bug", reason: text, includeLogs: false }), /disabled/);
    await assert.rejects(manager.nativeFeedback(chat.id, "send", confirmation(stale)), /policy changed/);
    assert.equal(nativeCalls.length, previousCalls);
    await manager.stop(chat.id);
    assert.equal((await manager.nativeFeedback(chat.id, "policy")).enabled, false);
    const beforeDisabled = envelopes.length;
    const restarted = adapters.get(chat.id);
    await assert.rejects(restarted.rpc.request("feedback/upload", { classification: "bug", reason: text, threadId: restarted.threadId, includeLogs: false, extraLogFiles: [] }), /disabled by configuration/);
    assert.equal(envelopes.length, beforeDisabled); assert.equal(modelCalls.length, 1); assert.equal(store.get(chat.id).messages.length, messages);
    await manager.stop(chat.id); assert.ok((await manager.nativeFeedback(chat.id)).reports.length); assert.equal(nativeCalls.length, previousCalls);
    console.log(`PASS: actual Codex feedback policy, four classifications, text-only envelope, opt-in native history/logs (${filenames.length} files), matching session acknowledgement, failure/deduplication, no extra agent turns and stopped-worker status. Network-isolated local TLS receiver only; no report or diagnostics reached OpenAI.`);
  } finally {
    await manager.shutdown(); for (const socket of sockets) socket.destroy(); proxy.closeAllConnections(); receiver.closeAllConnections(); model.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => model.close(resolve))]); await rm(directory, { recursive: true, force: true });
  }
}
