import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { HostEventIngestor } from "../src/host-event-ingest.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

const collector = new URL("../deploy/aws/host-event-collector.py", import.meta.url).pathname;
const id = "b".repeat(64);
function write(outbox, action, timeNano) {
  const event = { Type: "container", Action: action, timeNano,
    Actor: { ID: id, Attributes: { name: "relay", exitCode: "137" } } };
  execFileSync("python3", [collector, "--outbox", outbox, "--stdin"], { input: JSON.stringify(event) + "\n" });
}

test("host sidecar outbox is committed and acknowledged with startup and live event delivery", async t => {
  const outbox = await temporaryDirectory(t), records = new MemoryRecords();
  write(outbox, "die", 1790280000000000000);
  const errors = [], ingestor = await new HostEventIngestor({ directory: outbox, records, onError: error => errors.push(error) }).start();
  t.after(() => ingestor.close());
  assert.deepEqual((await records.systemEventsSince()).map(event => event.action), ["die"]);
  assert.equal((await readdir(outbox)).filter(name => name.endsWith(".json") && !name.startsWith(".")).length, 0);
  write(outbox, "start", 1790280000000000001);
  await waitFor(async () => (await records.systemEventsSince()).length === 2, { timeoutMs: 3000 });
  assert.deepEqual((await records.systemEventsSince()).map(event => event.action), ["die", "start"]);
  assert.deepEqual(errors, []);
});

test("database failure leaves the host evidence on disk for retry", async t => {
  const outbox = await temporaryDirectory(t), records = new MemoryRecords();
  write(outbox, "oom", 1790280000000000000);
  const append = records.appendSystemEvent.bind(records); let unavailable = true;
  records.appendSystemEvent = (...args) => unavailable ? Promise.reject(new Error("fixture database outage")) : append(...args);
  const errors = [], ingestor = await new HostEventIngestor({ directory: outbox, records, onError: error => errors.push(error) }).start();
  t.after(() => ingestor.close());
  assert.equal((await readdir(outbox)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 1);
  assert.equal((await records.systemEventsSince()).length, 0);
  unavailable = false;
  await waitFor(async () => (await records.systemEventsSince()).length === 1, { timeoutMs: 5000 });
  assert.equal((await readdir(outbox)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 0);
  assert.ok(errors.some(error => /database outage/.test(error.message)));
});

test("a missed filesystem wake is recovered by the independent outbox audit", async t => {
  const outbox = await temporaryDirectory(t), records = new MemoryRecords();
  const ingestor = await new HostEventIngestor({ directory: outbox, records, auditIntervalMs: 1000 }).start();
  t.after(() => ingestor.close());
  ingestor.watcher.close(); ingestor.watcher = null;
  write(outbox, "die", 1790280000000000000);
  await waitFor(async () => (await records.systemEventsSince()).length === 1, { timeoutMs: 3000 });
});

test("a Docker snapshot is accepted as an observation, not a claimed cause", async t => {
  const outbox = await temporaryDirectory(t), records = new MemoryRecords();
  const snapshot = { Id: id, State: { Status: "exited", OOMKilled: false, ExitCode: 0,
    StartedAt: "2026-09-24T21:00:00Z", FinishedAt: "2026-09-24T22:00:00Z" } };
  execFileSync("python3", [collector, "--outbox", outbox, "--snapshot-stdin"], { input: JSON.stringify(snapshot) });
  const ingestor = await new HostEventIngestor({ directory: outbox, records }).start();
  t.after(() => ingestor.close());
  assert.deepEqual((await records.systemEventsSince()).map(event => [event.action, event.status]), [["snapshot", "exited"]]);
});
