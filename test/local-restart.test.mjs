import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { inspectRows, parseOptions, processIdentity, publicInspection, restartWorkflow, sameIdentity, sanitizedEnvironment, signalExact } from "../scripts/restart-local-relay.mjs";

const revision = "a".repeat(40);
const options = { execute: true, pid: 123, startTicks: "456", revision, legacyIdleConfirmed: true };
const summary = { chats: 0, busyChats: 0, pendingAccounts: 0, encryptionVerified: true };
function fixture({ legacy = true, reject = [] } = {}) {
  const calls = [];
  const snapshot = { identity: { pid: 123, startTicks: "456" }, revision, legacy, summary, env: { private: "private-process-secret" } };
  const state = { backupComplete: false };
  const operations = Object.fromEntries(["inspect", "reserve", "recheck", "drain", "stop", "cold", "backup", "cleanupLaunch", "resume", "release"].map(name => [name, async () => {
    calls.push(name);
    if (reject.includes(name)) throw Error("private-provider-diagnostic");
    if (name === "inspect") return snapshot;
    if (name === "reserve") return state;
    if (name === "backup") state.backupComplete = true;
  }]));
  operations.launch = async (_snapshot, _state, recovery) => {
    calls.push(recovery ? "recover" : "launch");
    if (reject.includes(recovery ? "recover" : "launch")) throw Error("private-child-error");
    return { restarted: true, ready: true, backupComplete: state.backupComplete, recoveryAttempt: recovery };
  };
  return { calls, snapshot, operations };
}

test("local restart requires an explicit PID and matching inspection receipt for execution", () => {
  assert.deepEqual(parseOptions(["--pid", "123"]), { execute: false, legacyIdleConfirmed: false, pid: 123 });
  const execute = parseOptions(["--pid", "123", "--execute", "--start-ticks", "456", "--expected-revision", revision, "--legacy-idle-confirmed"]);
  assert.deepEqual(execute, options);
  for (const args of [[], ["--pid", "0"], ["--pid", "123", "--execute"], ["--pid", "123", "--start-ticks", "bad"], ["--pid", "123", "--unexpected"], ["--pid", "123", "--expected-revision", "bad"]]) assert.throws(() => parseOptions(args), /Local restart refused/);
});

test("process comparison rejects PID reuse and altered owner, executable, cwd or argv", async () => {
  const identity = await processIdentity(process.pid);
  assert.equal(sameIdentity(identity, structuredClone(identity)), true);
  for (const key of ["pid", "uid", "cwd", "executable", "startTicks", "argv"]) assert.equal(sameIdentity(identity, { ...identity, [key]: key === "argv" ? ["different"] : "different" }), false);
});

test("pidfd signaling rejects a stale incarnation then gracefully stops only its isolated fixture", async t => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000); console.log('fixture ready')"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  await once(child.stdout, "data");
  const identity = await processIdentity(child.pid);
  await assert.rejects(signalExact({ ...identity, startTicks: "0" }), /exact_signal_refused/);
  assert.equal(child.exitCode, null);
  const closed = once(child, "close");
  await signalExact(identity);
  assert.equal((await closed)[0], 0);
});

test("captured Doppler settings keep app secrets in memory but remove service token and old keyring/inspector handles", () => {
  const env = sanitizedEnvironment({ DOPPLER_PROJECT: "code-web", DOPPLER_CONFIG: "dev", DOPPLER_TOKEN: "private-doppler-token", DOPPLER_DEV_TOKEN_FILE: "/private/token",
    GOOGLE_CLIENT_ID: "private-client", GOOGLE_CLIENT_SECRET: "private-google-secret", AGENT_OWNER_EMAIL: "owner@example.test", DBUS_SESSION_BUS_ADDRESS: "private-bus",
    SSH_AUTH_SOCK: "/private/agent", GNOME_KEYRING_CONTROL: "/private/keyring", NODE_OPTIONS: "--inspect", AUTH_DEBUG: "1", AGENT_CONTROL_DIR: "/existing/controller", AGENT_DATA_DIR: "/existing/workspaces" });
  for (const key of ["DOPPLER_TOKEN", "DOPPLER_DEV_TOKEN_FILE", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "GNOME_KEYRING_CONTROL", "NODE_OPTIONS", "AUTH_DEBUG"]) assert.equal(env[key], undefined);
  assert.equal(env.GOOGLE_CLIENT_SECRET, "private-google-secret");
  assert.equal(env.AGENT_CONTROL_DIR, "/existing/controller");
  assert.equal(env.AGENT_DATA_DIR, "/existing/workspaces");
  assert.throws(() => sanitizedEnvironment({ DOPPLER_PROJECT: "wrong", DOPPLER_CONFIG: "dev" }), /expected Doppler/);
});

