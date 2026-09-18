import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { bakeWorkerImage, parseOptions, safeBootstrapReceipt, gzipWorkerUserData, EC2_USER_DATA_MAX_BYTES, safeBakerAwsFailure, runBakerAws } from "../deploy/aws/bake-worker-ami.mjs";

const required = ["--expected-account", "123456789012", "--deployment", "relay-fixture", "--subnet-id", "subnet-aaaaaaaaaaaaaaaaa", "--security-group-id", "sg-aaaaaaaaaaaaaaaaa", "--key-name", "relay-fixture-worker", "--builder-instance-profile", "relay-fixture-builder", "--base-image-id", "ami-aaaaaaaaaaaaaaaaa"];
const builderId = "i-aaaaaaaaaaaaaaaaa";
const imageId = "ami-bbbbbbbbbbbbbbbbb";
function fixture({ commandFailed = false, neverStops = false, foreignBuilder = false, baseOverride = {}, keyOverride = {}, account = "123456789012", subnetOverride = {}, groupOverride = {}, stackOverride = {}, roleOverride = {}, extraPolicy = false, terminationStates = ["shutting-down", "terminated"], mutateInstance = value => value, invocationNotVisible = false, externalTermination = false, detachedWhileTerminating = false } = {}) {
  const calls = [];
  let tags;
  let sent = 0;
  let userData;
  let terminationRequested = false;
  let terminationPolls = 0;
  let invocationPolls = 0;
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
      const source = args[args.indexOf("--user-data") + 1];
      assert.ok(source.startsWith("fileb://"));
      const filename = source.slice(8);
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
      const compressed = await readFile(filename);
      assert.ok(compressed.length <= EC2_USER_DATA_MAX_BYTES);
      userData = gunzipSync(compressed).toString("utf8");
      return JSON.stringify(builderId);
    }
    if (args.includes("describe-instances")) {
      const value = { InstanceId: builderId, ImageId: "ami-aaaaaaaaaaaaaaaaa", State: { Name: terminationRequested ? terminationStates[Math.min(terminationPolls++, terminationStates.length - 1)] : sent >= 2 && !neverStops ? "stopped" : "running" }, Tags: foreignBuilder ? [] : tags, SubnetId: "subnet-aaaaaaaaaaaaaaaaa", SecurityGroups: [{ GroupId: "sg-aaaaaaaaaaaaaaaaa" }], KeyName: "relay-fixture-worker", IamInstanceProfile: { Arn: "arn:aws:iam::123456789012:instance-profile/relay-fixture-builder" } };
      if (terminationRequested && detachedWhileTerminating) { delete value.SubnetId; delete value.IamInstanceProfile; value.SecurityGroups = []; }
      return JSON.stringify([mutateInstance(value, { terminationRequested, calls })]);
    }
    if (args.includes("describe-instance-information")) return JSON.stringify([{ InstanceId: builderId, PingStatus: "Online" }]);
    if (args.includes("send-command")) { sent++; return JSON.stringify({ Command: { CommandId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } }); }
    if (args.includes("get-command-invocation")) {
      if (invocationNotVisible && invocationPolls++ === 0) throw safeBakerAwsFailure(args, { stderr: "An error occurred (InvocationDoesNotExist) when calling the GetCommandInvocation operation: PRIVATE FIXTURE" });
      return JSON.stringify({ Status: commandFailed ? "Failed" : "Success", ResponseCode: commandFailed ? 1 : 0, StandardErrorContent: "must never be included in public errors" });
    }
    if (args.includes("create-image")) { if (externalTermination) terminationRequested = true; return JSON.stringify(imageId); }
    if (args.includes("terminate-instances")) { terminationRequested = true; return ""; }
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

