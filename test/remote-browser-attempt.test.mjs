import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MemoryRecords } from "../src/database.mjs";
import { WorkerSupervisorDaemon } from "../src/worker-supervisor-daemon.mjs";
import { workerSupervisorControl } from "../src/worker-supervisor-control.mjs";
import { WorkerProcessTransport } from "../src/worker-process-transport.mjs";
import { RemoteBrowserAttemptCoordinator } from "../src/remote-browser-attempt.mjs";
import { ReconnectableBrowserProcess } from "../src/reconnectable-browser-process.mjs";
import { BrowserProcess } from "../src/shared-browser.mjs";
import { Ec2Executor } from "../src/worker-backends.mjs";
import { fixtureBoot, leaseIdentity, seedLeaseScope } from "./fixtures/worker-lease-scope.mjs";

const worker = `const readline=require('node:readline'),crypto=require('node:crypto');const sentinel=crypto.randomUUID();let count=0;
const state=()=>({running:true,sentinel,count,pid:process.pid});
process.stdout.write(JSON.stringify({event:'ready',value:state()})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.action==='navigate')count++;process.stdout.write(JSON.stringify({id:request.id,value:state()})+'\\n')});`;
const until = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= deadline) throw Error("Remote browser coordinator fixture timed out"); await delay(5); }
};

test("fresh controller reconstructs the browser facade through the worker daemon and durable authority", async t => {
  const records = new MemoryRecords(); await seedLeaseScope(records);
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-remote-browser-"));
  const processSocket = path.join(root, "process.sock"), controlSocket = path.join(root, "control.sock");
  const daemon = await new WorkerSupervisorDaemon({ root, processSocket, controlSocket }).listen();
  const control = request => workerSupervisorControl(request, { socketPath: controlSocket });
  const connect = async ({ identity, credential }) => new WorkerProcessTransport({ socketPath: processSocket, expectedIdentity: identity, lease: credential }).connect();
  const chat = await records.get("chat", leaseIdentity.chatId), children = [];
  t.after(async () => {
    for (const child of children) child.detach();
    for (const entry of daemon.supervisor?.processes.values() || []) {
      if (!entry.groupCleaned) await daemon.supervisor.terminate(entry);
      await until(() => { daemon.supervisor.acknowledge(entry, entry.outputSeq); daemon.supervisor.drain(entry); return entry.exitRecorded; });
      daemon.supervisor.acknowledge(entry, entry.outputSeq);
    }
    await daemon.close().catch(() => {}); await rm(root, { recursive: true, force: true });
  });
  const coordinator = id => new RemoteBrowserAttemptCoordinator({ records, deploymentId: leaseIdentity.deploymentId,
    workerId: leaseIdentity.workerId, bootId: fixtureBoot, control, connect, controllerId: id, ttlMs: 30000 });
  const context1 = await coordinator("controller-one").open(chat);
  const child1 = new ReconnectableBrowserProcess(context1, 3000, "lifetime-one"); children.push(child1);
  await child1.start({ command: process.execPath, args: ["-e", worker], cwd: os.tmpdir(), env: {} });
  const browser1 = new BrowserProcess(child1); await browser1.ready;
  const first = await browser1.command("navigate", { url: "https://fixture.invalid" });
  assert.equal(first.count, 1);
  clearInterval(browser1.heartbeat); await browser1.heartbeatPending?.catch(() => {});
  await child1.outputQueue; await child1.inputQueue; await child1.storageQueue;
  await until(async () => {
    const ledger = (await records.workerTransportGet(child1.storageRequest)).value;
    return !ledger.input && !ledger.rpcs.length && !ledger.inbox.length && ledger.committedOutputSeq === ledger.appliedOutputSeq;
  });
  const receipt = child1.receipt; child1.detach(); await until(() => child1.detached);

  const context2 = await coordinator("controller-two").open(chat);
  const child2 = new ReconnectableBrowserProcess(context2, 3000, "lifetime-two"); children.push(child2);
  await child2.start({ command: process.execPath, args: ["-e", worker], cwd: os.tmpdir(), env: {} });
  const browser2 = new BrowserProcess(child2), recovered = await browser2.ready;
  assert.equal(child2.recovered, true); assert.deepEqual(child2.receipt, receipt);
  assert.deepEqual({ sentinel: recovered.sentinel, count: recovered.count, pid: recovered.pid }, { sentinel: first.sentinel, count: 1, pid: receipt.pid });
  const second = await browser2.command("navigate", { url: "https://fixture.invalid/again" });
  assert.equal(second.count, 2); assert.equal(second.sentinel, first.sentinel); assert.equal(daemon.supervisor.processes.size, 1);

  await browser2.stop();
  assert.equal((await control({ action: "status" })).configured, false);
});

