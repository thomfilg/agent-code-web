import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseVerificationOptions, verifyReceipt, verifyWorkerImage } from "../deploy/aws/verify-worker-ami.mjs";

const options = parseVerificationOptions(["--region", "us-east-2", "--expected-account", "123456789012", "--deployment", "relay-fixture", "--image-id", "ami-aaaaaaaaaaaaaaaaa"]);
const workerId = "i-aaaaaaaaaaaaaaaaa", controllerId = "i-ccccccccccccccccc";
const infrastructureTags = [{ Key: "ManagedBy", Value: "12-apps-ci" }, { Key: "AgentRelayDeployment", Value: "relay-fixture" }];
const outputs = { DeploymentName: "relay-fixture", ControllerInstanceId: controllerId, SecretArn: "arn:aws:secretsmanager:us-east-2:123456789012:secret:relay-fixture-test", WorkerSubnetId: "subnet-aaaaaaaaaaaaaaaaa", WorkerSecurityGroupId: "sg-aaaaaaaaaaaaaaaaa", WorkerKeyName: "relay-fixture-worker" };
const resources = [["Controller", "AWS::EC2::Instance", controllerId], ["ApplicationSecret", "AWS::SecretsManager::Secret", outputs.SecretArn], ["WorkerSubnet", "AWS::EC2::Subnet", outputs.WorkerSubnetId], ["WorkerGroup", "AWS::EC2::SecurityGroup", outputs.WorkerSecurityGroupId], ["WorkerKey", "AWS::EC2::KeyPair", outputs.WorkerKeyName], ["ControllerGroup", "AWS::EC2::SecurityGroup", "sg-ccccccccccccccccc"], ["ControllerSubnet", "AWS::EC2::Subnet", "subnet-ccccccccccccccccc"], ["ControllerProfile", "AWS::IAM::InstanceProfile", "fixture-controller"]].map(([LogicalResourceId, ResourceType, PhysicalResourceId]) => ({ LogicalResourceId, ResourceType, PhysicalResourceId }));

function receipt(payload) {
  return { schema: 1, verificationId: payload.verificationId, workerId, phase: payload.phase, heartbeatFresh: true, sentinelPresent: true, versions: { codex: "codex-cli 0.154.0", claude: "2.1.222 (Claude Code)" }, knownHosts: `verify-${workerId} ssh-ed25519 AAAAFixturePublicKey\n`,
    audit: { schema: 1, valid: true, finalized: true, cloudInitDisabled: true, ssmDisabled: true, credentialsAbsent: true, transportKeyMatches: true, freshIdentity: true, heartbeatEnabled: true, watchdogActive: true, metadataReachable: false, machine: "a".repeat(64), hostKeys: { "ssh_host_ed25519_key.pub": "b".repeat(64) } } };
}

