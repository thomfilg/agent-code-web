#!/usr/bin/env node
// Local isolated controller fixture; never opens the deployed application DB.
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Ec2Executor } from "../src/worker-backends.mjs";
import { terminateWorker } from "../src/worker-process.mjs";
import { nativeTarget, guardNativeTarget } from "./fixtures/ec2-native-guards.mjs";
import { awsArgs, runPrivate, openNativeTunnel, nativeProbeOverSsh } from "./fixtures/ec2-native-transport.mjs";
import { prepareSessionPlugin } from "./fixtures/session-manager-plugin.mjs";
import { validateProbeReceipt } from "./smoke-ec2-native.mjs";
import { workspaceIdentity, publicRepository, credentialFreeGitConfig } from "./fixtures/ec2-workspace-worker.mjs";

export function parseWorkspaceOptions(args) {
  const result = { run: false, sshKey: path.join(os.homedir(), ".local/share/agent-relay-aws-mvp/worker-ed25519") };
  const names = { "--worker-id": "workerId", "--image-id": "imageId", "--acceptance-id": "acceptanceId", "--ssh-key": "sshKey" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run") { result.run = true; continue; }
    if (!names[args[i]] || !args[i + 1] || args[i + 1].startsWith("--")) throw Error("Invalid workspace acceptance option");
    result[names[args[i]]] = args[++i];
  }
  if (result.run) {
    workspaceIdentity(result.acceptanceId);
    if (!/^i-[a-f0-9]{8,17}$/.test(result.workerId || "") || !/^ami-[a-f0-9]{8,17}$/.test(result.imageId || "") || !path.isAbsolute(result.sshKey)) throw Error("Exact worker, image and private transport key required");
  }
  return result;
}
export function workspaceBackend({ options, target, directory, tunnel, run = runPrivate }) {
  return {
    config: { ec2: { remoteRoot: "/opt/agent-web", remotePath: "/usr/local/bin:/usr/bin:/bin", sshBin: "ssh", gatewayOrigin: "https://fixture.invalid" } },
    sshArgs(host, instanceId) {
      assert.equal(host, target.host); assert.equal(instanceId, options.workerId);
      assert.ok(Number.isInteger(tunnel.port) && tunnel.port > 0 && tunnel.port < 65536);
      return ["-F", "/dev/null", "-T", "-p", String(tunnel.port), "-i", options.sshKey, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", `UserKnownHostsFile=${path.join(directory, "known_hosts")}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", `HostKeyAlias=native-${options.workerId}`, "-o", "StrictHostKeyChecking=yes", "ubuntu@127.0.0.1"];
    },
    sshCapture(host, command, instanceId) { return run("ssh", [...this.sshArgs(host, instanceId), command]); },
  };
}
export async function clonePublicFixture(directory, { run = runPrivate, signal } = {}) {
  const home = path.join(directory, "clone-home"), destination = path.join(directory, "workspace"), bin = path.join(directory, "clone-bin");
  await mkdir(home, { mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  // prepareWorkspace intentionally narrows its child env. A fixture-only
  // wrapper therefore enforces config/credential isolation at the Git boundary.
  await writeFile(path.join(bin, "git"), '#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0\nexec /usr/bin/git -c credential.helper= -c http.followRedirects=false -c core.hooksPath=/dev/null "$@"\n', { flag: "wx", mode: 0o700 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  // No authentication lookup, arbitrary URL or inherited SSH/Git configuration.
  const code = `import {prepareWorkspace} from ${JSON.stringify(new URL("../src/workspace.mjs", import.meta.url).href)}; await prepareWorkspace({destination:process.argv[1],source:${JSON.stringify(publicRepository)}});`;
  await run(process.execPath, ["--input-type=module", "-e", code, destination], { env, signal, timeout: 190000 });
  const head = (await run("git", ["-C", destination, "rev-parse", "HEAD"], { env, signal })).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(credentialFreeGitConfig(await run("git", ["-C", destination, "config", "--local", "--null", "--list"], { env, signal })), true);
  return { destination, head };
}
export async function captureFixture(executor, source, request, { signal } = {}) {
  const child = executor.spawn("/usr/bin/node", ["--input-type=module", "-e", source, "--", "--relay-workspace-probe", JSON.stringify(request)], {
    cwd: "/opt/agent-web", env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let bytes = 0, output = "", aborted = false;
    const abort = () => { aborted = true; void terminateWorker(child, 1000).catch(() => {}); };
    const timer = setTimeout(abort, 45000);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 32768) abort(); else output += chunk; });
    child.stderr.resume();
    child.once("error", () => finish(1)); child.once("close", finish);
    function finish(code) {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (aborted || code !== 0) { reject(Error("Workspace fixture command failed; output suppressed")); return; }
      try { resolve(JSON.parse(output)); } catch { reject(Error("Workspace fixture returned an invalid receipt")); }
    }
  });
}
export async function smokeEc2Workspace(options, { run = runPrivate, guard = guardNativeTarget, plugin = prepareSessionPlugin,
  tunnel = openNativeTunnel, probe = nativeProbeOverSsh, clone = clonePublicFixture, capture = captureFixture, executorFactory = input => new Ec2Executor(input), signal } = {}) {
  if (!options.run) return { dryRun: true, fixtureController: "isolated local process", repository: publicRepository, modelTurns: 0, providerCredentialReads: 0, selectedPrivateGitHubAuthTested: false, deployedControllerTested: false, stopStartTested: false, workerRetirementRequired: true };
  const json = async (...args) => JSON.parse(await run("aws", awsArgs([...args, "--output", "json"]), { signal }));
  assert.match(await run("aws", ["--version"], { signal }), /^aws-cli\/2\.35\.20\s/);
  const target = await guard(options, json), key = await lstat(options.sshKey);
  assert.ok(key.isFile() && !key.isSymbolicLink() && key.nlink === 1 && key.uid === process.getuid() && !(key.mode & 0o077));
  assert.equal((await run("ssh-keygen", ["-y", "-f", options.sshKey], { signal })).trim().split(/\s+/).slice(0, 2).join(" "), target.publicKey);
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-ec2-workspace-"));
  const fixtureId = randomUUID(); // Never reuse a prior invocation's remote root.
  const source = await readFile(new URL("./fixtures/ec2-workspace-worker.mjs", import.meta.url), "utf8");
  let transport, executor, created = false, cleaned = false, sessionClosed = false, succeeded = false, cleanupError;
  const recheck = async (cleanup = false) => assert.deepEqual(await guard(options, cleanup ? async (...args) => JSON.parse(await run("aws", awsArgs([...args, "--output", "json"]))) : json), target);
  try {
    const local = await clone(directory, { run, signal });
    const installed = await plugin(directory, { run: (command, args) => run(command, args, { signal }) });
    await recheck(); transport = await tunnel(target, directory, installed, { run, signal });
    validateProbeReceipt(await probe({ options, directory, tunnel: transport, request: { action: "preflight", runId: options.acceptanceId }, first: true, run, signal }), options.acceptanceId, "preflight");
    await recheck(); signal?.throwIfAborted();
    executor = executorFactory({ backend: workspaceBackend({ options, target, directory, tunnel: transport, run }), chat: { id: workspaceIdentity(fixtureId).chatId, workspace: local.destination, repositories: [] }, instance: { InstanceId: options.workerId }, host: target.host });
    const command = (action, phase) => capture(executor, source, { action, phase, runId: fixtureId }, { signal });
    created = true; // A lost creation receipt still requires exact-marker cleanup.
    const made = await command("create"); assert.equal(made.runId, fixtureId); assert.equal(made.created, true);
    await executor.prepare(); signal?.throwIfAborted();
    for (const phase of ["first", "second"]) {
      if (phase === "second") {
        await writeFile(path.join(local.destination, "relay-acceptance-sentinel.txt"), "local-copy-must-not-overwrite-remote\n", { flag: "wx", mode: 0o600 });
        await recheck(); await executor.prepare(); signal?.throwIfAborted();
      }
      const value = await command("inspect", phase);
      assert.equal(value.runId, fixtureId); assert.equal(value.head, local.head);
      assert.equal(value.credentialFreeGitConfig, true); assert.equal(value.remoteSentinel, true);
    }
    succeeded = true;
  } finally {
    if (created && executor) {
      try {
        await recheck(true);
        const value = await capture(executor, source, { action: "cleanup", runId: fixtureId });
        assert.equal(value.runId, fixtureId); assert.equal(value.cleanedUp, true); cleaned = true;
      } catch { cleanupError = true; }
    }
    try { await transport?.close(); sessionClosed = Boolean(transport); } catch { cleanupError = true; }
    await rm(directory, { recursive: true, force: false });
    if (cleanupError) throw Error("Workspace fixture cleanup unconfirmed; retire only the dedicated accepted worker");
  }
  assert.ok(succeeded && cleaned && sessionClosed);
  return { schema: 1, accepted: true, workerId: options.workerId, imageId: options.imageId, acceptanceId: options.acceptanceId,
    fixtureController: "isolated local process", repository: publicRepository, actualProductUpload: true, remoteHeadMatches: true, noAuthGitConfig: true,
    secondPreparePreservesRemoteSentinel: true, fixtureRemoved: true, sessionClosed: true, modelTurns: 0, providerCredentialReads: 0,
    selectedPrivateGitHubAuthTested: false, deployedControllerTested: false, backendAcquireTested: false, stopStartTested: false, workerRetirementRequired: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const abort = new AbortController(); for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => abort.abort());
  try { console.log(JSON.stringify(await smokeEc2Workspace(parseWorkspaceOptions(process.argv.slice(2)), { signal: abort.signal }), null, 2)); }
  catch { console.error("EC2 workspace acceptance failed; private diagnostics suppressed. Retire only the dedicated worker. Product GitHub consent was not tested."); process.exitCode = 1; }
}
