import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFile, writeFile, symlink, access, stat } from "node:fs/promises";
import path from "node:path";
import { ClaudeAccountClient, ClaudeAccountError, readClaudeAuth } from "../src/claude-account-client.mjs";
import { claudeAuthFixture, claudeModelsFixture } from "./fixtures/claude-account.mjs";

const url = "https://claude.com/cai/oauth/authorize?state=fixture-state&client_id=fixture-client&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge_method=S256&response_type=code";
function fixture({ loginUrl = url, quiet = false, initialModels = claudeModelsFixture, currentModels = claudeModelsFixture, initialCommands = [{ name: "fixture-command" }], settingsSnapshot = {}, listFailure = false, bootstrapGate = null, bootstrapMissing = false, profile = { account: { uuid: "person", email: "claude@example.test" }, organization: { uuid: "company" } } } = {}) {
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
          if (request.request.subtype === "initialize" && !bootstrapMissing) {
            const publish = () => writeFile(path.join(options.env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ modelAccessCache: [], additionalModelOptionsCache: currentModels }), { mode: 0o600 });
            if (bootstrapGate) void bootstrapGate.then(publish).catch(() => {}); else await publish();
          }
          if (request.request.subtype === "list_models" && listFailure === "timeout") return;
          child.stdout.write(`${JSON.stringify({ type: "control_response", response: {
            subtype: request.request.subtype === "list_models" && listFailure ? "error" : "success", request_id: request.request_id,
            error: "PRIVATE fixture native diagnostic", response: request.request.subtype === "initialize" ? { models: initialModels, commands: initialCommands } : request.request.subtype === "get_settings" ? settingsSnapshot : { models: currentModels },
          } })}\n`);
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
  assert.deepEqual(requests.map(value => JSON.parse(value).request.subtype), ["initialize", "list_models", "get_settings"]);
  const wrong = await setup(t, { profile: { account: {}, organization: {} } });
  await writeFile(path.join(wrong.client.home, ".credentials.json"), JSON.stringify(claudeAuthFixture()), { mode: 0o600 });
  await assert.rejects(() => wrong.client.snapshot(), ClaudeAccountError);
});

test("Ultracode capability reuses selected-account initialization without another process or a user prompt", async t => {
  const { client, requests, children } = await setup(t, { initialCommands: [{ name: "effort", argumentHint: "[high|xhigh|ultracode]" }],
    settingsSnapshot: { applied: { model: "native-fixture", effort: "high", ultracode: false }, sources: [{ secret: "must-not-leave-client" }] } });
  await writeFile(path.join(client.home, ".credentials.json"), JSON.stringify(claudeAuthFixture()));
  const models = await client.models();
  assert.deepEqual(models.ultracodeDiscovery, { model: "native-fixture", advertised: true, control: true });
  assert.equal(children.length, 1); assert.equal(requests.length, 3);
  assert.ok(requests.every(packet => JSON.parse(packet).type === "control_request"));
  assert.doesNotMatch(JSON.stringify(models.ultracodeDiscovery), /secret|must-not-leave-client/);
});

test("Claude current native list replaces only startup models and preserves disabled reasons and command metadata", async t => {
  const currentModels = [...claudeModelsFixture,
    { value: "fixture-new-model", displayName: "New native model", description: "Native account option" },
    { value: "fixture-future-model", displayName: "Future model", disabled: true, description: "Update the installed CLI to use this model" },
  ];
  const { client, requests, children } = await setup(t, { currentModels });
  await writeFile(path.join(client.home, ".credentials.json"), JSON.stringify(claudeAuthFixture()));
  assert.deepEqual(await client.models(), currentModels);
  assert.deepEqual(client.initialized.commands, [{ name: "fixture-command" }]);
  assert.equal(client.initialized.models.discoveryIncomplete, undefined);
  assert.deepEqual(await client.models(), currentModels); assert.equal(requests.length, 3); assert.equal(children.length, 1);
  assert.notEqual(children[0].child.exitCode, null);
});

