import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseVerificationOptions, verifyHibernationImage, verifyReceipt, verifyWorkerImage } from "../deploy/aws/verify-worker-ami.mjs";

const options = parseVerificationOptions(["--region", "us-east-2", "--expected-account", "123456789012", "--deployment", "relay-fixture", "--image-id", "ami-aaaaaaaaaaaaaaaaa"]);
const workerId = "i-aaaaaaaaaaaaaaaaa", controllerId = "i-ccccccccccccccccc";
const infrastructureTags = [{ Key: "ManagedBy", Value: "12-apps-ci" }, { Key: "AgentRelayDeployment", Value: "relay-fixture" }];
const outputs = { DeploymentName: "relay-fixture", ControllerInstanceId: controllerId, SecretArn: "arn:aws:secretsmanager:us-east-2:123456789012:secret:relay-fixture-test", WorkerSubnetId: "subnet-aaaaaaaaaaaaaaaaa", WorkerSecurityGroupId: "sg-aaaaaaaaaaaaaaaaa", WorkerKeyName: "relay-fixture-worker" };
const resources = [["Controller", "AWS::EC2::Instance", controllerId], ["ApplicationSecret", "AWS::SecretsManager::Secret", outputs.SecretArn], ["WorkerSubnet", "AWS::EC2::Subnet", outputs.WorkerSubnetId], ["WorkerGroup", "AWS::EC2::SecurityGroup", outputs.WorkerSecurityGroupId], ["WorkerKey", "AWS::EC2::KeyPair", outputs.WorkerKeyName], ["ControllerGroup", "AWS::EC2::SecurityGroup", "sg-ccccccccccccccccc"], ["ControllerSubnet", "AWS::EC2::Subnet", "subnet-ccccccccccccccccc"], ["ControllerProfile", "AWS::IAM::InstanceProfile", "fixture-controller"]].map(([LogicalResourceId, ResourceType, PhysicalResourceId]) => ({ LogicalResourceId, ResourceType, PhysicalResourceId }));

function receipt(payload) {
  return { schema: 1, verificationId: payload.verificationId, workerId, phase: payload.phase, heartbeatFresh: true, sentinelPresent: true, versions: { codex: "codex-cli 0.154.0", claude: "2.1.222 (Claude Code)" }, knownHosts: `verify-${workerId} ssh-ed25519 AAAAFixturePublicKey\n`,
    ...(payload.hibernation ? { processIdentity: payload.processIdentity || "d".repeat(64) } : {}),
    audit: { schema: 1, valid: true, finalized: true, cloudInitDisabled: true, ssmDisabled: true, credentialsAbsent: true, transportKeyMatches: true, freshIdentity: true, heartbeatEnabled: true, watchdogActive: true, metadataReachable: false, machine: "a".repeat(64), hostKeys: { "ssh_host_ed25519_key.pub": "b".repeat(64) } } };
}

