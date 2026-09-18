import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, chmod } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parseNativeOptions, smokeEc2Native, readNativeAccess, validateProbeReceipt } from "../scripts/smoke-ec2-native.mjs";
import { guardNativeTarget, nativeTarget as t } from "../scripts/fixtures/ec2-native-guards.mjs";
import { runNativeProbe, validateNativeResult, NativeAcceptanceError, nativeFailureReceipt, remoteNativeFailure } from "../scripts/fixtures/ec2-native-worker.mjs";
import { prepareSessionPlugin, pluginSigner } from "../scripts/fixtures/session-manager-plugin.mjs";
import { nativeProbeOverSsh, runPrivate, openNativeTunnel } from "../scripts/fixtures/ec2-native-transport.mjs";

const id = "b0c88b6d-aaa1-4222-8333-444444444444", workerId = "i-aaaaaaaaaaaaaaaaa", imageId = "ami-bbbbbbbbbbbbbbbbb";
const options = { run: true, workerId, imageId, acceptanceId: id, claudeAuth: "/private/fixture-auth", sshKey: "/private/fixture-key" };
const tags = values => Object.entries(values).map(([Key, Value]) => ({ Key, Value }));
const owned = tags({ ManagedBy: "12-apps-ci", AgentRelayDeployment: t.deployment });
const outputs = { DeploymentName: t.deployment, ControllerInstanceId: t.controller, WorkerSubnetId: "subnet-aaaaaaaaaaaaaaaaa", WorkerSecurityGroupId: "sg-aaaaaaaaaaaaaaaaa", WorkerKeyName: "fixture-worker" };
const resources = [["Controller", "AWS::EC2::Instance", t.controller], ["WorkerSubnet", "AWS::EC2::Subnet", outputs.WorkerSubnetId],
  ["WorkerGroup", "AWS::EC2::SecurityGroup", outputs.WorkerSecurityGroupId], ["WorkerKey", "AWS::EC2::KeyPair", outputs.WorkerKeyName],
  ["ControllerGroup", "AWS::EC2::SecurityGroup", "sg-controller"], ["ControllerSubnet", "AWS::EC2::Subnet", "subnet-controller"], ["ControllerProfile", "AWS::IAM::InstanceProfile", "fixture-controller"]]
  .map(([LogicalResourceId, ResourceType, PhysicalResourceId]) => ({ LogicalResourceId, ResourceType, PhysicalResourceId }));
