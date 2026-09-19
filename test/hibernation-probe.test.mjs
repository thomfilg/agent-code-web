import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { createHibernationProbe, processStartTicks } from "../deploy/aws/hibernation-probe-worker.mjs";
import { verifyHibernationReceipt } from "../deploy/aws/verify-worker-ami.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const binding = { schema: 2, verificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workerId: "i-aaaaaaaaaaaaaaaaa", imageIdentityHash: "a".repeat(64), continuityChallenge: "b".repeat(64) };
const browser = () => ({ child: { pid: process.pid }, memory: null, stopped: 0, start: async () => {},
  async evaluate(code) { if (code.includes(" = ")) this.memory = JSON.parse(code.split(" = ")[1]); return this.memory; }, async stop() { this.stopped++; } });
function state(socket, challenge, patch = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: "/state", method: "POST", agent: false }, response => {
      let data = ""; response.on("data", chunk => { data += chunk; }); response.on("end", () => resolve({ status: response.statusCode, value: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject); req.end(JSON.stringify({ ...binding, challenge, ...patch }));
  });
}
const audited = value => ({ ...value, configured: true, diskSupported: true });

test("private probe survives independent connections with memory proofs and exact process start identity", async t => {
  const directory = await temporaryDirectory(t), socket = path.join(directory, "probe.sock"), chrome = browser();
  const probe = await createHibernationProbe({ socket, binding, browser: chrome }); t.after(() => probe.close());
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  const first = await state(socket, "1".repeat(64)), second = await state(socket, "2".repeat(64));
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const fresh = audited(first.value), resumed = audited(second.value);
  verifyHibernationReceipt(fresh, null, { binding, challenge: "1".repeat(64) });
  verifyHibernationReceipt(resumed, fresh, { binding, challenge: "2".repeat(64) });
  assert.equal(fresh.nodePid, process.pid); assert.equal(fresh.nodeStartTicks, await processStartTicks(process.pid));
  assert.equal(fresh.continuityProof, resumed.continuityProof); assert.notEqual(fresh.challengeProof, resumed.challengeProof);
  assert.ok(!JSON.stringify(resumed).includes(chrome.memory));
  assert.ok(!JSON.stringify(resumed).includes(binding.continuityChallenge));
  assert.equal(chrome.stopped, 0);
});

test("foreign binding, replay and exhausted bounded challenge ledger cannot advance the probe", async t => {
  const directory = await temporaryDirectory(t), socket = path.join(directory, "probe.sock"), chrome = browser();
  const probe = await createHibernationProbe({ socket, binding, browser: chrome }); t.after(() => probe.close());
  for (const patch of [{ workerId: "i-bbbbbbbbbbbbbbbbb" }, { verificationId: "other" }, { imageIdentityHash: "c".repeat(64) }, { challenge: "not-a-challenge" }]) assert.equal((await state(socket, "1".repeat(64), patch)).status, 409);
  const results = await Promise.all([state(socket, "1".repeat(64)), state(socket, "1".repeat(64))]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  for (let i = 2; i <= 16; i++) assert.equal((await state(socket, i.toString(16).padStart(64, "0"))).status, 200);
  assert.equal((await state(socket, "f".repeat(64))).status, 409);
});

test("same PID with restarted probe, changed process start time or lost browser memory is not continuity", async t => {
  const directory = await temporaryDirectory(t), socket = path.join(directory, "probe.sock");
  let ticks = "100"; const chrome = browser();
  const first = await createHibernationProbe({ socket, binding, browser: chrome, startTicks: async () => ticks });
  const fresh = audited((await state(socket, "1".repeat(64))).value);
  ticks = "200"; assert.equal((await state(socket, "2".repeat(64))).status, 503);
  ticks = "100"; chrome.memory = null; assert.equal((await state(socket, "3".repeat(64))).status, 503);
  await first.close(); assert.equal(chrome.stopped, 1);
  const second = await createHibernationProbe({ socket, binding, browser: browser(), startTicks: async () => "100" }); t.after(() => second.close());
  const restarted = audited((await state(socket, "4".repeat(64))).value);
  assert.equal(restarted.nodePid, fresh.nodePid);
  assert.throws(() => verifyHibernationReceipt({ ...restarted, requests: 2 }, fresh, { binding, challenge: "4".repeat(64) }), /did not survive/);
});

test("probe startup failure closes only its own browser and cannot replace an existing socket", async t => {
  const directory = await temporaryDirectory(t), socket = path.join(directory, "probe.sock"), chrome = browser();
  const first = await createHibernationProbe({ socket, binding, browser: chrome }); t.after(() => first.close());
  const duplicate = browser();
  await assert.rejects(createHibernationProbe({ socket, binding, browser: duplicate }), { code: "EADDRINUSE" });
  assert.equal(duplicate.stopped, 1); assert.equal(chrome.stopped, 0);
  assert.equal((await state(socket, "1".repeat(64))).status, 200);
  const failed = browser(); failed.start = async () => { throw new Error("fixture startup failed"); };
  await assert.rejects(createHibernationProbe({ socket: path.join(directory, "unused.sock"), binding, browser: failed }), /fixture startup/);
  assert.equal(failed.stopped, 1);
});

test("standalone Node probe remains the same process when controller connections and launching output detach", { timeout: 10000 }, async t => {
  const directory = await temporaryDirectory(t), socket = path.join(directory, "process.sock");
  const child = spawn(process.execPath, [new URL("fixtures/hibernation-probe-process.mjs", import.meta.url).pathname, socket, JSON.stringify(binding)], {
    env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } });
  await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Local probe exited before readiness"); })]);
  const first = audited((await state(socket, "1".repeat(64))).value);
  assert.equal(first.nodePid, child.pid);
  child.stdout.destroy(); child.stderr.destroy();
  const resumed = audited((await state(socket, "2".repeat(64))).value);
  verifyHibernationReceipt(resumed, first, { binding, challenge: "2".repeat(64) });
  assert.equal(child.exitCode, null);
});
