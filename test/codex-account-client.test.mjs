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
async function fixture(t, overrides = {}) {
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
  const client = new CodexAccountClient(testConfig(root), { rpcFactory: value => { options = value; return rpc; } });
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
  await assert.rejects(() => client.snapshot(), /authentication/);
  await client.close(); await client.start({ tokens: { access_token: "secret-native-value" } });
  await assert.rejects(() => client.snapshot(), error => !error.message.includes("secret-native-value") && /authentication/.test(error.message));
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
