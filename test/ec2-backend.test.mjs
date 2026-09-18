import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { Ec2Backend } from "../src/worker-backends.mjs";

const chat = { id: `chat_${"a".repeat(32)}`, workspace: "/tmp/relay-workspace-fixture" };
function ec2Config(overrides = {}) {
  return loadConfig({ AGENT_WEB_HOST: "127.0.0.1", AGENT_WORKER_BACKEND: "ec2", AGENT_EC2_GATEWAY_ORIGIN: "https://relay.example.test", AGENT_EC2_DEPLOYMENT: "relay-fixture",
    AGENT_EC2_AMI_ID: "ami-aaaaaaaaaaaaaaaaa", AGENT_EC2_SUBNET_ID: "subnet-aaaaaaaaaaaaaaaaa", AGENT_EC2_SECURITY_GROUP_ID: "sg-aaaaaaaaaaaaaaaaa", AGENT_EC2_KEY_NAME: "fixture-worker", AGENT_EC2_SSH_PRIVATE_KEY: "/tmp/fixture-key", AGENT_EC2_SSH_KNOWN_HOSTS: "/tmp/relay-known-hosts-fixture", SSH_BIN: "ssh", AWS_REGION: "us-east-1", ...overrides });
}
function instance(overrides = {}) {
  return { InstanceId: "i-aaaaaaaaaaaaaaaaa", State: { Name: "stopped" }, PrivateIpAddress: "10.0.0.42", SubnetId: "subnet-aaaaaaaaaaaaaaaaa", KeyName: "fixture-worker", SecurityGroups: [{ GroupId: "sg-aaaaaaaaaaaaaaaaa" }], MetadataOptions: { HttpEndpoint: "disabled" }, Tags: [{ Key: "ManagedBy", Value: "agent-relay" }, { Key: "AgentRelayDeployment", Value: "relay-fixture" }, { Key: "AgentWebChat", Value: chat.id }], ...overrides };
}
function image(overrides = {}) {
  return { ImageId: "ami-aaaaaaaaaaaaaaaaa", State: "available", Architecture: "x86_64", Tags: [{ Key: "ManagedBy", Value: "agent-relay" }, { Key: "AgentRelayDeployment", Value: "relay-fixture" }, { Key: "AgentRelayWorkerKey", Value: "fixture-worker" }, { Key: "CodexVersion", Value: "0.154.0" }, { Key: "ClaudeVersion", Value: "2.1.222" }], ...overrides };
}
function fixture({ initial = instance(), config = ec2Config(), ami = image(), lookup, afterLaunch } = {}) {
  const calls = [];
  let worker = initial;
  const backend = new Ec2Backend({ store: {}, config, commandRunner: async (command, args) => {
    calls.push({ command, args });
    if (command === "ssh") return args.at(-1).includes(".workspace-seeded") ? "ready" : "";
    if (args.includes("describe-images")) return JSON.stringify(ami);
    if (args.includes("describe-instances")) return JSON.stringify(args.includes("--instance-ids") ? worker : (lookup || (worker ? [worker] : [])));
    if (args.includes("run-instances")) { worker = afterLaunch || instance({ State: { Name: "pending" } }); return JSON.stringify(worker); }
    if (args.includes("start-instances")) worker.State.Name = "running";
    if (args.includes("stop-instances")) worker.State.Name = "stopped";
    return "";
  } });
  return { backend, calls };
}

test("EC2 starts/stops only a private deployment/chat worker and uses the IAM default chain", async () => {
  const { backend, calls } = fixture();
  const executor = await backend.acquire(chat);
  assert.equal(executor.metadata.instanceId, "i-aaaaaaaaaaaaaaaaa");
  assert.ok(calls.some(c => c.args.includes("start-instances")));
  assert.ok(calls.filter(c => c.command !== "ssh").every(c => !c.args.includes("--profile")));
  const lookup = calls.find(c => c.args.includes("--filters")).args;
  assert.ok(lookup.includes("Name=tag:AgentRelayDeployment,Values=relay-fixture"));
  assert.ok(lookup.includes("Name=tag:ManagedBy,Values=agent-relay"));
  assert.ok(calls.some(c => c.command === "ssh" && c.args.at(-1).includes("0.154.0")));
  assert.deepEqual(await backend.sleep(chat), { instanceId: "i-aaaaaaaaaaaaaaaaa", stopped: true });
  await backend.destroy(chat);
  assert.ok(calls.some(c => c.args.includes("terminate-instances") && c.args.at(-1) === "i-aaaaaaaaaaaaaaaaa"));
  const ssh = backend.sshArgs("10.0.0.42", "i-aaaaaaaaaaaaaaaaa");
  assert.ok(ssh.includes("/dev/null"));
  assert.ok(ssh.includes("ForwardAgent=no"));
  assert.ok(ssh.includes("IdentitiesOnly=yes"));
  assert.ok(ssh.some(arg => arg.startsWith("UserKnownHostsFile=")));
  assert.ok(ssh.includes("HostKeyAlias=relay-fixture-i-aaaaaaaaaaaaaaaaa"));
});

