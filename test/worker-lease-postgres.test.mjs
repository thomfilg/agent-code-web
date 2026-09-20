import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fork } from "node:child_process";
import { once } from "node:events";
import { EncryptedRecords, openDatabase } from "../src/database.mjs";
import { recordLockKey } from "../src/worker-lease-scope.mjs";
import { leaseAuthority, leaseIdentity, leaseRequest, fixtureBoot, seedLeaseScope } from "./fixtures/worker-lease-scope.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

async function controller(records, t) {
  const child = fork(new URL("fixtures/worker-lease-controller.mjs", import.meta.url), [], { env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let seq = 0; const pending = new Map();
  child.on("message", message => { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(Object.assign(Error(message.error), { code: message.error })) : task.resolve(message.result); });
  child.on("exit", () => { for (const task of pending.values()) task.reject(Error("Synthetic controller exited")); pending.clear(); });
  const call = (action, ...args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); child.send({ id, action, args }); });
  const init = new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    const options = records.pool.options;
    child.send({ id, action: "initialize", connection: { host: options.host, port: options.port, user: options.user, password: options.password, database: options.database, max: 2 },
      encryptionKey: records.cipher.key.toString("base64"), deploymentId: leaseIdentity.deploymentId, bootId: fixtureBoot });
  });
  await init;
  const close = async () => { if (child.exitCode !== null) return; const exited = once(child, "exit"); await call("close"); await exited; };
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } });
  return { call, close };
}

