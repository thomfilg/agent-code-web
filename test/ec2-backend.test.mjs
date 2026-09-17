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
