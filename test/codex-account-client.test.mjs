import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { access, readFile, writeFile, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { CodexAccountClient, CodexAccountError } from "../src/codex-account-client.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const auth = () => ({ auth_mode: "chatgpt", unexpected: "not-retained", tokens: {
  id_token: `header.${Buffer.from(JSON.stringify({ sub: "native-subject" })).toString("base64url")}.signature`,
  access_token: "fixture-native-access", refresh_token: "fixture-native-refresh", account_id: "fixture-workspace",
} });
async function fixture(t, overrides = {}, clientOptions = {}) {
  const root = await temporaryDirectory(t), rpc = new EventEmitter();
  let options;
  rpc.start = () => {}; rpc.notify = () => {}; rpc.respondError = () => {};
  rpc.stop = async () => { rpc.stopped = true; };
  rpc.request = async method => {
    if (method === "initialize") return {};
    if (method === "account/read") return { account: { type: "chatgpt", email: "fixture@example.test", planType: "pro" } };
    if (method === "account/login/start") return { type: "chatgptDeviceCode", loginId: "login-fixture", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" };
    if (method === "account/login/cancel") { rpc.cancelled = true; return {}; }
    throw Error("Unexpected fixture method");
  };
  Object.assign(rpc, overrides);
  const client = new CodexAccountClient(testConfig(root), { ...clientOptions, rpcFactory: value => { options = value; return rpc; } });
  t.after(() => client.close()); await client.start();
  return { client, rpc, options, root };
}

test("controller auth runs with an empty private environment, only native login completion authorizes, and cleanup removes its profile", async t => {
  const { client, rpc, options } = await fixture(t);
  assert.deepEqual(Object.keys(options.spawnOptions.env).sort(), ["CODEX_HOME", "HOME", "LANG", "NO_COLOR", "PATH"]);
  assert.notEqual(options.spawnOptions.env.HOME, process.env.HOME);
  assert.equal((await stat(client.directory)).mode & 0o777, 0o700);
  assert.ok(options.args.includes('cli_auth_credentials_store="file"'));
  const flow = await client.login(); let connected = false; flow.completed.then(() => { connected = true; });
  rpc.emit("notification", { method: "account/login/completed", params: { loginId: "other-login", success: true } });
  await Promise.resolve(); assert.equal(connected, false);
  rpc.emit("notification", { method: "account/login/completed", params: { loginId: "login-fixture", success: true } });
  await flow.completed; assert.equal(connected, true);
  await writeFile(path.join(client.home, "auth.json"), JSON.stringify(auth()), { mode: 0o600 });
  const snapshot = await client.snapshot();
  assert.equal(snapshot.subject, "native-subject"); assert.equal(snapshot.email, "fixture@example.test");
  assert.equal(snapshot.auth.unexpected, undefined);
  const directory = client.directory; await client.close();
  assert.equal(rpc.stopped, true); await assert.rejects(access(directory), { code: "ENOENT" });
});

test("seeded credentials stay in a mode-0600 controller file, never argv or environment", async t => {
  const { client, options } = await fixture(t); await client.close();
  await client.start(auth());
  assert.equal((await stat(path.join(client.home, "auth.json"))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path.join(client.home, "auth.json"), "utf8")).tokens.refresh_token, "fixture-native-refresh");
  assert.doesNotMatch(JSON.stringify(options), /fixture-native-(access|refresh)/);
});

test("untrusted native URLs, malformed auth files and symlinks fail closed without disclosing secrets", async t => {
  const { client, rpc, root } = await fixture(t);
  const request = rpc.request;
  for (const verificationUrl of ["http://auth.openai.com/codex/device", "https://evil.example/codex/device", "https://auth.openai.com/codex/device?token=secret-native-value"]) {
    rpc.request = async method => method === "account/login/start" ? { type: "chatgptDeviceCode", loginId: "fixture", userCode: "CODE-1234", verificationUrl } : request(method);
    await assert.rejects(() => client.login(), error => error instanceof CodexAccountError && error.code === "unsupported_response" && !error.message.includes("secret-native-value"));
  }
  rpc.request = request;
  await writeFile(path.join(root, "outside.json"), JSON.stringify(auth()));
  await symlink(path.join(root, "outside.json"), path.join(client.home, "auth.json"));
  await assert.rejects(() => client.snapshot(), { code: "credentials_unavailable" });
  await client.close(); await client.start({ tokens: { access_token: "secret-native-value" } });
  await assert.rejects(() => client.snapshot(), error => error.code === "credentials_invalid" && !error.message.includes("secret-native-value"));
});

test("early completion is not lost; cancellation and failure reject pending consent", async t => {
  const { client, rpc } = await fixture(t), request = rpc.request;
  rpc.request = async method => {
    const result = await request(method);
    if (method === "account/login/start") rpc.emit("notification", { method: "account/login/completed", params: { loginId: result.loginId, success: true } });
    return result;
  };
  await (await client.login()).completed;
  rpc.request = request;
  const flow = await client.login(); await client.cancel(); await client.close();
  await assert.rejects(flow.completed, /authentication/); assert.equal(rpc.cancelled, true);
});