function awsFixture(change = {}) {
  const calls = [];
  const json = async (...args) => {
    calls.push(args); const operation = args[1];
    const rows = {
      "get-caller-identity": { Account: t.account },
      "describe-stacks": [{ StackName: t.deployment, StackId: `arn:aws:cloudformation:${t.region}:${t.account}:stack/${t.deployment}/fixture`, StackStatus: "CREATE_COMPLETE", Tags: owned, Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }],
      "list-stack-resources": resources,
      "describe-subnets": [{ SubnetId: outputs.WorkerSubnetId, OwnerId: t.account, Tags: owned, MapPublicIpOnLaunch: false, VpcId: "vpc-fixture" }],
      "describe-security-groups": [{ GroupId: outputs.WorkerSecurityGroupId, OwnerId: t.account, Tags: owned, VpcId: "vpc-fixture", IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, UserIdGroupPairs: [{ GroupId: "sg-controller" }] }] }],
      "describe-images": [{ ImageId: imageId, OwnerId: t.account, State: "available", Architecture: "x86_64", Public: false, RootDeviceType: "ebs", RootDeviceName: "/dev/sda1", BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { Encrypted: true } }], Tags: tags({ ManagedBy: "agent-relay", AgentRelayDeployment: t.deployment, AgentRelayWorkerKey: outputs.WorkerKeyName, CodexVersion: "0.154.0", ClaudeVersion: "2.1.222", AgentRelayAcceptance: "verified-v1", AgentRelayAcceptanceId: id }) }],
      "describe-key-pairs": [{ KeyName: outputs.WorkerKeyName, Tags: owned, PublicKey: "ssh-ed25519 AAAAFixturePublic comment" }],
    };
    const key = operation === "describe-instances" ? (args.includes(t.controller) ? "controller" : "worker") : operation;
    rows.controller = [{ InstanceId: t.controller, State: { Name: "running" }, Tags: owned, SubnetId: "subnet-controller", SecurityGroups: [{ GroupId: "sg-controller" }], IamInstanceProfile: { Arn: `arn:aws:iam::${t.account}:instance-profile/fixture-controller` } }];
    rows.worker = [{ InstanceId: workerId, InstanceType: "t3.medium", ImageId: imageId, State: { Name: "running" }, Tags: tags({ ManagedBy: "agent-relay", AgentRelayDeployment: t.deployment, AgentRelayNativeAcceptance: id }), SubnetId: outputs.WorkerSubnetId, SecurityGroups: [{ GroupId: outputs.WorkerSecurityGroupId }], KeyName: outputs.WorkerKeyName, MetadataOptions: { HttpEndpoint: "disabled" }, PrivateIpAddress: "10.84.2.12" }];
    if (!Object.hasOwn(rows, key)) throw Error("Unexpected AWS operation");
    const value = structuredClone(rows[key]); change[key]?.(value); return value;
  };
  return { json, calls };
}
const temp = async t => { const directory = await mkdtemp(path.join(os.tmpdir(), "relay-native-fixture-")); t.after(() => rm(directory, { recursive: true, force: true })); return directory; };
const audit = { schema: 1, valid: true, finalized: true, cloudInitDisabled: true, ssmDisabled: true, credentialsAbsent: true, transportKeyMatches: true, freshIdentity: true, heartbeatEnabled: true, watchdogActive: true, metadataReachable: false };
const nativeResult = (result = "OK") => ({ type: "result", subtype: "success", session_id: id, result, num_turns: 1, total_cost_usd: 0.001, modelUsage: { "claude-haiku-4-5": {} } });
const goodReceipt = { schema: 1, runId: id, accepted: true, provider: "claude", turns: 2, model: "haiku", firstReplyOk: true, resumedContext: true, identityStable: true, accessOnly: true, costUsdUpperBound: 0.002, githubCredentialsTransferred: false, cleanedUp: true };

test("default plan does not invoke AWS, native models or credential readers", async () => {
  const die = () => { throw Error("Unexpected activity"); };
  const result = await smokeEc2Native(parseNativeOptions([]), { run: die, readAccess: die, guard: die, plugin: die, tunnel: die, probe: die });
  assert.equal(result.dryRun, true); assert.equal(result.maximumModelTurns, 2); assert.equal(result.githubCredentialsTransferred, false);
  for (const args of [["--run"], ["--profile", "other"], ["--token", "private"], ["--worker-id"], ["--run", "--worker-id", "*"]]) assert.throws(() => parseNativeOptions(args));
});

test("AWS guards require exact existing dedicated worker and only read public metadata", async () => {
  const fixture = awsFixture(); const target = await guardNativeTarget(options, fixture.json);
  assert.deepEqual(target, { host: "10.84.2.12", publicKey: "ssh-ed25519 AAAAFixturePublic", workerId });
  assert.ok(fixture.calls.every(args => /^(get-caller-identity|describe-|list-stack-resources)/.test(args[1])));
  assert.doesNotMatch(JSON.stringify(fixture.calls), /get-secret|start-instances|run-instances|terminate-instances/);
});

test("AWS guards fail closed on owner, production tag, network, profile, image and resource drift", async () => {
  const changes = [
    { "get-caller-identity": x => { x.Account = "999999999999"; } },
    { "describe-stacks": x => { x[0].Tags = []; } }, { "list-stack-resources": x => { x[0].PhysicalResourceId = "i-wrong"; } },
    { controller: x => { x[0].IamInstanceProfile.Arn = "arn:wrong"; } }, { controller: x => { x[0].PublicIpAddress = "1.2.3.4"; } },
    { "describe-subnets": x => { x[0].MapPublicIpOnLaunch = true; } }, { "describe-security-groups": x => { x[0].IpPermissions[0].IpRanges = [{ CidrIp: "0.0.0.0/0" }]; } },
    { "describe-images": x => { x[0].Public = true; } }, { "describe-images": x => { x[0].Tags = []; } },
    { "describe-key-pairs": x => { x[0].Tags = []; } }, { worker: x => { x[0].Tags.push({ Key: "AgentWebChat", Value: "chat_fixture" }); } },
    { worker: x => { x[0].Tags = []; } }, { worker: x => { x[0].ImageId = "ami-foreign"; } }, { worker: x => { x[0].IamInstanceProfile = { Arn: "arn:role" }; } },
    { worker: x => { x[0].MetadataOptions.HttpEndpoint = "enabled"; } }, { worker: x => { x[0].PrivateIpAddress = "8.8.8.8"; } },
    { worker: x => { x[0].NetworkInterfaces = [{ Ipv6Addresses: [{ Ipv6Address: "::1" }] }]; } },
  ];
  for (const change of changes) await assert.rejects(guardNativeTarget(options, awsFixture(change).json));
});

