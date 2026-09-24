import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerProcessEventOutbox } from "../src/worker-process-event-outbox.mjs";

const selected = { chatId: "chat_fixture", workerId: "i-0abcdef1234567890", attemptId: "attempt_fixture" };
const receipt = { processId: "native-agent", processInstanceId: "process_fixture", supervisorInstanceId: "supervisor_fixture",
  exit: { code: 137, signal: "SIGKILL" } };

test("worker exit evidence survives daemon replacement and is removed only after explicit acknowledgement", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-worker-event-outbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "events"), first = new WorkerProcessEventOutbox(directory).initialize();
  const started = first.record("started", selected, receipt);
  const exited = first.record("exited", selected, receipt);
  assert.notEqual(started.sourceId, exited.sourceId);
  assert.deepEqual(exited.exit, { code: 137, signal: "SIGKILL" });
  assert.equal(first.record("exited", selected, receipt).sourceId, exited.sourceId);
  const raw = await readFile(path.join(directory, `${exited.sourceId.split(":")[1]}.json`), "utf8");
  assert.doesNotMatch(raw, /credential|command|environment|stdout|stderr/i);
  const replacement = new WorkerProcessEventOutbox(directory).initialize();
  assert.equal(replacement.list().length, 2);
  assert.equal(replacement.acknowledge(exited.sourceId), true);
  assert.equal(replacement.acknowledge(exited.sourceId), false);
  assert.deepEqual(replacement.list().map(item => item.action), ["started"]);
});

test("worker process event outbox rejects symlink evidence", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-worker-event-outbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "events"), outbox = new WorkerProcessEventOutbox(directory).initialize();
  const sourceId = outbox.record("exited", selected, receipt).sourceId;
  const filename = path.join(directory, `${sourceId.split(":")[1]}.json`);
  await rm(filename); await symlink(path.join(root, "not-an-event"), filename);
  assert.throws(() => outbox.list(), /Unsafe worker process event file/);
});

test("an anchor-only loss is recorded as unconfirmed, not a proven agent exit", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-worker-event-outbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outbox = new WorkerProcessEventOutbox(path.join(root, "events")).initialize();
  const uncertain = outbox.record("unconfirmed", selected, { ...receipt, exit: { code: null, signal: null } });
  assert.equal(uncertain.action, "unconfirmed");
  assert.deepEqual(uncertain.exit, { code: null, signal: null });
  assert.equal(outbox.list()[0].action, "unconfirmed");
});
