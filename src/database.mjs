import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { admissionRecordKind, assertAttemptFence, canonical, leaseFailure, recordLockKey, revision, scopeRecords, synchronousTransition, workerTransportKey } from "./worker-lease-scope.mjs";
import { nativeSessionRecords, sessionFailure } from "./native-session-scope.mjs";
import { githubEventRecords, githubEventLockedKind, githubEventNext, webhookId, githubEventFailure, githubEventSessionRecords, assertGitHubEventSession } from "./github-event-scope.mjs";

const admissionSnapshot = values => Object.fromEntries(["chat", "account", "disconnection", "company", "environment"].map((key, index) => [key, values[index]]));
// One dispatcher per database. A session lock (not an open transaction) owns
// crash recovery. Handles are opaque in-process capabilities, never API input.
const eventControllers = new WeakMap();
const eventControllerKeys = [182654783, 9826341];
const eventControllerQuery = `SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
  WHERE l.locktype='advisory' AND l.granted AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=2
  AND l.pid=$3 AND a.backend_start::text=$4) AS held`;
function requireEventController(records, handle) {
  const holder = handle && eventControllers.get(handle);
  if (!holder || holder.records !== records || !holder.active) throw githubEventFailure("CONTROLLER_FENCED");
  return holder;
}
function expectedRevision(actual, expected) { if (!revision(expected) || actual !== expected) throw leaseFailure("CAS_CONFLICT"); }
function attemptId(id) { if (!/^[a-f0-9]{64}$/.test(id || "")) throw leaseFailure("IDENTITY_INVALID"); return id; }
function nextAttempt(previous, next, scope) {
  if (!next || canonical(next.binding?.scope) !== canonical(scope) || previous && canonical(previous.binding) !== canonical(next.binding)) throw leaseFailure("IMMUTABLE_BINDING");
  return next;
}

export class RecordCipher {
  constructor(key) {
    this.key = Buffer.isBuffer(key) ? key : Buffer.from(key, "base64");
    if (this.key.length !== 32) throw new Error("AGENT_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  seal(kind, id, value) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${kind}/${id}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
  }
  open(kind, id, payload) {
    if (payload[0] !== 1) throw new Error("Unsupported encrypted record format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, payload.subarray(1, 13));
    decipher.setAAD(Buffer.from(`${kind}/${id}`));
    decipher.setAuthTag(payload.subarray(13, 29));
    return JSON.parse(Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]).toString());
  }
}

