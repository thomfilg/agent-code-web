// Explicit opt-in: actual installed native writer AND actual OCI deletion.
// No personal profiles/auth, external model inference, cloud or deploy.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import readline from "node:readline";
import { mkdtemp, readFile, readlink, open, rm, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createOciWorker } from "../test/fixtures/oci-worker.mjs";
import { JsonRpcProcess } from "../src/json-rpc-process.mjs";
import { cliVersionFromUserAgent } from "../src/session-info.mjs";
import { captureSessionBundle, workerSessionIO } from "../src/codex-session-bundle.mjs";
import { NativeSessionCheckpoints } from "../src/native-session-checkpoints.mjs";
import { nativeFixture } from "../test/fixtures/native-session.mjs";
import { openDatabase } from "../src/database.mjs";
import { ChatStore } from "../src/store.mjs";

test("installed Codex writer survives real isolated OCI deletion and controller PostgreSQL reopen", { timeout: 90000 }, async t => {
  const runc = process.env.RELAY_TEST_RUNC, nativeBin = process.env.CODEX_NATIVE_BINARY;
  assert(path.isAbsolute(runc || "") && path.isAbsolute(nativeBin || ""), "Explicit verified runtime and native executable paths required");
  const runcHash = createHash("sha256").update(await readFile(runc)).digest("hex");
  assert.equal(runcHash, "177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f", "Use the independently signature-verified runc 1.5.1 fixture binary");
  const directory = await mkdtemp("/tmp/relay-native-oci-controller-"), workers = [], rpcs = [], bridges = [];
  const counterPath = path.join(directory, "tool-executions.jsonl");
  let records, service, store, fixtureFailure, threadId, currentRpc, chatId;
  let executions = 0, requestCount = 0;
  const prompt = "OCI_NATIVE_USER_7493: preserve this exact original instruction and inspect the counted tool result.";
  const policy = "OCI_NATIVE_POLICY_7493: private local checkpoint acceptance only.";
  const resultText = "OCI_NATIVE_TOOL_RESULT_7493";
  const answer = "OCI_NATIVE_ASSISTANT_7493: counted tool completed.";
  const continuation = "OCI_NATIVE_CONTINUE_7493: inspect the retained context without rerunning the tool.";
  const home = "/runtime-home/codex", workspace = "/workspace";
  const observations = [];
  // Ensure a failed assertion still tries every independent owned cleanup.
  const emergency = setTimeout(() => { for (const worker of workers) void worker.delete().catch(() => {}); }, 80000);
  t.after(async () => {
    clearTimeout(emergency); const failures = [];
    for (const rpc of rpcs) { try { await rpc.stop(); } catch (error) { failures.push(error); } }
    for (const bridge of bridges) { try { bridge.child.stdin.end(); } catch (error) { failures.push(error); } }
    for (const worker of workers.reverse()) { try { await worker.cleanup(); } catch (error) { failures.push(error); } }
    try { await records?.close(); } catch (error) { failures.push(error); }
    if (!failures.length) await rm(directory, { recursive: true });
    else throw new AggregateError(failures, `Fixture cleanup uncertain; evidence retained at ${directory}`);
  });
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const database = { mode: "embedded", directory: path.join(directory, "db"), port };
  records = await openDatabase(database);
  const fixture = await nativeFixture(records); chatId = fixture.chat.id;
  await records.put("chat", chatId, { ...fixture.chat, agentSessionId: null, workspace });
  store = new ChatStore(directory, records); await store.initialize(); service = fixture.service;

  async function reply(message, toolPort, workerId) {
    if (message.kind === "tool") {
      executions++;
      const file = await open(counterPath, "a", 0o600);
      try { await file.writeFile(JSON.stringify({ execution: executions, workerId }) + "\n"); await file.sync(); } finally { await file.close(); }
      assert.equal(executions, 1, "No native tool replay is allowed after resume");
      return { text: resultText };
    }
    assert.equal(message.kind, "responses");
    const body = message.body, count = ++requestCount, input = JSON.stringify(body.input);
    assert(count <= 3, "Unexpected implicit/replayed provider request");
    assert(JSON.stringify(body).includes(policy), "Original developer instruction must remain native context");
    assert.equal(input.split(prompt).length - 1, 1, "Original native input must occur exactly once");
    let item;
    if (count === 1) {
      const args = { cmd: `/bin/node /fixtures/oci-counted-tool.mjs ${toolPort}`, workdir: workspace, login: false, max_output_tokens: 1000 };
      const catalog = body.input.filter(entry => entry.type === "additional_tools").flatMap(entry => entry.tools);
      if (catalog.some(tool => tool.name === "functions" && tool.tools?.some(child => child.name === "exec"))) {
        item = { type: "custom_tool_call", id: "oci_native_code", call_id: "oci_native_tool", namespace: "functions", name: "exec", input: `text(await tools.exec_command(${JSON.stringify(args)}));` };
      } else {
        const tool = body.tools?.find(entry => entry.type === "function" && ["exec_command", "shell", "shell_command"].includes(entry.name));
        assert(tool, "No supported advertised native shell tool");
        const parameters = tool.name === "exec_command" ? args : tool.name === "shell" ? { command: ["/bin/sh", "-c", args.cmd], workdir: workspace, timeout_ms: 10000 } : { command: args.cmd, workdir: workspace, timeout_ms: 10000 };
        item = { type: "function_call", id: "oci_native_code", call_id: "oci_native_tool", name: tool.name, arguments: JSON.stringify(parameters) };
      }
    } else {
      const output = body.input.find(entry => entry.call_id === "oci_native_tool" && /(?:function|custom_tool)_call_output/.test(entry.type));
      assert(JSON.stringify(output?.output)?.includes(resultText), "Actual counted native tool output must survive");
      assert.equal(executions, 1);
      if (count === 3) {
        assert.equal(input.split(continuation).length - 1, 1);
        assert.equal(input.split(answer).length - 1, 1);
        assert.equal(body.input.filter(entry => entry.call_id === "oci_native_tool" && ["function_call", "custom_tool_call"].includes(entry.type)).length, 1);
      }
    }
    item ||= { type: "message", id: `oci_message_${count}`, role: "assistant", status: "completed", content: [{ type: "output_text", annotations: [], text: count === 2 ? answer : "OCI_NATIVE_RECOVERY_CONFIRMED" }] };
    return { item };
  }
  async function makeWorker(providerPort = 0) {
    const worker = await createOciWorker(runc); workers.push(worker);
    const state = worker.inspect(); assert.equal(state.status, "running");
    for (const ns of ["pid", "mnt", "net", "user"]) assert.notEqual(await readlink(`/proc/${state.pid}/ns/${ns}`), await readlink(`/proc/self/ns/${ns}`));
    const spec = JSON.parse(await readFile(path.join(worker.root, "bundle/config.json"), "utf8"));
    assert(!spec.mounts.some(mount => mount.type === "bind" || mount.options?.includes("bind") || mount.options?.includes("rbind")));
    const network = worker.enableLoopback(); assert.deepEqual(network.links.map(link => link.ifname), ["lo"]); assert.equal(network.routes, "");
    await worker.put(nativeBin, "/bin/codex");
    await worker.installBinary("/bin/bash", "/bin/bash"); await worker.installBinary("/bin/sh", "/bin/sh");
    for (const name of ["oci-responses-bridge.mjs", "oci-counted-tool.mjs"]) await worker.put(new URL(`../test/fixtures/${name}`, import.meta.url).pathname, `/fixtures/${name}`);
    await worker.mkdir(home);
    const child = worker.spawn("node", ["/fixtures/oci-responses-bridge.mjs", String(providerPort)], { stdio: ["pipe", "pipe", "pipe"] });
    const ready = Promise.withResolvers(), bridge = { child, port: null }; bridges.push(bridge);
    let stderr = "", queued = 0;
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-1000); });
    child.on("error", error => ready.reject(error));
    child.stdin.on("error", () => {});
    child.once("close", code => ready.reject(Error(`Owned Responses bridge exited ${code}: ${stderr}`)));
    readline.createInterface({ input: child.stdout }).on("line", line => {
      if (line.length > 3 * 1024 * 1024 || ++queued > 4) { fixtureFailure ||= Error("Bridge payload/in-flight limit exceeded"); child.stdin.end(); return; }
      const message = JSON.parse(line);
      if (message.ready) { bridge.port = message.port; queued--; ready.resolve(bridge); return; }
      void reply(message, bridge.port, worker.id).then(value => {
        child.stdin.write(JSON.stringify({ id: message.id, ...value }) + "\n");
      }).catch(error => { fixtureFailure ||= error; if (child.stdin.writable) child.stdin.write(JSON.stringify({ id: message.id, error: true }) + "\n"); }).finally(() => queued--);
    });
    const timer = setTimeout(() => ready.reject(Error("Owned Responses bridge startup timed out")), 5000);
    try { await ready.promise; } finally { clearTimeout(timer); }
    return { worker, bridge };
  }
  async function connect({ worker, bridge }) {
    const rpc = new JsonRpcProcess({ command: "/bin/codex", spawnFn: worker.spawn.bind(worker), requestTimeoutMs: 15000,
      args: ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"', "-c", 'model_provider="fixture"', "-c", 'model="gpt-5.4"',
        "-c", 'model_providers.fixture.name="Local OCI fixture"', "-c", `model_providers.fixture.base_url="http://127.0.0.1:${bridge.port}/v1"`,
        "-c", 'model_providers.fixture.wire_api="responses"', "-c", "model_providers.fixture.requires_openai_auth=false", "-c", 'web_search="disabled"'],
      spawnOptions: { cwd: workspace, env: { PATH: "/bin:/usr/bin", HOME: "/runtime-home", CODEX_HOME: home, LANG: "C.UTF-8", SHELL: "/bin/bash", NO_COLOR: "1" } } });
    rpcs.push(rpc); rpc.on("error", () => {}); rpc.on("request", request => rpc.respondError(request.id, -32000, "No approvals or credentials in fixture"));
    let journalPath;
    rpc.on("notification", ({ method, params }) => {
      if (method !== "turn/completed" || params.threadId !== threadId) return;
      let marker = false;
      if (journalPath?.startsWith(home + "/sessions/")) {
        try { marker = readFileSync(path.join(worker.rootfs, journalPath), "utf8").trimEnd().split("\n").some(line => {
          const row = JSON.parse(line); return row.type === "event_msg" && row.payload?.type === "task_complete" && row.payload.turn_id === params.turn.id;
        }); } catch {}
      }
      observations.push({ turnId: params.turn.id, marker, at: Date.now() });
    });
    rpc.start(); const initialized = await rpc.request("initialize", { clientInfo: { name: "relay_native_oci_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized", {}); assert.equal(cliVersionFromUserAgent(initialized.userAgent), "0.155.0");
    return { rpc, setJournalPath(value) { journalPath = value; } };
  }
  async function turn(text) {
    const done = Promise.withResolvers(), listener = ({ method, params }) => { if (method === "turn/completed" && params.threadId === threadId) done.resolve(params.turn); };
    currentRpc.on("notification", listener); const timer = setTimeout(() => done.reject(fixtureFailure || Error("Native OCI turn timeout")), 20000);
    try {
      const started = await currentRpc.request("turn/start", { threadId, input: [{ type: "text", text }], approvalPolicy: "never" });
      const result = await done.promise; assert.ifError(fixtureFailure); assert.equal(result.status, "completed"); assert.equal(result.id, started.turn.id); return result;
    } finally { clearTimeout(timer); currentRpc.off("notification", listener); }
  }

  const first = await makeWorker(), connected = await connect(first); currentRpc = connected.rpc;
  const started = await currentRpc.request("thread/start", { cwd: workspace, model: "gpt-5.4", modelProvider: "fixture", approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: policy });
  threadId = started.thread.id; connected.setJournalPath(started.thread.path);
  await store.update(chatId, { agentSessionId: threadId }); await store.appendMessage(chatId, { role: "user", kind: "text", text: prompt });
  const finished = await turn(prompt); assert.equal(requestCount, 2); assert.equal(executions, 1);
  await store.appendMessage(chatId, { role: "assistant", kind: "text", text: answer });
  const bundle = await captureSessionBundle({ threadId, readThread: async id => {
    assert.equal(id, threadId); return started.thread;
  }, readBytes: async (filename, boundary) => Buffer.from((await workerSessionIO(first.worker, { action: "readScoped", home, path: filename, boundary })).data, "base64") });
  const checkpoint = await service.save(store.get(chatId), bundle, 0, { boundary: "turn-completed", turnId: finished.id });
  const bytes = Buffer.from(checkpoint.value.bundle.files[0].data, "base64");
  for (const value of [prompt, policy, resultText, answer]) assert(bytes.includes(value));
  const messages = structuredClone(store.get(chatId).messages), counterBytes = await readFile(counterPath, "utf8");
  assert.equal(counterBytes.trim().split("\n").length, 1);
  // Do not gracefully stop native first: destroy actual OCI runtime and rootfs.
  await first.worker.delete(); await assert.rejects(access(first.worker.rootfs), { code: "ENOENT" });
  await records.close(); records = await openDatabase(database);
  store = new ChatStore(directory, records); await store.initialize(); service = new NativeSessionCheckpoints({ records });
  assert.deepEqual(store.get(chatId).messages, messages); assert.equal(store.get(chatId).agentSessionId, threadId);
  const durable = await service.read(store.get(chatId)); assert.deepEqual(durable.value.bundle, bundle);
  // Keep the counted command's loopback endpoint valid in the replacement
  // network namespace, so a replay cannot hide behind a stale closed port.
  const second = await makeWorker(first.bridge.port); assert.equal(second.bridge.port, first.bridge.port);
  assert.notEqual(second.worker.id, first.worker.id); assert.notEqual(second.worker.rootfs, first.worker.rootfs);
  const restored = await workerSessionIO(second.worker, { action: "restoreFresh", home, bundle: durable.value.bundle }); assert.equal(restored.restored, true);
  assert.equal((await workerSessionIO(second.worker, { action: "readScoped", home, path: restored.path })).data, bytes.toString("base64"));
  const beforeResumeRequests = requestCount, resumedConnection = await connect(second); currentRpc = resumedConnection.rpc; resumedConnection.setJournalPath(restored.path);
  const resumed = await currentRpc.request("thread/resume", { threadId, cwd: workspace, model: "gpt-5.4", modelProvider: "fixture", approvalPolicy: "never", sandbox: "danger-full-access" });
  assert.equal(resumed.thread.id, threadId);
  const read = await currentRpc.request("thread/read", { threadId, includeTurns: true });
  assert(JSON.stringify(read.thread.turns).includes(prompt)); assert(JSON.stringify(read.thread.turns).includes(answer));
  assert.equal(requestCount, beforeResumeRequests); assert.equal(await readFile(counterPath, "utf8"), counterBytes);
  await turn(continuation); assert.equal(requestCount, 3); assert.equal(executions, 1);
  assert.equal(await readFile(counterPath, "utf8"), counterBytes); assert.deepEqual(store.get(chatId).messages, messages); assert.ifError(fixtureFailure);
  const observed = observations.find(item => item.turnId === finished.id); assert(observed);
  t.diagnostic(`PASS: installed Codex 0.155.0; two real private OCI containers, first runtime/rootfs deleted abruptly; real controller PostgreSQL reopened; exact native ID/bytes/instructions/tool/result/assistant restored. 3 private-loopback responses, durable counted tool executions=1, zero implicit resume requests; exact terminal marker at completion=${observed.marker}. runc sha256=${runcHash}. Completed-checkpoint evidence only: not mid-turn zero loss, independent child workflow, cloud lifecycle, or full MVP acceptance.`);
});
