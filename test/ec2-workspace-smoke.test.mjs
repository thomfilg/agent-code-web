import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { smokeEc2Workspace, parseWorkspaceOptions, workspaceBackend, clonePublicFixture, captureFixture } from "../scripts/smoke-ec2-workspace.mjs";
import { workspaceProbe, workspaceIdentity, publicRepository, credentialFreeGitConfig } from "../scripts/fixtures/ec2-workspace-worker.mjs";
import { Ec2Executor } from "../src/worker-backends.mjs";

const id = "12345678-1234-4234-8234-123456789abc", head = "a".repeat(40);
const temp = async t => { const p = await mkdtemp(path.join(os.tmpdir(), "relay-workspace-test-")); t.after(() => rm(p, { recursive: true, force: true })); return p; };
test("workspace plan performs zero calls, excludes account input and states the untested gates", async () => {
  const r = await smokeEc2Workspace(parseWorkspaceOptions([]), { run: () => { throw Error("network"); } });
  for (const key of ["deployedControllerTested", "selectedPrivateGitHubAuthTested", "stopStartTested"]) assert.equal(r[key], false);
  assert.equal(r.providerCredentialReads, 0); assert.throws(() => parseWorkspaceOptions(["--claude-auth", "/private"]));
  assert.throws(() => workspaceIdentity("../other"));
});
test("public clone uses actual product helper from sanitized child and a no-credential Git wrapper", async t => {
  const directory = await temp(t), calls = [];
  const result = await clonePublicFixture(directory, { run: async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === "git") return args.includes("rev-parse") ? head : `remote.origin.url\n${publicRepository}\0`;
    return "";
  } });
  assert.equal(result.head, head); assert.equal(calls.length, 3);
  assert.match(calls[0].args[2], /prepareWorkspace/); assert.match(calls[0].args[2], /octocat\/Hello-World/);
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "PATH"]);
  const wrapper = await readFile(path.join(directory, "clone-bin/git"), "utf8");
  assert.match(wrapper, /credential.helper=/); assert.match(wrapper, /http.followRedirects=false/); assert.match(wrapper, /GIT_CONFIG_NOSYSTEM=1/);
  assert.equal((await lstat(path.join(directory, "clone-home"))).mode & 0o777, 0o700);
});
test("Git metadata rejects credentials, arbitrary remotes, includes and helper rewrites", () => {
  const base = `remote.origin.url\n${publicRepository}\0`;
  assert.equal(credentialFreeGitConfig(base), true);
  for (const suffix of ["credential.helper\nsecret\0", "http.extraheader\nsecret\0", "http.cookiefile\n/private\0", "remote.origin.pushurl\nhttps://private.invalid/x\0", "include.path\n/private\0", "url.x.insteadof\nx\0", "remote.other.url\nhttps://token@github.com/x/y\0", "malformed\0"]) assert.equal(credentialFreeGitConfig(base + suffix), false);
});
test("transport is exact target and pinned tunnel, never a caller-selected remote", () => {
  const backend = workspaceBackend({ options: { workerId: "i-0123456789abcdef0", sshKey: "/private/key" }, target: { host: "10.0.1.2" }, directory: "/fixture", tunnel: { port: 12345 } });
  const args = backend.sshArgs("10.0.1.2", "i-0123456789abcdef0");
  assert.ok(args.includes("StrictHostKeyChecking=yes")); assert.ok(args.includes("GlobalKnownHostsFile=/dev/null")); assert.ok(args.includes("ForwardAgent=no"));
  assert.equal(args.at(-1), "ubuntu@127.0.0.1"); assert.throws(() => backend.sshArgs("10.0.1.3", "i-0123456789abcdef0"));
});
test("remote probe ownership and preservation use ordinary marked private fixtures only", async t => {
  const remoteRoot = await temp(t), execute = async (_cmd, args) => ({ stdout: args.includes("rev-parse") ? head : `remote.origin.url\n${publicRepository}\0` });
  const options = { remoteRoot, execute }, root = workspaceIdentity(id, remoteRoot).root;
  await workspaceProbe({ runId: id, action: "create" }, options);
  await assert.rejects(workspaceProbe({ runId: id, action: "create" }, options));
  await mkdir(path.join(root, "workspace"));
  const first = await workspaceProbe({ runId: id, action: "inspect", phase: "first" }, options); assert.equal(first.head, head);
  assert.equal((await workspaceProbe({ runId: id, action: "inspect", phase: "second" }, options)).remoteSentinel, true);
  await writeFile(path.join(root, "workspace-acceptance-owner.json"), "altered");
  await assert.rejects(workspaceProbe({ runId: id, action: "cleanup" }, options));
  await writeFile(path.join(root, "workspace-acceptance-owner.json"), JSON.stringify({ runId: id, kind: "public-workspace-acceptance" }));
  assert.equal((await workspaceProbe({ runId: id, action: "cleanup" }, options)).cleanedUp, true); await assert.rejects(lstat(root));
});
test("actual Ec2Executor tar and framed spawn preserve Git and remote sentinel on second prepare", async t => {
  const directory = await temp(t), remoteRoot = path.join(directory, "remote"), local = path.join(directory, "local"), shell = path.join(directory, "ssh-fixture");
  await mkdir(local); await mkdir(path.join(remoteRoot, "chats"), { recursive: true });
  const exec = promisify(execFile), env = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  await exec("git", ["init", local], { env }); await writeFile(path.join(local, "README"), "fixture\n");
  await exec("git", ["-C", local, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "add", "README"], { env });
  await exec("git", ["-C", local, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], { env });
  await exec("git", ["-C", local, "remote", "add", "origin", publicRepository], { env });
  await writeFile(shell, `#!/bin/sh\ncommand=$1\ncase "$command" in 'exec /usr/bin/node '*) command='exec ${process.execPath} '"\${command#exec /usr/bin/node }" ;; esac\nexec /bin/sh -c "$command"\n`, { mode: 0o700 });
  const backend = { config: { ec2: { remoteRoot, remotePath: "/usr/bin:/bin", sshBin: shell } }, sshArgs: () => [], sshCapture: async (_host, command) => (await exec("/bin/sh", ["-c", command])).stdout.trim() };
  const executor = new Ec2Executor({ backend, chat: { id: workspaceIdentity(id).chatId, workspace: local, repositories: [] }, instance: { InstanceId: "fixture" }, host: "fixture" });
  await executor.prepare();
  const sentinel = path.join(executor.workspace, "sentinel"); await writeFile(sentinel, "remote"); await writeFile(path.join(local, "sentinel"), "changed-local");
  await executor.prepare(); assert.equal(await readFile(sentinel, "utf8"), "remote");
  // Exercise exact product framed spawn through the shell-only SSH fixture.
  const child = executor.spawn("/usr/bin/git", ["rev-parse", "HEAD"], { env: { PATH: "/usr/bin:/bin", HOME: directory }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", c => output += c); child.stderr.resume(); await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => code ? reject(Error("spawn failed")) : resolve()); });
  assert.equal(output.trim(), (await exec("git", ["-C", local, "rev-parse", "HEAD"], { env })).stdout.trim());
});

test("orchestrator refuses false success and cleans its exact fixture after upload/receipt failures", async t => {
  for (const failure of [null, "upload", "head", "creation-receipt", "cleanup", "session", "guard"]) {
    const directory = await temp(t), key = path.join(directory, "key"); await writeFile(key, "public-only-test-file", { mode: 0o600 });
    const options = { run: true, workerId: "i-0123456789abcdef0", imageId: "ami-0123456789abcdef0", acceptanceId: id, sshKey: key };
    const calls = [], target = { host: "10.0.1.2", publicKey: "ssh-ed25519 AAAAFixture" }; let guards = 0;
    const dependencies = {
      run: async (command) => command === "aws" ? "aws-cli/2.35.20 fixture" : target.publicKey,
      guard: async () => { guards++; if (failure === "guard" && guards === 3) throw Error("changed"); return target; },
      clone: async folder => { const destination = path.join(folder, "workspace"); await mkdir(destination); return { destination, head }; },
      plugin: async () => ({}), tunnel: async () => ({ port: 12345, close: async () => { calls.push("closed"); if (failure === "session") throw Error("private"); } }),
      probe: async () => ({ schema: 1, runId: id, preflight: true, credentialFree: true }),
      executorFactory: () => ({ prepare: async () => { calls.push("prepare"); if (failure === "upload") throw Error("private"); } }),
      capture: async (_executor, _source, request) => {
        calls.push(request.action);
        assert.notEqual(request.runId, id);
        if (request.action === "create") { if (failure === "creation-receipt") throw Error("lost receipt"); return { runId: request.runId, created: true }; }
        if (request.action === "cleanup") { if (failure === "cleanup") throw Error("private"); return { runId: request.runId, cleanedUp: true }; }
        return { runId: request.runId, head: failure === "head" ? "b".repeat(40) : head, credentialFreeGitConfig: true, remoteSentinel: true };
      },
    };
    if (failure) await assert.rejects(smokeEc2Workspace(options, dependencies));
    else {
      const result = await smokeEc2Workspace(options, dependencies);
      assert.equal(result.accepted, true); assert.equal(result.actualProductUpload, true); assert.equal(result.backendAcquireTested, false); assert.equal(result.stopStartTested, false);
      assert.equal(calls.filter(c => c === "prepare").length, 2);
    }
    assert.ok(calls.includes("closed"));
    if (failure !== "guard") assert.ok(calls.includes("cleanup"));
  }
});

test("cleanup never follows a changed root symlink or owner marker symlink", async t => {
  const remoteRoot = await temp(t), { root } = workspaceIdentity(id, remoteRoot), options = { remoteRoot };
  await workspaceProbe({ runId: id, action: "create" }, options);
  const outside = path.join(remoteRoot, "outside"); await mkdir(outside);
  const marker = path.join(root, "workspace-acceptance-owner.json"), destination = path.join(outside, "keep");
  await writeFile(destination, await readFile(marker)); await rm(marker); await symlink(destination, marker);
  await assert.rejects(workspaceProbe({ runId: id, action: "cleanup" }, options));
  assert.ok((await lstat(destination)).isFile());
});
