import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { Ec2Backend } from "../src/worker-backends.mjs";

function ec2Config(overrides = {}) {
  return loadConfig({
    AGENT_WEB_HOST: "127.0.0.1",
    AGENT_WORKER_BACKEND: "ec2",
    AGENT_EC2_GATEWAY_ORIGIN: "http://gateway.internal:8787",
    AGENT_EC2_ALLOW_INSECURE_GATEWAY: "1",
    AGENT_EC2_AMI_ID: "ami-fixture",
    AGENT_EC2_DEPLOYMENT: "fixture",
    AGENT_EC2_SUBNET_ID: "subnet-fixture",
    AGENT_EC2_SECURITY_GROUP_ID: "sg-fixture",
    AGENT_EC2_KEY_NAME: "key-fixture",
    AGENT_EC2_SSH_PRIVATE_KEY: "/tmp/key-fixture",
    AGENT_EC2_SSH_USER: "ubuntu",
    AWS_PROFILE: "fixture",
    AWS_REGION: "us-test-1",
    OPENAI_API_KEY: "sk-fixture",
    ANTHROPIC_API_KEY: "sk-ant-fixture",
    ...overrides,
  });
}

test("EC2 backend starts a stopped per-chat instance and stops it on sleep", async () => {
  const calls = [];
  let state = "stopped";
  const instance = () => ({
    InstanceId: "i-fixture",
    State: { Name: state },
    PrivateIpAddress: "10.0.0.42",
  });
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === "ssh") {
      const remote = args.at(-1);
      return remote.includes(".workspace-seeded") ? "ready" : "";
    }
    if (args.includes("describe-instances")) return JSON.stringify(instance());
    if (args.includes("start-instances")) state = "running";
    if (args.includes("stop-instances")) state = "stopped";
    return "";
  };
  const backend = new Ec2Backend({ store: {}, config: ec2Config({ SSH_BIN: "ssh" }), commandRunner: runner });
  const chat = { id: "chat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspace: "/tmp/workspace" };
  const executor = await backend.acquire(chat);
  assert.equal(executor.metadata.instanceId, "i-fixture");
  assert.equal(executor.metadata.host, "10.0.0.42");
  assert.ok(calls.some(({ args }) => args.includes("start-instances")));
  assert.ok(calls.some(({ command, args }) => command === "ssh" && args.at(-1).includes("command -v codex")));
  assert.ok(calls.some(({ command, args }) => command === "ssh" && args.at(-1).includes(".heartbeat")));

  assert.deepEqual(await backend.sleep(chat), { instanceId: "i-fixture", stopped: true });
  assert.ok(calls.some(({ args }) => args.includes("stop-instances")));
  assert.ok(calls.some(({ args }) => args.includes("instance-stopped")));
  assert.deepEqual(await backend.sleep(chat), { instanceId: "i-fixture", stopped: true });
});

test("EC2 backend creates encrypted, IMDSv2-only worker tagged to one chat", async () => {
  const calls = [];
  let instance = null;
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === "ssh") return args.at(-1).includes(".workspace-seeded") ? "ready" : "";
    if (args.includes("describe-instances") && !args.includes("--instance-ids")) return instance ? JSON.stringify(instance) : "null";
    if (args.includes("run-instances")) {
      instance = { InstanceId: "i-created", State: { Name: "pending" } };
      return JSON.stringify(instance);
    }
    if (args.includes("describe-instances") && args.includes("--instance-ids")) {
      instance = { InstanceId: "i-created", State: { Name: "running" }, PrivateIpAddress: "10.0.0.77" };
      return JSON.stringify(instance);
    }
    return "";
  };
  const backend = new Ec2Backend({ store: {}, config: ec2Config({ SSH_BIN: "ssh" }), commandRunner: runner });
  const chat = { id: "chat_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", workspace: "/tmp/workspace" };
  await backend.acquire(chat);
  const launch = calls.find(({ args }) => args.includes("run-instances")).args;
  assert.ok(launch.includes("HttpTokens=required,HttpEndpoint=enabled"));
  const blockDevice = JSON.parse(launch[launch.indexOf("--block-device-mappings") + 1]);
  assert.equal(blockDevice[0].Ebs.Encrypted, true);
  assert.match(launch.join(" "), /AgentWebChat/);
  assert.match(launch.join(" "), /chat_b{32}/);
});

test("EC2 configuration rejects a plaintext public gateway by default", () => {
  assert.throws(
    () => ec2Config({ AGENT_EC2_ALLOW_INSECURE_GATEWAY: "0" }),
    /must use HTTPS/,
  );
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
