import test from "node:test";
import assert from "node:assert/strict";
import { ReconnectableBrowserProcess } from "../src/reconnectable-browser-process.mjs";

// A compare-and-swap ledger with the same contract as the database methods.
function ledger(initial) {
  const row = { revision: 1, value: structuredClone(initial) }, calls = { get: 0, tx: 0, conflicts: 0 };
  const cas = error => Object.assign(new Error("Worker lease: CAS_CONFLICT"), { code: "CAS_CONFLICT", error });
  return { row, calls,
    async workerTransportGet() { calls.get++; return structuredClone(row); },
    async workerTransportTransaction({ expectedRevision }, decide) {
      calls.tx++;
      if (expectedRevision !== row.revision) { calls.conflicts++; throw cas(); }
      const value = decide({ revision: row.revision, value: structuredClone(row.value) });
      if (value === undefined) return structuredClone(row);
      row.revision++; row.value = structuredClone(value); return structuredClone(row);
    } };
}
const state = () => ({ schema: 2, state: "running", nextInputSeq: 1, input: null, rpcs: [], committedOutputSeq: 0, appliedOutputSeq: 0, inbox: [] });
function browser(records) {
  const context = { records, claim: { attemptId: "attempt", controllerId: "controller", controllerEpoch: 1 } };
  return new ReconnectableBrowserProcess(context, 3000, "lifetime");
}
const chunk = (seq, text, channel = "stdout") => ({ seq, channel, data: Buffer.from(text) });

test("ledger writes reuse the last revision and fall back to a read only on conflict", async () => {
  const records = ledger(state()), child = browser(records);
  for (let i = 0; i < 5; i++) await child.update(({ value }) => ({ ...value, nextInputSeq: value.nextInputSeq + 1 }));
  assert.equal(records.calls.get, 1, "only the first write reads the row");
  assert.equal(records.row.value.nextInputSeq, 6);
  records.row.revision += 7; // another writer changed the row
  await child.update(({ value }) => ({ ...value, nextInputSeq: value.nextInputSeq + 1 }));
  assert.equal(records.calls.conflicts, 1); assert.equal(records.calls.get, 2);
  assert.equal(records.row.value.nextInputSeq, 7);
  await assert.rejects(child.update(() => { throw new Error("transition refused"); }), /transition refused/);
});

test("queued output is committed as one batch before delivery, keeps no payload and is applied after", async () => {
  const records = ledger(state()), child = browser(records), acks = [];
  const client = { ackOutput: async seq => { acks.push(seq); } };
  let delivered = "";
  child.stdout.on("data", data => {
    delivered += data;
    // Delivery happens only after the batch is committed, never before.
    assert.equal(records.row.value.committedOutputSeq, 3);
  });
  child.pendingOutput.push(...[chunk(1, "{\"a\":"), chunk(2, "1}\n"), chunk(3, "{\"b\":2}\n")].map(frame => ({ frame, client })));
  const writes = records.calls.tx;
  await child.drainOutput();
  assert.equal(delivered, "{\"a\":1}\n{\"b\":2}\n");
  assert.equal(records.calls.tx - writes, 2, "one commit and one apply for the whole batch");
  assert.deepEqual(acks, [3]);
  assert.equal(records.row.value.appliedOutputSeq, 3); assert.deepEqual(records.row.value.inbox, []);

  // A commit that fails midway never leaves payload bytes in the ledger.
  const bad = [chunk(4, "x"), chunk(6, "y")].map(frame => ({ frame, client }));
  child.pendingOutput.push(...bad);
  await assert.rejects(child.drainOutput(), /unexpected output sequence/);
  assert.equal(records.row.value.committedOutputSeq, 3);
  assert.ok(!JSON.stringify(records.row.value).includes("\"data\""));
});

test("committed output keeps only sequence metadata while it waits to be applied", async () => {
  const records = ledger(state()), child = browser(records);
  let seen;
  child.stdout.on("data", () => { seen = structuredClone(records.row.value.inbox); });
  child.pendingOutput.push({ frame: chunk(1, "secret page text\n"), client: { ackOutput: async () => {} } });
  await child.drainOutput();
  assert.deepEqual(seen, [{ seq: 1, channel: "stdout", bytes: 17 }]);
});

test("a reconnectable browser never delivers CDP events before the reply that precedes them", async () => {
  const { PassThrough } = await import("node:stream");
  const { EventEmitter } = await import("node:events");
  const { BrowserProcess } = await import("../src/shared-browser.mjs");
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: Object.assign(new EventEmitter(), { write() {} }),
    // The durable ledger acknowledges replies later than the next lines arrive.
    commandSettled: () => new Promise(resolve => setTimeout(resolve, 30)), sendCommand: async () => {} });
  const browser = new BrowserProcess(child);
  browser.resolveReady({}); clearTimeout(browser.timer);
  const order = [];
  browser.on("projection", value => order.push(`event:${value.method}`));
  const reply = browser.dispatch("project", {}, { onResponse: () => order.push("reply") });
  child.stdout.write(`${JSON.stringify({ id: 1, value: { ok: true } })}\n${JSON.stringify({ event: "projection", value: { method: "Page.lifecycleEvent" } })}\n`);
  await reply;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(order, ["reply", "event:Page.lifecycleEvent"]);
  browser.fail(new Error("done"));
});

test("large projection commands such as Playwright's injected script are sent in bounded chunks", async () => {
  const records = ledger(state()), child = browser(records), written = [];
  child.detached = false;
  child.client = { writeInput: async (seq, data) => { written.push({ seq, bytes: data.length }); } };
  const packet = { id: 7, action: "project", params: { operation: "command", method: "Runtime.evaluate", params: { expression: "x".repeat(340 * 1024) } } };
  await child.sendCommand(packet);
  const total = Buffer.byteLength(JSON.stringify(packet) + "\n");
  assert.equal(written.reduce((sum, item) => sum + item.bytes, 0), total);
  assert.ok(written.length > 1 && written.every(item => item.bytes <= 16 * 1024));
  assert.deepEqual(written.map(item => item.seq), written.map((_, index) => index + 1));
  assert.equal(records.row.value.input, null, "the chunked command settles its reservation");
  await assert.rejects(child.sendCommand({ id: 8, action: "project", params: { expression: "x".repeat(1100 * 1024) } }), /private input bound/);
});
