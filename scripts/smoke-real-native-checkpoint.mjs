import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { JsonRpcProcess } from "../src/json-rpc-process.mjs";
import { captureSessionBundle, readScopedSessionBytes, restoreSessionBundleIfFresh } from "../src/codex-session-bundle.mjs";
import { nativeFixture } from "../test/fixtures/native-session.mjs";
import { cliVersionFromUserAgent } from "../src/session-info.mjs";

// Reuse the real-CLI smoke harness conventions: loopback Responses/code-mode
// frames from smoke-real-init, network/PID isolation from smoke-real-mcps.
// No rollout is authored here: every journal byte comes from the installed CLI.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--",
    process.execPath, process.argv[1], "--network-isolated"], {
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", CODEX_WRITER_BIN: process.env.CODEX_WRITER_BIN || "codex" }, timeout: 90000, maxBuffer: 16000,
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  await run();
}

async function run() {
  const root = await mkdtemp("/tmp/relay-native-writer-"), home = path.join(root, "worker-codex"), workspace = path.join(root, "workspace");
  const originalPrompt = "NATIVE_CHECKPOINT_USER_7493: retain this exact instruction and inspect the harmless tool result.";
  const policy = "NATIVE_CHECKPOINT_POLICY_7493: this is a private local protocol fixture.";
  const resultSentinel = "NATIVE_CHECKPOINT_TOOL_RESULT_7493", answer = "NATIVE_CHECKPOINT_ASSISTANT_7493: the harmless tool completed.";
  const continuation = "NATIVE_CHECKPOINT_CONTINUE_7493: inspect the retained context without repeating the previous tool.";
  const requests = [], rpcs = new Set(), observations = [];
  let fixtureFailure, journalPath, threadId, rpc, timer;
  const toolOutput = body => body.input?.find(item => item.call_id === "native_checkpoint_tool" && /(?:function|custom_tool)_call_output/.test(item.type));
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url.endsWith("/responses")) { request.resume(); response.writeHead(404); response.end(); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), count = requests.push(body); let item;
    try {
      assert(count <= 3, "Unexpected replay or extra native provider request");
      assert.match(JSON.stringify(body), /NATIVE_CHECKPOINT_POLICY_7493/);
      assert.equal(JSON.stringify(body.input).split(originalPrompt).length - 1, 1, "original input must occur exactly once");
      if (count === 1) {
        const catalog = body.input.filter(entry => entry.type === "additional_tools").flatMap(entry => entry.tools);
        const args = { cmd: `printf '%s' '${resultSentinel}'`, workdir: workspace, login: false, max_output_tokens: 1000 };
        if (catalog.some(tool => tool.name === "functions" && tool.tools?.some(child => child.name === "exec"))) {
          item = { type: "custom_tool_call", id: "native_checkpoint_code", call_id: "native_checkpoint_tool", namespace: "functions", name: "exec",
            input: `text(await tools.exec_command(${JSON.stringify(args)}));` };
        } else {
          const nativeTool = body.tools?.find(tool => tool.type === "function" && ["exec_command", "shell", "shell_command"].includes(tool.name));
          assert(nativeTool, `No supported native shell tool advertised: ${JSON.stringify((body.tools || []).map(tool => ({ type: tool.type, name: tool.name })))}`);
          const parameters = nativeTool.name === "exec_command" ? args : nativeTool.name === "shell" ? { command: ["/bin/sh", "-c", args.cmd], workdir: workspace, timeout_ms: 1000 } : { command: args.cmd, workdir: workspace, timeout_ms: 1000 };
          item = { type: "function_call", id: "native_checkpoint_code", call_id: "native_checkpoint_tool", name: nativeTool.name, arguments: JSON.stringify(parameters) };
        }
      } else {
        assert.match(JSON.stringify(toolOutput(body)?.output), /NATIVE_CHECKPOINT_TOOL_RESULT_7493/, "native executed tool output must survive");
        if (count === 3) {
          assert.equal(JSON.stringify(body.input).split(continuation).length - 1, 1);
          assert.equal(JSON.stringify(body.input).split(answer).length - 1, 1, "prior native assistant context must survive exactly once");
          assert(body.input.some(entry => entry.call_id === "native_checkpoint_tool" && ["custom_tool_call", "function_call"].includes(entry.type)), "native tool call must remain paired with its result");
        }
      }
    } catch (error) { fixtureFailure ||= error; }
    item ||= { type: "message", id: `native_checkpoint_message_${count}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", annotations: [], text: fixtureFailure ? "Fixture failed; no recovery success is claimed." : count === 2 ? answer : "NATIVE_CHECKPOINT_RECOVERY_CONFIRMED" }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `native_checkpoint_response_${count}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `native_checkpoint_response_${count}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  const markerPresent = turnId => {
    if (!journalPath?.startsWith(`${home}/sessions/`)) return false;
    try { return readFileSync(journalPath, "utf8").trimEnd().split("\n").some(line => { const record = JSON.parse(line); return record.type === "event_msg" && record.payload?.type === "task_complete" && record.payload.turn_id === turnId; }); }
    catch { return false; }
  };
  async function close(childRpc, kill = false) {
    const child = childRpc?.child; if (!child) return;
    const closed = once(child, "close");
    if (kill) process.kill(-child.pid, "SIGKILL"); else await childRpc.stop();
    await closed;
  }
  async function connect() {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const childRpc = new JsonRpcProcess({ command: process.env.CODEX_WRITER_BIN || "codex", requestTimeoutMs: 15000,
      args: ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"', "-c", 'model_provider="fixture"', "-c", 'model="gpt-5.4"',
        "-c", 'model_providers.fixture.name="Local native writer fixture"', "-c", `model_providers.fixture.base_url=${JSON.stringify(origin + "/v1")}`,
        "-c", 'model_providers.fixture.wire_api="responses"', "-c", "model_providers.fixture.requires_openai_auth=false", "-c", 'web_search="disabled"'],
      spawnOptions: { cwd: workspace, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, LANG: "C.UTF-8", NO_COLOR: "1" } } });
    childRpc.on("error", () => {}); childRpc.on("request", request => childRpc.respondError(request.id, -32000, "No approval or credentials are available in this fixture"));
    childRpc.on("notification", ({ method, params }) => {
      if (method === "turn/completed" && params.threadId === threadId) observations.push({ turnId: params.turn.id, markerAtNotification: markerPresent(params.turn.id), observedAt: Date.now() });
    });
    rpcs.add(childRpc); childRpc.start();
    const initialized = await childRpc.request("initialize", { clientInfo: { name: "relay_native_writer_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    childRpc.notify("initialized", {}); return { rpc: childRpc, version: cliVersionFromUserAgent(initialized.userAgent) };
  }
  async function turn(text) {
    const completed = Promise.withResolvers();
    const listener = ({ method, params }) => { if (method === "turn/completed" && params.threadId === threadId) completed.resolve(params.turn); };
    rpc.on("notification", listener);
    const timeout = setTimeout(() => completed.reject(Error("Native fixture turn did not complete")), 20000);
    try {
      const started = await rpc.request("turn/start", { threadId, input: [{ type: "text", text }], approvalPolicy: "never" });
      const result = await completed.promise; assert.equal(result.id, started.turn.id); assert.equal(result.status, "completed"); assert.ifError(fixtureFailure); return result;
    } finally { clearTimeout(timeout); rpc.off("notification", listener); }
  }
  try {
    await mkdir(home, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    timer = setTimeout(() => { for (const childRpc of rpcs) void close(childRpc, true).catch(() => {}); server.closeAllConnections(); }, 60000);
    // Metadata-only synthetic owner/company/account; this helper does not
    // install a rollout. The production service consumes only CLI-written bytes.
    const { chat, records, service } = await nativeFixture();
    const connected = await connect(); rpc = connected.rpc;
    const started = await rpc.request("thread/start", { cwd: workspace, model: "gpt-5.4", modelProvider: "fixture", approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: policy });
    threadId = started.thread.id; journalPath = started.thread.path;
    assert.equal(connected.version, "0.155.0", "This receipt is intentionally pinned to the reviewed installed native writer");
    assert(journalPath?.startsWith(`${home}/sessions/`), "native writer must identify its owned journal before observing completion");
    chat.agentSessionId = threadId; await records.put("chat", chat.id, chat);
    const finished = await turn(originalPrompt);
    assert.equal(requests.length, 2, "one tool and one final native response");
    const observed = observations.find(item => item.turnId === finished.id); assert(observed);
    let checkpoint, retries = 0;
    do {
      try {
        const bundle = await captureSessionBundle({ threadId,
          // Match the adapter's cached root path. Do not insert a thread/read
          // round trip that could hide a native event-before-flush race.
          readThread: async id => id === threadId ? started.thread : (await rpc.request("thread/read", { threadId: id, includeTurns: false })).thread,
          readBytes: (filename, boundary) => readScopedSessionBytes(home, filename, boundary) });
        checkpoint = await service.save(chat, bundle, 0, { boundary: "turn-completed", turnId: finished.id });
      } catch (error) {
        if (error.code !== "TERMINAL_RECORD_NOT_FLUSHED" || retries++ >= 20) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } while (!checkpoint);
    const checkpointDelayMs = Date.now() - observed.observedAt;
    const savedBytes = Buffer.from(checkpoint.value.bundle.files.find(file => file.id === threadId).data, "base64");
    for (const value of [originalPrompt, policy, resultSentinel, answer]) assert(savedBytes.includes(value), "native journal must retain the actual instruction/tool/result/answer");
    await close(rpc, true); assert.equal(rpc.child, null);
    assert(home.startsWith(root + path.sep)); await rm(home, { recursive: true, force: true }); await mkdir(home, { mode: 0o700 });
    const restored = await restoreSessionBundleIfFresh(home, (await service.read(chat)).value.bundle);
    assert.equal(restored.restored, true); assert.deepEqual(await readFile(restored.path), savedBytes);
    journalPath = restored.path; const beforeResumeRequests = requests.length;
    rpc = (await connect()).rpc;
    const resumed = await rpc.request("thread/resume", { threadId, cwd: workspace, model: "gpt-5.4", modelProvider: "fixture", approvalPolicy: "never", sandbox: "danger-full-access" });
    assert.equal(resumed.thread.id, threadId);
    const read = await rpc.request("thread/read", { threadId, includeTurns: true });
    assert.match(JSON.stringify(read.thread.turns), /NATIVE_CHECKPOINT_USER_7493/); assert.match(JSON.stringify(read.thread.turns), /NATIVE_CHECKPOINT_ASSISTANT_7493/);
    assert.equal(requests.length, beforeResumeRequests, "resume/read cannot implicitly replay a prompt or tool");
    await turn(continuation); assert.equal(requests.length, 3); assert.ifError(fixtureFailure);
    console.log(`PASS: installed ${connected.version}; native-writer checkpoint recovered exact thread/user/instructions/tool/result/assistant after owned process kill and private journal deletion, then explicit continuation used retained context. ${requests.length} loopback responses; marker present at completed notification=${observed.markerAtNotification}; terminal-capture retries=${retries}; checkpoint delay=${checkpointDelayMs}ms. Observed boundary only, not a general flush/zero-loss guarantee or actual container deletion proof.`);
  } finally {
    clearTimeout(timer); for (const childRpc of rpcs) await close(childRpc);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  }
}