function fixture({ account = "123456789012", stackOutputs = outputs, controllerOverride = {}, imageOverride = {}, networkOverride = {}, workerOverride = {}, mutateReceipt = r => r, commandFailed = false, driftAfterLaunch = false, noCleanup = false, detachedShutdown = false, shutdownBeforeCleanup = false, driftDuringCleanup = false, markerFailure = false, markerReadbackFailure = false, imageDrift = {}, volumeStuck = false, volumeDrift = false, hibernation = false, hibernationWarmupFailures = 0 } = {}) {
  const calls = [], requests = [];
  let workerTags, state = "running", result, acceptanceTags = [], imageReads = 0;
  const run = async args => {
    calls.push(args);
    const reply = value => JSON.stringify(value);
    if (args.includes("get-caller-identity")) return reply({ Account: account });
    if (args.includes("describe-stacks")) return reply([{ StackName: "relay-fixture", StackId: "arn:aws:cloudformation:us-east-2:123456789012:stack/relay-fixture/fixture", StackStatus: "CREATE_COMPLETE", Tags: infrastructureTags, Outputs: Object.entries(stackOutputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }]);
    if (args.includes("list-stack-resources")) return reply(resources);
    if (args.includes("describe-subnets")) return reply([{ SubnetId: outputs.WorkerSubnetId, OwnerId: account, Tags: infrastructureTags, MapPublicIpOnLaunch: false, VpcId: "vpc-fixture", ...networkOverride }]);
    if (args.includes("describe-security-groups")) return reply([{ GroupId: outputs.WorkerSecurityGroupId, OwnerId: account, Tags: infrastructureTags, VpcId: "vpc-fixture", IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, UserIdGroupPairs: [{ GroupId: "sg-ccccccccccccccccc" }] }] }]);
    if (args.includes("describe-images")) return reply([{ ImageId: options.imageId, OwnerId: account, State: "available", Architecture: "x86_64", Public: false, RootDeviceType: "ebs", RootDeviceName: "/dev/sda1", BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { Encrypted: true, VolumeSize: 20 } }], Tags: [...Object.entries({ ManagedBy: "agent-relay", AgentRelayDeployment: "relay-fixture", AgentRelayWorkerKey: outputs.WorkerKeyName, CodexVersion: "0.154.0", ClaudeVersion: "2.1.222",
      ...(hibernation ? { AgentRelaySupervisor: "v3", AgentRelayHibernation: "candidate-v1" } : {}) }).map(([Key, Value]) => ({ Key, Value })), ...acceptanceTags], ...imageOverride, ...(imageReads++ > 0 ? imageDrift : {}) }]);
    if (args.includes("create-tags")) {
      assert.equal(state, "terminated");
      assert.equal(args[args.indexOf("--resources") + 1], options.imageId);
      if (markerFailure) throw Error("PRIVATE MARKER FAILURE");
      if (!markerReadbackFailure) acceptanceTags = JSON.parse(args[args.indexOf("--tags") + 1]);
      return "";
    }
    if (args.includes("describe-volumes")) return reply(state === "terminated" && !volumeStuck ? [] : [{ VolumeId: "vol-aaaaaaaaaaaaaaaaa", Encrypted: true, Tags: volumeDrift ? [] : workerTags, Attachments: [{ InstanceId: workerId }] }]);
    if (args.includes("describe-key-pairs")) return reply([{ KeyName: outputs.WorkerKeyName, Tags: infrastructureTags, PublicKey: "ssh-ed25519 AAAAFixturePublicKey comment\n" }]);
    if (args.includes("describe-instances")) {
      if (args.includes(controllerId)) return reply([{ InstanceId: controllerId, State: { Name: "running" }, Tags: infrastructureTags, SubnetId: "subnet-ccccccccccccccccc", SecurityGroups: [{ GroupId: "sg-ccccccccccccccccc" }], IamInstanceProfile: { Arn: "arn:aws:iam::123456789012:instance-profile/fixture-controller" }, ...controllerOverride }]);
      const base = { InstanceId: workerId, ImageId: options.imageId, State: { Name: state }, Tags: driftAfterLaunch || driftDuringCleanup && state === "shutting-down" ? [] : workerTags, ...workerOverride };
      if (["shutting-down", "terminated"].includes(state)) { if (state === "shutting-down") state = "terminated"; return reply([base]); }
      return reply([{ ...base, SubnetId: outputs.WorkerSubnetId, SecurityGroups: [{ GroupId: outputs.WorkerSecurityGroupId }], KeyName: outputs.WorkerKeyName, MetadataOptions: { HttpEndpoint: "disabled" }, PrivateIpAddress: "10.84.2.22", BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeId: "vol-aaaaaaaaaaaaaaaaa", DeleteOnTermination: true } }],
        ...(hibernation ? { HibernationOptions: { Configured: true } } : {}), ...workerOverride }]);
    }
    if (args.includes("run-instances")) { workerTags = JSON.parse(args[args.indexOf("--tag-specifications") + 1])[0].Tags; return reply(workerId); }
    if (args.includes("send-command")) {
      const parameters = JSON.parse(args[args.indexOf("--parameters") + 1]);
      const encoded = parameters.commands[0].match(/'([A-Za-z0-9+/=]+)'$/)[1];
      const payload = JSON.parse(Buffer.from(encoded, "base64").toString());
      requests.push(payload);
      result = mutateReceipt(receipt(payload));
      return reply({ Command: { CommandId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } });
    }
    if (args.includes("get-command-invocation")) { if (shutdownBeforeCleanup) state = "shutting-down"; return reply({ Status: commandFailed ? "Failed" : "Success", ResponseCode: commandFailed ? 1 : 0, StandardOutputContent: JSON.stringify(result), StandardErrorContent: "DO NOT PRINT PRIVATE OUTPUT" }); }
    if (args.includes("stop-instances")) {
      if (hibernationWarmupFailures-- > 0) throw Object.assign(Error("PRIVATE HIBERNATION DETAIL"), { code: "hibernation-warming" });
      state = "stopped"; return "";
    }
    if (args.includes("start-instances")) { state = "running"; return ""; }
    if (args.includes("terminate-instances")) { if (!noCleanup) state = detachedShutdown ? "shutting-down" : "terminated"; return ""; }
    throw new Error("Unexpected fixture AWS call");
  };
  return { calls, requests, run };
}