test("EC2 launch requires tagged pinned image; encrypts and tags volumes; disables IMDS, public IP and IAM", async () => {
  const { backend, calls } = fixture({ initial: null, config: ec2Config({ AWS_PROFILE: "fixture" }) });
  await backend.acquire(chat);
  const launch = calls.find(c => c.args.includes("run-instances")).args;
  assert.ok(launch.includes("--profile"));
  assert.ok(launch.includes("HttpTokens=required,HttpEndpoint=disabled"));
  assert.equal(launch.includes("--iam-instance-profile"), false);
  const network = JSON.parse(launch[launch.indexOf("--network-interfaces") + 1]);
  assert.equal(network[0].AssociatePublicIpAddress, false);
  const disk = JSON.parse(launch[launch.indexOf("--block-device-mappings") + 1]);
  assert.equal(disk[0].Ebs.Encrypted, true);
  assert.equal(disk[0].Ebs.DeleteOnTermination, true);
  const tags = JSON.parse(launch[launch.indexOf("--tag-specifications") + 1]);
  assert.deepEqual(tags.map(t => t.ResourceType), ["instance", "volume"]);
  for (const resource of tags) assert.ok(resource.Tags.some(t => t.Key === "AgentRelayDeployment" && t.Value === "relay-fixture"));
});

for (const [name, overrides] of Object.entries({ deployment: { Tags: [] }, subnet: { SubnetId: "subnet-foreign" }, key: { KeyName: "foreign" }, role: { IamInstanceProfile: { Arn: "controller-role" } }, publicIp: { PublicIpAddress: "1.2.3.4" }, metadata: { MetadataOptions: { HttpEndpoint: "enabled" } }, securityGroup: { SecurityGroups: [{ GroupId: "sg-foreign" }] }, extraSecurityGroup: { SecurityGroups: [{ GroupId: "sg-aaaaaaaaaaaaaaaaa" }, { GroupId: "sg-foreign" }] }, id: { InstanceId: "--bad" } })) {
  test(`EC2 refuses to acquire/sleep/destroy a worker with mismatched ${name}`, async () => {
    const { backend, calls } = fixture({ initial: instance(overrides) });
    for (const action of ["acquire", "sleep", "destroy"]) await assert.rejects(backend[action](chat), /ownership or isolation/);
    assert.ok(calls.every(c => c.args.includes("describe-instances")));
  });
}

test("EC2 rejects ambiguous matches and invalid chat IDs without mutation", async () => {
  const { backend, calls } = fixture({ lookup: [instance(), instance()] });
  await assert.rejects(backend.acquire(chat), /ambiguous/);
  await assert.rejects(backend.destroy({ id: "*,other-chat" }), /Invalid EC2 chat/);
  assert.equal(calls.length, 1);
});

test("EC2 refuses untagged/unpinned AMI and revalidates a newly created instance", async () => {
  for (const ami of [image({ Tags: [] }), image({ Architecture: "arm64" }), image({ State: "pending" })]) {
    const { backend, calls } = fixture({ initial: null, ami });
    await assert.rejects(backend.acquire(chat), /verified image/);
    assert.equal(calls.some(c => c.args.includes("run-instances")), false);
  }
  const { backend, calls } = fixture({ initial: null, afterLaunch: instance({ IamInstanceProfile: {} }) });
  await assert.rejects(backend.acquire(chat), /ownership or isolation/);
  assert.equal(calls.some(c => c.command === "ssh"), false);
});

test("EC2 requires deployment, private IP, safe origin and SSH target", () => {
  assert.throws(() => fixture({ config: ec2Config({ AGENT_EC2_DEPLOYMENT: "" }) }), /AGENT_EC2_DEPLOYMENT/);
  assert.throws(() => fixture({ config: ec2Config({ AGENT_EC2_USE_PUBLIC_IP: "1" }) }), /private addresses/);
  assert.throws(() => ec2Config({ AGENT_EC2_GATEWAY_ORIGIN: "http://relay.test" }), /must use HTTPS/);
  for (const origin of ["https://user:password@relay.test", "https://relay.test/path", "https://relay.test?key=secret"]) assert.throws(() => ec2Config({ AGENT_EC2_GATEWAY_ORIGIN: origin }), /without credentials/);
  const { backend } = fixture();
  for (const host of ["-oProxyCommand=bad", "example.com", "169.254.169.254", "127.0.0.1", "8.8.8.8"]) assert.throws(() => backend.sshArgs(host), /private IPv4/);
});
