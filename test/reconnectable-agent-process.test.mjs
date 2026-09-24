import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ReconnectableAgentProcess } from "../src/reconnectable-agent-process.mjs";
import { PROTOCOL } from "../src/worker-transport-wire.mjs";

test("a detached native transport reconnects without another agent launch or input replay", async () => {
  const receipt = { protocol: PROTOCOL, supervisorInstanceId: "supervisor-1", processId: "native-agent",
    processInstanceId: "process-1", pid: 4933, startedAt: new Date().toISOString(), groupAnchor: { pid: 4926, start: "1" } };
  let value = null, revision = 0, launches = 0, connections = 0;
  const clients = [];
  class Client extends EventEmitter {
    async launch() { launches++; return receipt; }
    async attach() { return { ...receipt, state: "running", inputAcceptedThrough: 0 }; }
    async inspect() { return { ...receipt, state: "running", inputAcceptedThrough: 0, outputProducedThrough: 0, outputCommittedThrough: 0 }; }
    async status() { return this.inspect(); }
    disconnect() { if (this.closed) return; this.closed = true; this.emit("disconnect"); }
  }
  const context = {
    claim: { attemptId: "attempt-1", controllerId: "controller-1", controllerEpoch: 1 },
    records: {
      workerTransportGet: async () => ({ revision, value: structuredClone(value) }),
      workerTransportTransaction: async (request, decide) => {
        assert.equal(request.expectedRevision, revision);
        value = decide({ value: structuredClone(value) }); revision++;
        return { revision, value: structuredClone(value) };
      },
    },
    issueLease: async () => ({ id: `lease-${clients.length + 1}`, credential: "fixture" }),
    renewLease: async () => {},
    connectTransport: async () => {
      connections++;
      if (connections === 2) throw new Error("transient bridge outage");
      const client = new Client(); clients.push(client); return client;
    },
    retain: () => {},
  };
  const child = new ReconnectableAgentProcess(context, { command: "codex", args: [] }, "lifetime-1");
  await child.ready;
  assert.equal(launches, 1);
  clients[0].disconnect();
  assert.equal(child.detached, true);
  const deadline = Date.now() + 3_000;
  while (child.detached && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(child.detached, false);
  assert.equal(clients.length, 2);
  assert.equal(connections, 3);
  assert.equal(launches, 1);
  assert.equal(child.pid, receipt.pid);
  clearInterval(child.renewal);
  clients[1].disconnect();
  child.stopping = true;
  clearTimeout(child.reconnectTimer);
});
