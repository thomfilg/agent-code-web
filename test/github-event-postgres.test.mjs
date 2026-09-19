import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { EncryptedRecords, openDatabase } from "../src/database.mjs";
import { ChatStore } from "../src/store.mjs";
import { GitHubEvents } from "../src/github-events.mjs";
import { recordLockKey } from "../src/worker-lease-scope.mjs";
import { eventFixture, eventAccount, eventOwner } from "./fixtures/github-events.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

test("real PostgreSQL GitHub event commits, scope locks, competing claims and restart uncertainty", { timeout: 60000 }, async t => {
  const root = await temporaryDirectory(t, "relay-github-events-pg-"), socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const config = { mode: "embedded", directory: `${root}/database`, port }; let records = await openDatabase(config);
  t.after(() => records.close());
  const f = await eventFixture(t, { records, root }); await f.configure();

  await t.test("two independent CAS writers cannot both update a subscription revision", async () => {
    const state = await f.events.state(f.chat.id), results = await Promise.allSettled([1, 2].map(() => f.events.configure(f.chat.id, {
      repository: "acme/project", number: 7, notifyFailures: true, wakePassing: false, revision: state.revision,
    }, { ownerId: eventOwner })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.code, "CAS_CONFLICT");
    await f.configure();
  });

  await t.test("deferred COMMIT failure publishes neither event nor native delivery grant", async () => {
    await records.pool.query(`CREATE FUNCTION fixture_reject_github_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='github-event-state' THEN RAISE EXCEPTION 'SYNTHETIC PRIVATE COMMIT ERROR'; END IF; RETURN NEW; END $$`);
    await records.pool.query(`CREATE CONSTRAINT TRIGGER fixture_github_commit AFTER INSERT OR UPDATE ON relay_records
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_reject_github_commit()`);
    const before = await f.events.state(f.chat.id);
    try {
      await f.update("failing"); assert.deepEqual(await f.events.state(f.chat.id), before); assert.equal(f.notifications.length, 0);
    } finally { await records.pool.query("DROP TRIGGER fixture_github_commit ON relay_records"); await records.pool.query("DROP FUNCTION fixture_reject_github_commit()"); }
    await f.monitor.refresh(f.chat.id, { force: true }); assert.equal((await f.events.state(f.chat.id)).events.length, 1);
  });

  await t.test("missing account disconnection marker is locked and queued revocation wins before claim", async () => {
    const event = (await f.events.state(f.chat.id)).events[0], blocker = await records.pool.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [recordLockKey("agent-account-disconnection", eventAccount)]);
    const waiting = count => waitFor(async () => Number((await records.pool.query("SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].count) >= count, { timeoutMs: 5000 });
    let revoke, claim;
    try {
      revoke = records.put("agent-account-disconnection", eventAccount, { ownerId: eventOwner }); await waiting(1);
      claim = f.events.claim(f.chat.id, event.id, () => {}); const rejected = assert.rejects(claim, { code: "SCOPE_UNAVAILABLE" });
      await waiting(2); await blocker.query("COMMIT"); await revoke; await rejected;
      assert.equal((await f.events.state(f.chat.id)).events[0].status, "pending");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled([revoke, claim].filter(Boolean)); await records.delete("agent-account-disconnection", eventAccount); }
  });

  await t.test("async transitions, no-CAS writes and externally owned transactions cannot publish authority", async () => {
    const before = await f.events.state(f.chat.id);
    await assert.rejects(records.githubEventTransaction({ chatId: f.chat.id, expectedRevision: before.revision }, async ({ value }) => value), { code: "ASYNC_TRANSITION_FORBIDDEN" });
    await assert.rejects(records.githubEventTransaction({ chatId: f.chat.id }, ({ value }) => value), { code: "INVALID_TRANSITION" });
    const client = await records.pool.connect(); await client.query("BEGIN");
    try { await assert.rejects(new EncryptedRecords({ pool: client, cipher: records.cipher }).githubEventTransaction({ chatId: f.chat.id }, () => {}), { code: "COMMIT_OWNERSHIP_REQUIRED" }); }
    finally { await client.query("ROLLBACK"); client.release(); }
    assert.deepEqual(await f.events.state(f.chat.id), before);
  });

  await t.test("dedicated PostgreSQL session ownership excludes recovery contenders and fences released holders", async () => {
    const contender = new GitHubEvents({ records, store: f.store, github: f.github, monitor: f.monitor, isLegacy: () => true });
    assert.equal(await contender.initialize(), false);
    const old = f.events.controller;
    await old.release(); assert.equal(await contender.initialize(), true);
    await assert.rejects(records.githubEventTransaction({ chatId: f.chat.id, controller: old }, () => {}), { code: "CONTROLLER_FENCED" });
    records.assertGitHubEventController(contender.controller);
    await contender.stop(); f.events.controller = null; assert.equal(await f.events.initialize(), true);
  });

  await t.test("logout queued before a blocked consent transaction denies the write at its durable boundary", async () => {
    const session = { kind: "browser-user-session", id: "c".repeat(64), ownerId: eventOwner };
    await records.put(session.kind, session.id, { id: session.id, ownerId: session.ownerId, expiresAt: Date.now() + 60000 });
    const before = await f.events.state(f.chat.id), blocker = await records.pool.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [recordLockKey(session.kind, session.id)]);
    const waiting = count => waitFor(async () => Number((await records.pool.query("SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].count) >= count, { timeoutMs: 5000 });
    let logout, update;
    try {
      logout = records.delete(session.kind, session.id); await waiting(1);
      update = f.events.configure(f.chat.id, { repository: "acme/project", number: 7, notifyFailures: false, wakePassing: false, revision: before.revision }, { ownerId: eventOwner, session });
      const rejected = assert.rejects(update, { code: "SESSION_REVOKED" });
      await waiting(2); await blocker.query("COMMIT"); await logout; await rejected;
      assert.deepEqual(await f.events.state(f.chat.id), before);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled([logout, update].filter(Boolean)); }
  });

  await t.test("loss of the exact owned PostgreSQL lock session fences its handle before a replacement dispatcher", async () => {
    const old = f.events.controller;
    const held = (await records.pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND classid=182654783 AND objid=9826341 AND objsubid=2")).rows;
    assert.equal(held.length, 1, "this disposable database has exactly one event dispatcher session");
    await records.pool.query("SELECT pg_terminate_backend($1)", [held[0].pid]);
    await waitFor(() => { try { records.assertGitHubEventController(old); return false; } catch { return true; } });
    await assert.rejects(records.githubEventTransaction({ chatId: f.chat.id, controller: old }, () => {}), { code: "CONTROLLER_FENCED" });
    await old.release().catch(() => {});
    f.events.controller = null; assert.equal(await f.events.initialize(), true);
  });

  await t.test("database reopen preserves a claimed event as uncertain without implicit replay", async () => {
    const event = (await f.events.state(f.chat.id)).events[0]; await f.events.claim(f.chat.id, event.id, () => {});
    const rows = (await records.pool.query("SELECT payload FROM relay_records WHERE kind IN ('github-event-state','github-webhook')")).rows;
    assert(rows.length); for (const row of rows) for (const secret of [eventOwner, "fixture-native", "acme/project"]) assert.equal(row.payload.includes(secret), false);
    await f.monitor.stop(); await f.events.stop(); await records.close(); records = await openDatabase(config);
    const store = new ChatStore(root, records); await store.initialize(); const notified = [];
    const restored = new GitHubEvents({ records, store, github: f.github, monitor: { refresh: async () => {} }, isLegacy: () => true, notify: async (...args) => notified.push(args) });
    await restored.initialize(); await restored.deliverPending(f.chat.id);
    assert.equal((await restored.state(f.chat.id)).events[0].status, "uncertain"); assert.deepEqual(notified, []);
    await restored.stop();
  });
});