test("worker acceptance dry-run makes zero AWS calls and requires explicit account/region/deployment/image", async () => {
  const result = await verifyWorkerImage({ ...options, dryRun: true }, { run: () => { throw new Error("must not run"); } });
  assert.equal(result.dryRun, true);
  assert.equal(result.promptsSent, false);
  for (const args of [[], ["--expected-account", "123456789012"], ["--image-id", "ami-*"], ["--secret", "private"]]) assert.throws(() => parseVerificationOptions(args));
});

test("AMI acceptance recognizes inert Canonical instance-store hints but rejects missing or unencrypted EBS roots", async () => {
  const root = { DeviceName: "/dev/sda1", Ebs: { Encrypted: true, VolumeSize: 20 } };
  const hint = { DeviceName: "/dev/sdb", VirtualName: "ephemeral0" };
  const valid = fixture({ imageOverride: { BlockDeviceMappings: [root, hint] } });
  assert.equal((await verifyWorkerImage(options, { run: valid.run, sleep: async () => {} })).accepted, true);
  const reversed = fixture({ imageOverride: { BlockDeviceMappings: [hint, root] } });
  assert.equal((await verifyWorkerImage(options, { run: reversed.run, sleep: async () => {} })).accepted, true);
  for (const mapping of [[hint], [{ ...root, Ebs: { Encrypted: false } }, hint], [root, { DeviceName: "/dev/sdc" }], [root, { ...hint, VirtualName: "unknown" }], [root, { ...hint, NoDevice: "" }]]) {
    const f = fixture({ imageOverride: { BlockDeviceMappings: mapping } });
    await assert.rejects(verifyWorkerImage(options, { run: f.run, sleep: async () => {} }), /private encrypted/);
    assert.ok(!f.calls.some(call => call.includes("run-instances")));
  }
});

