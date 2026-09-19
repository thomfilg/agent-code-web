import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, lstat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fork } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WorkerProcessSupervisor } from "../src/worker-process-supervisor.mjs";
import { WorkerProcessTransport } from "../src/worker-process-transport.mjs";

const binding = Object.freeze({ deploymentId: "fixture", ownerId: "owner", chatId: "chat", workerId: "worker", provider: "mock", accountId: "account", attemptId: "attempt" });
const memoryChild = `const readline=require('node:readline'); const sentinel=require('node:crypto').randomUUID(); let count=0;
readline.createInterface({input:process.stdin}).on('line',line=>{if(line==='increment') count++; process.stdout.write(JSON.stringify({pid:process.pid,sentinel,count,line})+'\\n');});`;
const spec = (code = memoryChild) => ({ command: process.execPath, args: ["-e", code], cwd: os.tmpdir(), env: {} });
async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw Error("Synthetic condition timed out"); await delay(5); }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-transport-"));
  const socketPath = path.join(directory, "worker.sock"), clients = [];
  const f = { directory, socketPath, generation: 1, expiresIn: 30000, denied: false, clients, hook: null };
  const supervisor = f.supervisor = await new WorkerProcessSupervisor({ socketPath, expectedIdentity: binding, ...options,
    authorize: async request => {
      await f.hook?.(request);
      if (f.denied || request.lease !== `lease-${f.generation}`) throw Error("PRIVATE_TOKEN_DO_NOT_EXPOSE");
      return { id: request.lease, generation: f.generation, expiresAt: Date.now() + f.expiresIn };
    },
  }).listen();
  f.client = async (overrides = {}) => {
    const client = await new WorkerProcessTransport({ socketPath, expectedIdentity: binding, lease: `lease-${f.generation}`, ...overrides }).connect();
    client.frames = []; client.on("output", frame => client.frames.push(frame)); clients.push(client); return client;
  };
  f.start = async (code = memoryChild) => { const client = await f.client(); const receipt = await client.launch("child", spec(code)); await client.attach(receipt, 0); return { client, receipt }; };
  t.after(async () => {
    for (const client of clients) client.disconnect();
    for (const entry of supervisor.processes.values()) {
      await supervisor.terminate(entry);
      await until(() => { supervisor.acknowledge(entry, entry.outputSeq); supervisor.drain(entry); return entry.exitRecorded; });
      supervisor.acknowledge(entry, entry.outputSeq);
    }
    await supervisor.close(); await rm(directory, { recursive: true, force: true });
  });
  return f;
}
const stdout = client => Buffer.concat(client.frames.filter(frame => frame.channel === "stdout").map(frame => frame.data)).toString();
const lines = client => stdout(client).split("\n").slice(0, -1).filter(Boolean).map(line => JSON.parse(line));

test("disconnect preserves PID, memory and stdin; committed output alone is pruned and reconnect never repeats input", async t => {
  const f = await fixture(t), { client, receipt } = await f.start();
  await client.writeInput(1, Buffer.from("increment\n")); await until(() => stdout(client).includes("\n"));
  const original = lines(client)[0], outputSeq = client.frames.at(-1).seq;
  assert.equal((await client.status()).outputCommittedThrough, 0);
  client.disconnect(); f.generation++;
  const next = await f.client(); await next.attach(receipt, 0);
  await until(() => stdout(next).includes("\n")); assert.deepEqual(lines(next), [original]);
  assert.equal((await next.status()).pid, receipt.pid);
  assert.equal((await next.writeInput(1, Buffer.from("increment\n"))).duplicate, true);
  await next.writeInput(2, Buffer.from("read\n")); await until(() => lines(next).length === 2);
  assert.deepEqual(lines(next).map(row => row.count), [1, 1]); assert.equal(lines(next)[1].sentinel, original.sentinel);
  await next.ackOutput(outputSeq); next.disconnect(); f.generation++;
  const third = await f.client(); await third.attach(receipt, outputSeq); await until(() => stdout(third).includes("\n"));
  assert.equal(lines(third).length, 1); assert.equal(lines(third)[0].line, "read");
  await third.endInput(3); await until(() => third.frames.some(frame => frame.channel === "exit"));
  assert.equal((await third.status()).state, "exited");
});

