import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { bakeWorkerImage, parseOptions } from "../deploy/aws/bake-worker-ami.mjs";

const required = ["--expected-account", "123456789012", "--deployment", "relay-fixture", "--subnet-id", "subnet-aaaaaaaaaaaaaaaaa", "--security-group-id", "sg-aaaaaaaaaaaaaaaaa", "--key-name", "relay-fixture-worker", "--builder-instance-profile", "relay-fixture-builder", "--base-image-id", "ami-aaaaaaaaaaaaaaaaa"];
const builderId = "i-aaaaaaaaaaaaaaaaa";
const imageId = "ami-bbbbbbbbbbbbbbbbb";
function fixture({ commandFailed = false, neverStops = false, foreignBuilder = false, baseOverride = {}, keyOverride = {}, account = "123456789012", subnetOverride = {}, groupOverride = {}, stackOverride = {}, roleOverride = {}, extraPolicy = false } = {}) {
  const calls = [];
  let tags;
  let sent = 0;
  let userData;
  const infrastructureTags = [{ Key: "AgentRelayDeployment", Value: "relay-fixture" }, { Key: "ManagedBy", Value: "12-apps-ci" }];
  const role = { RoleName: "fixture-builder-role", Arn: "arn:aws:iam::123456789012:role/fixture-builder-role", Tags: infrastructureTags, ...roleOverride };
  const run = async args => {
    calls.push(args);
    if (args.includes("get-caller-identity")) return JSON.stringify({ Account: account });
    if (args.includes("describe-stacks")) return JSON.stringify([{ StackName: "relay-fixture", StackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/relay-fixture/fixture", StackStatus: "CREATE_COMPLETE", Outputs: Object.entries({ DeploymentName: "relay-fixture", WorkerSubnetId: "subnet-aaaaaaaaaaaaaaaaa", WorkerSecurityGroupId: "sg-aaaaaaaaaaaaaaaaa", WorkerKeyName: "relay-fixture-worker", BuilderInstanceProfile: "relay-fixture-builder", BaseImageId: "ami-aaaaaaaaaaaaaaaaa" }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })), ...stackOverride }]);
    if (args.includes("describe-subnets")) return JSON.stringify([{ SubnetId: "subnet-aaaaaaaaaaaaaaaaa", OwnerId: "123456789012", Tags: infrastructureTags, MapPublicIpOnLaunch: false, VpcId: "vpc-fixture", ...subnetOverride }]);
    if (args.includes("describe-stack-resource")) return JSON.stringify("sg-bbbbbbbbbbbbbbbbb");
    if (args.includes("describe-security-groups")) return JSON.stringify([{ GroupId: "sg-aaaaaaaaaaaaaaaaa", OwnerId: "123456789012", Tags: infrastructureTags, VpcId: "vpc-fixture", IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, UserIdGroupPairs: [{ GroupId: "sg-bbbbbbbbbbbbbbbbb" }] }], IpPermissionsEgress: [80, 443].map(port => ({ IpProtocol: "tcp", FromPort: port, ToPort: port, IpRanges: [{ CidrIp: "0.0.0.0/0" }] })), ...groupOverride }]);
    if (args.includes("get-instance-profile")) return JSON.stringify({ InstanceProfileName: "relay-fixture-builder", Arn: "arn:aws:iam::123456789012:instance-profile/relay-fixture-builder", Roles: [role] });
    if (args.includes("get-role")) return JSON.stringify(role);
    if (args.includes("list-attached-role-policies")) return JSON.stringify([{ PolicyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" }, ...(extraPolicy ? [{ PolicyArn: "AdministratorAccess" }] : [])]);
    if (args.includes("list-role-policies")) return "[]";
    if (args.includes("describe-images")) return JSON.stringify(args.includes(imageId) ? { ImageId: imageId, State: "available" } : { ImageId: "ami-aaaaaaaaaaaaaaaaa", State: "available", Architecture: "x86_64", OwnerId: "099720109477", Name: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-fixture", ...baseOverride });
    if (args.includes("describe-key-pairs")) return JSON.stringify([{ KeyName: "relay-fixture-worker", Tags: infrastructureTags, PublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixturePublicKeyOnly fixture", ...keyOverride }]);
    if (args.includes("run-instances")) {
      tags = JSON.parse(args[args.indexOf("--tag-specifications") + 1])[0].Tags;
      userData = await readFile(args[args.indexOf("--user-data") + 1].slice(7), "utf8");
      return JSON.stringify(builderId);
    }
    if (args.includes("describe-instances")) return JSON.stringify([{ InstanceId: builderId, State: { Name: sent >= 2 && !neverStops ? "stopped" : "running" }, Tags: foreignBuilder ? [] : tags, SubnetId: "subnet-aaaaaaaaaaaaaaaaa", SecurityGroups: [{ GroupId: "sg-aaaaaaaaaaaaaaaaa" }], KeyName: "relay-fixture-worker", IamInstanceProfile: { Arn: "arn:aws:iam::123456789012:instance-profile/relay-fixture-builder" } }]);
    if (args.includes("describe-instance-information")) return JSON.stringify([{ InstanceId: builderId, PingStatus: "Online" }]);
    if (args.includes("send-command")) { sent++; return JSON.stringify({ Command: { CommandId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } }); }
    if (args.includes("get-command-invocation")) return JSON.stringify({ Status: commandFailed ? "Failed" : "Success", ResponseCode: commandFailed ? 1 : 0, StandardErrorContent: "must never be included in public errors" });
    if (args.includes("create-image")) return JSON.stringify(imageId);
    if (args.includes("terminate-instances")) return "";
    throw new Error("Unexpected AWS command in fixture");
  };
  return { run, calls, getUserData: () => userData };
}

test("AMI dry-run validates required network/deployment inputs and invokes no AWS commands", async () => {
  const result = await bakeWorkerImage(parseOptions([...required, "--dry-run"]), { run: () => { throw new Error("AWS must not run"); } });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.versions, { codex: "0.154.0", claude: "2.1.222" });
  assert.equal(result.finalWorkerRole, null);
  assert.equal(result.finalWorkerMetadata, "disabled");
  for (const args of [[], [...required, "--subnet-id", "subnet-*"], [...required, "--deployment", "*,other"], [...required, "--instance-type", "t4g.medium"], [...required, "--volume-gb", "2"], [...required, "--ssh-private-key", "secret"]]) assert.throws(() => parseOptions(args));
});

test("AMI baker uses private SSM-only builder, tags image/snapshot, finalizes before imaging and cleans exact builder", async () => {
  const f = fixture();
  const logs = [];
  const result = await bakeWorkerImage(parseOptions([...required, "--profile", "code-web"]), { run: f.run, sleep: async () => {}, log: line => logs.push(line) });
  assert.equal(result.imageId, imageId);
  const launch = f.calls.find(c => c.includes("run-instances"));
  assert.equal(JSON.parse(launch[launch.indexOf("--network-interfaces") + 1])[0].AssociatePublicIpAddress, false);
  assert.deepEqual(JSON.parse(launch[launch.indexOf("--iam-instance-profile") + 1]), { Name: "relay-fixture-builder" });
  assert.ok(launch.includes("CpuCredits=standard"));
  assert.ok(f.calls.every(c => c.includes("--profile") && c.includes("code-web")));
  assert.equal(f.calls.some(c => c.includes("stop-instances")), false);
  const sends = f.calls.filter(c => c.includes("send-command"));
  assert.equal(sends.length, 2);
  for (const send of sends) assert.ok(Array.isArray(JSON.parse(send[send.indexOf("--parameters") + 1]).executionTimeout));
  assert.ok(sends[0].join(" ").includes("cloud-init status --wait"));
  assert.ok(sends[1].join(" ").includes("agent-web-finalize-image"));
  assert.ok(f.calls.indexOf(sends[1]) < f.calls.findIndex(c => c.includes("create-image")));
  const created = f.calls.find(c => c.includes("create-image"));
  const tags = JSON.parse(created[created.indexOf("--tag-specifications") + 1]);
  assert.deepEqual(tags.map(t => t.ResourceType), ["image", "snapshot"]);
  for (const resource of tags) {
    assert.ok(resource.Tags.some(t => t.Key === "AgentRelayDeployment" && t.Value === "relay-fixture"));
    assert.ok(resource.Tags.some(t => t.Key === "AgentRelayWorkerKey" && t.Value === "relay-fixture-worker"));
  }
  const cleanup = f.calls.find(c => c.includes("terminate-instances"));
  assert.equal(cleanup.at(-1), builderId);
  assert.equal(f.getUserData().includes("__RELAY_WORKER_PUBLIC_KEY_BASE64__"), false);
  assert.ok(f.getUserData().includes("@openai/codex@0.154.0"));
  assert.equal(logs.join(" ").includes("AAAAC3"), false);
});

test("AMI baker supports IAM default chain and rejects failed bootstrap without publishing image", async () => {
  const f = fixture({ commandFailed: true });
  await assert.rejects(bakeWorkerImage(parseOptions(required), { run: f.run, sleep: async () => {} }), error => /SSM command failed/.test(error.message) && !error.message.includes("must never"));
  assert.ok(f.calls.every(c => !c.includes("--profile")));
  assert.equal(f.calls.some(c => c.includes("create-image")), false);
  assert.equal(f.calls.filter(c => c.includes("terminate-instances")).length, 1);
});

test("AMI baker never snapshots failed/timed-out guest finalization", async () => {
  const f = fixture({ neverStops: true });
  await assert.rejects(bakeWorkerImage(parseOptions(required), { run: f.run, sleep: async () => {}, pollLimit: 2 }), /sanitized builder shutdown/);
  assert.equal(f.calls.some(c => c.includes("create-image") || c.includes("stop-instances")), false);
  assert.equal(f.calls.filter(c => c.includes("terminate-instances")).length, 1);
});

test("AMI cleanup fails closed if exact builder scope changed", async () => {
  const f = fixture({ foreignBuilder: true });
  await assert.rejects(bakeWorkerImage(parseOptions(required), { run: f.run, sleep: async () => {} }), /ownership\/network\/profile mismatch/);
  assert.equal(f.calls.some(c => c.includes("terminate-instances") || c.includes("send-command") || c.includes("create-image")), false);
});

test("AMI baker rejects non-Canonical base or unusable public key before launching anything", async () => {
  for (const override of [{ baseOverride: { OwnerId: "foreign" } }, { baseOverride: { Architecture: "arm64" } }, { keyOverride: { PublicKey: "-----BEGIN PRIVATE KEY-----" } }]) {
    const f = fixture(override);
    await assert.rejects(bakeWorkerImage(parseOptions(required), { run: f.run }));
    assert.equal(f.calls.some(c => c.includes("run-instances")), false);
  }
});

test("AMI preflight rejects wrong AWS account, foreign resources and excessive builder permissions without mutation", async () => {
  for (const override of [{ account: "999999999999" }, { subnetOverride: { Tags: [] } }, { subnetOverride: { MapPublicIpOnLaunch: true } }, { subnetOverride: { OwnerId: "999999999999" } }, { groupOverride: { IpPermissions: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }] } }, { groupOverride: { IpPermissionsEgress: [{ IpProtocol: "-1" }] } }, { stackOverride: { Outputs: [] } }, { roleOverride: { Tags: [] } }, { extraPolicy: true }, { keyOverride: { Tags: [] } }]) {
    const f = fixture(override);
    await assert.rejects(bakeWorkerImage(parseOptions(required), { run: f.run }));
    assert.equal(f.calls.some(c => c.includes("run-instances") || c.includes("send-command") || c.includes("create-image") || c.includes("terminate-instances")), false);
  }
});

test("worker recipe removes builder identity, generates new host keys and does not need final IMDS", async () => {
  const recipe = await readFile(new URL("../deploy/aws/worker-cloud-init.yaml", import.meta.url), "utf8");
  for (const required of ["@openai/codex@0.154.0", "@anthropic-ai/claude-code@2.1.222", "cloud-init.disabled", "cloud-init clean --logs --seed --machine-id", "/var/lib/amazon/ssm", "/root/.aws", "ssh_host_${kind}_key", "ssh-keygen -A", "IMAGE_FINALIZED", "agent-web-heartbeat.service"]) assert.ok(recipe.includes(required), required);
  assert.ok(recipe.indexOf("Credential filename scan failed") < recipe.indexOf("systemctl poweroff"));
  assert.equal(recipe.includes("@openai/codex @anthropic-ai"), false);
  assert.ok(recipe.includes('agent ALL=(root) NOPASSWD: /usr/local/sbin/agent-web-audit-image ""'));
  assert.ok(recipe.includes("if os.geteuid() != 0 or len(sys.argv) != 1:"));
  assert.ok(recipe.includes("#!/usr/bin/python3 -I"));
  assert.ok(recipe.includes("agent-relay-builder-identity.json"));
  assert.ok(recipe.includes("metadataReachable"));
});
