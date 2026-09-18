import assert from "node:assert/strict";
import test from "node:test";
import { environmentFor, assertWorkerKey, assertWorkerOnlyUpdate, publishWorkerOnlyUpdate, parsePublishedEnvironment } from "../scripts/aws-secrets.mjs";
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
  assert.equal(environmentFor({ ...secrets, AGENT_ALLOWED_EMAILS: " Work@Example.Test,second@example.test " }, outputs, image, key).AGENT_ALLOWED_EMAILS, "work@example.test,second@example.test");
  assert.throws(() => environmentFor({ ...secrets, AGENT_ALLOWED_EMAILS: "not-an-email" }, outputs, image, key));
});

test("secret publication rejects missing keys, plaintext origins and wrong worker identity/version", () => {
  assert.throws(() => environmentFor({ ...secrets, GOOGLE_CLIENT_SECRET: "" }, outputs, image, key));
  assert.throws(() => environmentFor({ ...secrets, AGENT_ENCRYPTION_KEY: "invalid" }, outputs, image, key));
  assert.throws(() => environmentFor(secrets, { ...outputs, PublicUrl: "http://example.com" }, image, key));
  assert.throws(() => environmentFor(secrets, outputs, { ...image, Tags: [] }, key));
  assert.throws(() => environmentFor(secrets, outputs, { ...image, Architecture: "arm64" }, key));
  assert.throws(() => environmentFor(secrets, outputs, image, "not-a-private-key"));
});

test("secret publication requires the private transport key to match the deployed public key", () => {
  const key = "ssh-ed25519 ZmFrZS10ZXN0LWtleQ==";
  const pair = { KeyName: "deployment-key", PublicKey: key + " deployment comment" };
  assert.doesNotThrow(() => assertWorkerKey(key, pair, "deployment-key"));
  assert.throws(() => assertWorkerKey(key, pair, "different-deployment"));
  assert.throws(() => assertWorkerKey("ssh-ed25519 ZGlmZmVyZW50", pair, "deployment-key"));
  assert.throws(() => assertWorkerKey("invalid", pair, "deployment-key"));
});

test("worker metadata updates cannot alter or remove any existing setting or credential", () => {
  const before = environmentFor(secrets, outputs, { ...image, ImageId: "ami-0123456789abcdef0" }, key);
  const after = { ...before, AGENT_EC2_AMI_ID: "ami-1234567890abcdef0" };
  assert.doesNotThrow(() => assertWorkerOnlyUpdate(before, after));
  for (const field of Object.keys(before).filter(name => name !== "AGENT_EC2_AMI_ID")) {
    assert.throws(() => assertWorkerOnlyUpdate(before, { ...after, [field]: "changed" }));
    const missing = { ...after }; delete missing[field];
    assert.throws(() => assertWorkerOnlyUpdate(before, missing));
  }
  assert.throws(() => assertWorkerOnlyUpdate(before, { ...after, AWS_SECRET_ACCESS_KEY: "forbidden" }));
});

test("worker update uses a temporary version and conditional promotion, never overwriting a concurrent publication", async () => {
  const arn = "arn:aws:secretsmanager:us-east-2:456808212788:secret:fixture";
  const version = "11111111-2222-3333-4444-555555555555", previousVersion = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const before = environmentFor(secrets, outputs, { ...image, ImageId: "ami-0123456789abcdef0" }, key);
  const next = { ...before, AGENT_EC2_AMI_ID: "ami-1234567890abcdef0" };
  const current = { ARN: arn, VersionId: previousVersion, VersionStages: ["AWSCURRENT"], SecretString: JSON.stringify(before) };
  for (const concurrent of [false, true]) {
    const calls = [];
    const awsCall = async (op, args) => {
      calls.push([op, args]);
      const value = flag => args[args.indexOf(flag) + 1];
      if (op[1] === "put-secret-value") {
        assert.equal(value("--version-stages"), `relay-worker-${version}`);
        assert.equal(value("--secret-string"), "file:///private-tmpfs/fixture.json");
        return { ARN: arn, VersionId: version };
      }
      if (op[1] === "get-secret-value") return { ARN: arn, VersionId: version, SecretString: JSON.stringify(next) };
      if (value("--version-stage") === "AWSCURRENT") {
        assert.equal(value("--remove-from-version-id"), previousVersion);
        assert.equal(value("--move-to-version-id"), version);
        if (concurrent) throw new Error("concurrent-publication");
      }
      return {};
    };
    const run = () => publishWorkerOnlyUpdate(arn, current, next, { awsCall, version,
      secretFile: async (env, fn) => { assert.deepEqual(env, next); return fn("/private-tmpfs/fixture.json"); } });
    if (concurrent) await assert.rejects(run, /concurrent-publication/);
    else assert.deepEqual(await run(), { changed: true });
    assert.equal(calls.filter(([op, args]) => op[1] === "update-secret-version-stage" && args.includes("AWSCURRENT")).length, 1);
    assert.ok(calls.at(-1)[1].includes(`relay-worker-${version}`));
    assert.ok(!JSON.stringify(calls).includes(secrets.GOOGLE_CLIENT_SECRET));
  }
});

test("wrong secret incarnation and no-op image changes never write a secret", async () => {
  const env = environmentFor(secrets, outputs, { ...image, ImageId: "ami-0123456789abcdef0" }, key);
  const current = { ARN: "owned", VersionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", VersionStages: ["AWSCURRENT"], SecretString: JSON.stringify(env) };
  const awsCall = () => { throw new Error("No AWS writes allowed"); };
  await assert.rejects(() => publishWorkerOnlyUpdate("different", current, env, { awsCall }));
  assert.deepEqual(await publishWorkerOnlyUpdate("owned", current, env, { awsCall }), { changed: false });
});

test("malformed private snapshots cannot expose JSON input in operator diagnostics", async () => {
  for (const value of ['{"PRIVATE":"secret-prefix-leak",', '"secret-prefix-leak"', '["secret-prefix-leak"]', '{"PRIVATE":{"token":"secret-prefix-leak"}}', 'null', '1', '{"unexpected-key":"secret-prefix-leak"}']) {
    assert.throws(() => parsePublishedEnvironment(value), error => error.message === "Published AWS environment is malformed; private contents suppressed");
  }
  const current = { ARN: "owned", VersionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", VersionStages: ["AWSCURRENT"], SecretString: '{"PRIVATE":"secret-prefix-leak",' };
  let calls = 0;
  await assert.rejects(() => publishWorkerOnlyUpdate("owned", current, {}, { awsCall: () => { calls++; } }), error => !error.message.includes("secret-prefix-leak"));
  assert.equal(calls, 0);
  const env = environmentFor(secrets, outputs, { ...image, ImageId: "ami-0123456789abcdef0" }, key);
  current.SecretString = JSON.stringify(env);
  const version = "11111111-2222-3333-4444-555555555555";
  await assert.rejects(() => publishWorkerOnlyUpdate("owned", current, { ...env, AGENT_EC2_AMI_ID: "ami-1234567890abcdef0" }, {
    version, secretFile: async (_env, fn) => fn("/private/fixture.json"),
    awsCall: async op => op[1] === "get-secret-value" ? { ARN: "owned", VersionId: version, SecretString: 'secret-prefix-leak' } : { ARN: "owned", VersionId: version },
  }), error => error.message === "Published AWS environment is malformed; private contents suppressed");
});