test("fresh acceptance proves isolated boot, stop/start persistence, pinned host identity and exact cleanup", async () => {
  const f = fixture(), logs = [];
  const result = await verifyWorkerImage(options, { run: f.run, sleep: async () => {}, log: line => logs.push(line) });
  assert.equal(result.accepted, true);
  assert.equal(result.cleanedUp, true);
  assert.equal(result.promptsSent, false);
  assert.equal(result.accountImports, false);
  assert.deepEqual(result.acceptance, { version: "verified-v1", verificationId: result.verificationId, confirmed: true });
  assert.equal(result.volumesRemoved, 1);
  assert.ok(Object.values(result.checks).every(value => value === true));
  assert.deepEqual(f.requests.map(p => p.phase), ["fresh", "resumed"]);
  assert.equal(f.requests[1].knownHosts, receipt(f.requests[0]).knownHosts);
  assert.equal(f.requests[1].sentinel, f.requests[0].sentinel);
  assert.equal(f.requests[0].secretArn, outputs.SecretArn);
  const launch = f.calls.find(c => c.includes("run-instances"));
  assert.ok(launch.includes("HttpTokens=required,HttpEndpoint=disabled"));
  assert.equal(launch.includes("--iam-instance-profile"), false);
  assert.equal(JSON.parse(launch[launch.indexOf("--network-interfaces") + 1])[0].AssociatePublicIpAddress, false);
  assert.equal(f.calls.some(c => c.includes("get-secret-value")), false, "operator must not retrieve secrets");
  for (const command of ["stop-instances", "start-instances", "terminate-instances"]) assert.equal(f.calls.find(c => c.includes(command)).at(-1), workerId);
  const send = f.calls.find(c => c.includes("send-command"));
  assert.ok(send.includes(controllerId));
  const parameters = JSON.parse(send[send.indexOf("--parameters") + 1]);
  assert.deepEqual(parameters.executionTimeout, ["420"]);
  assert.ok(parameters.commands[0].length < 16_000, "compressed controller probe must stay within the Run Command string limit");
  assert.match(parameters.commands[0], /import base64,gzip;exec\(gzip\.decompress/);
  assert.doesNotMatch(JSON.stringify(result) + logs.join(""), /PRIVATE OUTPUT|SecretString|knownHosts/);
  assert.equal(JSON.stringify(result).includes(f.requests[0].sentinel), false);
  const markerIndex = f.calls.findIndex(call => call.includes("create-tags"));
  assert.ok(markerIndex > f.calls.findIndex(call => call.includes("terminate-instances")));
  assert.ok(f.calls.slice(0, markerIndex).some(call => call.includes("describe-volumes")));
});

test("ordinary acceptance cannot mark a hibernation candidate", async () => {
  const f = fixture({ imageOverride: { Tags: [{ Key: "AgentRelayHibernation", Value: "candidate-v1" }] } });
  await assert.rejects(verifyWorkerImage(options, { run: f.run }), /requires process-resume acceptance/);
  assert.equal(f.calls.some(c => c.includes("run-instances") || c.includes("create-tags")), false);
});

test("dedicated hibernation acceptance proves one native process survives and marks only the exact candidate", async () => {
  const f = fixture({ hibernation: true }), logs = [];
  const result = await verifyHibernationImage(options, { run: f.run, sleep: async () => {}, log: line => logs.push(line) });
  assert.equal(result.accepted, true); assert.equal(result.cleanedUp, true);
  assert.deepEqual(result.acceptance, { version: "verified-v1", verificationId: result.verificationId, confirmed: true, kind: "hibernation" });
  assert.equal(result.evidence.processIdentity, "d".repeat(64));
  assert.equal(result.checks.nativeProcessSurvivedHibernation, true);
  assert.deepEqual(f.requests.map(request => [request.phase, request.hibernation]), [["fresh", true], ["resumed", true]]);
  assert.equal(f.requests[1].processIdentity, "d".repeat(64));
  const launch = f.calls.find(call => call.includes("run-instances"));
  assert.deepEqual(launch.slice(launch.indexOf("--hibernation-options"), launch.indexOf("--hibernation-options") + 2), ["--hibernation-options", "Configured=true"]);
  const stop = f.calls.find(call => call.includes("stop-instances")); assert.ok(stop.includes("--hibernate"));
  const tags = JSON.parse(f.calls.find(call => call.includes("create-tags"))[f.calls.find(call => call.includes("create-tags")).indexOf("--tags") + 1]);
  assert.deepEqual(tags.map(tag => tag.Key), ["AgentRelayHibernationAcceptance", "AgentRelayHibernationAcceptanceId"]);
  assert.doesNotMatch(JSON.stringify(result) + logs.join(""), /knownHosts|AAAAFixturePublicKey/);
});

test("hibernation retries only the bounded EC2 warmup response and rechecks exact worker ownership", async () => {
  const f = fixture({ hibernation: true, hibernationWarmupFailures: 2 });
  const sleeps = [], logs = [];
  const result = await verifyHibernationImage(options, { run: f.run, sleep: async ms => sleeps.push(ms), log: line => logs.push(line) });
  assert.equal(result.accepted, true);
  assert.equal(f.calls.filter(call => call.includes("stop-instances")).length, 3);
  assert.deepEqual(sleeps.filter(ms => ms === 15_000), [15_000, 15_000]);
  assert.equal(logs.filter(line => line.includes("hibernation is still warming up")).length, 1);
  const firstStop = f.calls.findIndex(call => call.includes("stop-instances"));
  const thirdStop = f.calls.findLastIndex(call => call.includes("stop-instances"));
  assert.ok(f.calls.slice(firstStop + 1, thirdStop).some(call => call.includes("describe-instances") && call.includes(workerId)));
  assert.doesNotMatch(JSON.stringify(result) + logs.join(""), /PRIVATE HIBERNATION DETAIL/);
});

test("hibernation warmup retry is bounded and unrelated stop errors are immediate", async () => {
  const warming = fixture({ hibernation: true, hibernationWarmupFailures: 20 });
  await assert.rejects(verifyHibernationImage(options, { run: warming.run, sleep: async () => {} }), /PRIVATE HIBERNATION DETAIL/);
  assert.equal(warming.calls.filter(call => call.includes("stop-instances")).length, 13);

  const unrelated = fixture({ hibernation: true });
  let failed = false;
  const run = async args => {
    if (!failed && args.includes("stop-instances")) { failed = true; throw Object.assign(Error("UNRELATED"), { code: "AccessDenied" }); }
    return unrelated.run(args);
  };
  await assert.rejects(verifyHibernationImage(options, { run, sleep: async () => {} }), /UNRELATED/);
  assert.equal(unrelated.calls.filter(call => call.includes("stop-instances")).length, 0);
});

test("hibernation acceptance rejects missing candidate evidence and changed native process identity without marking", async () => {
  const ordinary = fixture();
  await assert.rejects(verifyHibernationImage(options, { run: ordinary.run, sleep: async () => {} }), /candidate recipe/);
  assert.equal(ordinary.calls.some(call => call.includes("run-instances") || call.includes("create-tags")), false);

  const changed = fixture({ hibernation: true, mutateReceipt: receipt => receipt.phase === "resumed" ? { ...receipt, processIdentity: "e".repeat(64) } : receipt });
  await assert.rejects(verifyHibernationImage(options, { run: changed.run, sleep: async () => {} }), /receipt failed validation/);
  assert.equal(changed.calls.filter(call => call.includes("terminate-instances")).length, 1);
  assert.equal(changed.calls.some(call => call.includes("create-tags")), false);
});

test("hibernation acceptance dry-run is read-only and names its process continuity gate", async () => {
  const result = await verifyHibernationImage({ ...options, dryRun: true }, { run: () => { throw Error("must not run"); } });
  assert.ok(result.actions.includes("native-process-hibernate-resume"));
  assert.ok(result.actions.includes("mark-exact-hibernation-accepted-image"));
});

test("acceptance refuses foreign identity/network/image/controller/secret before creating resources", async () => {
  for (const change of [{ account: "999999999999" }, { networkOverride: { MapPublicIpOnLaunch: true } }, { imageOverride: { Public: true } }, { imageOverride: { Tags: [] } }, { imageOverride: { OwnerId: "999999999999" } }, { controllerOverride: { PublicIpAddress: "1.2.3.4" } }, { controllerOverride: { IamInstanceProfile: { Arn: "wrong" } } }, { stackOutputs: { ...outputs, SecretArn: "arn:aws:secretsmanager:us-east-2:123456789012:secret:unrelated" } }]) {
    const f = fixture(change);
    await assert.rejects(verifyWorkerImage(options, { run: f.run, sleep: async () => {} }));
    assert.equal(f.calls.some(c => c.includes("run-instances") || c.includes("send-command") || c.includes("terminate-instances")), false);
  }
});

test("failed/malformed audits never claim acceptance and terminate only the verified test worker", async () => {
  for (const change of [{ commandFailed: true }, { mutateReceipt: r => ({ ...r, audit: { ...r.audit, credentialsAbsent: false } }) }, { mutateReceipt: r => ({ ...r, sentinelPresent: false }) }, { mutateReceipt: r => ({ ...r, workerId: controllerId }) }, { mutateReceipt: r => ({ ...r, knownHosts: "@cert-authority * bad-key" }) }, { mutateReceipt: r => r.phase === "resumed" ? { ...r, audit: { ...r.audit, machine: "c".repeat(64) } } : r }]) {
    const f = fixture(change);
    await assert.rejects(verifyWorkerImage(options, { run: f.run, sleep: async () => {} }), error => !error.message.includes("DO NOT PRINT"));
    assert.equal(f.calls.filter(c => c.includes("terminate-instances")).length, 1);
    assert.equal(f.calls.find(c => c.includes("terminate-instances")).at(-1), workerId);
    assert.equal(f.calls.some(c => c.includes("create-tags")), false);
  }
});

test("changed ownership blocks mutation; cleanup timeout cannot produce a success receipt", async () => {
  const foreign = fixture({ driftAfterLaunch: true });
  await assert.rejects(verifyWorkerImage(options, { run: foreign.run, sleep: async () => {} }), /ownership changed/);
  assert.equal(foreign.calls.some(c => c.includes("terminate-instances") || c.includes("send-command")), false);
  const stuck = fixture({ noCleanup: true });
  await assert.rejects(verifyWorkerImage(options, { run: stuck.run, sleep: async () => {}, pollLimit: 2 }), /test worker termination/);
  assert.equal(stuck.calls.some(call => call.includes("create-tags")), false);
});

test("acceptance marker requires confirmed encrypted-volume cleanup and unchanged image identity", async () => {
  for (const change of [
    { volumeStuck: true }, { volumeDrift: true },
    { imageDrift: { OwnerId: "999999999999" } }, { imageDrift: { Public: true } },
    { imageDrift: { Tags: [] } }, { imageDrift: { ImageId: "ami-bbbbbbbbbbbbbbbbb" } },
    { imageDrift: { BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { Encrypted: true, VolumeSize: 20, SnapshotId: "snap-changed" } }] } },
  ]) {
    const f = fixture(change);
    await assert.rejects(verifyWorkerImage(options, { run: f.run, sleep: async () => {}, pollLimit: 2 }));
    assert.equal(f.calls.some(call => call.includes("create-tags")), false);
    assert.equal(f.calls.filter(call => call.includes("terminate-instances")).length, 1);
  }
});

