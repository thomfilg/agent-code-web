import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

const environment = {
  AGENT_PREVIEW_ENABLED: "1", AGENT_WORKER_BACKEND: "ec2", AGENT_EC2_GATEWAY_ORIGIN: "https://gateway.example.test",
  AGENT_GOOGLE_AUTH: "1", AGENT_WEB_PUBLIC_URL: "https://relay.example.test", AGENT_PREVIEW_ACCOUNT_ID: "111122223333",
  AGENT_EC2_DEPLOYMENT: "relay-test", AGENT_PREVIEW_VPC_ORIGIN_ID: "vo_test", AGENT_PREVIEW_CONTROLLER_INSTANCE_ID: "i-0123456789abcdef0",
  AGENT_PREVIEW_CONTROLLER_ORIGIN_DNS: "ip-10-0-0-1.us-east-2.compute.internal", AGENT_PREVIEW_RELAY_DISTRIBUTION_ID: "ERELAYTEST",
};

test("app previews are opt-in and require EC2 plus authenticated HTTPS", () => {
  assert.equal(loadConfig({}).preview.enabled, false);
  assert.equal(loadConfig(environment).preview.enabled, true);
  for (const override of [{ AGENT_WORKER_BACKEND: "local" }, { AGENT_GOOGLE_AUTH: "0" }, { AGENT_WEB_PUBLIC_URL: "http://localhost:8787" }]) {
    assert.throws(() => loadConfig({ ...environment, ...override }), /EC2 workers and HTTPS Google/);
  }
});

test("preview deployment identity must be complete before activation", () => {
  for (const key of ["AGENT_PREVIEW_ACCOUNT_ID", "AGENT_EC2_DEPLOYMENT", "AGENT_PREVIEW_VPC_ORIGIN_ID", "AGENT_PREVIEW_CONTROLLER_INSTANCE_ID", "AGENT_PREVIEW_CONTROLLER_ORIGIN_DNS", "AGENT_PREVIEW_RELAY_DISTRIBUTION_ID"]) {
    assert.throws(() => loadConfig({ ...environment, [key]: "" }), /deployment identity/);
  }
  assert.throws(() => loadConfig({ ...environment, AGENT_PREVIEW_ACCOUNT_ID: "not-an-account" }), /deployment identity/);
});

test("preview resource limits are bounded and nested per chat, owner and deployment", () => {
  const config = loadConfig(environment).preview;
  assert.deepEqual([config.maxHosts, config.maxPerOwner, config.maxPerChat], [8, 4, 2]);
  for (const value of ["0", "41", "2.5", "Infinity"]) {
    assert.throws(() => loadConfig({ ...environment, AGENT_PREVIEW_MAX_HOSTS: value }), /integer/);
  }
  assert.throws(() => loadConfig({ ...environment, AGENT_PREVIEW_MAX_PER_OWNER: "9" }), /deployment limit/);
  assert.throws(() => loadConfig({ ...environment, AGENT_PREVIEW_MAX_PER_CHAT: "5" }), /deployment limit/);
});
