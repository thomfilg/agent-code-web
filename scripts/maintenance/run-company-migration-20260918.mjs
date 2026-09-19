// Runs only as stdin in the offline, network-disabled maintenance container.
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { openDatabase, EncryptedRecords } from "/app/src/database.mjs";
import { targets, migrationPlan, applyMigrationPlan } from "./company-migration-20260918.mjs";

process.umask(0o077);
const root = "/var/lib/relay", chatDirectory = `${root}/state/chats/${targets.chat}`;
const archive = `${root}/maintenance/${targets.receipt}`;
let database, client, moved = false, committed = false, commitAttempted = false;
try {
  for (const directory of [root, `${root}/control`, `${root}/state`, `${root}/state/chats`, chatDirectory]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Unsafe maintenance path");
  }
  if ((await readFile(`${root}/control/postgres/PG_VERSION`, "utf8")).trim() !== "17") throw new Error("Unexpected database version");
  await lstat(`${root}/control/local-credentials.json`);
  database = await openDatabase({ mode: "embedded", directory: `${root}/control`, port: 55438, encryptionKey: process.env.AGENT_ENCRYPTION_KEY || "" });
  client = await database.pool.connect();
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  const records = new EncryptedRecords({ pool: client, cipher: database.cipher });
  const plan = await migrationPlan(records);
  const before = (await client.query("SELECT kind,id,payload FROM relay_records ORDER BY kind,id")).rows;
  const allowed = new Set([...plan.writes, ...plan.deletes, { kind: "maintenance", id: targets.receipt }].map(row => `${row.kind}/${row.id}`));
  await mkdir(`${root}/maintenance`, { mode: 0o700, recursive: true });
  const backupRoot = await lstat(`${root}/maintenance`);
  if (!backupRoot.isDirectory() || backupRoot.isSymbolicLink() || backupRoot.mode & 0o077 || await realpath(`${root}/maintenance`) !== `${root}/maintenance`) throw new Error("Unsafe backup directory");
  await mkdir(archive, { mode: 0o700 });
  // An encrypted-record rollback receipt, never plaintext account credentials.
  await writeFile(`${archive}/records.json`, JSON.stringify(before.filter(row => allowed.has(`${row.kind}/${row.id}`))
    .map(row => ({ kind: row.kind, id: row.id, payload: row.payload.toString("base64") }))), { flag: "wx", mode: 0o600 });
  await rename(chatDirectory, `${archive}/chat`); moved = true;
  await applyMigrationPlan(records, plan);
  for (const row of plan.writes) if (!isDeepStrictEqual(await records.get(row.kind, row.id), row.value)) throw new Error("Migration write verification failed");
  for (const row of plan.deletes) if (await records.get(row.kind, row.id)) throw new Error("Deletion verification failed");
  const after = (await client.query("SELECT kind,id,payload FROM relay_records ORDER BY kind,id")).rows;
  const untouched = rows => rows.filter(row => !allowed.has(`${row.kind}/${row.id}`));
  if (!isDeepStrictEqual(untouched(before), untouched(after))) throw new Error("Unrelated records changed");
  commitAttempted = true; await client.query("COMMIT"); committed = true;
  console.log(JSON.stringify({ ok: true, ...plan.summary, unrelatedRecordsPreserved: true, recoveryArchive: archive }));
} catch {
  if (!committed && !commitAttempted) {
    await client?.query("ROLLBACK").catch(() => {});
    if (moved) await rename(`${archive}/chat`, chatDirectory);
  }
  console.log(JSON.stringify({ ok: false, error: "Offline migration failed; private diagnostics suppressed", commitAttempted, committed }));
  process.exitCode = 1;
} finally {
  client?.release(); await database?.close();
}