test("real worker recipe uses deterministic gzip and fits EC2 after binary decoding", async () => {
  const recipe = await readFile(new URL("../deploy/aws/worker-cloud-init.yaml", import.meta.url), "utf8");
  assert.ok(Buffer.byteLength(recipe) > EC2_USER_DATA_MAX_BYTES, "exercise the actual oversized YAML regression");
  const compressed = gzipWorkerUserData(recipe);
  assert.deepEqual(compressed.subarray(0, 3), Buffer.from([0x1f, 0x8b, 0x08]));
  assert.ok(compressed.length <= EC2_USER_DATA_MAX_BYTES);
  assert.equal(gunzipSync(compressed).toString("utf8"), recipe);
  assert.deepEqual(gzipWorkerUserData(recipe), compressed);
});

test("oversized compressed user-data fails before any AWS calls and never prints payload", async () => {
  const recipe = `#cloud-config\n# @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.222\n# PRIVATE-FIXTURE-NOT-TO-PRINT\n${Array.from({ length: 2000 }, (_, i) => `# ${createHash("sha256").update(String(i)).digest("hex")}`).join("\n")}\n`;
  assert.throws(() => gzipWorkerUserData(recipe), /exceeds the EC2 16 KiB limit/);
  for (const dryRun of [false, true]) await assert.rejects(bakeWorkerImage({ ...parseOptions(required), dryRun }, { recipe, run: () => { throw Error("AWS must not run"); } }), error => /exceeds the EC2 16 KiB limit/.test(error.message) && !error.message.includes("PRIVATE-FIXTURE"));
});

test("rendered public key is included in the compressed limit before launching", async () => {
  const key = `ssh-rsa ${Array.from({ length: 1500 }, (_, i) => createHash("sha256").update(String(i)).digest("base64")).join("")}`;
  const f = fixture({ keyOverride: { PublicKey: key } });
  await assert.rejects(bakeWorkerImage(parseOptions(required), { run: f.run }), /exceeds the EC2 16 KiB limit/);
  assert.equal(f.calls.some(c => c.includes("run-instances") || c.includes("terminate-instances")), false);
});

test("AMI baker uses private SSM-only builder, tags image/snapshot, finalizes before imaging and cleans exact builder", async () => {
  const f = fixture();
  const logs = [];
  const result = await bakeWorkerImage(parseOptions([...required, "--profile", "code-web"]), { run: f.run, sleep: async () => {}, log: line => logs.push(line) });
  assert.equal(result.imageId, imageId);
  assert.equal(result.cleanedUp, true);
  const launch = f.calls.find(c => c.includes("run-instances"));
  assert.equal(JSON.parse(launch[launch.indexOf("--network-interfaces") + 1])[0].AssociatePublicIpAddress, false);
  assert.deepEqual(JSON.parse(launch[launch.indexOf("--iam-instance-profile") + 1]), { Name: "relay-fixture-builder" });
  const instanceTags = JSON.parse(launch[launch.indexOf("--tag-specifications") + 1])[0].Tags;
  assert.equal(launch[launch.indexOf("--client-token") + 1], instanceTags.find(tag => tag.Key === "AgentRelayBake").Value);
  assert.ok(launch.includes("CpuCredits=standard"));
  assert.ok(f.calls.every(c => c.includes("--profile") && c.includes("code-web")));
  assert.equal(f.calls.some(c => c.includes("stop-instances")), false);
  const sends = f.calls.filter(c => c.includes("send-command"));
  assert.equal(sends.length, 2);
  for (const send of sends) assert.ok(Array.isArray(JSON.parse(send[send.indexOf("--parameters") + 1]).executionTimeout));
  assert.ok(sends[0].join(" ").includes("python3 -I"));
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
  assert.ok(logs.some(line => line.startsWith("Confirmed termination")));
  assert.ok(f.calls.slice(f.calls.indexOf(cleanup) + 1).filter(call => call.includes("describe-instances")).length >= 2);
});

