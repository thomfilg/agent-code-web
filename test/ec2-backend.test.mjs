import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { Ec2Backend } from "../src/worker-backends.mjs";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

const chat = { id: `chat_${"a".repeat(32)}`, workspace: "/tmp/relay-workspace-fixture" };
function ec2Config(overrides = {}) {
  return loadConfig({ AGENT_WEB_HOST: "127.0.0.1", AGENT_WORKER_BACKEND: "ec2", AGENT_EC2_GATEWAY_ORIGIN: "https://relay.example.test", AGENT_EC2_DEPLOYMENT: "relay-fixture",
    AGENT_EC2_AMI_ID: "ami-aaaaaaaaaaaaaaaaa", AGENT_EC2_SUBNET_ID: "subnet-aaaaaaaaaaaaaaaaa", AGENT_EC2_SECURITY_GROUP_ID: "sg-aaaaaaaaaaaaaaaaa", AGENT_EC2_KEY_NAME: "fixture-worker", AGENT_EC2_SSH_PRIVATE_KEY: "/tmp/fixture-key", AGENT_EC2_SSH_KNOWN_HOSTS: "/tmp/relay-known-hosts-fixture", SSH_BIN: "ssh", AWS_REGION: "us-east-1", ...overrides });
}
function instance(overrides = {}) {
  return { InstanceId: "i-aaaaaaaaaaaaaaaaa", ImageId: "ami-aaaaaaaaaaaaaaaaa", State: { Name: "stopped" }, PrivateIpAddress: "10.0.0.42", SubnetId: "subnet-aaaaaaaaaaaaaaaaa", KeyName: "fixture-worker", SecurityGroups: [{ GroupId: "sg-aaaaaaaaaaaaaaaaa" }], MetadataOptions: { HttpEndpoint: "disabled" }, Tags: [{ Key: "ManagedBy", Value: "agent-relay" }, { Key: "AgentRelayDeployment", Value: "relay-fixture" }, { Key: "AgentWebChat", Value: chat.id }], ...overrides };
}
function image(overrides = {}) {
  return { ImageId: "ami-aaaaaaaaaaaaaaaaa", OwnerId: "123456789012", Public: false, RootDeviceType: "ebs", RootDeviceName: "/dev/sda1", BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { Encrypted: true } }], State: "available", Architecture: "x86_64", Tags: [{ Key: "ManagedBy", Value: "agent-relay" }, { Key: "AgentRelayDeployment", Value: "relay-fixture" }, { Key: "AgentRelayWorkerKey", Value: "fixture-worker" }, { Key: "CodexVersion", Value: "0.154.0" }, { Key: "ClaudeVersion", Value: "2.1.222" }, { Key: "AgentRelayAcceptance", Value: "verified-v1" }, { Key: "AgentRelayAcceptanceId", Value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }], ...overrides };
}
function fixture({ initial = instance(), config = ec2Config(), ami = image(), lookup, afterLaunch, supervisorActive = true } = {}) {
  const calls = [];
  let worker = initial;
  const backend = new Ec2Backend({ store: {}, config, commandRunner: async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === config.ec2.sshBin) {
      if (args.at(-1).includes(".workspace-seeded")) return "ready";
      if (args.at(-1).includes("systemctl --user is-active")) return supervisorActive ? "active" : "";
      if (args.at(-1).includes("worker-supervisor-control.mjs")) return JSON.stringify({ protocol: "relay-worker-supervisor/1", version: "v3", daemonInstanceId: "daemon-fixture", configured: false });
      if (args.at(-1) === "cat /proc/sys/kernel/random/boot_id") return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      return "";
    }
    if (args.includes("describe-images")) return JSON.stringify([typeof ami === "function" ? ami(args) : ami]);
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
  assert.equal(executor.acquisitionReceipt.mutation, "started");
  assert.deepEqual(executor.acquisitionReceipt.worker, { backend: "ec2", instanceId: "i-aaaaaaaaaaaaaaaaa", imageId: "ami-aaaaaaaaaaaaaaaaa" });
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

test("an accepted supervisor image verifies the independent user service and records the worker boot identity", async () => {
  const tagged = image({ Tags: [...image().Tags, { Key: "AgentRelaySupervisor", Value: "v3" }] });
  const { backend, calls } = fixture({ ami: tagged });
  backend.store = { records: {} };
  const executor = await backend.acquire(chat);
  assert.equal(executor.supervisorReady, true);
  assert.match(executor.metadata.bootId, /^[a-f0-9]{64}$/);
  assert.equal(executor.acquisitionReceipt.worker.bootId, executor.metadata.bootId);
  const control = calls.find(call => call.command === "ssh" && call.args.at(-1).includes("worker-supervisor-control.mjs"));
  assert.deepEqual(JSON.parse(control.options.input), { action: "status" });
  assert.ok(calls.some(call => call.command === "ssh" && call.args.at(-1).includes("systemctl --user is-active")));
});

test("an inactive tagged supervisor uploads its explicit source allowlist and installs the user service", async () => {
  const tagged = image({ Tags: [...image().Tags, { Key: "AgentRelaySupervisor", Value: "v3" }] });
  const config = ec2Config({ SSH_BIN: process.execPath });
  const { backend, calls } = fixture({ ami: tagged, config, supervisorActive: false });
  backend.store = { records: {} };
  // The direct upload process receives the tar stream; mocked capture calls
  // still inspect the fixed final remote command through commandRunner.
  backend.sshArgs = () => ["-e", "process.stdin.resume()"];
  const executor = await backend.acquire(chat);
  assert.equal(executor.supervisorReady, true);
  assert.ok(calls.some(call => call.args.at(-1).includes("daemon-reload") && call.args.at(-1).includes("enable --now agent-relay-worker-supervisor.service")));
  assert.ok(calls.some(call => call.args.at(-1).includes("worker-supervisor-control.mjs")));
});

test("EC2 boots and connects while clone is pending, but workspace preparation waits for clone success", async () => {
  const { backend, calls } = fixture(), gate = Promise.withResolvers(), stages = [];
  const pending = backend.acquire(chat, { workspaceReady: gate.promise, onStage: async (id, status) => { stages.push([id, status]); } });
  await waitFor(() => stages.some(([id, status]) => id === "connection" && status === "completed"));
  assert.ok(calls.some(call => call.args.includes("start-instances")));
  assert.ok(!calls.some(call => call.command === "ssh" && call.args.at(-1).includes("install -d")));
  gate.resolve(); await pending;
  assert.deepEqual(stages, [["machine", "running"], ["machine", "completed"], ["connection", "running"], ["connection", "completed"], ["workspace", "running"], ["workspace", "completed"]]);
});

test("EC2 clone failure or cancellation after SSH never uploads a workspace", async () => {
  for (const cancelled of [false, true]) {
    const { backend, calls } = fixture(), gate = Promise.withResolvers(), stages = []; let stop = false;
    const pending = backend.acquire(chat, { workspaceReady: gate.promise, check: () => { if (stop) throw Object.assign(Error("Fixture cancelled"), { name: "AbortError" }); }, onStage: async (id, status) => { stages.push([id, status]); } });
    const rejection = assert.rejects(pending, /Fixture/);
    await waitFor(() => stages.some(([id, status]) => id === "connection" && status === "completed"));
    if (cancelled) { stop = true; gate.resolve(); } else gate.reject(Error("Fixture clone failed"));
    await rejection;
    assert.ok(!calls.some(call => call.command === "ssh" && call.args.at(-1).includes("install -d")));
    assert.ok(!stages.some(([id]) => id === "workspace"));
  }
});

test("hibernation opt-in denies direct acquisition before any AWS/SSH operation", async () => {
  const { backend, calls } = fixture({ config: ec2Config({ AGENT_IDLE_POLICY: "hibernate" }) });
  await assert.rejects(backend.acquire(chat), { code: "HIBERNATION_UNAVAILABLE" });
  assert.deepEqual(calls, []);
});

test("running worker admission rejection produces no rollback authority", async () => {
  const { backend, calls } = fixture({ initial: instance({ State: { Name: "running" } }), ami: image({ Tags: [] }) });
  const mutations = [];
  await assert.rejects(backend.acquire(chat, { onMutation: receipt => mutations.push(receipt) }), /AMI|accept/);
  assert.deepEqual(mutations, []); assert.ok(!calls.some(call => call.args.includes("stop-instances")));
});

test("new and started worker rollback receipts keep exact instance ownership and are idempotent", async () => {
  for (const [initial, mutation] of [[null, "created"], [instance(), "started"]]) {
    const lookup = initial ? [initial] : [], { backend, calls } = fixture({ initial, lookup });
    let receipt;
    const executor = await backend.acquire(chat, { onMutation: value => { receipt = value; } });
    assert.equal(receipt.instanceId, "i-aaaaaaaaaaaaaaaaa");
    assert.equal(receipt.mutation, mutation); assert.equal(executor.acquisitionReceipt.mutation, mutation);
    // A chat lookup now points at a replacement; the old attempt must never
    // acquire authority to stop it during its deferred failure cleanup.
    lookup.splice(0, lookup.length, instance({ InstanceId: "i-bbbbbbbbbbbbbbbbb", State: { Name: "running" } }));
    const before = calls.length;
    await Promise.all([receipt.release(), receipt.release(), executor.releaseAcquisition()]);
    const cleanup = calls.slice(before);
    assert.ok(!cleanup.some(call => call.args.includes("--filters")));
    const stops = cleanup.filter(call => call.args.includes("stop-instances"));
    assert.equal(stops.length, 1); assert.equal(stops[0].args.at(-1), "i-aaaaaaaaaaaaaaaaa");
  }
});

test("an already-running worker returns an inspected receipt without cleanup authority", async () => {
  const { backend, calls } = fixture({ initial: instance({ State: { Name: "running" } }) });
  const mutations = [], executor = await backend.acquire(chat, { onMutation: value => mutations.push(value) });
  assert.deepEqual(mutations, []); assert.equal(executor.acquisitionReceipt.mutation, "inspected");
  assert.equal(calls.some(call => call.args.includes("start-instances")), false);
});

test("late launched ID publishes cleanup authority before cancelled admission can throw", async () => {
  const { backend, calls } = fixture({ initial: null }); let receipt, cancelled = false;
  await assert.rejects(backend.acquire(chat, { onMutation: value => { receipt = value; cancelled = true; }, check: () => { if (cancelled) throw Error("Fixture cancellation"); } }), /Fixture cancellation/);
  assert.ok(receipt); await receipt.release();
  assert.equal(calls.filter(call => call.args.includes("stop-instances")).length, 1);
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

test("missing, revoked and malformed acceptance deny new and existing worker admission, not cleanup", async () => {
  const invalid = [
    image({ Tags: image().Tags.filter(tag => !tag.Key.startsWith("AgentRelayAcceptance")) }),
    image({ Tags: image().Tags.map(tag => tag.Key === "AgentRelayAcceptance" ? { ...tag, Value: "revoked" } : tag) }),
    image({ Tags: image().Tags.map(tag => tag.Key === "AgentRelayAcceptanceId" ? { ...tag, Value: "invalid" } : tag) }),
    image({ Public: true }), image({ BlockDeviceMappings: [] }),
  ];
  for (const ami of invalid) for (const initial of [null, instance(), instance({ State: { Name: "running" } })]) {
    const f = fixture({ ami, initial });
    await assert.rejects(f.backend.acquire(chat), /acceptance|verified image/);
    assert.ok(f.calls.every(call => call.command !== "ssh" && !call.args.some(arg => ["start-instances", "run-instances"].includes(arg))));
    if (initial) {
      await f.backend.sleep(chat); await f.backend.destroy(chat);
      assert.ok(f.calls.some(call => call.args.includes("terminate-instances")));
    }
  }
});

test("existing worker admission validates its actual AMI, and refreshes acceptance before returning executor", async () => {
  const actual = "ami-bbbbbbbbbbbbbbbbb", queries = [];
  const f = fixture({ initial: instance({ ImageId: actual }), ami: args => {
    queries.push(args);
    return image({ ImageId: actual });
  } });
  await f.backend.acquire(chat);
  assert.equal(queries.length, 3);
  for (const args of queries) { assert.ok(args.includes(actual)); assert.ok(args.includes("--owners")); assert.ok(args.includes("self")); }
  let reads = 0;
  const revoked = fixture({ ami: () => ++reads === 1 ? image() : image({ Tags: [] }) });
  await assert.rejects(revoked.backend.acquire(chat), /verified image/);
  assert.ok(revoked.calls.some(call => call.args.includes("start-instances")));
  assert.ok(!revoked.calls.some(call => call.command === "ssh"));
  reads = 0;
  const delayed = fixture({ ami: () => ++reads < 3 ? image() : image({ Tags: [] }) });
  await assert.rejects(delayed.backend.acquire(chat), /verified image/);
  assert.ok(delayed.calls.some(call => call.command === "ssh"));
  const wrongLaunch = fixture({ initial: null, afterLaunch: instance({ ImageId: actual }) });
  await assert.rejects(wrongLaunch.backend.acquire(chat), /requested accepted AMI/);
});

test("EC2 sends private environment and native arguments over stdin, never controller SSH argv", async () => {
  const { backend } = fixture(), executor = await backend.acquire(chat);
  // Emulate just SSH's transport input, without executing a remote command or
  // touching real keys/network. The fixed remote source is an unused argv item.
  backend.config.ec2.sshBin = process.execPath;
  backend.sshArgs = () => ["-e", "process.stdin.pipe(process.stdout)"];
  const child = executor.spawn("native-fixture", ["private-argument-fixture"], { env: { CLAUDE_CODE_OAUTH_TOKEN: "private-token-fixture" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => output += chunk);
  assert.ok(child.spawnargs.every(arg => !arg.includes("private-token-fixture") && !arg.includes("private-argument-fixture")));
  assert.equal((await once(child, "close"))[0], 0);
  const request = JSON.parse(output);
  assert.equal(request.env.CLAUDE_CODE_OAUTH_TOKEN, "private-token-fixture");
  assert.deepEqual(request.args, ["private-argument-fixture"]);
  assert.equal(request.env.PATH, backend.config.ec2.remotePath);
  assert.equal(request.cwd, executor.workspace);
  assert.equal(request.heartbeat, executor.heartbeat);
});

test("EC2 workspace upload survives SSH pipe/spawn failures and drains the archive on success", async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, "large-fixture"), Buffer.alloc(2 * 1024 * 1024, 42));
  for (const scenario of ["closed-pipe", "missing-ssh", "sync-spawn-failure", "sync-args-failure", "archive-failure", "success"]) {
    const { backend } = fixture(), executor = await backend.acquire(chat);
    executor.chat = { ...chat, workspace: scenario === "archive-failure" ? path.join(directory, "absent") : directory };
    backend.sshCapture = async () => ""; // Unseeded guest, no network or real keys.
    backend.config.ec2.sshBin = scenario === "missing-ssh" ? path.join(directory, "missing-ssh") : process.execPath;
    if (scenario === "sync-spawn-failure") backend.config.ec2.sshBin = "invalid\0ssh";
    const scripts = {
      "closed-pipe": "process.stdin.destroy();process.stderr.write('PRIVATE-FIXTURE-DIAGNOSTIC');process.exit(255)",
      "archive-failure": "setInterval(()=>{},1000)",
      "success": "let n=0;process.stdin.on('data',c=>n+=c.length);process.stdin.on('end',()=>{process.exitCode=n>2097152?0:1;})",
    };
    backend.sshArgs = () => ["-e", scripts[scenario] || ""];
    if (scenario === "sync-args-failure") backend.sshArgs = () => { throw Error("PRIVATE-FIXTURE-DIAGNOSTIC"); };
    if (scenario === "success") await executor.prepare();
    else await assert.rejects(executor.prepare(), error => {
      assert.match(error.message, /workspace upload failed/);
      assert.ok(!error.message.includes("PRIVATE-FIXTURE"));
      return true;
    });
  }
});
