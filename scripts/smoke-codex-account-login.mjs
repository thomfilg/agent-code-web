// Exercise the installed native device-login implementation against a loopback
// OAuth fixture. No real accounts, browser consent, tokens or model turns.
import assert from "node:assert/strict";
import http from "node:http";
import { access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentAccounts } from "../src/agent-accounts.mjs";
import { CodexAccountClient } from "../src/codex-account-client.mjs";
import { MemoryRecords, RecordCipher } from "../src/database.mjs";
import { JsonRpcProcess } from "../src/json-rpc-process.mjs";

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
  sub: "fixture-native-subject", email: "fixture@example.test",
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-workspace", chatgpt_plan_type: "plus", chatgpt_user_id: "fixture-user" },
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.fixture-signature`;
const routes = new Map();
const server = http.createServer(async (request, response) => {
  for await (const _ of request) { /* All input belongs to the empty fixture profile. */ }
  const route = new URL(request.url, "http://127.0.0.1").pathname;
  routes.set(route, (routes.get(route) || 0) + 1);
  response.setHeader("Content-Type", "application/json");
  if (request.method !== "POST") { response.statusCode = 405; response.end("{}"); return; }
  if (route === "/api/accounts/deviceauth/usercode") {
    response.end(JSON.stringify({ device_auth_id: "fixture-device", user_code: "TEST-1234", interval: "1" }));
  } else if (route === "/api/accounts/deviceauth/token") {
    response.end(JSON.stringify({ authorization_code: "fixture-code", code_challenge: "fixture-challenge", code_verifier: "fixture-verifier" }));
  } else if (route === "/oauth/token") {
    response.end(JSON.stringify({ id_token: idToken, access_token: "fictitious-native-access", refresh_token: "fictitious-native-refresh", token_type: "Bearer", expires_in: 3600 }));
  } else { response.statusCode = 404; response.end("{}"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const issuer = `http://127.0.0.1:${server.address().port}`;
const profiles = new Set(), records = new MemoryRecords();
const ownerId = `user_${"a".repeat(32)}`;
let accountReads = 0, initiallyUnsignedReads = 0;
const config = { codex: { bin: process.env.CODEX_BIN || "codex" }, processIsolation: process.platform === "linux" ? "namespace" : "none" };
const clientFactory = () => new CodexAccountClient(config, { rpcFactory: options => {
  profiles.add(path.dirname(options.spawnOptions.env.CODEX_HOME));
  // This native test-only override is never accepted by the Relay controller's
  // production configuration or inherited from a user's environment.
  const rpc = new JsonRpcProcess({ ...options, spawnOptions: { ...options.spawnOptions,
    env: { ...options.spawnOptions.env, CODEX_APP_SERVER_LOGIN_ISSUER: issuer } } });
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, ...args) => {
    const result = await request(method, ...args);
    if (method === "account/read") { accountReads++; if (result.account === null) initiallyUnsignedReads++; }
    if (method === "account/login/start") {
      assert.equal(result.verificationUrl, `${issuer}/codex/device`);
      // The fixture has no browser ceremony. Preserve the controller's strict
      // production URL validation instead of adding a loopback exception.
      return { ...result, verificationUrl: "https://auth.openai.com/codex/device" };
    }
    return result;
  };
  return rpc;
} });
const accounts = new AgentAccounts({ records, config, clientFactory });
let reloaded;
try {
  await accounts.initialize();
  let lastId;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const pending = await accounts.begin(ownerId, { provider: "codex", name: `Native fixture ${attempt}`, companies: ["fixture"], allowUnassigned: false });
    lastId = pending.account.id;
    const deadline = Date.now() + 25000;
    while (accounts.list(ownerId).find(account => account.id === lastId)?.status === "pending" && Date.now() < deadline) await delay(20);
    assert.equal((await accounts.status(ownerId, lastId)).account.status, "connected");
    await accounts.locks.get(lastId);
    const stored = await records.get("agent-account", lastId);
    assert.equal(stored.subject, "fixture-native-subject");
    assert.equal(stored.accountIdentity, "fixture-workspace");
    assert.equal(stored.auth.tokens.refresh_token, "fictitious-native-refresh");
    assert.doesNotMatch(JSON.stringify(accounts.list(ownerId)), /fictitious|id_token|refresh_token/);
    const cipher = new RecordCipher(Buffer.alloc(32, 17));
    const encrypted = cipher.seal("agent-account", lastId, stored);
    assert.equal(encrypted.includes(Buffer.from("fictitious-native-refresh")), false);
    assert.equal(cipher.open("agent-account", lastId, encrypted).id, lastId);
  }
  await accounts.close();
  reloaded = new AgentAccounts({ records, config, clientFactory }); await reloaded.initialize();
  assert.equal(reloaded.list(ownerId).length, 5);
  const credential = await reloaded.credentials(ownerId, lastId, { agent: "codex", repositories: [{ fullName: "fixture/native" }] });
  assert.equal(credential.chatgptAccountId, "fixture-workspace");
  assert.equal(credential.accessToken, "fictitious-native-access");
  assert.equal(Object.hasOwn(credential, "refreshToken"), false);
  assert.equal(routes.get("/api/accounts/deviceauth/usercode"), 5);
  assert.equal(routes.get("/api/accounts/deviceauth/token"), 5);
  assert.equal(routes.get("/oauth/token"), 5);
  console.log(JSON.stringify({ nativeDeviceLogins: 5, accountReads, initiallyUnsignedReads,
    namedAccountReload: true, controllerCredentialCheck: true, realCredentialsUsed: false, realModelTurns: 0 }));
} catch {
  console.error("Native device-login fixture failed. No real credentials or model turns were used.");
  process.exitCode = 1;
} finally {
  await accounts.close(); await reloaded?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (const directory of profiles) await assert.rejects(access(directory), { code: "ENOENT" });
}