test("database idle gate checks encryption and refuses work, queued prompts, goals and pending agent login", () => {
  const system = { kind: "system", id: "encryption-check", payload: { ok: true } };
  const cipher = { open: (_kind, _id, value) => value };
  assert.deepEqual(inspectRows([system], cipher), summary);
  for (const payload of [{ status: "running" }, { status: "starting" }, { status: "waiting" }, { status: "unknown" }, { status: "stopped", pendingRequest: {} }, { status: "stopped", queuedMessages: [{}] }, { status: "stopped", goal: { status: "active" } }]) {
    assert.throws(() => inspectRows([system, { kind: "chat", payload }], cipher), /active_work/);
  }
  assert.throws(() => inspectRows([system, { kind: "agent-account", payload: { status: "pending" } }], cipher), /active_work/);
  assert.throws(() => inspectRows([], cipher), /encryption_check/);
  assert.equal(inspectRows([system, { kind: "chat", payload: { status: "stopped" } }], cipher).chats, 1);
});

test("read-only default never reserves files, signals a process, drains or creates a token", async () => {
  const f = fixture();
  const result = await restartWorkflow({ ...options, execute: false }, f.operations);
  assert.deepEqual(f.calls, ["inspect"]);
  assert.equal(result.changesMade, false);
  assert.equal(result.legacyMaintenanceAcknowledgmentRequired, true);
  assert.ok(!JSON.stringify(result).includes("private-process-secret"));
  assert.deepEqual(result, publicInspection(f.snapshot));
});

test("legacy server requires explicit maintenance acknowledgment rather than pretending DB observes memory-only OAuth flows", async () => {
  const f = fixture();
  await assert.rejects(restartWorkflow({ ...options, legacyIdleConfirmed: false }, f.operations), /legacy_maintenance_confirmation_required/);
  assert.deepEqual(f.calls, ["inspect"]);
});

test("successful restart verifies cold source before backup and again before single launch", async () => {
  const f = fixture({ legacy: false });
  assert.deepEqual(await restartWorkflow(options, f.operations), { restarted: true, ready: true, backupComplete: true, recoveryAttempt: false });
  assert.deepEqual(f.calls, ["inspect", "reserve", "recheck", "drain", "stop", "cold", "backup", "cold", "launch", "release"]);
});

test("pre-stop and drain failures do not signal; ambiguous drain resumes only exact original", async () => {
  for (const rejected of ["recheck", "drain"]) {
    const f = fixture({ legacy: false, reject: [rejected] });
    await assert.rejects(restartWorkflow(options, f.operations), /restart_aborted_before_verified_stop/);
    assert.ok(!f.calls.includes("stop"));
    assert.equal(f.calls.includes("resume"), rejected === "drain");
    assert.equal(f.calls.at(-1), "release");
  }
});

test("ambiguous cold state never copies database or launches a second controller", async () => {
  const f = fixture({ reject: ["cold"] });
  await assert.rejects(restartWorkflow(options, f.operations), /manual_recovery/);
  assert.ok(!f.calls.includes("backup"));
  assert.ok(!f.calls.includes("launch"));
  assert.ok(!f.calls.includes("recover"));
});

test("backup failure recovers service without claiming complete backup or old-code rollback", async () => {
  const f = fixture({ reject: ["backup"] });
  const result = await restartWorkflow(options, f.operations);
  assert.equal(result.backupComplete, false);
  assert.equal(result.recoveryAttempt, true);
  assert.ok(f.calls.indexOf("cleanupLaunch") < f.calls.indexOf("recover"));
});

test("failed launch must be cleaned and source cold before one recovery attempt", async () => {
  const f = fixture({ reject: ["launch"] });
  assert.equal((await restartWorkflow(options, f.operations)).recoveryAttempt, true);
  assert.deepEqual(f.calls.slice(-5), ["launch", "cleanupLaunch", "cold", "recover", "release"]);
  const ambiguous = fixture({ reject: ["launch", "cleanupLaunch"] });
  await assert.rejects(restartWorkflow(options, ambiguous.operations), /manual_recovery/);
  assert.ok(!ambiguous.calls.includes("recover"));
});

test("failed recovery reports a fixed safe error and retains checkpoints", async () => {
  const f = fixture({ reject: ["launch", "recover"] });
  await assert.rejects(restartWorkflow(options, f.operations), error => !error.message.includes("private") || error.message.includes("Private diagnostics suppressed"));
  assert.equal(f.calls.filter(name => name === "recover").length, 1);
  assert.equal(f.calls.at(-1), "release");
});