test("refused remote recovery retains exact-process cleanup for explicit Stop", async t => {
  const records = new MemoryRecords(); await seedLeaseScope(records);
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-remote-cleanup-"));
  const processSocket = path.join(root, "process.sock"), controlSocket = path.join(root, "control.sock");
  const daemon = await new WorkerSupervisorDaemon({ root, processSocket, controlSocket }).listen();
  const control = request => workerSupervisorControl(request, { socketPath: controlSocket });
  const connect = async ({ identity, credential }) => new WorkerProcessTransport({ socketPath: processSocket, expectedIdentity: identity, lease: credential }).connect();
  const chat = await records.get("chat", leaseIdentity.chatId), children = [];
  t.after(async () => {
    for (const child of children) child.detach();
    for (const entry of daemon.supervisor?.processes.values() || []) {
      if (!entry.groupCleaned) await daemon.supervisor.terminate(entry);
      await until(() => { daemon.supervisor.acknowledge(entry, entry.outputSeq); daemon.supervisor.drain(entry); return entry.exitRecorded; });
      daemon.supervisor.acknowledge(entry, entry.outputSeq);
    }
    await daemon.close().catch(() => {}); await rm(root, { recursive: true, force: true });
  });
  const coordinator = id => new RemoteBrowserAttemptCoordinator({ records, deploymentId: leaseIdentity.deploymentId,
    workerId: leaseIdentity.workerId, bootId: fixtureBoot, control, connect, controllerId: id, ttlMs: 30000 });
  const first = new ReconnectableBrowserProcess(await coordinator("controller-one").open(chat), 3000, "lifetime-one"); children.push(first);
  await first.start({ command: process.execPath, args: ["-e", worker], cwd: os.tmpdir(), env: {} });
  await first.outputQueue; await first.storageQueue;
  await first.update(({ value }) => ({ ...value, rpcs: [{ commandId: "unknown-mutation", digest: "a".repeat(64), mutating: true, state: "accepted" }] }));
  const receipt = first.receipt; first.detach(); await until(() => first.detached);

  const recovered = new ReconnectableBrowserProcess(await coordinator("controller-two").open(chat), 3000, "lifetime-two"); children.push(recovered);
  let refusal;
  await assert.rejects(recovered.start({ command: process.execPath, args: ["-e", worker], cwd: os.tmpdir(), env: {} }), error => {
    refusal = error;
    assert.match(error.message, /not at a quiescent recovery boundary/);
    assert.equal(typeof error.retryBrowserCleanup, "function");
    return true;
  });
  assert.deepEqual(recovered.receipt, receipt);
  const retained = await control({ action: "status" });
  assert.equal(retained.processes.length, 1); assert.equal(retained.processes[0].pid, receipt.pid);

  await refusal.retryBrowserCleanup();
  assert.equal((await control({ action: "status" })).configured, false);
  assert.equal(recovered.processClosed, true);
});

