import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { openDatabase, EncryptedRecords } from "../src/database.mjs";
import { NativeSessionCheckpoints } from "../src/native-session-checkpoints.mjs";
import { recordLockKey } from "../src/worker-lease-scope.mjs";
import { nativeFixture, nativeBundle, nativeRow } from "./fixtures/native-session.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

test("native journal PostgreSQL transactions own COMMIT, survive reopen and serialize admission revocation", { timeout: 60000 }, async t => {
  const directory = await temporaryDirectory(t, "relay-native-session-pg-"), socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const config = { mode: "embedded", directory, port }; let records = await openDatabase(config);
  t.after(() => records.close()); const fixture = await nativeFixture(records), chat = fixture.chat;
  let service = fixture.service;

  await t.test("two independent service instances compete by durable CAS, and ciphertext survives database reopen", async () => {
    const other = new NativeSessionCheckpoints({ records }), bundle = nativeBundle();
    const writes = await Promise.allSettled([service.save(chat, bundle, 0), other.save(chat, bundle, 0)]);
    assert.equal(writes.filter(result => result.status === "fulfilled").length, 1);
    const raw = (await records.pool.query("SELECT payload FROM relay_records WHERE kind='native-session'")).rows[0].payload;
    for (const privateValue of ["private-opaque-fixture", chat.ownerId, bundle.files[0].data]) assert.equal(raw.includes(privateValue), false);
    await records.close(); records = await openDatabase(config); service = new NativeSessionCheckpoints({ records });
    assert.deepEqual((await service.read(chat)).value.bundle, bundle);
  });

  await t.test("a deferred real COMMIT failure never reports a new durable checkpoint", async () => {
    const previous = await service.read(chat), longer = nativeBundle(nativeRow("event_msg", { type: "task_complete" }));
    await records.pool.query(`CREATE FUNCTION fixture_reject_native_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='native-session' THEN RAISE EXCEPTION 'PRIVATE JOURNAL COMMIT FAILURE'; END IF; RETURN NEW; END $$`);
    await records.pool.query(`CREATE CONSTRAINT TRIGGER fixture_native_commit AFTER INSERT OR UPDATE ON relay_records
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_reject_native_commit()`);
    try {
      await assert.rejects(service.save(chat, longer, previous.revision), error => error.code === "STORAGE_FAILURE" && !error.message.includes("PRIVATE"));
      assert.deepEqual(await service.read(chat), previous);
    } finally {
      await records.pool.query("DROP TRIGGER fixture_native_commit ON relay_records");
      await records.pool.query("DROP FUNCTION fixture_reject_native_commit()");
    }
  });

  await t.test("absent account-revocation marker is locked and queued revoke denies late capture", async () => {
    const before = await service.read(chat), blocker = await records.pool.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [recordLockKey("agent-account-disconnection", chat.agentAccountId)]);
    const waiting = count => waitFor(async () => Number((await records.pool.query("SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].count) >= count, { timeoutMs: 5000 });
    let revoke, capture;
    try {
      revoke = records.put("agent-account-disconnection", chat.agentAccountId, { ownerId: chat.ownerId }); await waiting(1);
      capture = service.save(chat, nativeBundle(), before.revision); const rejected = assert.rejects(capture, { code: "SCOPE_UNAVAILABLE" });
      await waiting(2); await blocker.query("COMMIT"); await revoke; await rejected;
      assert.equal((await records.get("native-session", chat.id)).revision, before.revision);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled([revoke, capture].filter(Boolean)); await records.delete("agent-account-disconnection", chat.agentAccountId); }
  });

  await t.test("scope admission reads durable state, not speculative ChatStore values; async/outer transaction callbacks cannot publish", async () => {
    const before = await service.read(chat), scope = service.scope(chat), client = await records.pool.connect();
    await client.query("BEGIN");
    try {
      const unsafe = new NativeSessionCheckpoints({ records: new EncryptedRecords({ pool: client, cipher: records.cipher }) });
      await assert.rejects(unsafe.save(chat, nativeBundle(), before.revision), { code: "COMMIT_OWNERSHIP_REQUIRED" });
    } finally { await client.query("ROLLBACK"); client.release(); }
    await assert.rejects(records.nativeSessionTransaction({ scope, expectedRevision: before.revision }, async ({ value }) => value), { code: "ASYNC_TRANSITION_FORBIDDEN" });
    await records.put("chat", chat.id, { ...chat, archived: true });
    await assert.rejects(service.save({ ...chat, archived: false }, nativeBundle(), before.revision), { code: "SCOPE_UNAVAILABLE" });
    await records.put("chat", chat.id, chat); assert.deepEqual(await service.read(chat), before);
  });

  await t.test("chat deletion wins before a late captured snapshot and cannot recreate encrypted history", async () => {
    const before = await service.read(chat), blocker = await records.pool.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [recordLockKey("chat", chat.id)]);
    const waiting = count => waitFor(async () => Number((await records.pool.query("SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].count) >= count, { timeoutMs: 5000 });
    let removal, capture;
    try {
      removal = records.delete("chat", chat.id); await waiting(1);
      capture = service.save(chat, nativeBundle(), before.revision); const rejected = assert.rejects(capture, { code: "SCOPE_UNAVAILABLE" });
      await waiting(2); await blocker.query("COMMIT"); await removal; await rejected;
      await records.delete("native-session", chat.id); assert.equal(await records.get("native-session", chat.id), null);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled([removal, capture].filter(Boolean)); }
  });
});
