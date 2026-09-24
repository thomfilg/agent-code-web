import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { GitHubConnection } from "../src/github.mjs";
import { GitHubLogin, GitHubLoginError } from "../src/github-login.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const response = scopes => Response.json({ login: "fixture", id: 7 }, { headers: { "x-oauth-scopes": scopes } });

test("GitHub device login requests workflow only when selected and reports verified permissions", async () => {
  const starts = [];
  const github = new GitHubConnection({
    records: new MemoryRecords(),
    config: { apiBase: "https://api.github.test" },
    fetchImpl: async () => response("repo, read:org, gist, workflow"),
    loginFactory: () => ({
      start: async (onCode, options) => { starts.push(options); onCode({ userCode: "ABCD-EFGH" }); return "fixture-device-token"; },
      close: async () => {},
    }),
  });
  const started = await github.beginDevice({ permissions: ["repositories", "workflows"] });
  await github.pending.get(started.id).task;
  const [connection] = (await github.status()).connections;
  assert.deepEqual(starts, [{ scopes: ["workflow"] }]);
  assert.deepEqual(connection.requestedPermissions, ["repositories", "workflows"]);
  assert.deepEqual(connection.grantedPermissions, ["repositories", "workflows"]);
  assert.equal(connection.permissionsVerified, true);
  assert.equal(JSON.stringify(connection).includes("fixture-device-token"), false);
  await assert.rejects(github.beginDevice({ permissions: ["repositories", "admin:org"] }), /only the GitHub permissions shown/);
  await github.close();
});

test("cancelling a permission change preserves the currently connected credential", async () => {
  const records = new MemoryRecords(); let rejectLogin;
  const github = new GitHubConnection({
    records,
    config: { apiBase: "https://api.github.test" },
    fetchImpl: async () => response("repo, read:org, gist"),
    loginFactory: () => ({
      start: () => new Promise((resolve, reject) => { rejectLogin = reject; }),
      close: async () => rejectLogin?.(new GitHubLoginError("cancelled")),
    }),
  });
  const saved = (await github.connect({ name: "Existing", token: "fixture-existing-token", permissions: ["repositories"] })).connection;
  const started = await github.beginDevice({ id: saved.id, revision: saved.revision, permissions: ["repositories", "workflows"] });
  assert.equal(started.connection.connected, true);
  await github.cancelDevice(started.id);
  const current = await github.get(saved.id);
  assert.equal(current.token, "fixture-existing-token");
  assert.equal(current.loginState, "connected");
  assert.deepEqual(current.requestedPermissions, ["repositories"]);
  await github.close();
});

test("isolated gh login adds the allowlisted workflow scope to the CLI invocation", async t => {
  const directory = await temporaryDirectory(t), child = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
  child.stdout = stdout; child.stderr = stderr; child.exitCode = null; child.signalCode = null;
  const calls = [];
  const login = new GitHubLogin({
    directory,
    spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options });
      queueMicrotask(() => { stdout.write("First copy your one-time code: ABCD-EFGH\n"); child.exitCode = 0; child.emit("close", 0); });
      return child;
    },
    runImpl: async () => ({ stdout: "fixture_device_token\n" }),
  });
  assert.equal(await login.start(() => {}, { scopes: ["workflow"] }), "fixture_device_token");
  assert.deepEqual(calls[0].args.slice(-2), ["--scopes", "workflow"]);
  assert.equal(calls[0].options.env.GH_CONFIG_DIR.startsWith(directory), true);
  await assert.rejects(new GitHubLogin({ directory }).start(() => {}, { scopes: ["admin:org"] }), GitHubLoginError);
});