function fixture({ account = "123456789012", stackOutputs = outputs, controllerOverride = {}, imageOverride = {}, networkOverride = {}, workerOverride = {}, mutateReceipt = r => r, commandFailed = false, driftAfterLaunch = false, noCleanup = false } = {}) {
  const calls = [], requests = [];
  let workerTags, state = "running", result;
  const run = async args => {
    calls.push(args);
    const reply = value => JSON.stringify(value);
    if (args.includes("get-caller-identity")) return reply({ Account: account });
    if (args.includes("describe-stacks")) return reply([{ StackName: "relay-fixture", StackId: "arn:aws:cloudformation:us-east-2:123456789012:stack/relay-fixture/fixture", StackStatus: "CREATE_COMPLETE", Tags: infrastructureTags, Outputs: Object.entries(stackOutputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }]);
    if (args.includes("list-stack-resources")) return reply(resources);
    if (args.includes("describe-subnets")) return reply([{ SubnetId: outputs.WorkerSubnetId, OwnerId: account, Tags: infrastructureTags, MapPublicIpOnLaunch: false, VpcId: "vpc-fixture", ...networkOverride }]);
    if (args.includes("describe-security-groups")) return reply([{ GroupId: outputs.WorkerSecurityGroupId, OwnerId: account, Tags: infrastructureTags, VpcId: "vpc-fixture", IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, UserIdGroupPairs: [{ GroupId: "sg-ccccccccccccccccc" }] }] }]);
    if (args.includes("describe-images")) return reply([{ ImageId: options.imageId, OwnerId: account, State: "available", Architecture: "x86_64", Public: false, RootDeviceType: "ebs", RootDeviceName: "/dev/sda1", BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { Encrypted: true, VolumeSize: 20 } }], Tags: Object.entries({ ManagedBy: "agent-relay", AgentRelayDeployment: "relay-fixture", AgentRelayWorkerKey: outputs.WorkerKeyName, CodexVersion: "0.154.0", ClaudeVersion: "2.1.222" }).map(([Key, Value]) => ({ Key, Value })), ...imageOverride }]);
    if (args.includes("describe-key-pairs")) return reply([{ KeyName: outputs.WorkerKeyName, Tags: infrastructureTags, PublicKey: "ssh-ed25519 AAAAFixturePublicKey comment\n" }]);
    if (args.includes("describe-instances")) {
      if (args.includes(controllerId)) return reply([{ InstanceId: controllerId, State: { Name: "running" }, Tags: infrastructureTags, SubnetId: "subnet-ccccccccccccccccc", SecurityGroups: [{ GroupId: "sg-ccccccccccccccccc" }], IamInstanceProfile: { Arn: "arn:aws:iam::123456789012:instance-profile/fixture-controller" }, ...controllerOverride }]);
      const base = { InstanceId: workerId, ImageId: options.imageId, State: { Name: state }, Tags: driftAfterLaunch ? [] : workerTags, ...workerOverride };
      if (state === "terminated") return reply([base]);
      return reply([{ ...base, SubnetId: outputs.WorkerSubnetId, SecurityGroups: [{ GroupId: outputs.WorkerSecurityGroupId }], KeyName: outputs.WorkerKeyName, MetadataOptions: { HttpEndpoint: "disabled" }, PrivateIpAddress: "10.84.2.22", ...workerOverride }]);
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
    if (args.includes("get-command-invocation")) return reply({ Status: commandFailed ? "Failed" : "Success", ResponseCode: commandFailed ? 1 : 0, StandardOutputContent: JSON.stringify(result), StandardErrorContent: "DO NOT PRINT PRIVATE OUTPUT" });
    if (args.includes("stop-instances")) { state = "stopped"; return ""; }
    if (args.includes("start-instances")) { state = "running"; return ""; }
    if (args.includes("terminate-instances")) { if (!noCleanup) state = "terminated"; return ""; }
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
  assert.doesNotMatch(JSON.stringify(result) + logs.join(""), /PRIVATE OUTPUT|SecretString|knownHosts/);
  assert.equal(JSON.stringify(result).includes(f.requests[0].sentinel), false);
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
  }
});

test("changed ownership blocks mutation; cleanup timeout cannot produce a success receipt", async () => {
  const foreign = fixture({ driftAfterLaunch: true });
  await assert.rejects(verifyWorkerImage(options, { run: foreign.run, sleep: async () => {} }), /ownership changed/);
  assert.equal(foreign.calls.some(c => c.includes("terminate-instances") || c.includes("send-command")), false);
  const stuck = fixture({ noCleanup: true });
  await assert.rejects(verifyWorkerImage(options, { run: stuck.run, sleep: async () => {}, pollLimit: 2 }), /test worker termination/);
});

test("receipt validation compares identity values independently of object key ordering", () => {
  const context = { verificationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", workerId, phase: "fresh" };
  const first = receipt(context);
  first.audit.hostKeys["ssh_host_rsa_key.pub"] = "c".repeat(64);
  const second = { ...first, phase: "resumed", audit: { ...first.audit, hostKeys: Object.fromEntries(Object.entries(first.audit.hostKeys).reverse()) } };
  assert.equal(verifyReceipt(second, { ...context, phase: "resumed", previous: first }), second);
});

test("controller probe keeps key retrieval and root-only temporary files local and isolates known hosts", async () => {
  const script = await readFile(new URL("../deploy/aws/verify-worker-controller.py", import.meta.url), "utf8");
  for (const text of ["'/dev/shm'", "0o700", "0o600", "capture_output=True", "'get-secret-value'", "AWS_SHARED_CREDENTIALS_FILE", "'/dev/null'", "ssh-keygen", "'UpdateHostKeys=no'", "'GlobalKnownHostsFile=/dev/null'", "'knownHosts'", "'resumed'", "private diagnostics suppressed"]) assert.ok(script.includes(text), text);
  assert.doesNotMatch(script, /print\((?:private_key|secret|encoded|fetched)/);
});
