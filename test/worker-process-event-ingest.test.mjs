import test from "node:test";
import assert from "node:assert/strict";
import { ingestWorkerProcessEvents, validWorkerProcessEvent } from "../src/worker-process-event-ingest.mjs";
import { Ec2Executor } from "../src/worker-backends.mjs";

const chatId = `chat_${"a".repeat(32)}`, workerId = "i-0abcdef1234567890";
const event = { schema: 1, source: "worker-supervisor", sourceId: `worker-supervisor:${"b".repeat(64)}`,
  type: "native-process", action: "exited", chatId, workerId, attemptId: "attempt_one", processId: "native-agent",
  processInstanceId: "process_one", supervisorInstanceId: "supervisor_one", observedAt: "2026-09-24T23:00:00Z",
  exit: { code: 137, signal: "SIGKILL" } };

test("worker evidence is committed before ACK and replayed after database failure", async () => {
  const queued = [event], calls = [], committed = new Set(); let fail = true;
  const control = async request => {
    if (request.action === "events") return { events: [...queued] };
    calls.push("ack"); assert.equal(committed.has(request.sourceId), true);
    queued.splice(queued.findIndex(item => item.sourceId === request.sourceId), 1);
    return { acknowledged: true };
  };
  const records = { appendWorkerEvent: async (chat, sourceId) => {
    calls.push("commit"); assert.equal(chat, chatId);
    if (fail) throw new Error("database unavailable");
    committed.add(sourceId);
  } };
  await assert.rejects(ingestWorkerProcessEvents({ chatId, workerId, records, control }), /database unavailable/);
  assert.deepEqual(calls, ["commit"]); assert.equal(queued.length, 1);
  fail = false;
  assert.equal(await ingestWorkerProcessEvents({ chatId, workerId, records, control }), 1);
  assert.deepEqual(calls, ["commit", "commit", "ack"]); assert.equal(queued.length, 0);
});

test("worker evidence from another chat or with unallowlisted content is not committed or ACKed", async () => {
  for (const suspect of [{ ...event, chatId: `chat_${"c".repeat(32)}` }, { ...event, output: "private prompt" }]) {
    let acknowledged = false, committed = false;
    assert.equal(validWorkerProcessEvent(suspect, chatId, workerId), false);
    await assert.rejects(ingestWorkerProcessEvents({ chatId, workerId,
      records: { appendWorkerEvent: async () => { committed = true; } },
      control: async request => { if (request.action === "events") return { events: [suspect] }; acknowledged = true; return { acknowledged: true }; },
    }), /identity is invalid/);
    assert.equal(committed, false); assert.equal(acknowledged, false);
  }
});

test("an unconfirmed anchor loss is retained without claiming the native command exited", () => {
  assert.equal(validWorkerProcessEvent({ ...event, action: "unconfirmed", exit: { code: null, signal: null } }, chatId, workerId), true);
});

test("EC2 executor replays the exact worker outbox through its pinned control transport", async () => {
  const calls = [], pending = [event];
  const backend = { config: { ec2: { remoteRoot: "/opt/agent-web", gatewayOrigin: "https://relay.example.test" } },
    store: { records: { appendWorkerEvent: async (chat, sourceId) => {
      assert.equal(chat, chatId); assert.equal(sourceId, event.sourceId); calls.push("commit");
    } } },
    sshCapture: async (host, command, instanceId, options) => {
      assert.equal(host, "10.0.0.42"); assert.equal(instanceId, workerId);
      assert.match(command, /worker-supervisor-control\.mjs/);
      const request = JSON.parse(options.input);
      if (request.action === "events") return JSON.stringify({ events: [...pending] });
      assert.equal(request.action, "ackEvent"); assert.equal(request.sourceId, event.sourceId);
      calls.push("ack"); pending.length = 0;
      return JSON.stringify({ acknowledged: true });
    } };
  const executor = new Ec2Executor({ backend, chat: { id: chatId }, instance: { InstanceId: workerId, InstanceType: "t3.medium", ImageId: "ami-fixture" },
    host: "10.0.0.42" });
  executor.supervisorEventOutbox = true;
  assert.equal(await executor.flushSupervisorEvents(), 1);
  assert.deepEqual(calls, ["commit", "ack"]);
});
