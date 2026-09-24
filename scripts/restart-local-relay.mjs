#!/usr/bin/env node
// Operator-only Linux bootstrap. Inspection is read-only; --execute is explicit.
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { loadConfig } from "../src/config.mjs";
import { RecordCipher } from "../src/database.mjs";
import { injectedSettings } from "./doppler.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw Object.assign(new Error(`Local restart refused: ${code}. Private diagnostics suppressed.`), { code }); };

export function parseOptions(args) {
  const options = { execute: false, legacyIdleConfirmed: false };
  const names = { "--pid": "pid", "--start-ticks": "startTicks", "--expected-revision": "revision" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--execute") options.execute = true;
    else if (args[i] === "--legacy-idle-confirmed") options.legacyIdleConfirmed = true;
    else if (names[args[i]] && args[i + 1] && !args[i + 1].startsWith("--")) options[names[args[i]]] = args[++i];
    else fail("invalid_arguments");
  }
  if (!/^[1-9][0-9]*$/.test(options.pid || "")) fail("explicit_pid_required");
  if (options.startTicks && !/^[0-9]+$/.test(options.startTicks)) fail("invalid_start_ticks");
  if (options.revision && !/^[a-f0-9]{40}$/.test(options.revision)) fail("invalid_revision");
  if (options.execute && (!options.startTicks || !options.revision)) fail("inspection_receipt_required");
  options.pid = Number(options.pid);
  return options;
}

export async function processIdentity(pid) {
  try {
    const base = `/proc/${pid}`;
    const [info, cwd, executable, raw, status] = await Promise.all([
      stat(base), readlink(`${base}/cwd`), readlink(`${base}/exe`), readFile(`${base}/cmdline`), readFile(`${base}/stat`, "utf8"),
    ]);
    const fields = status.slice(status.lastIndexOf(")") + 2).split(" ");
    return { pid, uid: info.uid, cwd, executable, argv: raw.toString().split("\0").filter(Boolean), startTicks: fields[19] };
  } catch { fail("process_identity_unavailable"); }
}

export function sameIdentity(expected, current) {
  return ["pid", "uid", "cwd", "executable", "startTicks"].every(key => expected[key] === current[key]) &&
    JSON.stringify(expected.argv) === JSON.stringify(current.argv);
}

async function unchanged(identity) {
  if (!sameIdentity(identity, await processIdentity(identity.pid))) fail("process_identity_changed");
}

export async function signalExact(identity) {
  // A pidfd retains the process incarnation across the final check/signal gap;
  // an integer PID plus process.kill cannot provide this guarantee on Linux.
  const helper = `import json,os,signal,sys
e=json.loads(sys.argv[1]); p="/proc/"+str(e["pid"])
fd=os.pidfd_open(e["pid"],0)
try:
 s=open(p+"/stat").read(); ticks=s[s.rfind(")")+2:].split()[19]
 assert ticks==e["startTicks"] and os.stat(p).st_uid==e["uid"]
 assert os.readlink(p+"/cwd")==e["cwd"] and os.readlink(p+"/exe")==e["executable"]
 assert [v.decode() for v in open(p+"/cmdline","rb").read().split(b"\\0") if v]==e["argv"]
 signal.pidfd_send_signal(fd,signal.SIGTERM)
finally: os.close(fd)`;
  try { await exec("python3", ["-c", helper, JSON.stringify(identity)], { timeout: 3000, maxBuffer: 1024 }); }
  catch { fail("exact_signal_refused"); }
}

async function gone(identity) {
  try { await stat(`/proc/${identity.pid}`); } catch (error) { if (error.code === "ENOENT") return true; throw error; }
  // PID reuse is not permission to signal the replacement.
  await unchanged(identity);
  return false;
}