test("AMI cleanup observes exact terminal state with detached network but never relaxes ownership", async () => {
  for (const externalTermination of [false, true]) {
    const f = fixture({ detachedWhileTerminating: true, externalTermination });
    const result = await bakeWorkerImage(parseOptions(required), { run: f.run, sleep: async () => {} });
    assert.equal(result.cleanedUp, true);
    assert.equal(f.calls.filter(call => call.includes("terminate-instances")).length, externalTermination ? 0 : 1);
  }
  for (const patch of [{ Tags: [] }, { ImageId: "ami-ccccccccccccccccc" }, { InstanceId: "i-ccccccccccccccccc" }]) {
    const f = fixture({ detachedWhileTerminating: true, mutateInstance: (value, state) => state.terminationRequested ? { ...value, ...patch } : value });
    const logs = [];
    await assert.rejects(bakeWorkerImage(parseOptions(required), { run: f.run, sleep: async () => {}, log: value => logs.push(value) }), /ownership\/network\/profile mismatch.*cleanup unconfirmed/);
    assert.equal(logs.some(line => line.startsWith("Confirmed termination")), false);
    assert.equal(f.calls.filter(call => call.includes("terminate-instances")).length, 1);
  }
});

test("hibernation bake is explicitly opt-in and cannot claim production acceptance", async () => {
  const f = fixture();
  const options = parseOptions([...required, "--hibernation-candidate"]);
  const result = await bakeWorkerImage(options, { run: f.run, sleep: async () => {} });
  assert.equal(result.hibernationCandidate, "candidate-v1");
  assert.equal(result.productionReady, false);
  const launch = f.calls.find(c => c.includes("run-instances"));
  assert.equal(launch[launch.indexOf("--hibernation-options") + 1], "Configured=true");
  const image = f.calls.find(c => c.includes("create-image"));
  const tags = JSON.parse(image[image.indexOf("--tag-specifications") + 1])[0].Tags;
  assert.ok(tags.some(tag => tag.Key === "AgentRelayHibernation" && tag.Value === "candidate-v1"));
  assert.equal(tags.some(tag => tag.Key === "AgentRelayAcceptance"), false);
  assert.match(f.getUserData(), /ec2-hibinit-agent/);
  assert.doesNotMatch(f.getUserData(), /420.*shutdown/);
});

test("cleanup does a strict recheck before termination and rejects detached nonterminal instances", async () => {
  for (const race of [false, true]) {
    let cleanupReads = 0;
    const f = fixture({ mutateInstance: (value, state) => {
      if (state.calls.some(call => call.includes("create-image")) && ++cleanupReads >= (race ? 2 : 1)) return { ...value, SecurityGroups: [] };
      return value;
    } });
    await assert.rejects(bakeWorkerImage(parseOptions(required), { run: f.run, sleep: async () => {} }), /cleanup unconfirmed/);
    assert.equal(f.calls.some(call => call.includes("terminate-instances")), false);
  }
});

test("termination timeout cannot claim cleanup and preserves the original failure", async () => {
  for (const commandFailed of [false, true]) {
    const f = fixture({ commandFailed, terminationStates: ["shutting-down"], detachedWhileTerminating: true });
    const logs = [];
    await assert.rejects(bakeWorkerImage(parseOptions(required), { run: f.run, sleep: async () => {}, pollLimit: 2, log: value => logs.push(value) }), error => {
      assert.match(error.message, /temporary builder termination.*cleanup unconfirmed/);
      assert.equal(error.message.includes("Builder SSM command failed"), commandFailed);
      assert.doesNotMatch(error.message, /must never/);
      return true;
    });
    assert.equal(logs.some(line => line.startsWith("Confirmed termination")), false);
  }
});

