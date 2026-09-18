import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { parseLegacyBrowserOptions, smokeLegacyDeployedBrowser } from "../scripts/smoke-deployed-browser.mjs";
import { LoginProbeError } from "../scripts/smoke-deployed-login.mjs";
import { transportOrigin } from "../scripts/smoke-deployed-transports.mjs";

test("legacy default and exact cloud positional argument retain live intent without Google click", () => {
  for (const args of [[], [transportOrigin]]) assert.deepEqual(parseLegacyBrowserOptions(args), { run: true, checkGoogleRedirect: false });
});

test("local migration and unsupported inputs fail before any IO or silent cloud retarget", async () => {
  for (const args of [["http://localhost:8787"], ["https://other.example"], [transportOrigin, "extra"], ["--run"], ["--cookie-file", "/private"], ["--check-google-redirect"]]) {
    await assert.rejects(smokeLegacyDeployedBrowser(args, { fetchImpl: () => assert.fail("must not fetch"), loginProbe: () => assert.fail("must not start browser") }),
      error => ["local-retired", "invalid-arguments"].includes(error.category) && !error.message.includes("other.example") && !error.message.includes("/private"));
  }
});

test("wrapper validates readiness then delegates once to canonical browser lifecycle and receipt", async () => {
  const controller = new AbortController(), calls = [];
  const canonical = { schema: 1, consentSubmitted: false, authenticatedAccessVerified: false, cleanup: { transportClosed: true } };
  const receipt = await smokeLegacyDeployedBrowser([], { signal: controller.signal,
    fetchImpl: async (url, options) => { calls.push("ready"); assert.equal(url, transportOrigin + "/readyz"); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); return new Response('{"ok":true}'); },
    loginProbe: async (options, dependencies) => { calls.push("canonical"); assert.deepEqual(options, { run: true, checkGoogleRedirect: false }); assert.equal(dependencies.signal, controller.signal); return canonical; },
  });
  assert.deepEqual(calls, ["ready", "canonical"]); assert.equal(receipt.readiness, true); assert.equal(receipt.cleanup, canonical.cleanup);
  assert.equal(receipt.authenticatedAccessVerified, false); assert.equal(receipt.consentSubmitted, false);
});

test("invalid oversized or private readiness response prevents browser with a fixed safe error", async () => {
  for (const response of [new Response("private-error", { status: 503 }), new Response("x".repeat(1025)), new Response('{"ok":false}'), new Response('{"ok":true,"secret":"private"}'), new Response("private-invalid-json")]) {
    await assert.rejects(smokeLegacyDeployedBrowser([], { fetchImpl: async () => response, loginProbe: () => assert.fail() }),
      { category: "readiness-failed", message: "Legacy readiness check failed; private response suppressed." });
  }
});

test("canonical failure including cleanup uncertainty passes through without a success receipt", async () => {
  const failure = new LoginProbeError("entry-320", "entry-check-failed", { transportClosed: false });
  await assert.rejects(smokeLegacyDeployedBrowser([], { fetchImpl: async () => new Response('{"ok":true}'), loginProbe: async () => { throw failure; } }), error => error === failure);
});

test("actual legacy CLI rejects local/unknown arguments without printing raw arguments or stack", () => {
  for (const [arg, category] of [["http://localhost:8787", "local-retired"], ["private-secret-argument", "invalid-arguments"]]) {
    const result = spawnSync(process.execPath, ["scripts/smoke-deployed-browser.mjs", arg], { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 5000, env: { PATH: "/missing" } });
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    const receipt = JSON.parse(result.stderr); assert.equal(receipt.category, category); assert.equal(receipt.ok, false);
    assert.ok(!result.stderr.includes(arg)); assert.ok(!result.stderr.includes("Error:"));
  }
});