test("input conflicts, gaps and expired replay windows fail rather than replaying bytes", async t => {
  const f = await fixture(t, { inputWindow: 2 }), { client } = await f.start();
  await assert.rejects(client.writeInput(2, Buffer.from("increment\n")), { code: "INPUT_GAP" });
  for (let seq = 1; seq <= 3; seq++) await client.writeInput(seq, Buffer.from("increment\n"));
  await assert.rejects(client.writeInput(2, Buffer.from("different\n")), { code: "INPUT_CONFLICT" });
  await assert.rejects(client.writeInput(1, Buffer.from("increment\n")), { code: "INPUT_RETRY_EXPIRED" });
  await client.endInput(4); assert.equal((await client.endInput(4)).duplicate, true);
  await assert.rejects(client.writeInput(5, Buffer.from("increment\n")), { code: "INPUT_CLOSED" });
  await until(() => lines(client).length === 3); assert.deepEqual(lines(client).map(row => row.count), [1, 2, 3]);
});

test("explicit termination bypasses a held stdin acknowledgement and cannot accept later input", async t => {
  const f = await fixture(t), { client } = await f.start(`setInterval(()=>{},1000);`);
  const entry = f.supervisor.processes.get("child");
  const originalWrite = entry.child.stdin.write;
  let release;
  // Hold the pipe acknowledgement deterministically; socket scheduling latency
  // and transient writableLength do not establish actual OS pipe saturation.
  entry.child.stdin.write = (_data, callback) => { release = callback; return false; };
  const write = client.writeInput(1, Buffer.alloc(16384, 120)); write.catch(() => {});
  try {
    await until(() => Boolean(release) && entry.inputPending);
    const ended = await client.terminate(); assert.equal(ended.state, "exited");
    assert.equal(entry.inputPending, true, "termination does not await the held acknowledgement");
    release(Error("synthetic closed pipe")); release = null;
    await assert.rejects(write, { code: "INPUT_OUTCOME_UNKNOWN" });
    await assert.rejects(client.writeInput(2, Buffer.from("never")), { code: "INPUT_CLOSED" });
  } finally {
    release?.(Error("fixture cleanup"));
    entry.child.stdin.write = originalWrite;
  }
});

test("pipe-error input reservation never gets a false successful replay acknowledgement", async t => {
  const f = await fixture(t), { client } = await f.start();
  const child = f.supervisor.processes.get("child").child, originalWrite = child.stdin.write.bind(child.stdin);
  let writes = 0;
  child.stdin.write = (_data, callback) => { writes++; queueMicrotask(() => callback(Error("private pipe failure"))); return false; };
  await assert.rejects(client.writeInput(1, Buffer.from("increment\n")), { code: "INPUT_OUTCOME_UNKNOWN" });
  await assert.rejects(client.writeInput(1, Buffer.from("increment\n")), { code: "INPUT_OUTCOME_UNKNOWN" });
  await assert.rejects(client.writeInput(2, Buffer.from("read\n")), { code: "INPUT_OUTCOME_UNKNOWN" });
  assert.equal(writes, 1); child.stdin.write = originalWrite;
});

test("replacing clients cannot accumulate blocked stdin writes across generations", async t => {
  const f = await fixture(t), { client, receipt } = await f.start();
  const child = f.supervisor.processes.get("child").child, originalWrite = child.stdin.write.bind(child.stdin);
  let release, writes = 0;
  child.stdin.write = (_data, callback) => { writes++; release = callback; return false; };
  const pending = client.writeInput(1, Buffer.alloc(16384)); pending.catch(() => {});
  await until(() => writes === 1);
  for (let attempt = 0; attempt < 3; attempt++) {
    f.generation++; const next = await f.client(); await next.attach(receipt, 0);
    await assert.rejects(next.writeInput(2, Buffer.alloc(16384)), { code: "INPUT_BACKPRESSURE" });
    await assert.rejects(next.writeInput(1, Buffer.alloc(16384)), { code: "INPUT_OUTCOME_UNKNOWN" });
  }
  assert.equal(writes, 1); release(null); child.stdin.write = originalWrite;
  await assert.rejects(pending, { code: "CONNECTION_LOST_OUTCOME_UNKNOWN" });
});

