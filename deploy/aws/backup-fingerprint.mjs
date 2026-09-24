// Executed only inside the existing controller image with --network none.
// This imports no Relay server, runtime manager, scheduler or provider client.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";
import { RecordCipher } from "../../src/database.mjs";

const digest = () => createHash("sha256");
export function fingerprintRows(rows, cipher) {
  const records = digest(), attachments = digest();
  let attachmentCount = 0, attachmentBytes = 0, verifiedKey = false;
  for (const row of rows) {
    const value = cipher.open(row.kind, row.id, row.payload);
    if (row.kind === "system" && row.id === "encryption-check") verifiedKey = value?.ok === true;
    records.update(JSON.stringify([row.kind, row.id, row.payload.length])).update(row.payload);
    if (row.kind === "attachment") {
      if (typeof value.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw Error("Invalid attachment");
      const bytes = Buffer.from(value.data, "base64");
      if (bytes.length !== value.size) throw Error("Attachment length mismatch");
      attachments.update(JSON.stringify([row.id, bytes.length])).update(bytes);
      attachmentCount++; attachmentBytes += bytes.length;
    }
  }
  if (!verifiedKey) throw Error("Encryption verification failed");
  return { version: 1, records: rows.length, recordsSha256: records.digest("hex"), attachments: attachmentCount,
    attachmentBytes, attachmentsSha256: attachments.digest("hex"), encryptionVerified: true };
}

export async function fingerprintDatabase({ directory = "/var/lib/relay/control", encryptionKey = process.env.AGENT_ENCRYPTION_KEY, port = 55438 } = {}) {
  process.umask(0o077);
  for (const file of [directory, `${directory}/postgres`, `${directory}/postgres/PG_VERSION`, `${directory}/local-credentials.json`]) {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error("Unsafe database files");
  }
  const credentials = JSON.parse(await readFile(`${directory}/local-credentials.json`, "utf8"));
  const cipher = new RecordCipher(encryptionKey || credentials.encryptionKey);
  const embedded = new EmbeddedPostgres({ databaseDir: `${directory}/postgres`, user: "agent_relay", password: credentials.password,
    port, persistent: true, authMethod: "scram-sha-256", onLog: () => {}, onError: () => {},
    postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=", "-c", "log_statement=none"] });
  let pool, started = false;
  try {
    // Never initialize a missing database or create the encryption sentinel.
    await embedded.start(); started = true;
    pool = new pg.Pool({ host: "127.0.0.1", port, database: "postgres", user: "agent_relay", password: credentials.password,
      max: 1, connectionTimeoutMillis: 10000, statement_timeout: 60000 });
    await pool.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await pool.query("SELECT kind,id,payload FROM relay_records ORDER BY kind COLLATE \"C\",id COLLATE \"C\"");
    const result = fingerprintRows(rows, cipher);
    await pool.query("COMMIT");
    return result;
  } finally { try { await pool?.end(); } finally { if (started) await embedded.stop(); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await fingerprintDatabase())); }
  catch { console.error("Backup database fingerprint failed; private diagnostics suppressed."); process.exitCode = 1; }
}
