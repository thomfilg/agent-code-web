import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFile, writeFile, symlink, access, stat } from "node:fs/promises";
import path from "node:path";
import { ClaudeAccountClient, ClaudeAccountError, readClaudeAuth } from "../src/claude-account-client.mjs";
import { claudeAuthFixture, claudeModelsFixture } from "./fixtures/claude-account.mjs";

const url = "https://claude.com/cai/oauth/authorize?state=fixture-state&client_id=fixture-client&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge_method=S256&response_type=code";
function fixture({ loginUrl = url, quiet = false, profile = { account: { uuid: "person", email: "claude@example.test" }, organization: { uuid: "company" } } } = {}) {
  const children = [], requests = [];
  const spawn = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    child.kill = () => { child.exitCode = 1; child.emit("exit", 1); child.emit("close", 1); };
    const filename = path.join(options.env.CLAUDE_CONFIG_DIR, ".credentials.json");
    child.stdin = new Writable({ write(chunk, encoding, done) {
      requests.push(chunk.toString());
      (async () => {
        if (args.includes("login")) {
          await writeFile(filename, JSON.stringify(claudeAuthFixture()), { mode: 0o600 });
          child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0);
        } else {
          const request = JSON.parse(chunk.toString());
          const auth = JSON.parse(await readFile(filename, "utf8")); auth.claudeAiOauth.expiresAt = Date.now() + 3600000;
          await writeFile(filename, JSON.stringify(auth), { mode: 0o600 });
          child.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { models: claudeModelsFixture } } })}\n`);
        }
      })().then(() => done(), done);
    } });
    children.push({ child, command, args, options });
    if (args.includes("login") && !quiet) queueMicrotask(() => child.stdout.write(`Open ${loginUrl}\nPaste code here if prompted > `));
    return child;
  };
  const fetchImpl = async (endpoint, options) => {
    if (endpoint === "https://platform.claude.com/v1/oauth/token") {
      const body = JSON.parse(options.body); assert.equal(body.grant_type, "refresh_token"); assert.equal(body.refresh_token, "fixture-claude-refresh-value");
      assert.equal(options.redirect, "error"); return new Response(JSON.stringify({ access_token: "fixture-claude-access-value", refresh_token: "fixture-claude-refresh-value", expires_in: 3600, scope: "user:profile user:inference" }));
    }
    assert.equal(endpoint, "https://api.anthropic.com/api/oauth/profile"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-claude-access-value"); return new Response(JSON.stringify(profile));
  };
  return { children, requests, spawn, fetchImpl };
}
async function setup(t, options) {
  const fake = fixture(options), client = new ClaudeAccountClient({ claude: { bin: "fixture-claude" }, processIsolation: "namespace" }, { ...fake, timeoutMs: 100 });
  await client.start(); t.after(() => client.close()); return { client, ...fake };
}

test("Claude native ceremony has a private clean environment, explicit matching code, verified identity and cleanup", async t => {
  const { client, children, requests } = await setup(t), directory = client.directory;
  const flow = await client.login(); assert.equal(flow.inputRequired, true); assert.equal(flow.verificationUrl, url);
  assert.deepEqual(children[0].args, ["auth", "login", "--claudeai"]);
  const env = children[0].options.env; assert.equal(env.BROWSER, "/bin/true"); assert.notEqual(env.HOME, process.env.HOME);
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]) assert.equal(env[key], undefined);
  assert.equal((await stat(client.home)).mode & 0o777, 0o700);
  await assert.rejects(() => client.submitCode("private-code#wrong-state"), { code: "code" }); assert.equal(requests.length, 0);
  await client.submitCode("private-code#fixture-state"); await flow.completed;
  await assert.rejects(() => client.submitCode("another-code#fixture-state"), { code: "code" });
  const snapshot = await client.snapshot(); assert.equal(snapshot.subject, "person"); assert.equal(snapshot.accountIdentity, "company");
  assert.equal(snapshot.email, "claude@example.test"); assert.deepEqual(snapshot.auth, { claudeAiOauth: { ...claudeAuthFixture(snapshot.auth.claudeAiOauth.expiresAt - 3600000).claudeAiOauth, clientId: "fixture-client" } });
  await client.close(); await assert.rejects(access(directory), { code: "ENOENT" });
});

test("Claude URL allowlist rejects arbitrary origins, userinfo, callbacks and wrong state before accepting any code", async t => {
  for (const loginUrl of [url.replace("claude.com", "evil.example"), url.replace("claude.com", "user:password@claude.com"), url.replace("platform.claude.com", "evil.example"), url.replace("S256", "plain"), url.replace("fixture-state", ""), url.replace("fixture-client", "")]) {
    const { client } = await setup(t, { loginUrl }); await assert.rejects(() => client.login(), ClaudeAccountError); await client.close();
  }
});

test("Claude startup times out without leaking output and cancel closes the pending ceremony", async t => {
  const { client, children } = await setup(t, { quiet: true });
  await assert.rejects(() => client.login(), { code: "timeout" }); await client.close(); assert.equal(children[0].child.exitCode, 1);
  const next = await setup(t); const flow = await next.client.login(); await next.client.cancel(); await assert.rejects(flow.completed, ClaudeAccountError);
});

test("Claude refresh/model inspection uses no user turn and always validates account identity online", async t => {
  const { client, children, requests } = await setup(t), file = path.join(client.home, ".credentials.json");
  await writeFile(file, JSON.stringify(claudeAuthFixture(Date.now() - 7200000)), { mode: 0o600 });
  const snapshot = await client.snapshot({ refresh: true }); assert.ok(snapshot.auth.claudeAiOauth.expiresAt > Date.now());
  assert.deepEqual(await client.models(), claudeModelsFixture);
  assert.equal(children.length, 1); assert.ok(children[0].args.includes("--strict-mcp-config")); assert.ok(children[0].args.includes('{"disableAllHooks":true}'));
  assert.ok(requests.every(value => JSON.parse(value).type === "control_request"));
  const wrong = await setup(t, { profile: { account: {}, organization: {} } });
  await writeFile(path.join(wrong.client.home, ".credentials.json"), JSON.stringify(claudeAuthFixture()), { mode: 0o600 });
  await assert.rejects(() => wrong.client.snapshot(), ClaudeAccountError);
});

test("Claude credential reader rejects symlinks, oversize and missing inference or refresh credentials", async t => {
  const { client } = await setup(t), target = path.join(client.home, "target"), link = path.join(client.home, "link");
  await writeFile(target, JSON.stringify(claudeAuthFixture())); await symlink(target, link);
  await assert.rejects(() => readClaudeAuth(link));
  for (const content of [" ".repeat(262145), JSON.stringify({ claudeAiOauth: { ...claudeAuthFixture().claudeAiOauth, refreshToken: "" } }), JSON.stringify({ claudeAiOauth: { ...claudeAuthFixture().claudeAiOauth, scopes: ["user:profile"] } })]) {
    await writeFile(target, content); await assert.rejects(() => readClaudeAuth(target));
  }
});

test("Claude cancellation aborts a pending provider verification without leaking diagnostics", async t => {
  const entered = Promise.withResolvers();
  const client = new ClaudeAccountClient({ claude: { bin: "unused" } }, { fetchImpl: async (_url, { signal }) => {
    entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("private-provider-diagnostic")), { once: true }));
  } });
  await client.start(claudeAuthFixture()); t.after(() => client.close());
  const snapshot = assert.rejects(() => client.snapshot(), { code: "temporary" }); await entered.promise;
  await client.cancel(); await snapshot;
});

test("Claude distinguishes temporary throttling/transport failures from revoked access and invalid profile data", async t => {
  for (const failure of ["throttled", "network", "body", "revoked", "invalid"]) {
    const client = new ClaudeAccountClient({ claude: { bin: "unused" } }, { fetchImpl: async () => {
      if (failure === "network") throw TypeError("private-provider-diagnostic");
      if (failure === "body") return new Response(new ReadableStream({ start(controller) { controller.error(TypeError("private-provider-diagnostic")); } }));
      return new Response("private-provider-diagnostic", { status: failure === "throttled" ? 429 : failure === "revoked" ? 401 : 200 });
    } });
    await client.start(claudeAuthFixture()); t.after(() => client.close());
    await assert.rejects(() => client.snapshot(), { code: ["throttled", "network", "body"].includes(failure) ? "temporary" : "authentication" });
    await client.close();
  }
});
