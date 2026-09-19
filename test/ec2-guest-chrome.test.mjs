import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseGuestOptions, smokeEc2Guest, requireSandbox, officialGuestUi } from "../scripts/smoke-ec2-guest-chrome.mjs";
import { startGuestSite, chromeSandboxReceipt } from "../scripts/fixtures/ec2-guest-site.mjs";
import { spawnGuestWorker, guestExecutor, GuestSiteControl } from "../scripts/fixtures/ec2-guest-transport.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

const id = "af117d81-ccc2-4422-aaaa-444444444444";
const temp = async t => { const value = await mkdtemp(path.join(os.tmpdir(), "relay-guest-test-")); t.after(() => rm(value, { recursive: true, force: true })); return value; };
test("default guest plan makes zero calls and has no account/instance lifecycle options", async () => {
  const die = () => { throw Error("Forbidden side effect"); };
  const result = await smokeEc2Guest(parseGuestOptions([]), { run: die, guard: die, plugin: die, tunnel: die, probe: die, driveUi: die });
  assert.equal(result.dryRun, true); assert.equal(result.modelTurns, 0); assert.equal(result.providerCredentialReads, 0);
  for (const args of [["--run"], ["--claude-auth", "/secret"], ["--token", "secret"], ["--create"], ["--profile", "other"]]) assert.throws(() => parseGuestOptions(args));
});
test("SSH browser transport uses pinned host and private framed input, not arbitrary remote argv", () => {
  let captured, header, ended = false;
  const child = new EventEmitter(); child.stdin = Object.assign(new EventEmitter(), { write: value => { header = value; }, end: () => { ended = true; } });
  const value = spawnGuestWorker({ options: { workerId: "i-fixture", sshKey: "/private/key" }, directory: "/private/task", tunnel: { port: 2345 },
    command: "/usr/bin/node", args: ["private-command-fixture"], cwd: "/private/workspace", env: { HOME: "/private/home", PRIVATE_FIXTURE: "not-in-argv" }, stdio: ["ignore", "pipe", "pipe"],
    spawnImpl: (command, args, options) => { captured = { command, args, options }; return child; } });
  assert.equal(value, child); assert.ok(ended); assert.equal(captured.command, "ssh");
  assert.ok(captured.args.includes("StrictHostKeyChecking=yes")); assert.ok(captured.args.includes("ForwardAgent=no"));
  assert.doesNotMatch(JSON.stringify(captured.args), /not-in-argv|private-command-fixture/);
  assert.equal(JSON.parse(header).env.PRIVATE_FIXTURE, "not-in-argv"); assert.equal(JSON.parse(header).heartbeat, "/opt/agent-web/.heartbeat");
});
test("executor permits only baked Chrome check and exact product browser source", () => {
  const calls = [], root = "/opt/agent-web/guest-acceptance-fixture", source = "public-browser-source";
  const executor = guestExecutor(root, input => calls.push(input), source), options = { cwd: `${root}/workspace`, env: { AWS_SECRET_ACCESS_KEY: "never-inherit", HOME: "/other" } };
  executor.spawn("/usr/bin/google-chrome", ["--version"], options);
  executor.spawn("node", ["--input-type=module", "-e", source + "\nawait runBrowserWorker();"], options);
  assert.equal(calls.length, 2); assert.equal(calls[1].env.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(calls[1].env.TMPDIR, `${root}/tmp`);
  for (const [command, args] of [["npm", ["install"]], ["claude", ["--print", "OK"]], ["/bin/sh", ["-c", "false"]], ["node", ["--input-type=module", "-e", "malicious\nawait runBrowserWorker();"]]]) assert.throws(() => executor.spawn(command, args, options));
});
test("guest control rejects further commands after malformed/oversized output or stream closure", async () => {
  for (const failure of ["malformed", "oversized", "closed"]) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const control = new GuestSiteControl(child); child.stdout.write(JSON.stringify({ event: "ready", value: { fixture: true } }) + "\n");
    assert.deepEqual(await control.ready, { fixture: true });
    const pending = control.command("status");
    await Promise.resolve();
    if (failure === "malformed") child.stdout.write("not-json\n");
    if (failure === "oversized") child.stdout.write("x".repeat(262145) + "\n");
    if (failure === "closed") child.emit("close");
    await assert.rejects(pending, /disconnected/); await assert.rejects(control.command("stop"), /disconnected/);
    assert.equal(child.stdout.isPaused(), true, "failed protocol stops consuming unbounded output");
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
  }
});
test("guest HTTP fixture is loopback-only, bounded and removes only its own private marked workspace", async t => {
  const base = await temp(t), fixture = await startGuestSite(id, { rootBase: base, sandbox: async () => ({ processes: 0, scanComplete: true }) });
  assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:/); assert.equal((await lstat(fixture.root)).mode & 0o777, 0o700);
  assert.match(await (await fetch(fixture.url)).text(), /devicePixelRatio/);
  const metric = { documentId: id, sequence: 2, width: 640, height: 960, dpr: 2, clicks: 1, text: "fixture", live: "Waiting", ignored: "not exposed" };
  assert.equal((await fetch(fixture.url + "observed", { method: "POST", body: JSON.stringify(metric) })).status, 200);
  assert.equal((await fixture.command("status")).ignored, undefined);
  await fetch(fixture.url + "observed", { method: "POST", body: JSON.stringify({ ...metric, sequence: 1, text: "old" }) });
  assert.equal((await fixture.command("status")).text, "fixture", "out-of-order HTTP delivery must not overwrite the latest observation");
  assert.equal((await fetch(fixture.url + "observed", { method: "POST", body: "x".repeat(5000) })).status, 400);
  assert.equal((await fetch(fixture.url + "private-file")).status, 404);
  await fixture.close(); await fixture.close(); await assert.rejects(lstat(fixture.root), { code: "ENOENT" });
});
test("guest cleanup refuses altered marker and active Chrome, including repeated cleanup", async t => {
  for (const altered of [false, true]) {
    const base = await temp(t), fixture = await startGuestSite(id, { rootBase: base, cleanupTimeoutMs: 0, sandbox: async () => ({ processes: altered ? 0 : 1, scanComplete: true }) });
    if (altered) await writeFile(path.join(fixture.root, "owner.json"), JSON.stringify({ runId: "other", pid: process.pid }));
    await assert.rejects(fixture.close()); await assert.rejects(fixture.close()); assert.equal((await lstat(fixture.root)).isDirectory(), true);
  }
});
test("guest cleanup refuses an incomplete zero-process inventory", async t => {
  const fixture = await startGuestSite(id, { rootBase: await temp(t), cleanupTimeoutMs: 0, sandbox: async () => ({ processes: 0, scanComplete: false }) });
  await assert.rejects(fixture.close()); await assert.rejects(fixture.close());
  assert.equal((await lstat(fixture.root)).isDirectory(), true);
});
test("sandbox audit requires non-root renderer seccomp/namespaces and catches orphan Chrome", async t => {
  const proc = await temp(t), root = "/opt/agent-web/guest-acceptance-fixture";
  async function processFixture(pid, ppid, args, { namespace = "host", seccomp = 2, uid = process.getuid() } = {}) {
    const directory = path.join(proc, String(pid)); await mkdir(path.join(directory, "ns"), { recursive: true });
    await writeFile(path.join(directory, "comm"), "chrome\n");
    await writeFile(path.join(directory, "cmdline"), args.join("\0") + "\0"); await writeFile(path.join(directory, "status"), `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nPPid:\t${ppid}\nSeccomp:\t${seccomp}\nNSpid:\t${pid}${namespace === "renderer" ? " 5" : ""}\n`);
    await symlink(root + "/workspace", path.join(directory, "cwd"));
    for (const kind of ["pid", "user"]) await symlink(`${kind}:[${namespace}]`, path.join(directory, "ns", kind));
  }
  await processFixture(100, 1, ["/opt/google/chrome/chrome", "--remote-debugging-pipe", `--user-data-dir=${root}/tmp/relay-chrome-example`]);
  await processFixture(101, 100, ["/opt/google/chrome/chrome", "--type=renderer"], { namespace: "renderer" });
  await writeFile(path.join(proc, "101/comm"), "Chrome_ChildIOT\n");
  await writeFile(path.join(proc, "101/cmdline"), "/opt/google/chrome/chrome --type=renderer --lang=en-US\0");
  requireSandbox(await chromeSandboxReceipt(root, { proc }));
  await processFixture(102, 100, ["/opt/google/chrome/chrome", "--type=renderer"], { namespace: "renderer", uid: 0 });
  const rootChild = await chromeSandboxReceipt(root, { proc });
  assert.equal(rootChild.processes, 3); assert.equal(rootChild.renderers, 2); assert.equal(rootChild.nonRoot, false);
  assert.throws(() => requireSandbox(rootChild), "a changed-UID child cannot hide behind healthy renderers");
  await rm(path.join(proc, "102"), { recursive: true });
  await chmod(path.join(proc, "101/ns"), 0);
  requireSandbox(await chromeSandboxReceipt(root, { proc })); // namespace symlinks can be inaccessible on actual Chrome.
  await chmod(path.join(proc, "101/ns"), 0o700);
  await writeFile(path.join(proc, "101/status"), `Uid:\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\nPPid:\t100\nSeccomp:\t0\n`); assert.throws(() => requireSandbox({ roots: 1, renderers: 1, rendererSeccomp: false }));
  assert.equal((await chromeSandboxReceipt(root, { proc })).rendererSeccomp, false);
  await rm(path.join(proc, "100"), { recursive: true });
  assert.equal((await chromeSandboxReceipt(root, { proc })).processes, 1, "orphan renderer prevents directory cleanup");
  await chmod(path.join(proc, "101/status"), 0);
  assert.equal((await chromeSandboxReceipt(root, { proc })).scanComplete, false, "inaccessible existing Chrome is not proof of absence");
  await chmod(path.join(proc, "101/status"), 0o600);
});

