import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkerSupervisorDaemon } from "../src/worker-supervisor-daemon.mjs";
import { workerSupervisorControl } from "../src/worker-supervisor-control.mjs";
import { WorkerProcessTransport } from "../src/worker-process-transport.mjs";

const selected = Object.freeze({ deploymentId: "fixture", ownerId: "owner", chatId: "chat", workerId: "worker", provider: "claude", accountId: "account", attemptId: "attempt" });
const spec = { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: os.tmpdir(), env: {} };
const credential = number => Buffer.alloc(32, number).toString("base64url");
const until = async (predicate, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw Error("Supervisor daemon fixture timed out"); await delay(5); }
};

test("worker daemon owns exact identity and leases while controller transports come and go", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-supervisor-daemon-"));
  const processSocket = path.join(root, "process.sock"), controlSocket = path.join(root, "control.sock"), clients = [];
  const daemon = await new WorkerSupervisorDaemon({ root, processSocket, controlSocket }).listen();
  const control = request => workerSupervisorControl(request, { socketPath: controlSocket });
  t.after(async () => {
    for (const client of clients) client.disconnect();
    for (const entry of daemon.supervisor?.processes.values() || []) {
      if (!entry.groupCleaned) await daemon.supervisor.terminate(entry);
      await until(() => { daemon.supervisor.acknowledge(entry, entry.outputSeq); daemon.supervisor.drain(entry); return entry.exitRecorded; });
      daemon.supervisor.acknowledge(entry, entry.outputSeq);
    }
    await daemon.close().catch(() => {}); await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual((await control({ action: "status" })).configured, false);
  const lease1 = { id: "lease-one", generation: 1, expiresAt: Date.now() + 30000, credential: credential(1) };
  const configured = await control({ action: "configure", identity: selected, lease: lease1 });
  assert.equal(configured.configured, true); assert.equal(configured.lease.id, lease1.id);
  assert.equal(JSON.stringify(configured).includes(lease1.credential), false);
  await assert.rejects(control({ action: "configure", identity: { ...selected, accountId: "foreign" }, lease: lease1 }), { code: "IDENTITY_CHANGED" });

  const connect = async lease => {
    const client = await new WorkerProcessTransport({ socketPath: processSocket, expectedIdentity: selected, lease }).connect();
    client.frames = []; client.on("output", frame => client.frames.push(frame)); clients.push(client); return client;
  };
  const first = await connect(lease1.credential), receipt = await first.launch("shared-chrome", spec); await first.attach(receipt, 0);
  first.disconnect(); await until(() => first.closed);

  const lease2 = { id: "lease-two", generation: 2, expiresAt: Date.now() + 30000, credential: credential(2) };
  await control({ action: "configure", identity: selected, lease: lease2 });
  const second = await connect(lease2.credential); await second.attach(receipt, 0);
  assert.equal((await second.status()).pid, receipt.pid);
  await assert.rejects(control({ action: "reset" }), { code: "SUPERVISOR_BUSY" });
  await control({ action: "invalidate", leaseId: lease2.id }); await until(() => second.closed);
  const denied = await connect(lease2.credential); await assert.rejects(denied.inspect("shared-chrome"), { code: "ADMISSION_DENIED" });

  const lease3 = { id: "lease-three", generation: 3, expiresAt: Date.now() + 30000, credential: credential(3) };
  await control({ action: "configure", identity: selected, lease: lease3 });
  const third = await connect(lease3.credential); await third.attach(receipt, 0); await third.terminate();
  await until(() => third.frames.some(frame => frame.channel === "exit")); await third.ackOutput(third.frames.at(-1).seq); third.disconnect();
  assert.deepEqual(await control({ action: "reset" }), { reset: true });
  assert.equal((await control({ action: "status" })).configured, false);
});

test("a duplicate daemon never unlinks a live daemon's private sockets", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-supervisor-duplicate-"));
  const processSocket = path.join(root, "process.sock"), controlSocket = path.join(root, "control.sock");
  const daemon = await new WorkerSupervisorDaemon({ root, processSocket, controlSocket }).listen();
  t.after(async () => { await daemon.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(new WorkerSupervisorDaemon({ root, processSocket, controlSocket }).listen(), { code: "SOCKET_ALREADY_EXISTS" });
  assert.equal((await workerSupervisorControl({ action: "status" }, { socketPath: controlSocket })).configured, false);
});