test("all binding fields deny foreign admission and errors hide authorizer secrets", async t => {
  const f = await fixture(t), { receipt } = await f.start();
  for (const field of Object.keys(binding)) {
    const foreign = await f.client({ expectedIdentity: { ...binding, [field]: "foreign" } });
    await assert.rejects(foreign.inspect(receipt.processId), { code: "ADMISSION_DENIED" }); foreign.disconnect();
  }
  f.denied = true; const denied = await f.client();
  await assert.rejects(denied.inspect("child"), error => error.code === "ADMISSION_DENIED" && !error.message.includes("PRIVATE_TOKEN"));
});

test("new authoritative generation fences stale clients; same generation cannot reattach or kill a replacement", async t => {
  const f = await fixture(t), { client, receipt } = await f.start();
  const duplicate = await f.client(); await assert.rejects(duplicate.attach(receipt, 0), { code: "LEASE_FENCED" });
  f.generation++; const next = await f.client(); await next.attach(receipt, 0);
  await until(() => client.closed);
  await assert.rejects(client.terminate());
  await next.writeInput(1, Buffer.from("increment\n")); await until(() => lines(next).length === 1);
  assert.equal(lines(next)[0].pid, receipt.pid);
  const wrongInstance = await f.client(); await assert.rejects(wrongInstance.attach({ ...receipt, processInstanceId: "wrong" }, 0), { code: "PROCESS_IDENTITY_CHANGED" });
});

test("a delayed old authorizer completion cannot supersede a newer attachment", async t => {
  const f = await fixture(t), { receipt } = await f.start();
  let release, entered = false;
  f.hook = request => request.lease === "lease-1" && request.action === "attach" ? new Promise(resolve => { entered = true; release = resolve; }) : undefined;
  const old = await f.client(); const pending = old.attach(receipt, 0); pending.catch(() => {}); await until(() => entered);
  f.generation++; const current = await f.client(); await current.attach(receipt, 0); release();
  await assert.rejects(pending, { code: "ADMISSION_DENIED" });
  await current.writeInput(1, Buffer.from("read\n")); await until(() => lines(current).length === 1);
});

test("lease expiry and explicit invalidation detach output without ending the child", async t => {
  const f = await fixture(t); f.expiresIn = 100;
  const { client, receipt } = await f.start(); await until(() => client.closed);
  assert.equal(f.supervisor.processes.get("child").exited, false);
  f.expiresIn = 30000; f.generation++; const next = await f.client(); await next.attach(receipt, 0);
  f.denied = true; f.supervisor.invalidateLease("lease-2"); await until(() => next.closed);
  assert.equal(f.supervisor.processes.get("child").exited, false);
});

test("revocation remains authoritative even if a previously approved authorizer returns late", async t => {
  const f = await fixture(t), { receipt } = await f.start();
  f.generation++;
  let release, entered = false;
  f.supervisor.authorize = async () => {
    const previouslyApproved = { id: "lease-2", generation: 2, expiresAt: Date.now() + 30000 };
    await new Promise(resolve => { release = resolve; entered = true; }); return previouslyApproved;
  };
  const next = await f.client(); const pending = next.attach(receipt, 0); pending.catch(() => {}); await until(() => entered);
  f.supervisor.invalidateLease("lease-2"); release();
  await assert.rejects(pending, { code: "ADMISSION_DENIED" });
});

test("bounded spool backpressures a verbose process without dropping output and explicit terminate is separate", async t => {
  const f = await fixture(t, { maxSpoolBytes: 1024 });
  const { client, receipt } = await f.start(`process.stdout.write('x'.repeat(65536)); setInterval(()=>{},1000);`);
  await until(() => f.supervisor.processes.get("child").blocked);
  assert.equal((await client.status()).outputSpoolBytes, 1024);
  client.disconnect(); f.generation++; const next = await f.client(); await next.attach(receipt, 0);
  let committed = 0;
  await until(() => next.frames.length > 0);
  for (let i = 0; i < 100 && stdout(next).length < 65536; i++) {
    committed = next.frames.at(-1).seq; await next.ackOutput(committed); await delay(5);
    assert.ok((await next.status()).outputSpoolBytes <= 1024);
  }
  assert.equal(stdout(next), "x".repeat(65536));
  assert.equal((await next.terminate()).state, "exited");
  await next.ackOutput(next.frames.at(-1).seq); await until(() => next.frames.some(frame => frame.channel === "exit"));
});

