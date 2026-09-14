import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

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
    await this.pool.query(`INSERT INTO relay_records(kind,id,payload) VALUES($1,$2,$3)
      ON CONFLICT(kind,id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now()`, [kind, id, this.cipher.seal(kind, id, value)]);
    return structuredClone(value);
  }
  async delete(kind, id) { await this.pool.query("DELETE FROM relay_records WHERE kind=$1 AND id=$2", [kind, id]); }
  async close() { await this.pool.end(); }
}

// Explicitly injected in unit tests; never a fallback when PostgreSQL fails.
export class MemoryRecords {
  constructor() { this.rows = new Map(); this.kind = "memory-test"; }
  async get(kind, id) { return structuredClone(this.rows.get(`${kind}/${id}`) || null); }
  async list(kind) { return [...this.rows.entries()].filter(([k]) => k.startsWith(`${kind}/`)).map(([, v]) => structuredClone(v)); }
  async put(kind, id, value) { this.rows.set(`${kind}/${id}`, structuredClone(value)); return structuredClone(value); }
  async delete(kind, id) { this.rows.delete(`${kind}/${id}`); }
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