test("real-shaped Canonical AMI accepts inert hints but requires one encrypted EBS root and t3.medium", async () => {
  const root = { DeviceName: "/dev/sda1", Ebs: { Encrypted: true } }, hint = { DeviceName: "/dev/sdb", VirtualName: "ephemeral0" };
  const valid = awsFixture({ "describe-images": x => { x[0].BlockDeviceMappings = [root, hint, { DeviceName: "/dev/sdc", VirtualName: "ephemeral1" }]; } });
  assert.equal((await guardNativeTarget(options, valid.json)).workerId, workerId);
  for (const mapping of [[hint], [root, root], [{ ...root, Ebs: { Encrypted: false } }, hint], [root, { DeviceName: "/dev/sdc" }], [root, { ...hint, NoDevice: "" }]]) {
    await assert.rejects(guardNativeTarget(options, awsFixture({ "describe-images": x => { x[0].BlockDeviceMappings = mapping; } }).json));
  }
  await assert.rejects(guardNativeTarget(options, awsFixture({ worker: x => { x[0].InstanceType = "i3.large"; } }).json));
});

test("native acceptance refuses missing, revoked or wrong-version AMI markers before worker access", async () => {
  for (const mode of ["missing", "revoked", "id", "version"]) {
    const f = awsFixture({ "describe-images": images => {
      if (mode === "missing") images[0].Tags = images[0].Tags.filter(tag => !tag.Key.startsWith("AgentRelayAcceptance"));
      else images[0].Tags.find(tag => tag.Key === (mode === "id" ? "AgentRelayAcceptanceId" : "AgentRelayAcceptance")).Value = mode === "version" ? "verified-v2" : "invalid";
    } });
    await assert.rejects(guardNativeTarget(options, f.json), /acceptance/);
    assert.ok(!f.calls.some(args => args.includes(workerId)));
  }
});

test("host credential reader transfers only access and detects source changes without restoring", async t => {
  const directory = await temp(t), filename = path.join(directory, "credential");
  const data = { claudeAiOauth: { accessToken: "fixture-access", refreshToken: "fixture-refresh-NEVER-TRANSFER", expiresAt: Date.now() + 3600000, scopes: ["user:inference"] } };
  await writeFile(filename, JSON.stringify(data), { mode: 0o600 });
  const result = await readNativeAccess(filename);
  assert.deepEqual(Object.keys(result).sort(), ["accessToken", "assertUnchanged", "expiresAt"]); await result.assertUnchanged();
  assert.doesNotMatch(JSON.stringify(result), /refresh/);
  await writeFile(filename, JSON.stringify({ ...data, changed: true })); await assert.rejects(result.assertUnchanged());
  const link = path.join(directory, "link"); await symlink(filename, link); await assert.rejects(readNativeAccess(link));
  await writeFile(filename, JSON.stringify({ claudeAiOauth: { ...data.claudeAiOauth, expiresAt: Date.now() } })); await assert.rejects(readNativeAccess(filename));
});

