import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkerProcessSupervisor } from "../src/worker-process-supervisor.mjs";
import { createSshWorkerProcessTransport, SSH_WORKER_SUPERVISOR_BRIDGE } from "../src/ssh-worker-process-transport.mjs";

const identity = Object.freeze({ deploymentId: "fixture", ownerId: "owner", chatId: "chat", workerId: "worker", provider: "codex", accountId: "account", attemptId: "attempt" });
const native = `const readline=require('node:readline');const sentinel=require('node:crypto').randomUUID();let count=0;readline.createInterface({input:process.stdin}).on('line',line=>{if(line==='increment')count++;process.stdout.write(JSON.stringify({pid:process.pid,sentinel,count,line})+'\\n')});`;
const spec = { command: process.execPath, args: ["-e", native], cwd: os.tmpdir(), env: {} };
const until = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw Error("SSH transport fixture timed out"); await delay(5); }
};

test("pinned SSH byte bridge detaches without ending the worker-owned process", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-ssh-process-"));
  const socketPath = path.join(directory, "process.sock"), calls = [], clients = [];
  let generation = 1;
  const supervisor = await new WorkerProcessSupervisor({ socketPath, expectedIdentity: identity, authorize: request => {
    if (request.lease !== `lease-${generation}`) throw Error("PRIVATE");
    return { id: request.lease, generation, expiresAt: Date.now() + 30000 };
  } }).listen();
  const bridgeSource = `import {bridgeWorkerSupervisor} from ${JSON.stringify(new URL("../src/worker-supervisor-bridge.mjs", import.meta.url).href)};await bridgeWorkerSupervisor({socketPath:${JSON.stringify(socketPath)}});`;
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    return spawn(process.execPath, ["--input-type=module", "-e", bridgeSource], options);
  };
  const connect = async () => {
    const client = await createSshWorkerProcessTransport({ sshBin: "ssh-fixture", sshArgs: ["-F", "/dev/null", "worker@10.0.0.2"],
      expectedIdentity: identity, lease: `lease-${generation}`, spawnProcess }).connect();
    client.frames = []; client.on("output", frame => client.frames.push(frame)); clients.push(client); return client;
  };
  t.after(async () => {
    for (const client of clients) client.disconnect();
    for (const entry of supervisor.processes.values()) {
      if (!entry.groupCleaned) await supervisor.terminate(entry);
      await until(() => { supervisor.acknowledge(entry, entry.outputSeq); supervisor.drain(entry); return entry.exitRecorded; });
      supervisor.acknowledge(entry, entry.outputSeq);
    }
    await supervisor.close(); await rm(directory, { recursive: true, force: true });
  });

  const first = await connect(), receipt = await first.launch("shared-chrome", spec); await first.attach(receipt, 0);
  await first.writeInput(1, Buffer.from("increment\n")); await until(() => first.frames.some(frame => frame.channel === "stdout"));
  const original = JSON.parse(first.frames.find(frame => frame.channel === "stdout").data.toString());
  first.disconnect(); await until(() => first.closed);
  assert.equal(supervisor.processes.get("shared-chrome").exited, false);

  generation++;
  const second = await connect(); await second.attach(receipt, 0); await until(() => second.frames.some(frame => frame.channel === "stdout"));
  await second.writeInput(2, Buffer.from("read\n")); await until(() => second.frames.filter(frame => frame.channel === "stdout").length === 2);
  const resumed = JSON.parse(second.frames.filter(frame => frame.channel === "stdout").at(-1).data.toString());
  assert.deepEqual({ pid: resumed.pid, sentinel: resumed.sentinel, count: resumed.count }, { pid: receipt.pid, sentinel: original.sentinel, count: 1 });
  assert.equal(supervisor.processes.size, 1);

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, "ssh-fixture"); assert.equal(call.args.at(-1), SSH_WORKER_SUPERVISOR_BRIDGE);
    const visible = JSON.stringify(call);
    assert.equal(visible.includes("lease-"), false); assert.equal(visible.includes(identity.accountId), false);
  }

  await second.terminate(); await until(() => second.frames.some(frame => frame.channel === "exit"));
  await second.ackOutput(second.frames.at(-1).seq);
});

