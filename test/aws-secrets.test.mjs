import assert from "node:assert/strict";
import test from "node:test";
import { environmentFor, assertWorkerKey, assertWorkerOnlyUpdate, publishWorkerOnlyUpdate, parsePublishedEnvironment, initializeWorkerKey } from "../scripts/aws-secrets.mjs";
const secrets = { GOOGLE_CLIENT_ID: "google-fixture", GOOGLE_CLIENT_SECRET: "google-secret-fixture", AGENT_OWNER_EMAIL: "owner@example.test", AUTH_SECRET: "x".repeat(48), AGENT_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"), DOPPLER_TOKEN: "DO-NOT-COPY", OPENAI_API_KEY: "DO-NOT-COPY", ANTHROPIC_API_KEY: "DO-NOT-COPY" };
const outputs = { PublicUrl: "https://example.cloudfront.net", WorkerSubnetId: "subnet-fixture", WorkerSecurityGroupId: "sg-fixture", WorkerKeyName: "deployment-key" };
const image = { ImageId: "ami-aaaaaaaaaaaaaaaaa", OwnerId: "456808212788", Public: false, RootDeviceType: "ebs", RootDeviceName: "/dev/sda1", BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { Encrypted: true } }], State: "available", Architecture: "x86_64", Tags: Object.entries({ ManagedBy: "agent-relay", AgentRelayDeployment: "agent-relay-mvp", AgentRelayWorkerKey: "deployment-key", CodexVersion: "0.154.0", ClaudeVersion: "2.1.222", AgentRelayAcceptance: "verified-v1", AgentRelayAcceptanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }).map(([Key, Value]) => ({ Key, Value })) };
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

test("both secret publication paths require accepted private owned encrypted AMI metadata", () => {
  for (const change of [
    { Public: true }, { OwnerId: "999999999999" }, { BlockDeviceMappings: [] },
    { Tags: image.Tags.filter(tag => !tag.Key.startsWith("AgentRelayAcceptance")) },
    { Tags: image.Tags.map(tag => tag.Key === "AgentRelayAcceptance" ? { ...tag, Value: "verified-v2" } : tag) },
    { Tags: image.Tags.map(tag => tag.Key === "AgentRelayAcceptanceId" ? { ...tag, Value: "not-a-verification-uuid" } : tag) },
  ]) assert.throws(() => environmentFor(secrets, outputs, { ...image, ...change }, key), /verified image|acceptance/);
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

function bootstrapFixture({ existing, concurrent = false, readback = null, metadata = null } = {}) {
  const arn = "arn:aws:secretsmanager:us-east-2:456808212788:secret:fixture";
  const version = "11111111-2222-4333-8444-555555555555", old = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", calls = [];
  let candidate, currentId = existing === undefined ? null : old;
  const awsCall = async (operation, args) => {
    calls.push([operation, args]);
    const flag = key => args[args.indexOf(key) + 1];
    if (operation[1] === "describe-secret") return metadata || { ARN: arn, ...(existing === undefined ? {} : { VersionIdsToStages: { [old]: ["AWSCURRENT"] } }) };
    if (operation[1] === "get-secret-value") return { ARN: arn, VersionId: args.includes("--version-id") ? old : version, VersionStages: ["AWSCURRENT"], SecretString: JSON.stringify(args.includes("--version-id") ? existing : readback || candidate) };
    if (operation[1] === "put-secret-value") {
      assert.equal(flag("--version-stages"), `relay-worker-bootstrap-${version}`);
      assert.equal(flag("--secret-string"), "file:///private-tmpfs/fixture.json");
      if (!currentId) currentId = version; // Actual AWS first-version behavior.
      if (concurrent) currentId = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
      return { ARN: arn, VersionId: version, VersionStages: currentId === version ? ["AWSCURRENT"] : [] };
    }
    if (flag("--version-stage") === "AWSCURRENT") {
      assert.equal(args.includes("--remove-from-version-id"), existing !== undefined);
      if (existing !== undefined) assert.equal(flag("--remove-from-version-id"), old);
      if (currentId !== version && currentId !== (args.includes("--remove-from-version-id") ? flag("--remove-from-version-id") : null)) throw Error("PRIVATE-CONCURRENT-WRITER");
      currentId = version;
    }
    return {};
  };
  return { calls, run: () => initializeWorkerKey(arn, key, { awsCall, version, secretFile: async (value, fn) => { candidate = value; assert.deepEqual(Object.keys(value), ["AGENT_WORKER_SSH_KEY_BASE64"]); return fn("/private-tmpfs/fixture.json"); } }) };
}

test("initial transport bootstrap permits empty secrets only and never publishes an environment", async () => {
  for (const existing of [undefined, {}]) {
    const f = bootstrapFixture({ existing });
    assert.deepEqual(await f.run(), { changed: true });
    assert.equal(f.calls.filter(([op]) => op[1] === "put-secret-value").length, 1);
    assert.doesNotMatch(JSON.stringify(f.calls), /fake-test-key|GOOGLE_CLIENT|AGENT_EC2_AMI|DOPPLER/);
    assert.ok(f.calls.at(-1)[1].includes("relay-worker-bootstrap-11111111-2222-4333-8444-555555555555"));
  }
  const same = bootstrapFixture({ existing: { AGENT_WORKER_SSH_KEY_BASE64: Buffer.from(key).toString("base64") } });
  assert.deepEqual(await same.run(), { changed: false });
  assert.equal(same.calls.some(([op]) => op[1] === "put-secret-value"), false);
});

test("transport bootstrap refuses existing configuration, different key or uncertain secret versions", async () => {
  for (const existing of [{ GOOGLE_CLIENT_SECRET: "PRIVATE" }, { AGENT_WORKER_SSH_KEY_BASE64: "different" }, { AGENT_WORKER_SSH_KEY_BASE64: Buffer.from(key).toString("base64"), AGENT_EC2_AMI_ID: image.ImageId }]) {
    const f = bootstrapFixture({ existing }); await assert.rejects(f.run(), /never overwrites/);
    assert.equal(f.calls.some(([op]) => op[1] === "put-secret-value"), false);
  }
  for (const metadata of [{ ARN: "foreign" }, { ARN: "arn:aws:secretsmanager:us-east-2:456808212788:secret:fixture", VersionIdsToStages: { "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee": ["pending"] } }]) {
    const f = bootstrapFixture({ metadata }); await assert.rejects(f.run());
    assert.equal(f.calls.some(([op]) => op[1] === "put-secret-value"), false);
  }
});

test("transport bootstrap conditional promotion detects concurrent publication and wrong readback safely", async () => {
  for (const existing of [undefined, {}]) for (const fault of [{ concurrent: true }, { readback: { GOOGLE_CLIENT_SECRET: "PRIVATE" } }]) {
    const f = bootstrapFixture({ existing, ...fault });
    await assert.rejects(f.run(), error => /not confirmed/.test(error.message) && !error.message.includes("PRIVATE"));
    assert.equal(f.calls.filter(([op, args]) => op[1] === "update-secret-version-stage" && args.includes("AWSCURRENT")).length, 1);
    assert.ok(f.calls.at(-1)[1].includes("relay-worker-bootstrap-11111111-2222-4333-8444-555555555555"));
  }
});