test("Claude refresh control failure keeps only the same account startup snapshot with an explicit incomplete marker", async t => {
  for (const listFailure of [true, "timeout"]) {
    const { client, requests, children } = await setup(t, { listFailure });
    await writeFile(path.join(client.home, ".credentials.json"), JSON.stringify(claudeAuthFixture()));
    const models = await client.models();
    assert.deepEqual(models, claudeModelsFixture); assert.equal(models.discoveryIncomplete, true);
    assert.equal(children.length, 1); assert.equal(requests.length, 3); assert.notEqual(children[0].child.exitCode, null);
  }
});

test("invalid native model inventories cannot fabricate a catalog or expose native diagnostics", async t => {
  for (const currentModels of [null, [null], Array(101).fill({ value: "fixture" })]) {
    const { client, children } = await setup(t, { initialModels: null, currentModels });
    await writeFile(path.join(client.home, ".credentials.json"), JSON.stringify(claudeAuthFixture()));
    await assert.rejects(() => client.models(), error => error.code === "temporary" && !error.message.includes("PRIVATE"));
    assert.notEqual(children[0].child.exitCode, null);
  }
});

test("cold-profile discovery waits for the native bootstrap completion before listing newly advertised models", async t => {
  const gate = Promise.withResolvers(), currentModels = [...claudeModelsFixture, { value: "fixture-bootstrap-model", displayName: "Native bootstrap model" }];
  const { client, requests, children } = await setup(t, { bootstrapGate: gate.promise, currentModels });
  client.timeoutMs = 1000;
  await writeFile(path.join(client.home, ".credentials.json"), JSON.stringify(claudeAuthFixture()));
  const pending = client.models();
  while (!requests.length) await new Promise(resolve => setImmediate(resolve));
  // initialize is already issued, but the native bootstrap gate remains shut.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(value => JSON.parse(value).request.subtype), ["initialize"]);
  gate.resolve(); const models = await pending;
  assert.deepEqual(models, currentModels); assert.equal(models.discoveryIncomplete, undefined);
  assert.deepEqual(requests.map(value => JSON.parse(value).request.subtype), ["initialize", "list_models", "get_settings"]);
  assert.notEqual(children[0].child.exitCode, null);
});

test("missing bootstrap stays explicit and a foreign config symlink is never treated as ready", async t => {
  for (const foreign of [false, true]) {
    const { client } = await setup(t, { bootstrapMissing: true });
    const authFile = path.join(client.home, ".credentials.json");
    await writeFile(authFile, JSON.stringify(claudeAuthFixture()));
    if (foreign) {
      const foreignFile = path.join(client.directory, "foreign-config");
      await writeFile(foreignFile, JSON.stringify({ modelAccessCache: [], additionalModelOptionsCache: [] }));
      await symlink(foreignFile, path.join(client.home, ".claude.json"));
    }
    assert.equal((await client.models()).discoveryIncomplete, true);
    assert.ok((await readFile(authFile, "utf8")).includes("fixture-claude-access-value"));
  }
});

test("closing cold discovery aborts the watcher and subprocess without publishing startup metadata", async t => {
  const { client, requests, children } = await setup(t, { bootstrapMissing: true });
  client.timeoutMs = 10000;
  await writeFile(path.join(client.home, ".credentials.json"), JSON.stringify(claudeAuthFixture()));
  const pending = assert.rejects(() => client.models(), { code: "temporary" });
  while (!requests.length) await new Promise(resolve => setImmediate(resolve));
  await client.close(); await pending;
  assert.equal(client.initialized, undefined); assert.notEqual(children[0].child.exitCode, null);
  assert.equal(requests.length, 1);
});

test("synchronous native startup failure closes the bootstrap watcher without leaking diagnostics", async t => {
  const client = new ClaudeAccountClient({ claude: { bin: "unused" } }, { timeoutMs: 10000, spawn: () => { throw Error("PRIVATE startup diagnostic"); } });
  await client.start(claudeAuthFixture()); t.after(() => client.close());
  await assert.rejects(() => client.models(), error => error.code === "temporary" && !error.message.includes("PRIVATE"));
  await client.close();
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