test("official MCP drives real disposable local UI/Chrome before EC2 execution", { skip: process.env.RELAY_GUEST_UI_TEST !== "1", timeout: 180000 }, async t => {
  const directory = await temp(t), token = "isolated-fixture-token-not-a-user-account";
  const fixture = await startGuestSite(id, { rootBase: directory });
  const source = await readFile(new URL("../src/browser-worker.mjs", import.meta.url), "utf8");
  const executor = guestExecutor(fixture.root, input => spawn(input.command === "/usr/bin/node" ? process.execPath : input.command, input.args, { cwd: input.cwd, env: input.env, stdio: input.stdio, detached: true }), source);
  const config = loadConfig({ AGENT_WEB_HOST: "127.0.0.1", AGENT_WEB_PORT: "0", AGENT_DATA_DIR: path.join(directory, "data"), AGENT_DATABASE_MODE: "memory", AGENT_ENABLE_MOCK: "1", AGENT_PROCESS_ISOLATION: "none", AGENT_WEB_AUTH_TOKEN: token, AGENT_IDLE_TIMEOUT_MS: "60000", AGENT_CHROME_BIN: "/usr/bin/google-chrome", AGENT_WORKER_BACKEND: "ec2", AGENT_EC2_GATEWAY_ORIGIN: "https://fixture.invalid", PATH: process.env.PATH });
  const app = await createAgentWebServer({ config, workerBackend: { acquire: async () => executor, sleep: async () => {}, destroy: async () => { throw Error("No EC2 mutation"); } } });
  const { url } = await app.start(), chat = await app.manager.createChat({ agent: "mock", title: "Guest Chrome local fixture" });
  const output = path.resolve("test-results/ec2-guest-local-fixture"); await mkdir(output, { recursive: true, mode: 0o700 });
  try {
    const receipt = await officialGuestUi({ origin: url, chat, token, site: fixture, browsers: app.manager.browsers, output });
    assert.equal(receipt.sharpPixels, true); assert.equal(receipt.sameTabAndDocument, true); assert.equal(receipt.rendererSandbox, true);
    assert.deepEqual(app.store.get(chat.id).messages, []);
  } finally { await app.stop(); await fixture.close(); }
});