function workerFixture({ resultChange = x => x, identityChange = false } = {}) {
  const calls = []; let turns = 0, identities = 0;
  const run = async (command, args, o) => {
    calls.push({ command, args, o });
    if (command === "sudo") return JSON.stringify(audit);
    if (args[0] === "--version") return "2.1.222 (Claude Code)";
    turns++; return JSON.stringify(resultChange(nativeResult(turns === 1 ? "OK" : id), turns));
  };
  const fetchImpl = async (url, o) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/profile"); assert.equal(o.headers.Authorization, "Bearer fixture-access"); assert.equal(o.redirect, "error");
    identities++; return new Response(JSON.stringify({ account: { uuid: identityChange && identities > 1 ? "different" : "account-fixture" }, organization: { uuid: "org-fixture" } }));
  };
  return { run, fetchImpl, calls };
}
test("native probe performs exactly two bounded Haiku turns with isolated profile and native resume", async t => {
  const directory = await temp(t), f = workerFixture();
  const request = { action: "run", runId: id, accessToken: "fixture-access", expiresAt: Date.now() + 3600000 };
  const receipt = await runNativeProbe(request, { ...f, rootBase: directory });
  assert.deepEqual(receipt, goodReceipt);
  const turns = f.calls.filter(c => c.args.includes("--print")); assert.equal(turns.length, 2);
  assert.ok(turns[0].args.includes("--session-id")); assert.ok(turns[1].args.includes("--resume"));
  for (const call of turns) {
    assert.equal(call.args[call.args.indexOf("--model") + 1], "haiku"); assert.equal(call.args[call.args.indexOf("--max-budget-usd") + 1], "0.05");
    assert.equal(call.args[call.args.indexOf("--tools") + 1], ""); assert.ok(call.args.includes("--strict-mcp-config"));
    assert.equal(call.o.env.CLAUDE_CODE_OAUTH_TOKEN, "fixture-access"); assert.equal(call.o.env.GH_TOKEN, undefined);
    assert.ok(call.o.env.HOME.startsWith(directory)); assert.doesNotMatch(JSON.stringify(call.args), /fixture-access|refresh/);
  }
  await assert.rejects(lstat(path.join(directory, "native-acceptance-" + id)), { code: "ENOENT" });
});

test("native probe rejects changed identity, wrong model, excess cost/context/error and removes profile", async t => {
  const directory = await temp(t);
  for (const settings of [{ identityChange: true }, { resultChange: x => ({ ...x, total_cost_usd: 0.06 }) }, { resultChange: x => ({ ...x, modelUsage: { opus: {} } }) },
    { resultChange: (x, turn) => ({ ...x, result: turn === 1 ? "OK" : "forgot" }) }, { resultChange: x => ({ ...x, is_error: true }) }]) {
    await assert.rejects(runNativeProbe({ action: "run", runId: id, accessToken: "fixture-access", expiresAt: Date.now() + 3600000 }, { ...workerFixture(settings), rootBase: directory }));
    await assert.rejects(lstat(path.join(directory, "native-acceptance-" + id)), { code: "ENOENT" });
  }
  assert.throws(() => validateNativeResult({ ...nativeResult(), session_id: "wrong" }, id, "OK"));
  await assert.rejects(runNativeProbe({ action: "run", runId: id, accessToken: "fixture-access", refreshToken: "not-allowed", expiresAt: Date.now() + 3600000 }, { ...workerFixture(), rootBase: directory }));
});

test("preflight and cleanup never use model or profile APIs; cleanup refuses symlinks", async t => {
  const directory = await temp(t), f = workerFixture();
  const receipt = await runNativeProbe({ action: "preflight", runId: id }, { run: f.run, fetchImpl: () => { throw Error(); }, rootBase: directory });
  assert.equal(receipt.credentialFree, true); assert.equal(f.calls.length, 2);
  await symlink(directory, path.join(directory, "native-acceptance-" + id));
  await assert.rejects(runNativeProbe({ action: "cleanup", runId: id }, { rootBase: directory }));
});

test("recovery cleanup refuses a still-live probe instead of falsely claiming credential removal", async t => {
  const directory = await temp(t), profile = path.join(directory, "native-acceptance-" + id);
  await mkdir(profile, { mode: 0o700 }); await writeFile(path.join(profile, "owner.json"), JSON.stringify({ runId: id, pid: process.pid }), { mode: 0o600 });
  await assert.rejects(runNativeProbe({ action: "cleanup", runId: id }, { rootBase: directory }), error => error.diagnostic.category === "profile-active" && error.diagnostic.profileCleanupConfirmed === false);
  assert.equal((await lstat(profile)).isDirectory(), true);
});

