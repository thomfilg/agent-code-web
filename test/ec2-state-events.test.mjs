import assert from "node:assert/strict";
import test from "node:test";
import { Ec2StateEventConsumer, parseEc2StateMessage } from "../src/ec2-state-events.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { ChatStore } from "../src/store.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const region = "us-east-2", account = "456808212788", instance = "i-aaaaaaaaaaaaaaaaa";
const id = "11111111-2222-4333-8444-555555555555";
const body = (state = "stopped", target = instance) => JSON.stringify({
  version: "0", id, source: "aws.ec2", account, region, time: "2026-09-24T22:00:00Z",
  "detail-type": "EC2 Instance State-change Notification",
  resources: [`arn:aws:ec2:${region}:${account}:instance/${target}`],
  detail: { "instance-id": target, state },
});

test("EC2 state event requires exact account, region, resource ARN and instance identity", () => {
  assert.deepEqual(parseEc2StateMessage(body(), region), { eventId: id, instanceId: instance,
    state: "stopped", observedAt: "2026-09-24T22:00:00Z", account, region });
  assert.throws(() => parseEc2StateMessage(body().replace('"account":"456808212788"', '"account":"not-an-account"'), region));
  assert.throws(() => parseEc2StateMessage(body().replace("arn:aws:ec2:us-east-2", "arn:aws:ec2:us-west-2"), region));
  assert.throws(() => parseEc2StateMessage(body("Spot eviction"), region));
});

test("EC2 queue ACK follows two durable idempotent commits and never stops the worker", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records);
  await store.initialize();
  const chat = await store.create({ agent: "mock", title: "EC2 event fixture" });
  await store.update(chat.id, { runtimeMetadata: { backend: "ec2", instanceId: instance }, status: "running" });
  const calls = [], runner = async args => { calls.push(args); return "{}"; };
  const consumer = new Ec2StateEventConsumer({ records, store, region, deployment: "agent-relay-mvp", runner });
  consumer.url = `https://sqs.${region}.amazonaws.com/${account}/agent-relay-mvp-worker-state`;
  const message = { Body: body(), ReceiptHandle: "private-receipt" };
  await consumer.consume(message);
  await consumer.consume(message);
  await assert.rejects(consumer.consume({ Body: body().replaceAll(account, "123456789012"), ReceiptHandle: "wrong-account" }), /account does not match/);
  assert.equal((await records.systemEventsSince()).length, 1);
  assert.equal((await records.workerEventsSince(chat.id)).filter(event => event.type === "ec2-instance-state").length, 1);
  assert.equal(store.get(chat.id).status, "running", "an observation is not a worker Stop command");
  assert.equal(calls.filter(args => args[1] === "delete-message").length, 2);
  await consumer.consume({ Body: body("stopped", "i-bbbbbbbbbbbbbbbbb"), ReceiptHandle: "unrelated" });
  assert.equal((await records.systemEventsSince()).length, 1, "unrelated account instances are not retained");
  assert.equal(calls.filter(args => args[1] === "delete-message").length, 3);
  await store.remove(chat.id);
  assert.deepEqual(await records.systemEventsSince(), [], "deleting the chat erases its global EC2 evidence too");
  assert.deepEqual(await records.workerEventsSince(chat.id), []);
});

test("EC2 queue message remains unacknowledged until replay completes after a database fault", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records);
  await store.initialize();
  const chat = await store.create({ agent: "mock", title: "EC2 replay fixture" });
  await store.update(chat.id, { runtimeMetadata: { backend: "ec2", instanceId: instance } });
  const calls = [], runner = async args => { calls.push(args); return "{}"; };
  const consumer = new Ec2StateEventConsumer({ records, store, region, deployment: "agent-relay-mvp", runner });
  consumer.url = `https://sqs.${region}.amazonaws.com/${account}/agent-relay-mvp-worker-state`;
  const append = records.appendWorkerEvent.bind(records); let fail = true;
  records.appendWorkerEvent = (...args) => fail ? Promise.reject(new Error("fixture database outage")) : append(...args);
  const message = { Body: body(), ReceiptHandle: "private-receipt" };
  await assert.rejects(consumer.consume(message), /database outage/);
  assert.equal(calls.filter(args => args[1] === "delete-message").length, 0);
  fail = false; await consumer.consume(message);
  assert.equal((await records.systemEventsSince()).length, 1);
  assert.equal((await records.workerEventsSince(chat.id)).filter(event => event.type === "ec2-instance-state").length, 1);
  assert.equal(calls.filter(args => args[1] === "delete-message").length, 1);
});