test("successful native consent can precede account/read becoming signed in", async t => {
  const { client, rpc } = await fixture(t), request = rpc.request;
  await writeFile(path.join(client.home, "auth.json"), JSON.stringify(auth()), { mode: 0o600 });
  const reads = [];
  rpc.request = async (method, params, ...args) => {
    if (method === "account/read") {
      reads.push(params);
      if (reads.length === 1) return { account: null, requiresOpenaiAuth: true };
    }
    return request(method, params, ...args);
  };
  const flow = await client.login();
  rpc.emit("notification", { method: "account/login/completed", params: { loginId: "login-fixture", success: true } });
  await flow.completed;
  const snapshot = await client.snapshot();
  assert.equal(snapshot.subject, "native-subject");
  assert.equal(snapshot.auth.tokens.account_id, "fixture-workspace");
  assert.deepEqual(reads, [{ refreshToken: false }, { refreshToken: false }]);
});

test("an unsigned account is not retried or accepted from its file without native consent", async t => {
  const { client, rpc } = await fixture(t), request = rpc.request;
  await writeFile(path.join(client.home, "auth.json"), JSON.stringify(auth()), { mode: 0o600 });
  let reads = 0;
  rpc.request = async (method, ...args) => {
    if (method === "account/read") { reads++; return { account: null }; }
    return request(method, ...args);
  };
  await assert.rejects(() => client.snapshot(), { code: "account_unavailable" });
  assert.equal(reads, 1);
  const flow = await client.login();
  rpc.emit("notification", { method: "account/login/completed", params: { loginId: "other-login", success: true } });
  await assert.rejects(() => client.snapshot(), { code: "account_unavailable" });
  assert.equal(reads, 2);
  await client.close(); await assert.rejects(flow.completed, { code: "authentication" });
});

test("account readiness has a total deadline and never accepts a different auth type", async t => {
  const { client, rpc } = await fixture(t, {}, { accountReadyTimeoutMs: 40, accountReadyRetryMs: 2 }), request = rpc.request;
  const flow = await client.login();
  rpc.emit("notification", { method: "account/login/completed", params: { loginId: "login-fixture", success: true } });
  await flow.completed;
  const reads = [];
  rpc.request = async (method, params, timeoutMs) => {
    if (method === "account/read") { reads.push({ params, timeoutMs }); return { account: null }; }
    return request(method, params, timeoutMs);
  };
  await assert.rejects(() => client.snapshot({ refresh: true }), { code: "verification_timeout" });
  assert.ok(reads.length > 0);
  assert.ok(reads.every(read => read.timeoutMs > 0 && read.timeoutMs <= 40));
  assert.equal(reads[0].params.refreshToken, true);
  assert.ok(reads.slice(1).every(read => read.params.refreshToken === false));
  let otherReads = 0;
  rpc.request = async () => { otherReads++; return { account: { type: "apiKey" } }; };
  await assert.rejects(() => client.snapshot(), { code: "account_unavailable" });
  assert.equal(otherReads, 1);
});

test("verification failures retain only fixed stage diagnostics", async t => {
  const { client, rpc } = await fixture(t), request = rpc.request;
  rpc.request = async () => { throw Error("account/read timed out after 15000ms"); };
  await assert.rejects(() => client.snapshot(), { code: "verification_timeout" });
  rpc.request = async () => { throw Error("secret-native-value https://example.test/private"); };
  await assert.rejects(() => client.snapshot(), error => error.code === "account_unavailable" && !/secret-native-value|example\.test/.test(error.message));
  rpc.request = request;
  await assert.rejects(() => client.snapshot(), { code: "credentials_unavailable" });
  await writeFile(path.join(client.home, "auth.json"), "private-malformed-credential");
  await assert.rejects(() => client.snapshot(), error => error.code === "credentials_invalid" && !error.message.includes("private-malformed-credential"));
});

test("slow native startup and code issuance have separate bounded deadlines", async t => {
  const { client, rpc } = await fixture(t), request = rpc.request;
  await client.close();
  const deadlines = new Map();
  rpc.request = async (method, params, timeoutMs) => {
    deadlines.set(method, timeoutMs);
    if (["initialize", "account/login/start"].includes(method) && !(timeoutMs > 15000 && timeoutMs <= 60000)) throw Error(`${method} timed out after 15000ms`);
    return request(method, params, timeoutMs);
  };
  await client.start(); await client.login(); await client.cancel();
  assert.equal(deadlines.get("initialize"), 60000);
  assert.equal(deadlines.get("account/login/start"), 60000);
  assert.equal(deadlines.get("account/login/cancel"), 5000);
});

test("native failures expose a safe stage-specific message without blaming unrelated account settings", async t => {
  const { client, rpc } = await fixture(t), request = rpc.request;
  for (const [method, nativeMessage, expectedCode] of [
    ["initialize", "initialize timed out after 60000ms", "startup_timeout"],
    ["initialize", "ENOENT secret-native-value", "startup_failed"],
    ["account/login/start", "account/login/start timed out after 60000ms", "code_timeout"],
    ["account/login/start", "device code authentication is not enabled secret-native-value", "device_disabled"],
    ["account/login/start", "request failed secret-native-value https://example.test/private", "code_failed"],
  ]) {
    await client.close();
    rpc.request = async (name, ...args) => { if (name === method) throw Error(nativeMessage); return request(name, ...args); };
    if (method !== "initialize") await client.start();
    await assert.rejects(() => method === "initialize" ? client.start() : client.login(), error => {
      assert.ok(error instanceof CodexAccountError); assert.equal(error.code, expectedCode);
      assert.doesNotMatch(error.message, /secret-native-value|example\.test/);
      if (expectedCode !== "device_disabled") assert.doesNotMatch(error.message, /security settings|workspace administrator/);
      return true;
    });
  }
});
