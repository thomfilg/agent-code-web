import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dopplerInvocation, injectedSettings } from "../scripts/doppler.mjs";
import { buildWorkerEnvironment } from "../src/worker-process.mjs";

const supplied = { DOPPLER_PROJECT: "code-web", DOPPLER_CONFIG: "dev",
  GOOGLE_CLIENT_ID: "fixture-client", GOOGLE_CLIENT_SECRET: "fixture-secret",
  AGENT_OWNER_EMAIL: "owner@example.test" };
const absent = async () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); };

test("Doppler launcher pins this project/dev and disables secret fallback files", async () => {
  const invocation = await dopplerInvocation("start", { DOPPLER_PROJECT: "another-app", DOPPLER_CONFIG: "prd" }, absent);
  assert.deepEqual(invocation.args.slice(0, 7), ["run", "--project", "code-web", "--config", "dev", "--no-fallback", "--no-check-version"]);
  assert.equal(invocation.command, "doppler");
  assert.equal(invocation.env.DOPPLER_TOKEN, undefined);
  assert.ok(invocation.args.includes("--injected"));
});

test("Doppler launcher accepts an explicit service token without printing it in arguments", async () => {
  const invocation = await dopplerInvocation("dev", { DOPPLER_TOKEN: "fixture-token" }, () => assert.fail("should not read a file"));
  assert.equal(invocation.env.DOPPLER_TOKEN, "fixture-token");
  assert.ok(!invocation.args.join(" ").includes("fixture-token"));
  assert.equal(invocation.args.at(-1), "dev");
});

test("Doppler only loads this project's default token and fails closed for a selected file", async () => {
  const invocation = await dopplerInvocation("check", {}, async filename => {
    assert.ok(filename.endsWith("/.doppler-code-web-dev-token")); return " fixture-token\n";
  });
  assert.equal(invocation.env.DOPPLER_TOKEN, "fixture-token");
  await assert.rejects(dopplerInvocation("start", { DOPPLER_DEV_TOKEN_FILE: "/missing" }, absent), { code: "ENOENT" });
  await assert.rejects(dopplerInvocation("start", {}, async () => " \n"), /empty/);
  await assert.rejects(dopplerInvocation("start", {}, async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }), /denied/);
});

test("Doppler settings validate project/config and require a designated owner", () => {
  for (const override of [{ DOPPLER_PROJECT: "future-pay" }, { DOPPLER_CONFIG: "prd" }, { DOPPLER_PROJECT: undefined }]) {
    assert.throws(() => injectedSettings({ ...supplied, ...override }), /expected Doppler project code-web, config dev/);
  }
  const result = injectedSettings({ ...supplied, AGENT_OWNER_EMAIL: "", GOOGLE_CLIENT_SECRET: "" });
  assert.deepEqual(result.missing, ["GOOGLE_CLIENT_SECRET", "AGENT_OWNER_EMAIL"]);
  assert.equal(result.env.AGENT_GOOGLE_AUTH, "1");
});

test("Doppler rejects non-private token files and accepts mode 600", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-doppler-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "token");
  await writeFile(filename, "fixture-token", { mode: 0o600 });
  const env = { DOPPLER_DEV_TOKEN_FILE: filename };
  assert.equal((await dopplerInvocation("check", env)).env.DOPPLER_TOKEN, "fixture-token");
  if (process.platform !== "win32") {
    await chmod(filename, 0o644);
    await assert.rejects(dopplerInvocation("check", env), /private to your OS user/);
  }
});

test("Doppler check runs as a process without a database, and missing configuration returns failure", () => {
  for (const present of [true, false]) {
    const result = spawnSync(process.execPath, ["scripts/doppler.mjs", "--injected", "check"], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000,
      env: { ...supplied, AGENT_OWNER_EMAIL: present ? supplied.AGENT_OWNER_EMAIL : "",
        AGENT_CONTROL_DIR: "/not-created-by-a-config-check", AGENT_DATA_DIR: "/not-created-by-a-config-check" },
    });
    assert.equal(result.status, present ? 0 : 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout).missing, present ? [] : ["AGENT_OWNER_EMAIL"]);
  }
});

test("Doppler settings preserve data locations but not the Doppler token; diagnostics contain no secrets or emails", () => {
  const result = injectedSettings({ ...supplied, DOPPLER_TOKEN: "fixture-token", DOPPLER_DEV_TOKEN_FILE: "/private/token",
    AGENT_CONTROL_DIR: "/existing/control", AGENT_DATA_DIR: "/existing/workspaces", AGENT_GOOGLE_AUTH: "0" });
  assert.equal(result.env.DOPPLER_TOKEN, undefined);
  assert.equal(result.env.DOPPLER_DEV_TOKEN_FILE, undefined);
  assert.equal(result.env.AGENT_CONTROL_DIR, "/existing/control");
  assert.equal(result.env.AGENT_DATA_DIR, "/existing/workspaces");
  assert.equal(result.report.callbackUrl, "http://localhost:8787/api/auth/callback/google");
  assert.deepEqual(result.missing, []);
  const report = JSON.stringify(result.report);
  for (const value of ["fixture-client", "fixture-secret", "fixture-token", "owner@example.test"]) assert.ok(!report.includes(value));
  assert.equal(result.env.AGENT_GOOGLE_AUTH, "1");
  assert.equal(injectedSettings(supplied, "dev").env.AGENT_ENABLE_MOCK, "1");
  assert.equal(injectedSettings({ ...supplied, AGENT_ENABLE_MOCK: "0" }, "dev").env.AGENT_ENABLE_MOCK, "0");
  assert.equal(injectedSettings({ ...supplied, AGENT_WEB_PUBLIC_URL: "https://relay.example.test" }).report.origin, "https://relay.example.test");
});

test("Google and Doppler secrets are not inherited by native workers", async t => {
  for (const [name, value] of Object.entries({ ...supplied, DOPPLER_TOKEN: "fixture-token", AUTH_SECRET: "fixture-session-secret" })) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  for (const provider of ["openai", "anthropic"]) {
    const env = await buildWorkerEnvironment({ chat: { id: "fixture" }, runtimeHome: "/fixture/runtime", provider,
      authMode: "gateway", capability: "chat-only", gatewayOrigin: "http://127.0.0.1:8787", ensureDirectory: async () => {} });
    for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "DOPPLER_TOKEN", "AUTH_SECRET", "AGENT_OWNER_EMAIL"]) {
      assert.equal(env[name], undefined);
    }
  }
});