test("Session Manager extraction/execution follows pinned public key and valid signature only", async t => {
  for (const invalid of ["", "fingerprint", "signature"]) {
    const directory = await temp(t), calls = [];
    const run = async (command, args) => {
      calls.push([command, args]);
      if (args.includes("--list-keys")) return `fpr:::::::::${invalid === "fingerprint" ? "WRONG" : pluginSigner}:\n`;
      if (args.includes("--verify")) return invalid === "signature" ? "[GNUPG:] BADSIG fixture" : `[GNUPG:] VALIDSIG ${pluginSigner} timestamp`;
      if (args.includes("--version")) return "1.2.835.0\n"; return "";
    };
    const promise = prepareSessionPlugin(directory, { run, fetchImpl: async () => new Response("public-package-fixture") });
    if (invalid) { await assert.rejects(promise); assert.equal(calls.some(c => c[0] === "dpkg-deb"), false); }
    else { const result = await promise; assert.equal(result.version, "1.2.835.0"); assert.ok(calls.findIndex(c => c[1].includes("--verify")) < calls.findIndex(c => c[0] === "dpkg-deb")); }
  }
});

test("checked-in public AWS signing key has the pinned official fingerprint", async t => {
  const directory = await temp(t);
  const result = await runPrivate("gpg", ["--no-options", "--homedir", directory, "--batch", "--with-colons", "--show-keys", new URL("../scripts/fixtures/session-manager-signing-key.asc", import.meta.url).pathname]);
  assert.deepEqual(result.split("\n").filter(line => line.startsWith("fpr:")).map(line => line.split(":")[9]), [pluginSigner]);
});

test("SSM tunnel uses only exact controller/private destination; cleanup targets its own session", async context => {
  const directory = await temp(context), child = new EventEmitter(), calls = [];
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter() });
  const tunnel = await openNativeTunnel({ host: "10.84.2.12" }, directory, { binary: "/private/verified/session-manager-plugin" }, {
    reserve: async () => 12345, spawnImpl: (cmd, args, o) => { calls.push({ cmd, args, o }); return child; },
    sleep: async () => child.stdout.emit("data", Buffer.from("Starting session with SessionId: fixture-session-id\nPort 12345 opened for sessionId fixture-session-id")),
    kill: (target, name) => { assert.equal(target, child); calls.push({ name }); queueMicrotask(() => child.emit("close", 0)); },
    run: async (cmd, args) => { calls.push({ cmd, args }); return "{}"; },
  });
  assert.equal(tunnel.port, 12345); await tunnel.close(); await tunnel.close();
  const launch = calls[0]; assert.ok(launch.args.includes(t.controller));
  assert.deepEqual(JSON.parse(launch.args[launch.args.indexOf("--parameters") + 1]), { host: ["10.84.2.12"], portNumber: ["22"], localPortNumber: ["12345"] });
  assert.equal(calls.filter(c => c.args?.includes("terminate-session")).length, 1); assert.equal(calls.at(-1).args.at(-1), "fixture-session-id");
  const wrapper = await readFile(path.join(directory, "bin/session-manager-plugin"), "utf8");
  assert.match(wrapper, /AWS_SSM_START_SESSION_RESPONSE/); assert.match(wrapper, /exit 64/);
  assert.equal(launch.o.env.CLAUDE_CODE_OAUTH_TOKEN, undefined); assert.equal(launch.o.env.GH_TOKEN, undefined);
});

test("SSH places access only after the fixed launcher header and pins subsequent host identity", async () => {
  let captured;
  await nativeProbeOverSsh({ options, directory: "/private/fixture", tunnel: { port: 12345 }, request: { action: "run", runId: id, accessToken: "fixture-access", expiresAt: 42 },
    run: async (cmd, args, opts) => { captured = { cmd, args, opts }; return JSON.stringify(goodReceipt); } });
  assert.equal(captured.cmd, "ssh"); assert.ok(captured.args.includes("StrictHostKeyChecking=yes"));
  assert.doesNotMatch(JSON.stringify(captured.args), /fixture-access|expiresAt/);
  const newline = captured.opts.input.indexOf("\n"), header = captured.opts.input.slice(0, newline);
  assert.equal(JSON.parse(header).heartbeat, "/opt/agent-web/.heartbeat"); assert.equal(header.includes("fixture-access"), false);
  assert.equal(JSON.parse(captured.opts.input.slice(newline + 1)).accessToken, "fixture-access");
});

