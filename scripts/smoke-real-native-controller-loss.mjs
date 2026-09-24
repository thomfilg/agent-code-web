// Opt-in, real installed native writer + real controller SIGKILL + OCI deletion.
// The supervisor owns infrastructure/assertions, never a native RPC connection.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import readline from "node:readline";
import { mkdtemp, mkdir, readFile, readlink, open, rm, access } from "node:fs/promises";
import { createOciWorker } from "../test/fixtures/oci-worker.mjs";
import { verifiedRuncHash } from "../test/fixtures/oci-executor.mjs";
import { scenario } from "../test/fixtures/native-oci-controller.mjs";
import { nativeFixture } from "../test/fixtures/native-session.mjs";
import { openDatabase } from "../src/database.mjs";

test("installed native history survives actual controller SIGKILL and isolated OCI replacement", { timeout: 90000 }, async t => {
  const runc = process.env.RELAY_TEST_RUNC, nativeBin = process.env.CODEX_NATIVE_BINARY;
  assert(path.isAbsolute(runc || "") && path.isAbsolute(nativeBin || ""), "Explicit verified runtime and native executable paths required");
  assert.equal(createHash("sha256").update(await readFile(runc)).digest("hex"), verifiedRuncHash);
  const directory = await mkdtemp("/tmp/relay-controller-loss-"), counterPath = path.join(directory, "tool-executions.jsonl");
  const workers = [], bridges = [], controllers = [];
  let records, fixtureFailure, executions = 0, requestCount = 0;
  const emergency = setTimeout(() => {
    for (const controller of controllers) controller.kill();
    for (const worker of workers) void worker.delete().catch(() => {});
  }, 80000);
  t.after(async () => {
    clearTimeout(emergency); const failures = [];
    for (const controller of controllers) { try { await controller.terminate(); } catch (error) { failures.push(error); } }
    for (const bridge of bridges) bridge.child.stdin.end();
    for (const worker of workers.reverse()) { try { await worker.cleanup(); } catch (error) { failures.push(error); } }
    try { await records?.close(); } catch (error) { failures.push(error); }
    if (!failures.length) await rm(directory, { recursive: true });
    else throw new AggregateError(failures, `Fixture cleanup uncertain; retained ${directory}`);
  });
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  // Database is external infrastructure, not owned by the controller being
  // killed. Both controllers open independent pools with this synthetic key.
  records = await openDatabase({ mode: "embedded", directory: path.join(directory, "db"), port });
  const fixture = await nativeFixture(records), chatId = fixture.chat.id;
  await records.put("chat", chatId, { ...fixture.chat, agentSessionId: null, workspace: "/workspace" });

  async function reply(message, toolPort, workerId) {
    if (message.kind === "tool") {
      executions++;
      const file = await open(counterPath, "a", 0o600);
      try { await file.writeFile(JSON.stringify({ execution: executions, workerId }) + "\n"); await file.sync(); } finally { await file.close(); }
      assert.equal(executions, 1, "No native tool replay after controller loss");
      return { text: scenario.result };
    }
    assert.equal(message.kind, "responses");
    const body = message.body, count = ++requestCount, input = JSON.stringify(body.input);
    assert(count <= 3, "Unexpected implicit provider request");
    assert(JSON.stringify(body).includes(scenario.policy), "Native instructions retained");
    assert.equal(input.split(scenario.prompt).length - 1, 1);
    let item;
    if (count === 1) {
      const args = { cmd: `/bin/node /fixtures/oci-counted-tool.mjs ${toolPort}`, workdir: "/workspace", login: false, max_output_tokens: 1000 };
      const catalog = body.input.filter(entry => entry.type === "additional_tools").flatMap(entry => entry.tools);
      if (catalog.some(tool => tool.name === "functions" && tool.tools?.some(child => child.name === "exec"))) {
        item = { type: "custom_tool_call", id: "oci_native_code", call_id: "oci_native_tool", namespace: "functions", name: "exec", input: `text(await tools.exec_command(${JSON.stringify(args)}));` };
      } else {
        const tool = body.tools?.find(entry => entry.type === "function" && ["exec_command", "shell", "shell_command"].includes(entry.name));
        assert(tool, "No supported native shell tool");
        const parameters = tool.name === "exec_command" ? args : tool.name === "shell" ? { command: ["/bin/sh", "-c", args.cmd], workdir: "/workspace", timeout_ms: 10000 } : { command: args.cmd, workdir: "/workspace", timeout_ms: 10000 };
        item = { type: "function_call", id: "oci_native_code", call_id: "oci_native_tool", name: tool.name, arguments: JSON.stringify(parameters) };
      }
    } else {
      const output = body.input.find(entry => entry.call_id === "oci_native_tool" && /(?:function|custom_tool)_call_output/.test(entry.type));
      assert(JSON.stringify(output?.output)?.includes(scenario.result)); assert.equal(executions, 1);
      if (count === 3) {
        assert.equal(input.split(scenario.continuation).length - 1, 1); assert.equal(input.split(scenario.answer).length - 1, 1);
        assert.equal(body.input.filter(entry => entry.call_id === "oci_native_tool" && ["function_call", "custom_tool_call"].includes(entry.type)).length, 1);
      }
    }
    item ||= { type: "message", id: `oci_message_${count}`, role: "assistant", status: "completed", content: [{ type: "output_text", annotations: [], text: count === 2 ? scenario.answer : "OCI_NATIVE_RECOVERY_CONFIRMED" }] };
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
    await worker.mkdir("/runtime-home/codex");
    const child = worker.spawn("node", ["/fixtures/oci-responses-bridge.mjs", String(providerPort)], { stdio: ["pipe", "pipe", "pipe"] });
    const ready = Promise.withResolvers(), bridge = { child, port: null }; bridges.push(bridge);
    let stderr = "", queued = 0;
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-1000); });
    child.on("error", error => ready.reject(error)); child.stdin.on("error", () => {});
    child.once("close", code => ready.reject(Error(`Owned bridge exited ${code}: ${stderr}`)));
    readline.createInterface({ input: child.stdout }).on("line", line => {
      if (line.length > 3 * 1024 * 1024 || ++queued > 4) { fixtureFailure ||= Error("Bridge bounds exceeded"); child.stdin.end(); return; }
      let message;
      try { message = JSON.parse(line); } catch { fixtureFailure ||= Error("Invalid bridge message"); child.stdin.end(); return; }
      if (message.ready) { bridge.port = message.port; queued--; ready.resolve(bridge); return; }
      void reply(message, bridge.port, worker.id).then(value => { child.stdin.write(JSON.stringify({ id: message.id, ...value }) + "\n"); })
        .catch(error => { fixtureFailure ||= error; if (child.stdin.writable) child.stdin.write(JSON.stringify({ id: message.id, error: true }) + "\n"); }).finally(() => queued--);
    });
    const timer = setTimeout(() => ready.reject(Error("Owned bridge startup timeout")), 5000);
    try { await ready.promise; } finally { clearTimeout(timer); }
    return { worker, bridge, descriptor: { runc, id: worker.id, root: worker.root, pid: state.pid } };
  }
  async function makeController(worker, name) {
    const privateHome = path.join(directory, name); await mkdir(privateHome, { mode: 0o700 });
    const child = fork(new URL("../test/fixtures/native-oci-controller.mjs", import.meta.url), [], {
      cwd: privateHome, env: { PATH: "/usr/bin:/bin", HOME: privateHome, LANG: "C.UTF-8" }, stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
    const ended = Promise.withResolvers(), pending = new Map(); let seq = 0, exited = false, stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-1500); });
    child.on("error", error => ended.reject(error));
    child.once("exit", (code, signal) => { exited = true; ended.resolve({ code, signal }); for (const task of pending.values()) task.reject(Error(`Owned controller exited: ${code}/${signal}: ${stderr}`)); pending.clear(); });
    child.on("message", message => { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(Error(message.error)) : task.resolve(message.result); });
    const call = async (action, fields = {}) => {
      assert(!exited); const id = ++seq, task = Promise.withResolvers(); pending.set(id, task);
      child.send({ id, action, ...fields }, error => { if (error) task.reject(error); });
      const timer = setTimeout(() => task.reject(Error(`Controller ${action} timeout`)), 25000);
      try { return await task.promise; } finally { clearTimeout(timer); pending.delete(id); }
    };
    const controller = { child, call, kill() { if (!exited) child.kill("SIGKILL"); }, async terminate() {
      controller.kill(); let timer;
      try { return await Promise.race([ended.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Owned controller termination unconfirmed")), 5000); })]); }
      finally { clearTimeout(timer); }
    } };
    controllers.push(controller);
    const options = records.pool.options;
    const initialized = await call("initialize", { chatId, worker: worker.descriptor, directory: privateHome,
      connection: { host: options.host, port: options.port, user: options.user, password: options.password, database: options.database, max: 2 }, encryptionKey: records.cipher.key.toString("base64") });
    assert.equal(initialized.pid, child.pid); return controller;
  }

  const first = await makeWorker(), a = await makeController(first, "controller-a");
  const committed = await a.call("capture", { providerPort: first.bridge.port });
  assert.equal(committed.committed, true); assert.equal(committed.revision, 1); assert.equal(committed.pid, a.child.pid);
  assert.equal(requestCount, 2); assert.equal(executions, 1); assert.ifError(fixtureFailure);
  const counterBytes = await readFile(counterPath, "utf8"); assert.equal(counterBytes.trim().split("\n").length, 1);
  // No graceful close, no in-memory journal handoff, no supervisor RPC owner.
  const dead = await a.terminate(); assert.deepEqual(dead, { code: null, signal: "SIGKILL" });
  await first.worker.delete(); await assert.rejects(access(first.worker.rootfs), { code: "ENOENT" });
  const second = await makeWorker(first.bridge.port); assert.equal(second.bridge.port, first.bridge.port);
  assert.notEqual(second.worker.id, first.worker.id); assert.notEqual(second.worker.rootfs, first.worker.rootfs);
  const b = await makeController(second, "controller-b"); assert.notEqual(b.child.pid, a.child.pid);
  const restored = await b.call("restore", { providerPort: second.bridge.port });
  assert.equal(restored.pid, b.child.pid); assert.equal(restored.threadId, committed.threadId);
  assert.equal(restored.bundleHash, committed.bundleHash); assert.equal(restored.messagesHash, committed.messagesHash); assert.equal(restored.revision, committed.revision);
  assert.equal(requestCount, 2, "Resume/read must not send a turn"); assert.equal(await readFile(counterPath, "utf8"), counterBytes);
  const continued = await b.call("continue"); assert.equal(continued.messagesHash, committed.messagesHash);
  assert.equal(requestCount, 3); assert.equal(executions, 1); assert.equal(await readFile(counterPath, "utf8"), counterBytes); assert.ifError(fixtureFailure);
  await b.call("close");
  t.diagnostic(`PASS: installed Codex 0.155.0, controller A PID ${a.child.pid} COMMIT then confirmed SIGKILL, controller B PID ${b.child.pid} rebuilt from independent PostgreSQL pool; actual first OCI/rootfs deleted, different isolated OCI restored exact native ID/bytes/messages/instructions/tool/result/assistant. 3 private-loopback Responses requests; durable tool counter=1; zero implicit resume requests; observed terminal marker=${committed.terminalMarkerObserved}; runc sha256=${verifiedRuncHash}. Completed-checkpoint/direct-RPC fixture, not full RuntimeManager restart, mid-turn zero loss, cloud or HA acceptance.`);
});