export class EncryptedRecords {
  constructor({ pool, cipher }) { this.pool = pool; this.cipher = cipher; this.kind = "postgresql"; }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS relay_records (
      kind TEXT NOT NULL, id TEXT NOT NULL, payload BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(kind, id))`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS relay_worker_state (
      kind TEXT NOT NULL CHECK(kind IN ('attempt','transport')), id TEXT NOT NULL,
      revision BIGINT NOT NULL CHECK(revision > 0), payload BYTEA NOT NULL,
      PRIMARY KEY(kind,id))`);
    if (!await this.get("system", "encryption-check")) await this.put("system", "encryption-check", { ok: true });
  }
  async get(kind, id) {
    const result = await this.pool.query("SELECT payload FROM relay_records WHERE kind=$1 AND id=$2", [kind, id]);
    return result.rows[0] ? this.cipher.open(kind, id, result.rows[0].payload) : null;
  }
  async list(kind) {
    const result = await this.pool.query("SELECT id, payload FROM relay_records WHERE kind=$1 ORDER BY updated_at", [kind]);
    return result.rows.map(row => this.cipher.open(kind, row.id, row.payload));
  }
  async put(kind, id, value) {
    const write = client => client.query(`INSERT INTO relay_records(kind,id,payload) VALUES($1,$2,$3)
      ON CONFLICT(kind,id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now()`, [kind, id, this.cipher.seal(kind, id, value)]);
    if (admissionRecordKind(kind) || kind === "native-session" || githubEventLockedKind(kind)) await this.#transaction([recordLockKey(kind, id)], write);
    else await write(this.pool);
    return structuredClone(value);
  }
  async delete(kind, id) {
    const remove = client => client.query("DELETE FROM relay_records WHERE kind=$1 AND id=$2", [kind, id]);
    if (admissionRecordKind(kind) || kind === "native-session" || githubEventLockedKind(kind)) await this.#transaction([recordLockKey(kind, id)], remove);
    else await remove(this.pool);
  }
  async #transaction(keys, action, requireCommit = false) {
    // Existing offline maintenance injects an already checked-out client and
    // owns its outer transaction. Never commit/rollback that transaction here.
    // Lease/ledger APIs require ownership of COMMIT before returning a grant.
    if (typeof this.pool.release === "function") {
      if (requireCommit) throw leaseFailure("COMMIT_OWNERSHIP_REQUIRED");
      for (const key of [...new Set(keys)].sort()) await this.pool.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      return action(this.pool);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Stable order, including keys whose rows do not exist yet. The same
      // locks in scope put/delete close the absent-disconnection-marker race.
      for (const key of [...new Set(keys)].sort()) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      const result = await action(client);
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async #workerGet(client, kind, id) {
    const result = await client.query("SELECT revision,payload FROM relay_worker_state WHERE kind=$1 AND id=$2", [kind, id]);
    const row = result.rows[0];
    return row ? { revision: Number(row.revision), value: this.cipher.open(`worker:${kind}`, id, row.payload) } : { revision: 0, value: null };
  }
  async #workerPut(client, kind, id, row, value) {
    const next = row.revision + 1;
    if (!revision(next)) throw leaseFailure("REVISION_EXHAUSTED");
    const payload = this.cipher.seal(`worker:${kind}`, id, value);
    const result = row.revision ? await client.query("UPDATE relay_worker_state SET revision=$3,payload=$4 WHERE kind=$1 AND id=$2 AND revision=$5", [kind, id, next, payload, row.revision])
      : await client.query("INSERT INTO relay_worker_state(kind,id,revision,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [kind, id, next, payload]);
    if (result.rowCount !== 1) throw leaseFailure("CAS_CONFLICT");
    return { revision: next, value: structuredClone(value) };
  }
  async workerAttemptGet(id) { return this.#workerGet(this.pool, "attempt", attemptId(id)); }
  async acquireGitHubEventController() {
    if (typeof this.pool.release === "function") throw githubEventFailure("COMMIT_OWNERSHIP_REQUIRED");
    const client = await this.pool.connect(); let holder;
    try {
      const acquired = (await client.query("SELECT pg_try_advisory_lock($1::integer,$2::integer) AS held", eventControllerKeys)).rows[0].held;
      if (!acquired) { client.release(); return null; }
      const identity = (await client.query("SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
      holder = { records: this, active: true, client, ...identity };
      const lost = () => { holder.active = false; }; client.on("error", lost); client.on("end", lost);
      let released = false;
      const handle = Object.freeze({ release: async () => {
        if (released) return; released = true; holder.active = false;
        try { await client.query("SELECT pg_advisory_unlock($1::integer,$2::integer)", eventControllerKeys); }
        finally { client.removeListener("error", lost); client.removeListener("end", lost); client.release(true); }
      } }); eventControllers.set(handle, holder); return handle;
    } catch (error) { holder && (holder.active = false); client.release(true); throw error; }
  }
  assertGitHubEventController(handle) { requireEventController(this, handle); }
  async githubEventTransaction({ chatId, scope, controller, session, expectedRevision: expected }, transition) {
    return this.#githubTransaction("github-event-state", chatId, [...githubEventRecords(chatId, scope), ...githubEventSessionRecords(session)], expected, transition,
      (next, revision) => githubEventNext(next, chatId, revision), controller, session);
  }
  async githubWebhookTransaction({ deliveryId, expectedRevision: expected }, transition) {
    webhookId(deliveryId);
    return this.#githubTransaction("github-webhook", deliveryId, [], expected, transition, (next, revision) => {
      if (!next || next.id !== deliveryId || !Number.isSafeInteger(revision + 1) || Buffer.byteLength(JSON.stringify(next)) > 4096) throw githubEventFailure("INVALID_TRANSITION");
      return { ...next, revision: revision + 1 };
    });
  }
  async #githubTransaction(kind, id, refs, expected, transition, validate, controller, session) {
    return this.#transaction([...(kind === "github-webhook" ? [recordLockKey("github-webhook-inbox", "capacity")] : []), recordLockKey(kind, id), ...refs.map(([type, key]) => recordLockKey(type, key))], async client => {
      if (controller) {
        const holder = requireEventController(this, controller);
        if (!(await client.query(eventControllerQuery, [...eventControllerKeys, holder.pid, holder.started])).rows[0].held) { holder.active = false; throw githubEventFailure("CONTROLLER_FENCED"); }
      }
      const read = async (type, key) => {
        const result = await client.query("SELECT payload FROM relay_records WHERE kind=$1 AND id=$2", [type, key]);
        return result.rows[0] ? this.cipher.open(type, key, result.rows[0].payload) : null;
      };
      const value = await read(kind, id), revision = value?.revision || 0;
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || revision !== expected)) throw githubEventFailure("CAS_CONFLICT");
      const records = [];
      for (const [type, key] of refs) records.push(await read(type, key));
      assertGitHubEventSession(session, records.at(-1), records[0], Date.now());
      const next = synchronousTransition(transition, { value, revision, records, now: Date.now() });
      if (controller) requireEventController(this, controller);
      if (next === undefined) return { value, revision };
      if (expected === undefined) throw githubEventFailure("INVALID_TRANSITION");
      const updated = validate(next, revision);
      if (kind === "github-webhook" && !value && Number((await client.query("SELECT count(*) AS count FROM relay_records WHERE kind='github-webhook'")).rows[0].count) >= 1000) throw Object.assign(githubEventFailure("WEBHOOK_BACKLOG_FULL"), { statusCode: 503 });
      await client.query(`INSERT INTO relay_records(kind,id,payload) VALUES($1,$2,$3)
        ON CONFLICT(kind,id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now()`, [kind, id, this.cipher.seal(kind, id, updated)]);
      return { value: structuredClone(updated), revision: updated.revision };
    }, true);
  }
  async nativeSessionTransaction({ scope, expectedRevision: expected }, transition) {
    const refs = nativeSessionRecords(scope), id = scope.chatId, kind = "native-session";
    return this.#transaction([recordLockKey(kind, id), ...refs.map(([type, key]) => recordLockKey(type, key))], async client => {
      const read = async (type, key) => {
        const result = await client.query("SELECT payload FROM relay_records WHERE kind=$1 AND id=$2", [type, key]);
        return result.rows[0] ? this.cipher.open(type, key, result.rows[0].payload) : null;
      };
      const previous = await read(kind, id), currentRevision = previous?.revision || 0;
      if (expected !== undefined) expectedRevision(currentRevision, expected);
      const values = [];
      for (const [type, key] of refs) values.push(await read(type, key));
      const now = Number((await client.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);
      const row = { revision: currentRevision, value: previous };
      const next = synchronousTransition(transition, { ...row, records: admissionSnapshot(values), now });
      if (next === undefined) return row;
      if (expected === undefined || !next || next.scope?.chatId !== id || canonical(next.scope) !== canonical(scope)
        || !revision(currentRevision + 1)) throw sessionFailure("INVALID_TRANSITION");
      const value = { ...next, revision: currentRevision + 1 };
      await client.query(`INSERT INTO relay_records(kind,id,payload) VALUES($1,$2,$3)
        ON CONFLICT(kind,id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now()`, [kind, id, this.cipher.seal(kind, id, value)]);
      return { revision: value.revision, value: structuredClone(value) };
    }, true);
  }
  async workerAttemptTransaction({ attemptId: id, expectedRevision: expected, scope }, transition) {
    attemptId(id); const refs = scopeRecords(scope);
    return this.#transaction([recordLockKey("worker-attempt", id), ...refs.map(([kind, key]) => recordLockKey(kind, key))], async client => {
      const row = await this.#workerGet(client, "attempt", id); expectedRevision(row.revision, expected);
      const values = [];
      for (const [kind, key] of refs) {
        const result = await client.query("SELECT payload FROM relay_records WHERE kind=$1 AND id=$2", [kind, key]);
        values.push(result.rows[0] ? this.cipher.open(kind, key, result.rows[0].payload) : null);
      }
      const now = Number((await client.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);
      const value = synchronousTransition(transition, { ...row, records: admissionSnapshot(values), now });
      return value === undefined ? row : this.#workerPut(client, "attempt", id, row, nextAttempt(row.value, value, scope));
    }, true);
  }
  async workerTransportTransaction(request, transition) {
    const { attemptId: id, processId, expectedRevision: expected } = request, key = workerTransportKey(id, processId);
    return this.#transaction([recordLockKey("worker-attempt", id), recordLockKey("worker-transport", key)], async client => {
      const attempt = (await this.#workerGet(client, "attempt", id)).value;
      const now = Number((await client.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);
      assertAttemptFence(attempt, request, now);
      const row = await this.#workerGet(client, "transport", key); expectedRevision(row.revision, expected);
      const value = synchronousTransition(transition, row);
      return value === undefined ? row : this.#workerPut(client, "transport", key, row, value);
    }, true);
  }
  async workerTransportGet(request) {
    const { attemptId: id, processId } = request, key = workerTransportKey(id, processId);
    return this.#transaction([recordLockKey("worker-attempt", id), recordLockKey("worker-transport", key)], async client => {
      const attempt = (await this.#workerGet(client, "attempt", id)).value;
      const now = Number((await client.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);
      assertAttemptFence(attempt, request, now); return this.#workerGet(client, "transport", key);
    }, true);
  }
  async close() { await this.pool.end(); }
}

