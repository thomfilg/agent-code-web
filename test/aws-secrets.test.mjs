import assert from "node:assert/strict";
import test from "node:test";
import { environmentFor } from "../scripts/aws-secrets.mjs";
const secrets = { GOOGLE_CLIENT_ID: "google-fixture", GOOGLE_CLIENT_SECRET: "google-secret-fixture", AGENT_OWNER_EMAIL: "owner@example.test", AUTH_SECRET: "x".repeat(48), AGENT_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"), DOPPLER_TOKEN: "DO-NOT-COPY", OPENAI_API_KEY: "DO-NOT-COPY", ANTHROPIC_API_KEY: "DO-NOT-COPY" };
const outputs = { PublicUrl: "https://example.cloudfront.net", WorkerSubnetId: "subnet-fixture", WorkerSecurityGroupId: "sg-fixture", WorkerKeyName: "deployment-key" };
const image = { ImageId: "ami-fixture", State: "available", Architecture: "x86_64", Tags: Object.entries({ ManagedBy: "agent-relay", AgentRelayDeployment: "agent-relay-mvp", AgentRelayWorkerKey: "deployment-key", CodexVersion: "0.154.0", ClaudeVersion: "2.1.222" }).map(([Key, Value]) => ({ Key, Value })) };
const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake-test-key\n-----END OPENSSH PRIVATE KEY-----\n";

test("AWS environment copies only Google/encryption settings and uses IAM plus isolated workers", () => {
  const env = environmentFor(secrets, outputs, image, key);
  for (const name of ["DOPPLER_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) assert.equal(env[name], undefined);
  assert.equal(env.AGENT_WORKER_BACKEND, "ec2");
  assert.equal(env.AGENT_EC2_USE_PUBLIC_IP, "0");
  assert.equal(env.AGENT_EC2_DEPLOYMENT, "agent-relay-mvp");
  assert.equal(env.AGENT_ENABLE_MOCK, "0");
  assert.equal(env.AGENT_ALLOWED_EMAILS, "");
  assert.equal(Buffer.from(env.AGENT_WORKER_SSH_KEY_BASE64, "base64").toString(), key);
});

test("secret publication rejects missing keys, plaintext origins and wrong worker identity/version", () => {
  assert.throws(() => environmentFor({ ...secrets, GOOGLE_CLIENT_SECRET: "" }, outputs, image, key));
  assert.throws(() => environmentFor({ ...secrets, AGENT_ENCRYPTION_KEY: "invalid" }, outputs, image, key));
  assert.throws(() => environmentFor(secrets, { ...outputs, PublicUrl: "http://example.com" }, image, key));
  assert.throws(() => environmentFor(secrets, outputs, { ...image, Tags: [] }, key));
  assert.throws(() => environmentFor(secrets, outputs, { ...image, Architecture: "arm64" }, key));
  assert.throws(() => environmentFor(secrets, outputs, image, "not-a-private-key"));
});
