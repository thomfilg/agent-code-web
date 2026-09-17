import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { ClaudeDebugLog, claudeDebugRequest } from "../src/claude-debug.mjs";
import { spawnWorker } from "../src/worker-process.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

async function fixture(t, options = {}) {
  const runtimeHome = await temporaryDirectory(t), sessionId = randomUUID();
  const log = await ClaudeDebugLog.open({ runtimeHome, sessionId, ...options });
  t.after(() => log.close()); return { runtimeHome, sessionId, log, filename: `${runtimeHome}/claude/debug/${sessionId}.txt` };
}

test("debug opt-in matches only the exact installed user command, including empty/help and multiline inputs", () => {
  for (const text of ["/debug", " /debug --help ", "/debug Diagnose ação\nPreserve the app"]) assert.equal(claudeDebugRequest(text), true);
  for (const text of ["Explain /debug", "/debug-config", "/plugin:debug", "/debugger"]) assert.equal(claudeDebugRequest(text), false);
});

test("private debug capture records redacted native lines, stays bounded, and resumes only the same native log", async t => {
  const f = await fixture(t);
  assert.equal(await readFile(f.filename, "utf8"), "");
  f.log.append('Native ação: Authorization: Bearer opaque-credential; {"password":"dummy-password","token":"dummy-token"} sk-fixture_secret_123 cap_fixture_secret_12345678901234');
  await f.log.flush(); const safe = await readFile(f.filename, "utf8");
  assert.match(safe, /Native ação/); assert.doesNotMatch(safe, /opaque-credential|dummy-password|dummy-token|fixture_secret/);
  assert.equal((await lstat(f.filename)).mode & 0o777, 0o600);
  assert.equal((await lstat(`${f.runtimeHome}/claude/debug`)).mode & 0o777, 0o700);
  for (let group = 0; group < 18; group++) { for (let index = 0; index < 16; index++) f.log.append(`line-${group}-${index}:${"x".repeat(7900)}`); await f.log.flush(); }
  f.log.append("Latest actual native diagnostic"); await f.log.flush();
  assert((await lstat(f.filename)).size <= 2 * 1024 * 1024);
  assert.doesNotMatch(await readFile(f.filename, "utf8"), /Native ação/);
  await f.log.close(); assert.equal(f.log.ended, true);
  const resumed = await ClaudeDebugLog.open(f); t.after(() => resumed.close());
  resumed.append("Native process resumed"); await resumed.flush();
  assert.match(await readFile(f.filename, "utf8"), /Latest actual native diagnostic\nNative process resumed/);
});

test("private debug capture refuses linked profiles, directories, files, hardlinks and invalid native session IDs", async t => {
  for (const kind of ["profile", "directory", "file", "hardlink", "session"]) {
    const runtimeHome = await temporaryDirectory(t), outside = await temporaryDirectory(t), sessionId = randomUUID();
    const target = `${outside}/keep.txt`; await writeFile(target, "Unrelated file remains unchanged");
    if (kind === "profile") await symlink(outside, `${runtimeHome}/claude`);
    else {
      await mkdir(`${runtimeHome}/claude`, { recursive: true });
      if (kind === "directory") await symlink(outside, `${runtimeHome}/claude/debug`);
      else {
        await mkdir(`${runtimeHome}/claude/debug`);
        if (kind === "file") await symlink(target, `${runtimeHome}/claude/debug/${sessionId}.txt`);
        if (kind === "hardlink") await link(target, `${runtimeHome}/claude/debug/${sessionId}.txt`);
      }
    }
    await assert.rejects(ClaudeDebugLog.open({ runtimeHome, sessionId: kind === "session" ? "../../outside" : sessionId }), /Cannot safely enable/);
    assert.equal(await readFile(target, "utf8"), "Unrelated file remains unchanged");
  }
});

test("replacing a debug file stops capture visibly without writing the replacement or leaving its writer alive", async t => {
  const errors = [], f = await fixture(t, { onError: error => errors.push(error.message) });
  await rename(f.filename, `${f.filename}.original`); await writeFile(f.filename, "Replacement must stay unchanged");
  f.log.append("Must not be written"); await assert.rejects(f.log.flush(), /capture stopped/);
  await f.log.close(); assert.equal(f.log.ended, true); assert.equal(errors.length, 1);
  assert.equal(await readFile(f.filename, "utf8"), "Replacement must stay unchanged");
  assert.equal(await readFile(`${f.filename}.original`, "utf8"), "");
});

test("remote debug capture executes only in its owning private worker and startup cancellation closes the writer", async t => {
  const launches = [], runtimeHome = await temporaryDirectory(t), sessionId = randomUUID();
  const executor = { metadata: { backend: "ec2" }, spawn(command, args, options) {
    launches.push({ command, args: args.slice(-2), env: options.env }); return spawnWorker(command, args, options);
  } };
  const log = await ClaudeDebugLog.open({ runtimeHome, sessionId, executor }); t.after(() => log.close());
  log.append("Remote native diagnostic"); await log.flush(); await log.close();
  assert.deepEqual(launches[0].args, [runtimeHome, sessionId]);
  assert.deepEqual(Object.keys(launches[0].env).sort(), ["LANG", "PATH"]);
  assert.equal(await readFile(`${runtimeHome}/claude/debug/${sessionId}.txt`, "utf8"), "Remote native diagnostic\n");
  const controller = new AbortController(), errors = []; let child;
  const stalled = { metadata: { backend: "ec2" }, spawn(_command, _args, options) { child = spawnWorker(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options); return child; } };
  const running = ClaudeDebugLog.open({ runtimeHome, sessionId, executor: stalled, signal: controller.signal, onError: error => errors.push(error) });
  const rejected = assert.rejects(running, /Cannot safely enable/); controller.abort(); await rejected;
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  assert.deepEqual(errors, [], "Explicit cancellation is not a storage failure notice");
});