test("committed output cursors cannot silently rewind or jump ahead", async t => {
  const f = await fixture(t), { client, receipt } = await f.start();
  await client.writeInput(1, Buffer.from("read\n")); await until(() => client.frames.length);
  await assert.rejects(client.ackOutput(99), { code: "OUTPUT_CURSOR_INVALID" });
  await client.ackOutput(client.frames.at(-1).seq); client.disconnect(); f.generation++;
  const next = await f.client(); await assert.rejects(next.attach(receipt, 0), { code: "OUTPUT_CURSOR_EXPIRED" });
});

test("launch retry is idempotent and private directory/socket ownership modes are enforced", async t => {
  const f = await fixture(t), { client, receipt } = await f.start();
  assert.equal((await client.launch("child", spec())).processInstanceId, receipt.processInstanceId);
  await assert.rejects(client.launch("child", spec("process.exit()")), { code: "LAUNCH_CONFLICT" });
  assert.equal((await lstat(f.socketPath)).mode & 0o777, 0o600);
  await assert.rejects(new WorkerProcessSupervisor({ socketPath: f.socketPath, expectedIdentity: binding, authorize: () => {} }).listen(), { code: "SOCKET_ALREADY_EXISTS" });
  await chmod(f.directory, 0o755);
  await assert.rejects(f.client(), { code: "PRIVATE_DIRECTORY_REQUIRED" });
  await chmod(f.directory, 0o700); await chmod(f.socketPath, 0o666);
  await assert.rejects(f.client(), { code: "PRIVATE_SOCKET_REQUIRED" }); await chmod(f.socketPath, 0o600);
  const occupied = path.join(f.directory, "do-not-delete"); await writeFile(occupied, "sentinel");
  await assert.rejects(new WorkerProcessSupervisor({ socketPath: occupied, expectedIdentity: binding, authorize: () => {} }).listen(), { code: "SOCKET_ALREADY_EXISTS" });
  assert.equal(await readFile(occupied, "utf8"), "sentinel");
});

test("proven initial anchor spawn failure permits output acknowledgement, a later valid process and clean shutdown", async t => {
  const f = await fixture(t), client = await f.client();
  await assert.rejects(client.launch("missing-cwd", { ...spec(), cwd: path.join(f.directory, "does-not-exist") }), { code: "LAUNCH_FAILED" });
  const receipt = await client.inspect("missing-cwd"); assert.equal(receipt.pid, null); assert.equal(receipt.groupCleanup, "confirmed");
  await client.attach(receipt, 0); await until(() => client.frames.some(frame => frame.channel === "exit"));
  await client.ackOutput(client.frames.at(-1).seq);
  const { client: valid } = await f.start(); await valid.writeInput(1, Buffer.from("read\n")); await until(() => lines(valid).length === 1);
  await valid.terminate(); await until(() => valid.frames.some(frame => frame.channel === "exit")); await valid.ackOutput(valid.frames.at(-1).seq);
  await f.supervisor.close();
});

test("supervisor refuses shutdown while live children or uncommitted output remain", async t => {
  const f = await fixture(t), { client } = await f.start();
  await assert.rejects(f.supervisor.close(), { code: "LIVE_PROCESSES_REQUIRE_EXPLICIT_TERMINATION" });
  await client.terminate(); await until(() => client.frames.some(frame => frame.channel === "exit"));
  await assert.rejects(f.supervisor.close(), { code: "UNCOMMITTED_OUTPUT_REMAINS" });
  await client.ackOutput(client.frames.at(-1).seq);
});