// Explicitly injected in unit tests; never a fallback when PostgreSQL fails.
export class MemoryRecords {
  constructor() { this.rows = new Map(); this.kind = "memory-test"; this.workerRows = new Map(); this.workerLocks = new Map(); }
  async get(kind, id) { return structuredClone(this.rows.get(`${kind}/${id}`) || null); }
  async list(kind) { return [...this.rows.entries()].filter(([k]) => k.startsWith(`${kind}/`)).map(([, v]) => structuredClone(v)); }
  async put(kind, id, value) {
    const write = () => { this.rows.set(`${kind}/${id}`, structuredClone(value)); return structuredClone(value); };
    return admissionRecordKind(kind) || kind === "native-session" || githubEventLockedKind(kind) ? this.#locked([recordLockKey(kind, id)], write) : write();
  }
  async delete(kind, id) {
    const remove = () => { this.rows.delete(`${kind}/${id}`); };
    return admissionRecordKind(kind) || kind === "native-session" || githubEventLockedKind(kind) ? this.#locked([recordLockKey(kind, id)], remove) : remove();
  }
  async #locked(keys, action) {
    const releases = [];
    try {
      for (const key of [...new Set(keys)].sort()) {
        const prior = this.workerLocks.get(key) || Promise.resolve(); let release;
        const held = new Promise(resolve => { release = resolve; });
        const tail = prior.then(() => held); this.workerLocks.set(key, tail);
        await prior; releases.push(() => { release(); if (this.workerLocks.get(key) === tail) this.workerLocks.delete(key); });
      }
      return await action();
    } finally { for (const release of releases.reverse()) release(); }
  }
  #workerGet(kind, id) { return structuredClone(this.workerRows.get(`${kind}/${id}`) || { revision: 0, value: null }); }
  #workerPut(kind, id, row, value) {
    if (!revision(row.revision + 1)) throw leaseFailure("REVISION_EXHAUSTED");
    const next = { revision: row.revision + 1, value: structuredClone(value) }; this.workerRows.set(`${kind}/${id}`, next); return structuredClone(next);
  }
  async workerAttemptGet(id) { return this.#workerGet("attempt", attemptId(id)); }
  async acquireGitHubEventController() {
    if (this.eventController?.active) return null;
    const holder = { records: this, active: true }; this.eventController = holder;
    const handle = Object.freeze({ release: async () => { holder.active = false; } }); eventControllers.set(handle, holder); return handle;
  }
  assertGitHubEventController(handle) { requireEventController(this, handle); }
  async githubEventTransaction({ chatId, scope, controller, session, expectedRevision: expected }, transition) {
    return this.#githubTransaction("github-event-state", chatId, [...githubEventRecords(chatId, scope), ...githubEventSessionRecords(session)], expected, transition,
      (next, revision) => githubEventNext(next, chatId, revision), controller, session);
  }
  async githubWebhookTransaction({ deliveryId, expectedRevision: expected }, transition) {
    webhookId(deliveryId);
    return this.#githubTransaction("github-webhook", deliveryId, [], expected, transition, (next, revision) => {
      if (!next || next.id !== deliveryId || !Number.isSafeInteger(revision + 1) || Buffer.byteLength(JSON.stringify(next)) > 4096) throw githubEventFailure("INVALID_TRANSITION");
      return { ...next, revision: revision + 1 };
    });
  }
  async #githubTransaction(kind, id, refs, expected, transition, validate, controller, session) {
    return this.#locked([...(kind === "github-webhook" ? [recordLockKey("github-webhook-inbox", "capacity")] : []), recordLockKey(kind, id), ...refs.map(([type, key]) => recordLockKey(type, key))], () => {
      if (controller) requireEventController(this, controller);
      const value = structuredClone(this.rows.get(`${kind}/${id}`) || null), revision = value?.revision || 0;
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || revision !== expected)) throw githubEventFailure("CAS_CONFLICT");
      const records = refs.map(([type, key]) => structuredClone(this.rows.get(`${type}/${key}`) || null));
      assertGitHubEventSession(session, records.at(-1), records[0], Date.now());
      const next = synchronousTransition(transition, { value, revision, records, now: Date.now() });
      if (next === undefined) return { value, revision };
      if (expected === undefined) throw githubEventFailure("INVALID_TRANSITION");
      const updated = validate(next, revision);
      if (kind === "github-webhook" && !value && [...this.rows.keys()].filter(key => key.startsWith("github-webhook/")).length >= 1000) throw Object.assign(githubEventFailure("WEBHOOK_BACKLOG_FULL"), { statusCode: 503 });
      this.rows.set(`${kind}/${id}`, structuredClone(updated));
      return { value: structuredClone(updated), revision: updated.revision };
    });
  }
  async nativeSessionTransaction({ scope, expectedRevision: expected }, transition) {
    const refs = nativeSessionRecords(scope), id = scope.chatId, key = `native-session/${id}`;
    return this.#locked([recordLockKey("native-session", id), ...refs.map(([type, value]) => recordLockKey(type, value))], () => {
      const previous = structuredClone(this.rows.get(key) || null), currentRevision = previous?.revision || 0;
      if (expected !== undefined) expectedRevision(currentRevision, expected);
      const row = { revision: currentRevision, value: previous };
      const values = refs.map(([type, value]) => structuredClone(this.rows.get(`${type}/${value}`) || null));
      const next = synchronousTransition(transition, { ...row, records: admissionSnapshot(values), now: Date.now() });
      if (next === undefined) return row;
      if (expected === undefined || !next || next.scope?.chatId !== id || canonical(next.scope) !== canonical(scope)
        || !revision(currentRevision + 1)) throw sessionFailure("INVALID_TRANSITION");
      const value = { ...next, revision: currentRevision + 1 };
      this.rows.set(key, structuredClone(value)); return { revision: value.revision, value: structuredClone(value) };
    });
  }
  async workerAttemptTransaction({ attemptId: id, expectedRevision: expected, scope }, transition) {
    attemptId(id); const refs = scopeRecords(scope);
    return this.#locked([recordLockKey("worker-attempt", id), ...refs.map(([kind, key]) => recordLockKey(kind, key))], () => {
      const row = this.#workerGet("attempt", id); expectedRevision(row.revision, expected);
      const values = refs.map(([kind, key]) => structuredClone(this.rows.get(`${kind}/${key}`) || null));
      const value = synchronousTransition(transition, { ...row, records: admissionSnapshot(values), now: Date.now() });
      return value === undefined ? row : this.#workerPut("attempt", id, row, nextAttempt(row.value, value, scope));
    });
  }
  async workerTransportTransaction(request, transition) {
    const { attemptId: id, processId, expectedRevision: expected } = request, key = workerTransportKey(id, processId);
    return this.#locked([recordLockKey("worker-attempt", id), recordLockKey("worker-transport", key)], () => {
      assertAttemptFence(this.#workerGet("attempt", id).value, request, Date.now());
      const row = this.#workerGet("transport", key); expectedRevision(row.revision, expected);
      const value = synchronousTransition(transition, row);
      return value === undefined ? row : this.#workerPut("transport", key, row, value);
    });
  }
  async workerTransportGet(request) {
    const { attemptId: id, processId } = request, key = workerTransportKey(id, processId);
    return this.#locked([recordLockKey("worker-attempt", id), recordLockKey("worker-transport", key)], () => {
      assertAttemptFence(this.#workerGet("attempt", id).value, request, Date.now()); return this.#workerGet("transport", key);
    });
  }
  async close() {}
}

