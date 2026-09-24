import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GuestAcceptanceError, classifyGuestFailure, guestFailure, guestFailureReceipt, observeGuestChild, cleanupGuestFixture } from "../scripts/fixtures/ec2-guest-diagnostics.mjs";
import { startGuestSite } from "../scripts/fixtures/ec2-guest-site.mjs";
import { GuestSiteControl } from "../scripts/fixtures/ec2-guest-transport.mjs";
import { officialGuestUi } from "../scripts/smoke-ec2-guest-chrome.mjs";

const id = "af117d81-ccc2-4422-aaaa-444444444444";
test("guest receipt retains only fixed phase/category/flags and bounded sandbox counts", () => {
  const error = guestFailure(Error("PRIVATE-UPSTREAM-PATH-TOKEN"), "PRIVATE-PHASE", {
    browserFailure: "PRIVATE", siteFailure: "PRIVATE", browserReady: "true", versionExitCode: "1", arbitrary: "PRIVATE",
    sandbox: { roots: 1, processes: 999999, scanComplete: false, rendererSeccomp: "true", command: "PRIVATE" },
  });
  assert.deepEqual(guestFailureReceipt(error).diagnostic, { phase: "unknown", category: "failed", sandbox: { scanComplete: false, roots: 1 } });
  assert.doesNotMatch(JSON.stringify(guestFailureReceipt(error)), /PRIVATE/);
  for (const [text, category] of [["Timeout 5000ms exceeded: PRIVATE", "ui-timeout"], ["No usable sandbox PRIVATE", "chrome-sandbox"],
    ["ENOENT PRIVATE", "chrome-missing"], ["Permission denied PRIVATE", "chrome-permission"], ["EPIPE PRIVATE", "chrome-pipe"], ["Chrome Browser.getVersion timed out PRIVATE", "chrome-timeout"]]) assert.equal(classifyGuestFailure(text), category);
});
test("cleanup waits for pending app/browser stop before process scan and does not conceal the primary UI error", async () => {
  const calls = [], diagnostics = {}, primary = new GuestAcceptanceError("fixture-login-and-browser-start", "ui-timeout");
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  const worker = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const cleaning = cleanupGuestFixture({ app: { stop: async () => { calls.push("app-start"); await stopped; calls.push("app-stopped"); } },
    site: { command: async () => { calls.push("site-scan"); throw Object.assign(Error("PRIVATE"), { guestSiteCode: "scan-incomplete" }); } },
    children: new Set([worker]), terminate: async child => { calls.push("worker"); child.emit("exit", 0); }, connection: { close: async () => { calls.push("session"); throw Error("PRIVATE"); } },
    directory: "/private-fixture", remove: async () => { calls.push("local"); }, diagnostics });
  await Promise.resolve(); assert.deepEqual(calls, ["app-start"]); release();
  assert.equal(await cleaning, true); assert.deepEqual(calls, ["app-start", "app-stopped", "site-scan", "worker", "session", "local"]);
  const result = guestFailureReceipt(guestFailure(primary, "cleanup", diagnostics));
  assert.equal(result.diagnostic.phase, "fixture-login-and-browser-start"); assert.equal(result.diagnostic.category, "ui-timeout");
  assert.equal(result.diagnostic.appStopped, true); assert.equal(result.diagnostic.siteFailure, "scan-incomplete");
  assert.equal(result.diagnostic.sessionCloseAttempted, true); assert.equal(result.diagnostic.sessionClosed, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private-fixture/);
});
test("cleanup cannot claim worker shutdown merely because a signal was requested; all exact children are attempted", async () => {
  const children = new Set([Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }), Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })]);
  const diagnostics = {}, attempted = [];
  const failed = await cleanupGuestFixture({ children, diagnostics, confirmWorkerMs: 1,
    terminate: async child => { attempted.push(child); if (attempted.length === 2) child.emit("close", 0); }, remove: async () => {} });
  assert.equal(failed, true); assert.equal(attempted.length, 2); assert.equal(diagnostics.workersStopAttempted, true); assert.equal(diagnostics.workersStopped, undefined);
  for (const child of children) { assert.equal(child.listenerCount("exit"), 0); assert.equal(child.listenerCount("close"), 0); }
});
test("guest cleanup waits for complete zero-process evidence without relaxing the audit", async t => {
  const rootBase = await mkdtemp(path.join(os.tmpdir(), "guest-cleanup-diagnostics-")); t.after(() => rm(rootBase, { recursive: true, force: true }));
  const values = [{ processes: 2, scanComplete: true }, { processes: 0, scanComplete: false }, { processes: 0, scanComplete: true }]; let scans = 0;
  const site = await startGuestSite(id, { rootBase, cleanupTimeoutMs: 500, cleanupPollMs: 1, sandbox: async () => values[scans++] });
  await site.close(); assert.equal(scans, 3); await assert.rejects(lstat(site.root));
  const blocked = await startGuestSite(id, { rootBase, cleanupTimeoutMs: 0, sandbox: async () => ({ processes: 0, scanComplete: false }) });
  await assert.rejects(blocked.close(), error => error.guestSiteCode === "scan-incomplete"); assert.equal((await lstat(blocked.root)).isDirectory(), true);
});
test("control protocol accepts only fixed remote cleanup categories", async () => {
  for (const diagnostic of ["scan-incomplete", "PRIVATE-UNTRUSTED"]) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const control = new GuestSiteControl(child); child.stdout.write(JSON.stringify({ event: "ready", value: {} }) + "\n");
    const command = control.command("stop"); await Promise.resolve();
    child.stdout.write(JSON.stringify({ id: 1, error: "PRIVATE-ERROR", diagnostic }) + "\n");
    await assert.rejects(command, error => { assert.equal(error.guestSiteCode, diagnostic === "scan-incomplete" ? diagnostic : undefined); assert.doesNotMatch(error.message, /PRIVATE/); return true; });
    child.emit("close"); for (const value of [child.stdin, child.stdout, child.stderr]) value.destroy();
  }
});
test("native child observations expose classifications and exit codes, never raw stderr", () => {
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() }), diagnostics = {};
  observeGuestChild(child, "browser", diagnostics); child.stderr.write("PRIVATE TOKEN No usable sandbox /private/path"); child.emit("close", 1);
  assert.deepEqual(diagnostics, { browserFailure: "chrome-sandbox", browserExitCode: 1 }); child.stderr.destroy();
});
test("initial official MCP wait allows bounded remote startup and preserves safe UI timeout phase", async () => {
  const calls = [], client = { connect: async () => {}, listTools: async () => ({ tools: [{ name: "browser_run_code" }] }), close: async () => {},
    callTool: async value => { calls.push(value); return value.name === "browser_run_code" ? { isError: true, content: [{ type: "text", text: "Timeout 45000ms exceeded /PRIVATE cap_PRIVATE" }] } : { content: [] }; } };
  await assert.rejects(officialGuestUi({ origin: "http://127.0.0.1:1", chat: { id: "fixture" }, token: "PRIVATE", output: "/fixture", clientFactory: () => client, transportFactory: () => ({ close: async () => {} }) }), error => {
    assert.equal(error.diagnostic.phase, "fixture-login-and-browser-start"); assert.equal(error.diagnostic.category, "ui-timeout"); assert.doesNotMatch(JSON.stringify(guestFailureReceipt(error)), /PRIVATE/); return true;
  });
  assert.match(calls.find(call => call.name === "browser_run_code").arguments.code, /waitFor\(\{timeout:45000\}\)/);
  assert.ok(calls.some(call => call.name === "browser_close"));
});