test("real PostgreSQL lease authority survives controller/database restart and serializes independent controllers and missing markers", { timeout: 60000 }, async t => {
  const directory = await temporaryDirectory(t, "relay-lease-pg-"), socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const config = { mode: "embedded", directory, port }; let records = await openDatabase(config);
  t.after(() => records.close()); await seedLeaseScope(records);
  let binding, latest, claim;

  await t.test("two real controllers compete by CAS and cannot resurrect a stale claim", async () => {
    const a = await controller(records, t), b = await controller(records, t), c = await controller(records, t);
    binding = await a.call("prepare", leaseIdentity); claim = await a.call("claim", binding, "controller-a");
    const first = await a.call("issue", binding, "controller-a"), row = await records.workerAttemptGet(claim.attemptId);
    const results = await Promise.allSettled([b.call("takeover", binding, "controller-b", { expectedRevision: row.revision }), c.call("takeover", binding, "controller-c", { expectedRevision: row.revision })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    await assert.rejects(a.call("issue", binding, "controller-a"), { code: "CONTROLLER_FENCED" });
    await assert.rejects(a.call("authorize", leaseRequest(first)), { code: "ADMISSION_DENIED" });
    const winner = results.findIndex(result => result.status === "fulfilled");
    latest = await [b, c][winner].call("issue", binding, ["controller-b", "controller-c"][winner]);
    assert.equal(latest.generation, 2); assert.equal(latest.claim.controllerEpoch, 2);
    for (const process of [a, b, c]) await process.close();
    const encrypted = await records.pool.query("SELECT payload FROM relay_worker_state");
    assert.ok(encrypted.rows.length > 0);
    for (const row of encrypted.rows) for (const value of [first.credential, latest.credential, "synthetic-identity", leaseIdentity.ownerId]) assert.equal(row.payload.includes(value), false);
  });

  await t.test("database reopen retains generation; a restarted controller needs explicit takeover and revocation survives another restart", async () => {
    await records.close(); records = await openDatabase(config);
    const d = await controller(records, t);
    assert.equal((await d.call("authorize", leaseRequest(latest))).generation, 2);
    await assert.rejects(d.call("issue", binding, latest.claim.controllerId), { code: "CONTROLLER_FENCED" });
    const row = await records.workerAttemptGet(claim.attemptId);
    await d.call("takeover", binding, "controller-d", { expectedRevision: row.revision });
    const resumed = await d.call("issue", binding, "controller-d"); assert.equal(resumed.generation, 3);
    await assert.rejects(d.call("authorize", leaseRequest(latest)), { code: "ADMISSION_DENIED" });
    await d.call("revoke", binding, resumed.id); await d.close();
    await records.close(); records = await openDatabase(config);
    const e = await controller(records, t);
    await assert.rejects(e.call("authorize", leaseRequest(resumed)), { code: "ADMISSION_DENIED" });
    await assert.rejects(e.call("claim", binding, "controller-e"), { code: "CAS_CONFLICT" });
    assert.equal((await records.workerAttemptGet(claim.attemptId)).value.status, "revoked"); await e.close();
  });

  await t.test("an absent disconnection row is locked: a queued durable revoke wins before issuance can read scope", async () => {
    const authority = leaseAuthority(records), selected = { ...leaseIdentity, attemptId: "marker-race" }, scope = await authority.prepare(selected);
    const holder = await authority.claim(scope, "controller-marker"); await authority.issue(scope, "controller-marker");
    const blocker = await records.pool.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [recordLockKey("agent-account-disconnection", leaseIdentity.accountId)]);
    const waiting = async count => waitFor(async () => Number((await records.pool.query("SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].count) >= count, { timeoutMs: 5000 });
    let revoke, issue;
    try {
      revoke = records.put("agent-account-disconnection", leaseIdentity.accountId, { id: leaseIdentity.accountId, ownerId: leaseIdentity.ownerId });
      await waiting(1); issue = authority.issue(scope, "controller-marker"); const rejected = assert.rejects(issue, { code: "ADMISSION_DENIED" });
      await waiting(2); await blocker.query("COMMIT"); await revoke; await rejected;
      assert.equal((await records.workerAttemptGet(holder.attemptId)).value.generation, 1);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled([revoke, issue].filter(Boolean)); await records.delete("agent-account-disconnection", leaseIdentity.accountId); }
  });

  await t.test("ledger commits are fenced atomically and failed or asynchronous transitions roll back without plaintext storage", async () => {
    const authority = leaseAuthority(records), selected = { ...leaseIdentity, attemptId: "ledger-fixture" }, scope = await authority.prepare(selected);
    await authority.claim(scope, "controller-ledger"); const issued = await authority.issue(scope, "controller-ledger");
    const request = { ...issued.claim, processId: "shared-chrome" };
    const results = await Promise.allSettled([1, 2].map(number => records.workerTransportTransaction({ ...request, expectedRevision: 0 }, () => ({ committedOutputSeq: number, raw: "private-synthetic-frame" }))));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const saved = await records.workerTransportGet(request);
    await assert.rejects(records.workerTransportTransaction({ ...request, expectedRevision: saved.revision }, async () => ({ changed: true })), { code: "ASYNC_TRANSITION_FORBIDDEN" });
    await assert.rejects(records.workerTransportTransaction({ ...request, expectedRevision: saved.revision }, ({ value }) => { value.changed = true; throw Error("synthetic failure"); }));
    assert.deepEqual(await records.workerTransportGet(request), saved);
    const encrypted = await records.pool.query("SELECT payload FROM relay_worker_state WHERE kind='transport'");
    assert.equal(encrypted.rows[0].payload.includes("private-synthetic-frame"), false);
    await authority.revoke(scope, issued.id);
    await assert.rejects(records.workerTransportGet(request), { code: "CONTROLLER_FENCED" });
    await assert.rejects(records.workerTransportTransaction({ ...request, expectedRevision: saved.revision }, () => ({})), { code: "CONTROLLER_FENCED" });
  });

  await t.test("existing outer maintenance transactions retain rollback and can never issue a lease before their own commit", async () => {
    const client = await records.pool.connect(); await client.query("BEGIN");
    const scoped = new EncryptedRecords({ pool: client, cipher: records.cipher });
    const before = await records.get("chat", leaseIdentity.chatId);
    try {
      await scoped.put("chat", leaseIdentity.chatId, { ...before, title: "uncommitted fixture" });
      assert.notEqual((await records.get("chat", leaseIdentity.chatId)).title, "uncommitted fixture");
      const authority = leaseAuthority(scoped), selected = { ...leaseIdentity, attemptId: "outer-transaction" }, binding = await leaseAuthority(records).prepare(selected);
      await assert.rejects(authority.claim(binding, "controller-outer"), { code: "COMMIT_OWNERSHIP_REQUIRED" });
      await client.query("ROLLBACK");
      assert.deepEqual(await records.get("chat", leaseIdentity.chatId), before);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  await t.test("an actual deferred PostgreSQL COMMIT error returns no credential or speculative generation", async () => {
    const authority = leaseAuthority(records), selected = { ...leaseIdentity, attemptId: "commit-failure" }, binding = await authority.prepare(selected);
    const claim = await authority.claim(binding, "controller-commit");
    await records.pool.query(`CREATE FUNCTION fixture_reject_worker_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='attempt' AND NEW.id='${claim.attemptId}' THEN RAISE EXCEPTION 'PRIVATE SYNTHETIC COMMIT FAILURE'; END IF; RETURN NEW; END $$`);
    await records.pool.query(`CREATE CONSTRAINT TRIGGER fixture_worker_commit AFTER INSERT OR UPDATE ON relay_worker_state
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_reject_worker_commit()`);
    try {
      await assert.rejects(authority.issue(binding, "controller-commit"), error => error.code === "STORAGE_FAILURE" && !error.message.includes("PRIVATE"));
      const unchanged = await records.workerAttemptGet(claim.attemptId);
      assert.equal(unchanged.revision, 1); assert.equal(unchanged.value.generation, 0); assert.deepEqual(unchanged.value.leases, {});
    } finally {
      await records.pool.query("DROP TRIGGER fixture_worker_commit ON relay_worker_state");
      await records.pool.query("DROP FUNCTION fixture_reject_worker_commit()");
    }
    assert.equal((await authority.issue(binding, "controller-commit")).generation, 1);
  });
});