async function children(pid) {
  return (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
}

async function listeners(port) {
  const lines = (await Promise.all(["tcp", "tcp6"].map(name => readFile(`/proc/net/${name}`, "utf8")))).flatMap(text => text.trim().split("\n").slice(1));
  return lines.map(line => line.trim().split(/\s+/)).filter(fields => fields[3] === "0A" && parseInt(fields[1].split(":")[1], 16) === port).map(fields => fields[9]);
}

async function ownsListener(pid, port) {
  const sockets = new Set();
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    try { const match = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`)); if (match) sockets.add(match[1]); } catch {}
  }
  const actual = await listeners(port);
  if (actual.length !== 1 || !sockets.has(actual[0])) fail("listener_owner_mismatch");
}

async function privatePath(filename, directory = false) {
  const info = await lstat(filename);
  if (info.uid !== process.getuid() || (info.mode & 0o077) || (directory ? !info.isDirectory() : !info.isFile()) || await realpath(filename) !== path.resolve(filename)) fail("non_private_or_indirect_path");
}

export function sanitizedEnvironment(input) {
  const settings = injectedSettings(input, "start");
  if (settings.missing.length) fail("missing_loaded_google_settings");
  const env = settings.env;
  // These belong to the old login session, not the detached controller.
  for (const name of ["DBUS_SESSION_BUS_ADDRESS", "DBUS_SESSION_BUS_PID", "GNOME_KEYRING_CONTROL", "GNOME_KEYRING_PID", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "NODE_OPTIONS", "NODE_INSPECT_RESUME_ON_START", "AUTH_DEBUG"]) delete env[name];
  return env;
}

export function inspectRows(rows, cipher) {
  const summary = { chats: 0, busyChats: 0, pendingAccounts: 0, encryptionVerified: false };
  for (const row of rows) {
    const value = cipher.open(row.kind, row.id, row.payload);
    if (row.kind === "chat") {
      summary.chats++;
      if (!["stopped", "error"].includes(value.status) || value.pendingRequest || value.queuedMessages?.length ||
          ["active", "running"].includes(value.goal?.status)) summary.busyChats++;
    }
    if (row.kind === "agent-account" && value.status === "pending") summary.pendingAccounts++;
    if (row.kind === "system" && row.id === "encryption-check") summary.encryptionVerified = value.ok === true;
  }
  if (!summary.encryptionVerified) fail("encryption_check_failed");
  if (summary.busyChats || summary.pendingAccounts) fail("active_work_or_agent_login");
  return summary;
}

async function idleRecords(snapshot) {
  const filename = path.join(snapshot.config.database.directory, "local-credentials.json");
  await privatePath(filename);
  const credentials = JSON.parse(await readFile(filename, "utf8"));
  const client = new pg.Client({ host: "127.0.0.1", port: snapshot.config.database.port, database: "postgres", user: "agent_relay", password: credentials.password,
    connectionTimeoutMillis: 3000, options: "-c default_transaction_read_only=on -c statement_timeout=3000" });
  try {
    await client.connect(); await client.query("BEGIN READ ONLY");
    const rows = (await client.query("SELECT kind,id,payload FROM relay_records WHERE kind IN ('chat','agent-account','system')")).rows;
    const summary = inspectRows(rows, new RecordCipher(snapshot.config.database.encryptionKey || credentials.encryptionKey));
    await client.query("ROLLBACK");
    return summary;
  } finally { await client.end(); }
}

async function revision(root) {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
  const result = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(result)) fail("invalid_source_revision");
  // Unrelated doctor/operator changes do not change the app being launched.
  const { stdout: dirty } = await exec("git", ["status", "--porcelain", "--", "src", "public", "scripts/doppler.mjs", "package.json", "package-lock.json"], { cwd: root });
  if (dirty.trim()) fail("application_source_not_committed");
  return result;
}

async function httpStatus(route, method = "GET") {
  const response = await fetch(`http://127.0.0.1:8787${route}`, { method, signal: AbortSignal.timeout(3000), redirect: "error" });
  await response.body?.cancel();
  return response.status;
}

export async function inspectLocal(options, { root = ROOT } = {}) {
  if (process.platform !== "linux" || !process.getuid()) fail("same_user_linux_only");
  const identity = await processIdentity(options.pid);
  if (identity.uid !== process.getuid() || identity.cwd !== root || identity.executable !== await realpath(process.execPath) || identity.argv.length !== 2 ||
      !["src/server.mjs", path.join(root, "src/server.mjs")].includes(identity.argv[1])) fail("unexpected_server_process");
  if (options.startTicks && options.startTicks !== identity.startTicks) fail("stale_process_receipt");
  const sourceRevision = await revision(root);
  if (options.revision && sourceRevision !== options.revision) fail("source_revision_changed");
  const raw = await readFile(`/proc/${options.pid}/environ`);
  let env;
  try { env = sanitizedEnvironment(Object.fromEntries(raw.toString().split("\0").filter(Boolean).map(entry => { const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)]; }))); }
  finally { raw.fill(0); }
  const config = loadConfig(env);
  const expectedControl = path.join(os.homedir(), ".local/share/agent-code-web");
  if (config.database.mode !== "embedded" || config.database.directory !== expectedControl || config.dataDir !== path.join(root, "data") || config.port !== 8787 || config.host !== "127.0.0.1" || config.google.origin !== "http://localhost:8787") fail("unexpected_local_layout");
  await privatePath(config.database.directory, true);
  // Workspace sources may have normal read permissions; backup itself is private.
  if (await realpath(config.dataDir) !== config.dataDir || !(await lstat(config.dataDir)).isDirectory()) fail("indirect_workspace_path");
  const pgPid = Number((await readFile(path.join(config.database.directory, "postgres/postmaster.pid"), "utf8")).split("\n")[0]);
  const postgres = await processIdentity(pgPid);
  if (postgres.uid !== process.getuid() || path.basename(postgres.executable) !== "postgres" || postgres.argv[postgres.argv.indexOf("-D") + 1] !== path.join(config.database.directory, "postgres") ||
      JSON.stringify(await children(options.pid)) !== JSON.stringify([pgPid])) fail("unexpected_server_children");
  await ownsListener(options.pid, 8787); await ownsListener(pgPid, config.database.port);
  try { await exec("python3", ["-c", "import os,signal; assert hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal')"], { timeout: 3000 }); }
  catch { fail("pidfd_support_required"); }
  const snapshot = { identity, postgres, env, config, revision: sourceRevision };
  snapshot.summary = await idleRecords(snapshot);
  snapshot.legacy = (await httpStatus("/readyz")) === 404;
  await unchanged(identity);
  return snapshot;
}

