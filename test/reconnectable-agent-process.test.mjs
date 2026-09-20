import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { MemoryRecords } from "../src/database.mjs";
import { ReconnectableAgentProcess } from "../src/reconnectable-agent-process.mjs";
import { ReconnectableBrowserProcess } from "../src/reconnectable-browser-process.mjs";
import { RemoteBrowserAttemptCoordinator } from "../src/remote-browser-attempt.mjs";
import { BrowserProcess } from "../src/shared-browser.mjs";
import { WorkerProcessTransport } from "../src/worker-process-transport.mjs";
import { WorkerSupervisorDaemon } from "../src/worker-supervisor-daemon.mjs";
import { workerSupervisorControl } from "../src/worker-supervisor-control.mjs";
import { fixtureBoot, leaseIdentity, seedLeaseScope } from "./fixtures/worker-lease-scope.mjs";

const backgroundSource = `const readline=require('node:readline'),crypto=require('node:crypto');const sentinel=crypto.randomUUID();let count=0;
process.stdout.write(JSON.stringify({type:'server-ready',sentinel,pid:process.pid})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>process.stdout.write(JSON.stringify({type:'server-reply',line,count:++count,sentinel,pid:process.pid})+'\\n'));`;
const source = `const readline=require('node:readline'),crypto=require('node:crypto'),{spawn}=require('node:child_process');const sentinel=crypto.randomUUID();let count=0,buffer='';
const server=spawn(process.execPath,['-e',${JSON.stringify(backgroundSource)}],{stdio:['pipe','pipe','inherit']});server.stdout.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\\n');buffer=lines.pop();for(const line of lines){const event=JSON.parse(line);if(event.type==='server-ready')process.stdout.write(JSON.stringify({type:'ready',sentinel,pid:process.pid,server:event})+'\\n');else process.stdout.write(line+'\\n')}});
readline.createInterface({input:process.stdin}).on('line',line=>{if(line.startsWith('server:'))server.stdin.write(line.slice(7)+'\\n');else process.stdout.write(JSON.stringify({type:'reply',line,count:++count,sentinel,pid:process.pid})+'\\n')});setInterval(()=>{},1000);`;
const browserSource = `const readline=require('node:readline'),crypto=require('node:crypto');const sentinel=crypto.randomUUID();let count=0;const state=()=>({running:true,sentinel,count,pid:process.pid});
process.stdout.write(JSON.stringify({event:'ready',value:state()})+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.action==='navigate')count++;process.stdout.write(JSON.stringify({id:request.id,value:state()})+'\\n')});`;
const until = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= deadline) throw Error("Reconnectable agent fixture timed out"); await delay(5); }
};
const write = (stream, data) => new Promise((resolve, reject) => stream.write(data, error => error ? reject(error) : resolve()));