test("explicit termination cleans a TERM-resistant descendant after its command leader has exited", async t => {
  const f = await fixture(t);
  const descendant = `process.on('SIGTERM',()=>{}); process.stdout.write(JSON.stringify({descendant:process.pid})+'\\n'); setInterval(()=>{},1000);`;
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}).unref(); setTimeout(()=>process.exit(0),100);`;
  const { client, receipt } = await f.start(code);
  await until(() => lines(client).length === 1 && f.supervisor.processes.get("child").exited);
  const pid = lines(client)[0].descendant;
  process.kill(pid, 0);
  assert.equal((await client.status()).groupCleanup, "pending");
  assert.notEqual(receipt.groupAnchor.pid, receipt.pid);
  const result = await client.terminate(); assert.equal(result.groupCleanup, "confirmed");
  await until(() => client.frames.some(frame => frame.channel === "exit"));
  let live = false;
  try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); live = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] !== "Z"; } catch {}
  assert.equal(live, false);
});

test("TERM-exiting command cannot prevent escalation against a resistant same-group descendant", async t => {
  const f = await fixture(t);
  const descendant = `process.on('SIGTERM',()=>{}); process.stdout.write(JSON.stringify({descendant:process.pid})+'\\n'); setInterval(()=>{},1000);`;
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  const { client } = await f.start(code); await until(() => lines(client).length === 1);
  assert.equal((await client.terminate()).groupCleanup, "confirmed");
});

test("unexpected anchor exit invalidates signal authority and reports cleanup unconfirmed", async t => {
  const f = await fixture(t), { client, receipt } = await f.start();
  // First close the only command cleanly, so this failure test leaves no child
  // requiring unsafe cleanup after we deliberately destroy its group anchor.
  await client.endInput(1); await until(() => f.supervisor.processes.get("child").exited);
  const entry = f.supervisor.processes.get("child"); process.kill(receipt.groupAnchor.pid, "SIGKILL");
  await until(() => entry.anchorExited);
  await assert.rejects(client.terminate(), { code: "GROUP_CLEANUP_UNCONFIRMED" });
  assert.equal((await client.status()).groupCleanup, "unconfirmed");
  // Fixture-only proof that no owned live process remains, then allow disposal
  // without making production close() erase an unconfirmed cleanup state.
  await until(() => entry.exitRecorded); f.supervisor.acknowledge(entry, entry.outputSeq);
  f.supervisor.processes.delete("child");
});

const ipc = (child, type) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { cleanup(); reject(Error(`Fixture IPC timed out: ${type}`)); }, 5000);
  const onMessage = message => { if (message.type === type) { cleanup(); resolve(message); } };
  const cleanup = () => { clearTimeout(timeout); child.off("message", onMessage); };
  child.on("message", onMessage);
});
test("actual controller process exit leaves worker supervisor and child memory alive for a fresh client", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-worker-daemon-")), socketPath = path.join(directory, "worker.sock");
  const env = { FIXTURE_SOCKET: socketPath, FIXTURE_IDENTITY: JSON.stringify(binding) };
  const daemon = fork(new URL("./fixtures/worker-transport-daemon.mjs", import.meta.url), [], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let client, receipt, daemonClosed = false;
  t.after(async () => {
    client?.disconnect();
    if (!daemonClosed && daemon.connected) { const cleaned = ipc(daemon, "cleaned"); daemon.send({ type: "cleanup" }); await cleaned; }
    daemon.kill(); await rm(directory, { recursive: true, force: true });
  });
  await ipc(daemon, "ready");
  const controller = fork(new URL("./fixtures/worker-transport-controller.mjs", import.meta.url), [], { env: { ...env, FIXTURE_SPEC: JSON.stringify(spec()) }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const output = await ipc(controller, "output"); receipt = output.receipt;
  await new Promise(resolve => controller.exitCode === null ? controller.once("exit", resolve) : resolve());
  const generation = ipc(daemon, "generation"); daemon.send({ type: "generation", generation: 2 }); await generation;
  client = await new WorkerProcessTransport({ socketPath, expectedIdentity: binding, lease: "lease-2" }).connect();
  client.frames = []; client.on("output", frame => client.frames.push(frame)); await client.attach(receipt, 0);
  await until(() => lines(client).length === 1); const original = JSON.parse(output.frame.data);
  assert.deepEqual(lines(client)[0], original);
  await client.writeInput(1, Buffer.from("increment\n")); await client.writeInput(2, Buffer.from("read\n")); await until(() => lines(client).length === 2);
  assert.equal(lines(client)[1].count, 1); assert.equal(lines(client)[1].sentinel, original.sentinel); assert.equal(lines(client)[1].pid, receipt.pid);
  await client.terminate(); await until(() => client.frames.some(frame => frame.channel === "exit")); await client.ackOutput(client.frames.at(-1).seq);
  const closed = ipc(daemon, "closed"); daemon.send({ type: "close" }); await closed; daemonClosed = true; client.disconnect();
});