test("marker write or readback failure never returns accepted receipt or leaks provider output", async () => {
  for (const change of [{ markerFailure: true }, { markerReadbackFailure: true }]) {
    const f = fixture(change);
    await assert.rejects(verifyWorkerImage(options, { run: f.run, sleep: async () => {} }), error => {
      assert.match(error.message, /acceptance marker was not confirmed/);
      assert.doesNotMatch(error.message, /PRIVATE MARKER/); return true;
    });
    assert.equal(f.calls.filter(call => call.includes("create-tags")).length, 1);
    assert.equal(f.calls.filter(call => call.includes("terminate-instances")).length, 1);
  }
});

test("termination observation tolerates detached interfaces only for an exactly owned shutting-down worker", async () => {
  const success = fixture({ detachedShutdown: true });
  assert.equal((await verifyWorkerImage(options, { run: success.run, sleep: async () => {} })).cleanedUp, true);
  assert.equal(success.calls.filter(call => call.includes("terminate-instances")).length, 1);
  for (const shutdownBeforeCleanup of [false, true]) {
    const failed = fixture({ commandFailed: true, detachedShutdown: true, shutdownBeforeCleanup });
    await assert.rejects(verifyWorkerImage(options, { run: failed.run, sleep: async () => {} }), /Worker acceptance audit failed \(fresh\).*private output suppressed$/);
    assert.equal(failed.calls.filter(call => call.includes("terminate-instances")).length, shutdownBeforeCleanup ? 0 : 1);
  }
  const foreign = fixture({ detachedShutdown: true, driftDuringCleanup: true });
  await assert.rejects(verifyWorkerImage(options, { run: foreign.run, sleep: async () => {} }), /ownership changed/);
  assert.equal(foreign.calls.filter(call => call.includes("terminate-instances")).length, 1);
});