test("native-agent facade reconnects the same worker process without replaying input and releases it exactly", async t => {
  const records = new MemoryRecords(); await seedLeaseScope(records);
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-remote-agent-"));
  const processSocket = path.join(root, "process.sock"), controlSocket = path.join(root, "control.sock");
  const daemon = await new WorkerSupervisorDaemon({ root, processSocket, controlSocket }).listen();
  const control = request => workerSupervisorControl(request, { socketPath: controlSocket });
  const connect = async ({ identity, credential }) => new WorkerProcessTransport({ socketPath: processSocket, expectedIdentity: identity, lease: credential }).connect();
  t.after(async () => {
    for (const entry of daemon.supervisor?.processes.values() || []) {
      if (!entry.groupCleaned) await daemon.supervisor.terminate(entry).catch(() => {});
      daemon.supervisor.acknowledge(entry, entry.outputSeq);
    }
    await daemon.close().catch(() => {}); await rm(root, { recursive: true, force: true });
  });
  const chat = await records.get("chat", leaseIdentity.chatId);
  const coordinator = new RemoteBrowserAttemptCoordinator({ records, deploymentId: leaseIdentity.deploymentId,
    workerId: leaseIdentity.workerId, bootId: fixtureBoot, control, connect, controllerId: "controller-agent", ttlMs: 30000 });
  const child = new ReconnectableAgentProcess(coordinator.open(chat, "native-agent"), {
    command: process.execPath, args: ["-e", source], cwd: os.tmpdir(), env: {},
  });
  const messages = [];
  createInterface({ input: child.stdout }).on("line", line => messages.push(JSON.parse(line)));
  await child.ready; await until(() => messages.length === 1);
  const first = messages[0], receipt = child.receipt;
  assert.equal(first.pid, receipt.pid); assert.equal(child.pid, receipt.pid);

  await write(child.stdin, "one\n"); await until(() => messages.length === 2);
  assert.deepEqual({ line: messages[1].line, count: messages[1].count, sentinel: messages[1].sentinel }, { line: "one", count: 1, sentinel: first.sentinel });
  await write(child.stdin, "server:before-detach\n"); await until(() => messages.length === 3);
  const server = messages[2];
  assert.deepEqual({ type: server.type, line: server.line, count: server.count, sentinel: server.sentinel, pid: server.pid },
    { type: "server-reply", line: "before-detach", count: 1, sentinel: first.server.sentinel, pid: first.server.pid });
  child.detach(); await until(() => child.detached);
  assert.equal(daemon.supervisor.processes.get("native-agent").exited, false);
  assert.equal(daemon.supervisor.processes.get("native-agent").inputSeq, 2);

  await child.reconnect();
  assert.equal(child.receipt.pid, receipt.pid);
  await write(child.stdin, "two\n"); await until(() => messages.length === 4);
  assert.deepEqual({ line: messages[3].line, count: messages[3].count, sentinel: messages[3].sentinel, pid: messages[3].pid },
    { line: "two", count: 2, sentinel: first.sentinel, pid: first.pid });
  await write(child.stdin, "server:after-reconnect\n"); await until(() => messages.length === 5);
  assert.deepEqual({ type: messages[4].type, line: messages[4].line, count: messages[4].count, sentinel: messages[4].sentinel, pid: messages[4].pid },
    { type: "server-reply", line: "after-reconnect", count: 2, sentinel: server.sentinel, pid: server.pid });
  assert.equal(daemon.supervisor.processes.get("native-agent").inputSeq, 4, "no agent or background-server input was replayed during reconnect");

  const firstBrowserChild = new ReconnectableBrowserProcess(await coordinator.open(chat), 3000, "browser-lifetime-one");
  await firstBrowserChild.start({ command: process.execPath, args: ["-e", browserSource], cwd: os.tmpdir(), env: {} });
  const firstBrowser = new BrowserProcess(firstBrowserChild); await firstBrowser.ready;
  const firstBrowserState = await firstBrowser.command("navigate", { url: "https://fixture.invalid" });
  await firstBrowser.stop();
  let status = await control({ action: "status" });
  assert.equal(status.configured, true); assert.deepEqual(status.processes.map(item => item.processId), ["native-agent"]);
  await write(child.stdin, "three\n"); await until(() => messages.length === 6);
  assert.equal(messages[5].count, 3); assert.equal(messages[5].sentinel, first.sentinel);

  const secondBrowserChild = new ReconnectableBrowserProcess(await coordinator.open(chat), 3000, "browser-lifetime-two");
  await secondBrowserChild.start({ command: process.execPath, args: ["-e", browserSource], cwd: os.tmpdir(), env: {} });
  const secondBrowser = new BrowserProcess(secondBrowserChild), secondBrowserState = await secondBrowser.ready;
  assert.notEqual(secondBrowserChild.receipt.processInstanceId, firstBrowserChild.receipt.processInstanceId);
  assert.notEqual(secondBrowserState.sentinel, firstBrowserState.sentinel);
  await secondBrowser.stop();
  status = await control({ action: "status" });
  assert.equal(status.configured, true); assert.deepEqual(status.processes.map(item => item.processId), ["native-agent"]);

  await child.terminateRemote();
  assert.equal(child.processReleased, true); assert.equal(child.killed, true);
  assert.equal((await control({ action: "status" })).configured, false);
});