test("failed termination keeps safe API classification and the original bootstrap failure", async () => {
  const f = fixture({ commandFailed: true });
  const run = args => args.includes("terminate-instances") ? runBakerAws(args, async () => {
    throw Object.assign(Error("PRIVATE-COMMAND"), { stderr: "An error occurred (UnauthorizedOperation) when calling the TerminateInstances operation: PRIVATE-SECRET", stdout: "PRIVATE-STDOUT" });
  }) : f.run(args);
  const logs = [];
  await assert.rejects(bakeWorkerImage(parseOptions(required), { run, sleep: async () => {}, log: value => logs.push(value) }), error => {
    assert.match(error.message, /Builder SSM command failed.*AWS ec2\/terminate-instances failed \(UnauthorizedOperation\).*cleanup unconfirmed/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(logs.some(line => line.startsWith("Confirmed termination")), false);
});

test("SSM eventual consistency retry uses only the exact safe InvocationDoesNotExist code", async () => {
  const f = fixture({ invocationNotVisible: true });
  await bakeWorkerImage(parseOptions(required), { run: f.run, sleep: async () => {} });
  assert.equal(f.calls.filter(call => call.includes("get-command-invocation")).length, 3);
});

test("malformed AWS JSON and unexpected SSM status never print private response data", async () => {
  for (const malformed of [true, false]) {
    const f = fixture();
    const run = args => args.includes("get-command-invocation") ? malformed ? '{PRIVATE-SECRET' : JSON.stringify({ Status: "PRIVATE-SECRET", ResponseCode: 1 }) : f.run(args);
    await assert.rejects(bakeWorkerImage(parseOptions(required), { run, sleep: async () => {} }), error => {
      assert.doesNotMatch(error.message, /PRIVATE-SECRET/);
      assert.match(error.message, malformed ? /AWS ssm\/get-command-invocation failed \(invalid-response\)/ : /SSM command failed \(unexpected-status\)/);
      return true;
    });
  }
});

test("AWS process failures expose only fixed operation/category names, never stderr, argv or causes", async () => {
  const args = ["--profile", "PRIVATE-PROFILE", "--region", "PRIVATE-REGION", "--no-cli-pager", "ec2", "run-instances", "--user-data", "PRIVATE-PAYLOAD"];
  for (const code of ["InvalidParameterValue", "InvalidParameterCombination", "UnauthorizedOperation", "ExpiredToken", "RequestLimitExceeded"]) {
    const raw = Object.assign(Error("PRIVATE-ERROR"), { stderr: `An error occurred (${code}) when calling the RunInstances operation: PRIVATE-SECRET`, stdout: "PRIVATE-STDOUT", cmd: "PRIVATE-COMMAND" });
    await assert.rejects(runBakerAws(args, async () => { throw raw; }), error => {
      assert.equal(error.message, `AWS ec2/run-instances failed (${code}); private diagnostics suppressed`);
      assert.equal(error.code, code);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE/);
      return true;
    });
  }
  for (const [raw, expected] of [
    [{ stderr: "PRIVATE-SECRET InvocationDoesNotExist InvalidParameterValue" }, "unclassified"],
    [{ stderr: "An error occurred (PRIVATESECRET) when calling the RunInstances operation: PRIVATE" }, "unclassified"],
    [{ stderr: "An error occurred (UnauthorizedOperation) when calling the DeleteSecret operation: PRIVATE" }, "unclassified"],
    [{ stderr: "An error occurred (InvocationDoesNotExist) when calling the RunInstances operation: PRIVATE" }, "unclassified"],
    [{ killed: true, signal: "SIGTERM", stderr: "PRIVATE" }, "timeout"],
    [{ code: "ETIMEDOUT", stderr: "PRIVATE" }, "timeout"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM", stderr: "PRIVATE" }, "output-limit"],
    [{ code: "ENOENT", stderr: "PRIVATE" }, "executable-unavailable"],
  ]) {
    const error = safeBakerAwsFailure(args, raw);
    assert.equal(error.code, expected);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE/);
  }
  const unknown = safeBakerAwsFailure(["PRIVATE-SERVICE", "PRIVATE-ACTION"], { stderr: "An error occurred (UnauthorizedOperation) when calling the RunInstances operation: PRIVATE" });
  assert.equal(unknown.message, "AWS operation failed (unclassified); private diagnostics suppressed");
});

test("AMI baker supports IAM default chain and rejects failed bootstrap without publishing image", async () => {
  const f = fixture({ commandFailed: true });
  await assert.rejects(bakeWorkerImage(parseOptions(required), { run: f.run, sleep: async () => {} }), error => /SSM command failed/.test(error.message) && !error.message.includes("must never"));
  assert.ok(f.calls.every(c => !c.includes("--profile")));
  assert.equal(f.calls.some(c => c.includes("create-image")), false);
  assert.equal(f.calls.filter(c => c.includes("terminate-instances")).length, 1);
});

test("AMI baker accepts AWS's newline-terminated public key but not multiple keys", async () => {
  const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixturePublicKeyOnly";
  const f = fixture({ keyOverride: { PublicKey: `${publicKey} deployment-key\n` } });
  await bakeWorkerImage(parseOptions(required), { run: f.run, sleep: async () => {} });
  assert.ok(f.getUserData().includes(Buffer.from(`${publicKey}\n`).toString("base64")));
  const invalid = fixture({ keyOverride: { PublicKey: `${publicKey}\n${publicKey}\n` } });
  await assert.rejects(bakeWorkerImage(parseOptions(required), { run: invalid.run }));
  assert.equal(invalid.calls.some(c => c.includes("run-instances")), false);
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
  assert.ok(recipe.includes("package_upgrade: false"));
  assert.ok(recipe.includes("package_update: true"));
  assert.ok(recipe.includes("/etc/needrestart/conf.d/99-agent-relay-build.conf"));
  assert.ok(recipe.includes("rm -f /etc/needrestart/conf.d/99-agent-relay-build.conf"));
  assert.ok(recipe.includes("DefaultDependencies=no\n      After=local-fs.target\n      Before=ssh.service ssh.socket"));
});

test("bootstrap diagnostics expose only fixed stages and booleans, never private output", () => {
  const receipt = { kind: "relay-worker-bootstrap", schema: 1, status: "error", failedModules: ["scripts-user"], sshOrderingCycle: true, checks: Object.fromEntries(["node", "codex", "claude", "docker", "chrome", "readyMarker", "finalizer", "auditHelper", "systemdVerified"].map(key => [key, false])), privateField: "DO-NOT-PRINT" };
  const safe = safeBootstrapReceipt(JSON.stringify(receipt));
  assert.equal(safe.sshOrderingCycle, true);
  assert.equal(JSON.stringify(safe).includes("DO-NOT-PRINT"), false);
  assert.equal(safeBootstrapReceipt(JSON.stringify({ ...receipt, failedModules: ["PRIVATE DATA"] })), null);
  assert.equal(safeBootstrapReceipt(JSON.stringify({ ...receipt, checks: { ...receipt.checks, node: "SECRET" } })), null);
  assert.equal(safeBootstrapReceipt("raw private error"), null);
});

test("Ubuntu 24.04 dependencies use actual t64 package names accepted by cloud-init", async () => {
  const recipe = await readFile(new URL("../deploy/aws/worker-cloud-init.yaml", import.meta.url), "utf8");
  const packages = recipe.split("packages:\n")[1].split("\nusers:")[0].split("\n").map(line => line.trim().replace(/^- /, ""));
  // apt-get resolves these virtual aliases, but cloud-init first filters via
  // apt-cache pkgnames and rejects aliases not present in the package catalogue.
  for (const legacy of ["libatk-bridge2.0-0", "libatk1.0-0", "libatspi2.0-0", "libcups2", "libgtk-3-0"]) {
    assert.ok(packages.includes(`${legacy}t64`));
    assert.ok(!packages.includes(legacy));
  }
});