export async function openDatabase(config) {
  if (config.mode === "memory") return new MemoryRecords();
  let embedded;
  let connection;
  let key = config.encryptionKey;
  if (config.mode === "embedded") {
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    const secretPath = path.join(config.directory, "local-credentials.json");
    let secrets;
    try { secrets = JSON.parse(await readFile(secretPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      secrets = { encryptionKey: randomBytes(32).toString("base64"), password: randomBytes(32).toString("base64url") };
      await writeFile(secretPath, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
    }
    key ||= secrets.encryptionKey;
    new RecordCipher(key); // Fail before starting PostgreSQL for an invalid key.
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    embedded = new EmbeddedPostgres({
      databaseDir: path.join(config.directory, "postgres"), user: "agent_relay", password: secrets.password,
      port: config.port, persistent: true, authMethod: "scram-sha-256",
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=", "-c", "log_statement=none"],
      onLog: () => {}, onError: () => {},
    });
    let initialized = false;
    try { await access(path.join(config.directory, "postgres", "PG_VERSION")); initialized = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!initialized) {
      // The embedded binary wrapper creates an initdb password file; ensure
      // even that short-lived bootstrap file is owner-readable only.
      const previousMask = process.umask(0o077);
      try { await embedded.initialise(); } finally { process.umask(previousMask); }
    }
    try { await embedded.start(); }
    catch { throw new Error(`Could not start PostgreSQL on port ${config.port}. Check for another running control plane and database-directory permissions.`); }
    connection = { host: "127.0.0.1", port: config.port, database: "postgres", user: "agent_relay", password: secrets.password };
  } else {
    if (!config.url || !key) throw new Error("PostgreSQL requires DATABASE_URL and AGENT_ENCRYPTION_KEY");
    const url = new URL(config.url);
    if (!config.tls && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("Remote PostgreSQL connections require certificate-verified TLS");
    }
    for (const option of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(option);
    connection = { connectionString: url.toString(), ssl: config.tls ? { rejectUnauthorized: true } : false };
  }
  const pool = new pg.Pool({ ...connection, max: 6, connectionTimeoutMillis: 10000 });
  const records = new EncryptedRecords({ pool, cipher: new RecordCipher(key) });
  try { await records.initialize(); }
  catch (error) { await pool.end(); await embedded?.stop(); throw error; }
  let closing;
  records.close = () => closing ||= (async () => { await pool.end(); await embedded?.stop(); })();
  return records;
}