test("orchestrator gates credentials after native preflight, safely allowlists receipts and closes tunnel", async t => {
  const directory = await temp(t), key = path.join(directory, "key"); await writeFile(key, "fixture", { mode: 0o600 });
  const events = [], target = { publicKey: "ssh-ed25519 AAAAFixturePublic", host: "10.84.2.12" };
  const deps = { run: async (cmd, args) => cmd === "aws" && args[0] === "--version" ? "aws-cli/2.35.20 fixture" : "ssh-ed25519 AAAAFixturePublic",
    guard: async () => { events.push("guard"); return target; }, plugin: async () => { events.push("plugin"); return {}; },
    tunnel: async () => ({ close: async () => { events.push("closed"); } }), readAccess: async () => { events.push("credential-read"); return { accessToken: "fixture-access", expiresAt: 1, assertUnchanged: async () => { events.push("unchanged"); } }; },
    probe: async ({ request }) => { events.push(request.action); return request.action === "run" ? { ...goodReceipt, extra: "PRIVATE-DO-NOT-PRINT" } : { schema: 1, runId: id, preflight: true, credentialFree: true, cleanedUp: true }; } };
  const receipt = await smokeEc2Native({ ...options, sshKey: key }, deps);
  assert.ok(events.indexOf("credential-read") > events.indexOf("preflight")); assert.ok(events.indexOf("unchanged") < events.indexOf("closed"));
  assert.equal(receipt.workerRetirementRequired, true); assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|fixture-access/);
  events.length = 0;
  await assert.rejects(smokeEc2Native({ ...options, sshKey: key }, { ...deps, probe: async ({ request }) => { events.push(request.action); if (request.action === "run") throw Error("PRIVATE-DO-NOT-PRINT"); return { schema: 1, runId: id, preflight: true, credentialFree: true, cleanedUp: true }; } }));
  assert.ok(events.includes("cleanup")); assert.ok(events.includes("unchanged")); assert.ok(events.includes("closed"));
  events.length = 0;
  await assert.rejects(smokeEc2Native({ ...options, sshKey: key }, { ...deps, probe: async ({ request }) => {
    events.push(request.action);
    if (request.action === "run") return { ...goodReceipt, runId: "wrong", cleanedUp: true };
    return { schema: 1, runId: id, preflight: true, credentialFree: true, cleanedUp: true };
  } }));
  assert.ok(events.includes("cleanup"), "unvalidated cleanedUp cannot suppress exact recovery");
});

test("private subprocess errors suppress stdout/stderr/arguments and terminate on timeout", async () => {
  await assert.rejects(runPrivate(process.execPath, ["-e", "console.error('fixture-secret'); process.exit(2)"]), error => !error.message.includes("fixture-secret"));
  await assert.rejects(runPrivate(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { timeout: 20 }));
  assert.throws(() => validateProbeReceipt({ ...goodReceipt, turns: 3 }, id, "run"));
});

test("source diagnostics distinguish schema, scope, expired, short-lived and unsafe files without values", async t => {
  const directory = await temp(t), file = path.join(directory, "PRIVATE-PATH");
  const credential = { accessToken: "PRIVATE-ACCESS", refreshToken: "PRIVATE-REFRESH", expiresAt: Date.now() + 3600000, scopes: ["user:inference"] };
  for (const [value, category] of [["PRIVATE-NOT-JSON", "source-schema"], [JSON.stringify({ claudeAiOauth: { ...credential, scopes: [] } }), "source-scope"],
    [JSON.stringify({ claudeAiOauth: { ...credential, expiresAt: Date.now() - 1 } }), "source-access-expired"],
    [JSON.stringify({ claudeAiOauth: { ...credential, expiresAt: Date.now() + 10000 } }), "source-access-too-short"]]) {
    await writeFile(file, value, { mode: 0o600 });
    await assert.rejects(readNativeAccess(file), error => {
      const receipt = nativeFailureReceipt(error); assert.equal(receipt.diagnostic.category, category); assert.equal(receipt.diagnostic.stage, "source-access");
      assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE/); assert.equal(error.cause, undefined); return true;
    });
  }
  await chmod(file, 0o644); await assert.rejects(readNativeAccess(file), error => error.diagnostic.category === "source-file-permissions");
  await assert.rejects(readNativeAccess(path.join(directory, "missing")), error => error.diagnostic.category === "source-file-unavailable");
});

