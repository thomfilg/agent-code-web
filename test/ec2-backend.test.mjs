import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { Ec2Backend, Ec2Executor } from "../src/worker-backends.mjs";
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
  return { InstanceId: "i-aaaaaaaaaaaaaaaaa", ImageId: "ami-aaaaaaaaaaaaaaaaa", InstanceType: "t3.medium", State: { Name: "stopped" }, PrivateIpAddress: "10.0.0.42", SubnetId: "subnet-aaaaaaaaaaaaaaaaa", KeyName: "fixture-worker", SecurityGroups: [{ GroupId: "sg-aaaaaaaaaaaaaaaaa" }], MetadataOptions: { HttpEndpoint: "disabled" }, Tags: [{ Key: "ManagedBy", Value: "agent-relay" }, { Key: "AgentRelayDeployment", Value: "relay-fixture" }, { Key: "AgentWebChat", Value: chat.id }], ...overrides };
}
function image(overrides = {}) {
  return { ImageId: "ami-aaaaaaaaaaaaaaaaa", OwnerId: "123456789012", Public: false, RootDeviceType: "ebs", RootDeviceName: "/dev/sda1", BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { Encrypted: true } }], State: "available", Architecture: "x86_64", Tags: [{ Key: "ManagedBy", Value: "agent-relay" }, { Key: "AgentRelayDeployment", Value: "relay-fixture" }, { Key: "AgentRelayWorkerKey", Value: "fixture-worker" }, { Key: "CodexVersion", Value: "0.154.0" }, { Key: "ClaudeVersion", Value: "2.1.222" }, { Key: "AgentRelayAcceptance", Value: "verified-v1" }, { Key: "AgentRelayAcceptanceId", Value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }], ...overrides };
}
function fixture({ initial = instance(), config = ec2Config(), ami = image(), lookup, afterLaunch, supervisorActive = true, supervisorStatusFailures = 0 } = {}) {
  const calls = [];
  let worker = initial;
  const backend = new Ec2Backend({ store: {}, config, commandRunner: async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === config.ec2.sshBin) {
      if (args.at(-1).includes(".workspace-seeded")) return "ready";
      if (args.at(-1).includes("systemctl --user is-active")) return supervisorActive ? "active" : "";
      if (args.at(-1).includes("worker-supervisor-control.mjs")) {
        if (supervisorStatusFailures-- > 0) throw Error("synthetic socket startup race");
        return JSON.stringify({ protocol: "relay-worker-supervisor/1", version: "v3", daemonInstanceId: "daemon-fixture", configured: false });
      }
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

test("new monitoring code never restarts a supervisor that retains an active process", async () => {
  const calls = [];
  const backend = { config: ec2Config(), store: { records: {} }, controllerId: "controller_fixture", legacyOwnerId: null,
    sshCapture: async (_host, command) => {
      calls.push(command);
      if (command.includes(".workspace-seeded")) return "ready";
      if (command.includes("systemctl --user is-active")) return "active";
      if (command.includes("worker-supervisor-control.mjs")) return JSON.stringify({ protocol: "relay-worker-supervisor/1", version: "v3",
        daemonInstanceId: "daemon_fixture", configured: true, leaseHeartbeat: true, eventOutbox: false });
      if (command === "cat /proc/sys/kernel/random/boot_id") return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      return "";
    } };
  const executor = new Ec2Executor({ backend, chat, instance: instance({ State: { Name: "running" } }), host: "10.0.0.42", supervisorAvailable: true });
  await executor.prepare();
  assert.equal(executor.supervisorReady, true);
  assert.equal(executor.supervisorEventOutbox, false);
  assert.ok(!calls.some(command => command.includes("systemctl --user restart")), "retained process must not be restarted for a monitoring upgrade");
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

test("deleting a chat waits for its EC2 worker and tagged storage to be gone", async () => {
  const chat = { id: "chat_cccccccccccccccccccccccccccccccc" };
  const config = ec2Config({ AGENT_EC2_DEPLOYMENT: "fixture" });
  const calls = [];
  let instanceState = "stopped", volumeState = "available";
  const tags = [
    { Key: "AgentWebChat", Value: chat.id },
    { Key: "AgentRelayDeployment", Value: config.ec2.deployment },
    { Key: "ManagedBy", Value: "agent-relay" },
  ];
  const instance = {
    InstanceId: "i-0123456789abcdef0", State: { Name: instanceState }, Tags: tags,
    SubnetId: config.ec2.subnetId, KeyName: config.ec2.keyName,
    SecurityGroups: [{ GroupId: config.ec2.securityGroupId }],
    MetadataOptions: { HttpEndpoint: "disabled" },
  };
  const runner = async (_command, args) => {
    calls.push(args);
    if (args.includes("describe-instances")) return JSON.stringify(instanceState === "terminated" ? [] : [{ ...instance, State: { Name: instanceState } }]);
    if (args.includes("terminate-instances")) instanceState = "shutting-down";
    if (args.includes("instance-terminated")) instanceState = "terminated";
    if (args.includes("describe-volumes")) return JSON.stringify(volumeState === "deleted" ? [] : [{ VolumeId: "vol-0123456789abcdef0", State: volumeState, Tags: tags }]);
    if (args.includes("delete-volume")) volumeState = "deleting";
    if (args.includes("volume-deleted")) volumeState = "deleted";
    return "";
  };
  await new Ec2Backend({ store: {}, config, commandRunner: runner }).destroy(chat);
  assert.equal(instanceState, "terminated");
  assert.equal(volumeState, "deleted");
  assert.ok(calls.some(args => args.includes("instance-terminated")));
  assert.ok(calls.some(args => args.includes("volume-deleted")));
  assert.ok(calls.some(args => args.includes("delete-volume")));
});