export function publicInspection(snapshot) {
  return { inspected: true, changesMade: false, pid: snapshot.identity.pid, startTicks: snapshot.identity.startTicks, revision: snapshot.revision,
    ...snapshot.summary, legacyMaintenanceAcknowledgmentRequired: snapshot.legacy,
    warning: snapshot.legacy ? "Old server has no atomic drain: GitHub/MCP OAuth flows are memory-only and cannot be proven absent by this database inspection." : null,
    configurationSource: "Already loaded Doppler code-web/dev environment; not a fresh Doppler fetch", futureDopplerCliReauthenticationMayBeRequired: true };
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do { if (await check()) return; await pause(200); } while (Date.now() < deadline);
  fail("bounded_wait_expired");
}

async function cold(snapshot) {
  if (!await gone(snapshot.identity) || !await gone(snapshot.postgres) || (await listeners(8787)).length || (await listeners(snapshot.config.database.port)).length) fail("source_not_cold");
  try { await stat(path.join(snapshot.config.database.directory, "postgres/postmaster.pid")); fail("postgres_pid_file_remains"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function archive(source, filename) {
  const output = await open(filename, "wx", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("tar", ["--create", "--file=-", "--one-file-system", "--directory", path.dirname(source), "--", path.basename(source)], { stdio: ["ignore", output.fd, "ignore"] });
      child.once("error", () => reject(Error("archive_failed")));
      child.once("close", code => code === 0 ? resolve() : reject(Error("archive_failed")));
    });
    await output.sync();
  } finally { await output.close(); }
}

// Injectable orchestration lets regressions prove that failed checks cannot stop
// the old process, copy a live database, or launch a second controller.
export async function restartWorkflow(options, operations) {
  const snapshot = await operations.inspect(options);
  if (!options.execute) return publicInspection(snapshot);
  if (snapshot.legacy && !options.legacyIdleConfirmed) fail("legacy_maintenance_confirmation_required");
  const state = await operations.reserve(snapshot);
  let stopRequested = false, drained = false;
  try {
    await operations.recheck(snapshot);
    if (!snapshot.legacy) { drained = true; await operations.drain(snapshot); }
    stopRequested = true;
    await operations.stop(snapshot);
    await operations.cold(snapshot);
    await operations.backup(snapshot, state);
    await operations.cold(snapshot);
    return await operations.launch(snapshot, state, false);
  } catch {
    // Only a verified cold source permits recovery. Never kill PG, force-close
    // the old app, or start around an ambiguous listener/process identity.
    if (stopRequested) {
      try { await operations.cleanupLaunch(snapshot, state); await operations.cold(snapshot); return await operations.launch(snapshot, state, true); }
      catch { if (drained) await operations.resume(snapshot).catch(() => {}); fail("restart_failed_manual_recovery_required"); }
    }
    if (drained) await operations.resume(snapshot).catch(() => {});
    fail("restart_aborted_before_verified_stop");
  } finally { await operations.release(state); }
}

export const localOperations = {
  inspect: inspectLocal,
  async reserve(snapshot) {
    const base = path.join(os.homedir(), ".local/share/agent-code-web-restart-backups");
    await mkdir(base, { recursive: true, mode: 0o700 }); await privatePath(base, true);
    const lockPath = path.join(base, "restart.lock"), lock = await open(lockPath, "wx", 0o600);
    try {
      const directory = await mkdtemp(path.join(base, "checkpoint-"));
      const log = await open(path.join(directory, "restart.log"), "wx", 0o600);
      return { directory, log, lock, lockPath, backupComplete: false, child: null };
    } catch (error) { await lock.close(); await unlink(lockPath); throw error; }
  },
  async recheck(snapshot) {
    await unchanged(snapshot.identity); await unchanged(snapshot.postgres);
    if (await revision(ROOT) !== snapshot.revision || JSON.stringify(await children(snapshot.identity.pid)) !== JSON.stringify([snapshot.postgres.pid])) fail("pre_stop_state_changed");
    await ownsListener(snapshot.identity.pid, 8787); await ownsListener(snapshot.postgres.pid, snapshot.config.database.port);
    await idleRecords(snapshot);
  },
  async drain() { if (await httpStatus("/internal/deploy/drain", "POST") !== 200) fail("drain_refused"); },
  async resume(snapshot) { await unchanged(snapshot.identity); await ownsListener(snapshot.identity.pid, 8787); await httpStatus("/internal/deploy/resume", "POST"); },
  async stop(snapshot) {
    await unchanged(snapshot.identity);
    await signalExact(snapshot.identity);
    await waitUntil(() => gone(snapshot.identity), 60000);
    await waitUntil(() => gone(snapshot.postgres), 10000);
  },
  cold,
  async backup(snapshot, state) {
    await state.log.write("Original server and PostgreSQL stopped. Cold checkpoint started.\n");
    for (const [source, name] of [[snapshot.config.database.directory, "controller.tar"], [snapshot.config.dataDir, "workspaces.tar"]]) {
      await cold(snapshot);
      await archive(source, path.join(state.directory, name));
    }
    const manifest = { version: 1, revision: snapshot.revision, sourcePid: snapshot.identity.pid, sourceStartTicks: snapshot.identity.startTicks,
      includesFileBackedEncryptionKey: true, complete: true };
    const output = await open(path.join(state.directory, "manifest.json"), "wx", 0o600);
    try { await output.writeFile(JSON.stringify(manifest)); await output.sync(); } finally { await output.close(); }
    state.backupComplete = true;
    await state.log.write("Cold checkpoint completed. Archives contain private credentials; do not publish.\n");
  },
  async launch(snapshot, state, recovery) {
    // A failed wrapper attempt must have exited completely before direct startup.
    if (state.child) {
      if (!state.childIdentity) fail("unobserved_launch_process");
      if (!await gone(state.childIdentity)) fail("previous_launch_still_alive");
    }
    await cold(snapshot);
    if (await revision(ROOT) !== snapshot.revision) fail("source_revision_changed");
    await state.log.write(recovery ? "Attempting same-environment recovery with current code; not a code rollback.\n" : "Starting current code with captured Doppler settings.\n");
    const args = recovery ? ["src/server.mjs"] : ["scripts/doppler.mjs", "--injected", "start"];
    const child = spawn(snapshot.identity.executable, args, { cwd: ROOT, env: snapshot.env, detached: true, stdio: "ignore" });
    state.child = child;
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(Error("launch_failed"))); });
    child.unref(); state.childIdentity = await processIdentity(child.pid);
    let serverPid;
    await waitUntil(async () => {
      try {
        if (await gone(state.childIdentity)) fail("new_server_exited");
        const candidates = recovery ? [child.pid] : await children(child.pid);
        if (candidates.length !== 1) return false;
        const server = await processIdentity(candidates[0]);
        if (server.cwd !== ROOT || server.executable !== snapshot.identity.executable || server.argv.length !== 2 || server.argv[1] !== "src/server.mjs") return false;
        state.serverIdentity = server;
        await ownsListener(server.pid, 8787);
        if (await httpStatus("/readyz") !== 200) return false;
        serverPid = server.pid;
        return true;
      } catch (error) { if (error.code === "new_server_exited") throw error; return false; }
    }, 45000);
    await state.log.write("Current controller is ready. Raw application output was not recorded.\n");
    return { restarted: true, pid: serverPid, ready: true, recoveryAttempt: recovery, codeRollback: false, backupComplete: state.backupComplete,
      checkpointDirectory: state.directory, configurationSource: "Captured Doppler code-web/dev environment", futureDopplerCliReauthenticationMayBeRequired: true };
  },
  async cleanupLaunch(snapshot, state) {
    if (!state.child) return;
    if (!state.childIdentity) fail("unobserved_launch_process");
    if (!await gone(state.childIdentity)) {
      await unchanged(state.childIdentity);
      await signalExact(state.childIdentity);
      await waitUntil(() => gone(state.childIdentity), 60000);
    }
    if (state.serverIdentity && !await gone(state.serverIdentity)) {
      await unchanged(state.serverIdentity);
      await signalExact(state.serverIdentity);
      await waitUntil(() => gone(state.serverIdentity), 60000);
    }
    await waitUntil(async () => !(await listeners(snapshot.config.database.port)).length, 10000);
    await cold(snapshot);
  },
  async release(state) { await state.log.close(); await state.lock.close(); await unlink(state.lockPath); },
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await restartWorkflow(parseOptions(process.argv.slice(2)), localOperations), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: /^Local restart refused: [a-z_]+\. Private diagnostics suppressed\.$/.test(error.message) ? error.message : "Local restart failed; private diagnostics suppressed. Inspect exact processes before retrying." })); process.exitCode = 1; }
}