test("remote failure envelope is bound to schema, run and action, and excludes private or arbitrary fields", async () => {
  const request = { action: "run", runId: id };
  const envelope = remoteNativeFailure(new NativeAcceptanceError("first-turn", "command-timeout", { profileCleanupAttempted: true, profileCleanupConfirmed: true }), request);
  const invoke = value => nativeProbeOverSsh({ options, directory: "/private/fixture", tunnel: { port: 12345 }, request,
    run: async () => JSON.stringify(value) });
  await assert.rejects(invoke({ ...envelope, PRIVATE: "PRIVATE-SECRET", diagnostic: { ...envelope.diagnostic, cause: "PRIVATE-PATH" } }), error => {
    assert.deepEqual(error.diagnostic, { stage: "first-turn", category: "command-timeout", profileCleanupAttempted: true, profileCleanupConfirmed: true });
    assert.doesNotMatch(JSON.stringify(nativeFailureReceipt(error)), /PRIVATE/); return true;
  });
  for (const value of [{ ...envelope, schema: 2 }, { ...envelope, runId: "foreign" }, { ...envelope, action: "cleanup" },
    { ...envelope, diagnostic: { ...envelope.diagnostic, stage: "PRIVATE-STAGE" } },
    { ...envelope, diagnostic: { ...envelope.diagnostic, category: "PRIVATE-ERROR" } },
    { ...envelope, diagnostic: { ...envelope.diagnostic, profileCleanupConfirmed: "true" } }]) {
    await assert.rejects(invoke(value), error => error.diagnostic.stage === "ssh-receipt" && error.diagnostic.category === "invalid-receipt");
  }
  assert.deepEqual(nativeFailureReceipt(Object.assign(Error("PRIVATE"), { diagnostic: { stage: "PRIVATE", category: "PRIVATE" }, cause: Error("PRIVATE") })).diagnostic, { stage: "unknown", category: "failed" });
});

test("worker fixed phases distinguish identity denial, rate limit, first result and resume failures", async t => {
  const directory = await temp(t), request = { action: "run", runId: id, accessToken: "fixture-access", expiresAt: Date.now() + 3600000 };
  for (const status of [401, 429]) {
    await assert.rejects(runNativeProbe(request, { ...workerFixture(), rootBase: directory, fetchImpl: async () => new Response("PRIVATE-PROVIDER-BODY", { status }) }), error => {
      assert.equal(error.diagnostic.stage, "identity-before"); assert.equal(error.diagnostic.category, status === 401 ? "identity-auth-rejected" : "identity-rate-limited");
      assert.equal(error.diagnostic.profileCleanupConfirmed, true); assert.doesNotMatch(JSON.stringify(nativeFailureReceipt(error)), /PRIVATE/); return true;
    });
  }
  for (const failedTurn of [1, 2]) {
    const f = workerFixture(); let turn = 0;
    await assert.rejects(runNativeProbe(request, { ...f, rootBase: directory, run: async (command, args, opts) => {
      if (args.includes("--print") && ++turn === failedTurn) return "PRIVATE-INVALID-JSON";
      return f.run(command, args, opts);
    } }), error => {
      assert.equal(error.diagnostic.stage, failedTurn === 1 ? "first-result" : "resume-result"); assert.equal(error.diagnostic.category, "invalid-json");
      assert.equal(error.diagnostic.profileCleanupConfirmed, true); assert.doesNotMatch(JSON.stringify(nativeFailureReceipt(error)), /PRIVATE/); return true;
    });
  }
});

test("worker preserves primary identity failure when exact profile cleanup is refused", async t => {
  const directory = await temp(t), request = { action: "run", runId: id, accessToken: "fixture-access", expiresAt: Date.now() + 3600000 };
  await assert.rejects(runNativeProbe(request, { ...workerFixture(), rootBase: directory, fetchImpl: async () => {
    await writeFile(path.join(directory, "native-acceptance-" + id, "owner.json"), JSON.stringify({ runId: "different", pid: process.pid }));
    return new Response("PRIVATE-BODY", { status: 401 });
  } }), error => {
    assert.equal(error.diagnostic.category, "identity-auth-rejected"); assert.equal(error.diagnostic.stage, "identity-before");
    assert.equal(error.diagnostic.profileCleanupAttempted, true); assert.equal(error.diagnostic.profileCleanupConfirmed, false); return true;
  });
});