test("failed cleanup retains the original probe reason and never prints arbitrary diagnostics", async () => {
  const failed = fixture({ commandFailed: true, noCleanup: true, mutateReceipt: () => ({ diagnostic: { stage: "worker-probe", category: "ssh-permission-denied", exitCode: 255 }, reason: "PRIVATE SECRET", error: "PRIVATE SECRET" }) });
  await assert.rejects(verifyWorkerImage(options, { run: failed.run, sleep: async () => {}, pollLimit: 2 }), error => {
    assert.match(error.message, /Worker acceptance audit failed \(fresh\); ssh-permission-denied \(exit 255\)/);
    assert.match(error.message, /cleanup unconfirmed for acceptance worker i-aaaaaaaaaaaaaaaaa/);
    assert.doesNotMatch(error.message, /PRIVATE SECRET|DO NOT PRINT/);
    return true;
  });
  for (const diagnostic of [{ stage: "worker-probe", category: "PRIVATE SECRET", exitCode: 255 }, { stage: "PRIVATE SECRET", category: "ssh-host-key", exitCode: 255 }, { stage: "worker-probe", category: "ssh-host-key", exitCode: "PRIVATE SECRET" }]) {
    const f = fixture({ commandFailed: true, mutateReceipt: () => ({ diagnostic }) });
    await assert.rejects(verifyWorkerImage(options, { run: f.run, sleep: async () => {} }), error => !error.message.includes("PRIVATE SECRET"));
  }
});