test("EC2 executor browser path recovers the worker-owned process after controller replacement", async t => {
  const records = new MemoryRecords(); await seedLeaseScope(records);
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-ec2-browser-"));
  const processSocket = path.join(root, "process.sock"), controlSocket = path.join(root, "control.sock");
  const daemon = await new WorkerSupervisorDaemon({ root, processSocket, controlSocket }).listen();
  const control = request => workerSupervisorControl(request, { socketPath: controlSocket });
  const bridgeSource = `import {bridgeWorkerSupervisor} from ${JSON.stringify(new URL("../src/worker-supervisor-bridge.mjs", import.meta.url).href)};await bridgeWorkerSupervisor({socketPath:${JSON.stringify(processSocket)}});`;
  const savedChat = await records.get("chat", leaseIdentity.chatId);
  const chat = { ...savedChat, repositories: savedChat.repositories.map(repository => ({ ...repository, directory: "acme--project" })), workspace: os.tmpdir() }, children = [];
  t.after(async () => {
    for (const child of children) child.detach();
    for (const entry of daemon.supervisor?.processes.values() || []) {
      if (!entry.groupCleaned) await daemon.supervisor.terminate(entry);
      await until(() => { daemon.supervisor.acknowledge(entry, entry.outputSeq); daemon.supervisor.drain(entry); return entry.exitRecorded; });
      daemon.supervisor.acknowledge(entry, entry.outputSeq);
    }
    await daemon.close().catch(() => {}); await rm(root, { recursive: true, force: true });
  });
  const backend = (controllerId, controllerLifetime) => ({
    store: { records }, controllerId, controllerLifetime, legacyOwnerId: null,
    config: { appRoot: path.resolve(new URL("..", import.meta.url).pathname), ec2: { deployment: leaseIdentity.deploymentId,
      remoteRoot: "/opt/agent-web", remotePath: process.env.PATH, sshBin: process.execPath } },
    sshArgs: () => ["--input-type=module", "-e", bridgeSource],
    sshCapture: async (_host, command, _instanceId, options = {}) => {
      if (command.includes(".workspace-seeded")) return "ready";
      if (command.includes("test -e")) return "ready";
      if (command.includes("systemctl --user is-active")) return "active";
      if (command.includes("worker-supervisor-control.mjs")) return JSON.stringify(await control(JSON.parse(options.input)));
      if (command === "cat /proc/sys/kernel/random/boot_id") return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      return "";
    },
  });
  const instance = { InstanceId: leaseIdentity.workerId, ImageId: "ami-fixture" };
  const create = async (controllerId, lifetime) => {
    const executor = new Ec2Executor({ backend: backend(controllerId, lifetime), chat, instance, host: "10.0.0.42", supervisorAvailable: true });
    await executor.prepare(); return executor;
  };
  const firstExecutor = await create("controller-one", "lifetime-one");
  const firstChild = await firstExecutor.spawnBrowser(process.execPath, ["-e", worker], { cwd: os.tmpdir() }); children.push(firstChild);
  const firstBrowser = new BrowserProcess(firstChild), first = await firstBrowser.ready;
  const advanced = await firstBrowser.command("navigate", { url: "https://fixture.invalid" }); assert.equal(advanced.count, 1);
  clearInterval(firstBrowser.heartbeat); await firstBrowser.heartbeatPending?.catch(() => {});
  await firstChild.outputQueue; await firstChild.inputQueue; await firstChild.storageQueue;
  await until(async () => {
    const ledger = (await records.workerTransportGet(firstChild.storageRequest)).value;
    return !ledger.input && !ledger.rpcs.length && !ledger.inbox.length && ledger.committedOutputSeq === ledger.appliedOutputSeq;
  });
  firstChild.detach(); await until(() => firstChild.detached);

  const secondExecutor = await create("controller-two", "lifetime-two");
  const secondChild = await secondExecutor.spawnBrowser(process.execPath, ["-e", worker], { cwd: os.tmpdir() }); children.push(secondChild);
  const secondBrowser = new BrowserProcess(secondChild), resumed = await secondBrowser.ready;
  assert.equal(secondChild.recovered, true);
  assert.deepEqual({ pid: resumed.pid, sentinel: resumed.sentinel, count: resumed.count }, { pid: first.pid, sentinel: first.sentinel, count: 1 });
  assert.equal((await secondBrowser.command("navigate", { url: "https://fixture.invalid/resumed" })).count, 2);
  await secondBrowser.stop();
  assert.equal((await control({ action: "status" })).configured, false);
});