test("operator preserves primary failure and reports independent cleanup/source flags", async t => {
  const directory = await temp(t), key = path.join(directory, "key"); await writeFile(key, "fixture", { mode: 0o600 });
  const primary = new NativeAcceptanceError("first-turn", "command-failed");
  const deps = { run: async (cmd, args) => cmd === "aws" && args[0] === "--version" ? "aws-cli/2.35.20 fixture" : "ssh-ed25519 AAAAFixturePublic",
    guard: async () => ({ publicKey: "ssh-ed25519 AAAAFixturePublic", host: "10.84.2.12" }), plugin: async () => ({}),
    tunnel: async () => ({ close: async () => { throw Error("PRIVATE-SESSION"); } }),
    readAccess: async () => ({ accessToken: "PRIVATE-ACCESS", expiresAt: 1, assertUnchanged: async () => { throw Error("PRIVATE-SOURCE"); } }),
    probe: async ({ request }) => { if (request.action === "preflight") return { schema: 1, runId: id, preflight: true, credentialFree: true }; if (request.action === "run") throw primary; throw Error("PRIVATE-CLEANUP"); } };
  await assert.rejects(smokeEc2Native({ ...options, sshKey: key }, deps), error => {
    assert.deepEqual(error.diagnostic, { stage: "first-turn", category: "command-failed", profileCleanupAttempted: true, profileCleanupConfirmed: false,
      sourceCheckAttempted: true, sourceUnchanged: false, sessionCloseAttempted: true, sessionClosed: false, localCleanupAttempted: true, localCleanupConfirmed: true });
    assert.doesNotMatch(JSON.stringify(nativeFailureReceipt(error)), /PRIVATE/); return true;
  });
  await assert.rejects(smokeEc2Native(options, { run: async () => { throw Error("PRIVATE-AWS-OUTPUT"); } }), error => error.diagnostic.stage === "aws-cli");
});

test("standalone worker delivers a fixed failure envelope without running external commands", async () => {
  const source = await readFile(new URL("../scripts/fixtures/ec2-native-worker.mjs", import.meta.url), "utf8");
  const output = await runPrivate(process.execPath, ["--input-type=module", "-e", source, "--", "--relay-native-probe"], { input: JSON.stringify({ runId: id, action: "PRIVATE-INVALID-ACTION", token: "PRIVATE-TOKEN" }) });
  const envelope = JSON.parse(output);
  assert.equal(envelope.failed, true); assert.equal(envelope.schema, 1); assert.equal(envelope.runId, id); assert.equal(envelope.action, null);
  assert.deepEqual(envelope.diagnostic, { stage: "worker-request", category: "invalid-request" }); assert.doesNotMatch(output, /PRIVATE/);
});

test("tunnel startup failure retains safe primary stage and unconfirmed session cleanup", async t => {
  const directory = await temp(t), child = new EventEmitter();
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter() });
  await assert.rejects(openNativeTunnel({ host: "10.84.2.12" }, directory, { binary: "/private/fixture" }, {
    reserve: async () => 12345, spawnImpl: () => child, sleep: async () => child.emit("close", 1),
    kill: () => { throw Error("PRIVATE-KILL"); }, run: async () => { throw Error("PRIVATE-CLEANUP"); },
  }), error => {
    assert.deepEqual(error.diagnostic, { stage: "ssm-tunnel", category: "failed", sessionCloseAttempted: true, sessionClosed: false });
    assert.doesNotMatch(JSON.stringify(nativeFailureReceipt(error)), /PRIVATE/); return true;
  });
});

test("outer CLI fails with only a fixed diagnostic receipt before any AWS call", () => {
  const result = spawnSync(process.execPath, [new URL("../scripts/smoke-ec2-native.mjs", import.meta.url).pathname, "--PRIVATE-UNKNOWN-ARGUMENT"], { encoding: "utf8", env: { PATH: "", LANG: "C.UTF-8" } });
  assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.doesNotMatch(result.stderr, /PRIVATE|\.mjs:| at /);
  const receipt = JSON.parse(result.stderr.split("\n")[0]);
  assert.equal(receipt.accepted, false); assert.deepEqual(receipt.diagnostic, { stage: "arguments", category: "failed" });
});