test("image audit errors expose only fixed-name boolean checks from the controller", async () => {
  const f = fixture({ commandFailed: true, mutateReceipt: () => ({ diagnostic: { stage: "worker-probe", category: "image-audit", exitCode: 1,
    auditChecks: { finalized: true, ssmDisabled: false, credentialsAbsent: false, metadataReachable: false, freshIdentity: "PRIVATE SECRET", watchdogActive: 1, private: "PRIVATE SECRET", machine: "PRIVATE SECRET" } } }) });
  await assert.rejects(verifyWorkerImage(options, { run: f.run, sleep: async () => {} }), error => {
    assert.match(error.message, /image-audit \(exit 1\)/);
    assert.match(error.message, /finalized=true, ssmDisabled=false, credentialsAbsent=false, metadataReachable=false/);
    assert.doesNotMatch(error.message, /PRIVATE SECRET|freshIdentity=|watchdogActive=|machine=/);
    return true;
  });
});

test("image audit diagnostics expose only bounded category counts and metadata enum", async () => {
  for (const metadataProbe of ["http-403-denied", "PRIVATE SECRET"]) {
    const f = fixture({ commandFailed: true, mutateReceipt: () => ({ diagnostic: { stage: "worker-probe", category: "image-audit", exitCode: 1, metadataProbe,
      credentialFailureCounts: { providerAuthFiles: 0, ssmSnapFiles: 2, pemFiles: true, scanErrors: -1, ssmLibraryFiles: 1000001, ssmPackageFiles: "PRIVATE SECRET", private: "PRIVATE SECRET" } } }) });
    await assert.rejects(verifyWorkerImage(options, { run: f.run, sleep: async () => {} }), error => {
      assert.match(error.message, /credential counts: providerAuthFiles=0, ssmSnapFiles=2/);
      assert.equal(error.message.includes("metadata probe: http-403-denied"), metadataProbe === "http-403-denied");
      assert.doesNotMatch(error.message, /PRIVATE SECRET|pemFiles=|scanErrors=|ssmLibraryFiles=|ssmPackageFiles=/);
      return true;
    });
  }
});

test("receipt validation compares identity values independently of object key ordering", () => {
  const context = { verificationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", workerId, phase: "fresh" };
  const first = receipt(context);
  first.audit.hostKeys["ssh_host_rsa_key.pub"] = "c".repeat(64);
  const second = { ...first, phase: "resumed", audit: { ...first.audit, hostKeys: Object.fromEntries(Object.entries(first.audit.hostKeys).reverse()) } };
  assert.equal(verifyReceipt(second, { ...context, phase: "resumed", previous: first }), second);
});

test("probe failure details expose only fixed stages/classes and bounded helper line", async () => {
  for (const valid of [true, false]) {
    const diagnostic = { stage: "worker-probe", category: "invalid-receipt", probeStage: valid ? "image-audit-json" : "PRIVATE_STAGE", exceptionClass: valid ? "JSONDecodeError" : "PRIVATE_EXCEPTION", helperExceptionClass: valid ? "NameError" : "PRIVATE_HELPER", helperLine: valid ? 142 : 10001 };
    const f = fixture({ commandFailed: true, mutateReceipt: () => ({ diagnostic }) });
    await assert.rejects(verifyWorkerImage(options, { run: f.run, sleep: async () => {} }), error => {
      assert.doesNotMatch(error.message, /PRIVATE|10001/);
      assert.equal(error.message.includes("probe stage: image-audit-json"), valid);
      assert.equal(error.message.includes("exceptionClass=JSONDecodeError"), valid);
      assert.equal(error.message.includes("helperExceptionClass=NameError"), valid);
      assert.equal(error.message.includes("helper line: 142"), valid); return true;
    });
  }
});

test("controller probe keeps key retrieval and root-only temporary files local and isolates known hosts", async () => {
  const script = await readFile(new URL("../deploy/aws/verify-worker-controller.py", import.meta.url), "utf8");
  for (const text of ["'/dev/shm'", "0o700", "0o600", "capture_output=True", "'get-secret-value'", "AWS_SHARED_CREDENTIALS_FILE", "'/dev/null'", "ssh-keygen", "'UpdateHostKeys=no'", "'GlobalKnownHostsFile=/dev/null'", "'knownHosts'", "'resumed'", "private diagnostics suppressed"]) assert.ok(script.includes(text), text);
  assert.doesNotMatch(script, /print\((?:private_key|secret|encoded|fetched)/);
});
