import assert from "node:assert/strict";
import test from "node:test";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";
import { parseDeployedGitHubOptions, smokeDeployedGitHub } from "../scripts/smoke-deployed-github.mjs";
import { transportOrigin } from "../scripts/smoke-deployed-transports.mjs";

test("deployed GitHub probe defaults to zero network and accepts no destination or credentials", async () => {
  const receipt = await smokeDeployedGitHub(parseDeployedGitHubOptions([]), { fetchImpl: () => assert.fail("No default network") });
  assert.equal(receipt.dryRun, true); assert.equal(receipt.deploymentIdentityVerified, false); assert.equal(receipt.checks.length, 13);
  assert.deepEqual(parseDeployedGitHubOptions(["--run"]), { run: true });
  for (const args of [["--origin", "https://foreign.invalid"], ["--cookie-file", "/private/session"], ["--token", "synthetic-secret"], ["--run", "--run"], ["--expected-revision", "fake"]]) assert.throws(() => parseDeployedGitHubOptions(args));
  assert.doesNotMatch(JSON.stringify(receipt), /cap_|Bearer|synthetic-secret/);
});

async function fixture(t) {
  const root = await temporaryDirectory(t), calls = [];
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "private-relay-auth-fixture" }),
    githubWorkerFetch: () => assert.fail("Must never access GitHub"), adapterFactory: () => assert.fail("Must never create an adapter") });
  const { url } = await app.start(); t.after(() => app.stop());
  app.manager.github.request = () => assert.fail("Must never use a saved account");
  const fetchImpl = (input, options) => {
    const destination = new URL(input); assert.equal(destination.origin, transportOrigin);
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit"); assert.equal(options.cache, "no-store");
    assert.equal(options.headers.cookie, undefined); assert.ok(["GET", "OPTIONS", "POST"].includes(options.method));
    assert.ok(destination.pathname.startsWith("/gateway/github/")); assert.ok(!destination.pathname.includes("git-receive-pack"));
    if (options.body) { assert.equal(options.method, "POST"); assert.equal(JSON.parse(options.body).method, "tools/list"); }
    calls.push({ pathname: destination.pathname, method: options.method });
    return fetch(url + destination.pathname + destination.search, options);
  };
  return { app, calls, fetchImpl };
}

test("actual product handlers reject all fixed probes without sessions, grants, workers or provider operations", async t => {
  const f = await fixture(t), receipt = await smokeDeployedGitHub({ run: true }, f);
  assert.equal(receipt.checks.length, 13); assert.equal(f.calls.length, 13);
  assert.ok(receipt.checks.every(check => check.fixedRejectionVerified && [400, 401, 403, 404].includes(check.status)));
  assert.equal(receipt.verificationScope, "negative-route-behavior-only"); assert.equal(receipt.deploymentIdentityVerified, false);
  assert.equal(receipt.authenticatedAccessVerified, false); assert.equal(receipt.providerOperationsRequested, 0);
  assert.equal(f.app.store.list().length, 0); assert.equal(f.app.manager.githubWorkers.entries.size, 0);
  assert.equal(f.app.manager.githubWorkers.active, 0); assert.equal(f.app.manager.browsers.entries.size, 0);
  assert.equal((await f.app.records.list("relay-user")).length, 0);
  assert.doesNotMatch(JSON.stringify(receipt), /cap_|Bearer|private-relay-auth-fixture/);
});

test("old generic routing, successful auth, redirects, private bodies and missing no-store cannot pass", async () => {
  for (const response of [
    new Response('{"error":"not found"}', { status: 404 }),
    new Response("PRIVATE-RESPONSE", { status: 200 }),
    new Response("PRIVATE-RESPONSE", { status: 302, headers: { location: "https://foreign.invalid/PRIVATE-TOKEN" } }),
    new Response("PRIVATE-RESPONSE", { status: 401, headers: { "content-type": "text/plain", "cache-control": "no-store" } }),
    new Response("GitHub worker request denied. Resume the chat or reconnect GitHub.\n", { status: 401, headers: { "content-type": "text/plain" } }),
    new Response("GitHub worker request denied. Resume the chat or reconnect GitHub.\n", { status: 401, headers: { "content-type": "text/plain", "cache-control": "no-store", "set-cookie": "PRIVATE-COOKIE" } }),
  ]) {
    let calls = 0;
    await assert.rejects(smokeDeployedGitHub({ run: true }, { fetchImpl: async () => { calls++; return response; } }), error => {
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE|foreign.invalid/); assert.equal(error.probeId, "git-anonymous"); return true;
    });
    assert.equal(calls, 1);
  }
});

test("response byte limits, cancellation and network failures terminate with fixed private-safe diagnostics", async () => {
  for (const headers of [{ "content-length": "2049" }, {}]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(2049, 65)); }, cancel() { cancelled = true; } }),
      { status: 401, headers: { "content-type": "text/plain", "cache-control": "no-store", ...headers } });
    await assert.rejects(smokeDeployedGitHub({ run: true }, { fetchImpl: async () => response }), { category: "oversized-response" });
    assert.equal(cancelled, true);
  }
  let calls = 0;
  await assert.rejects(smokeDeployedGitHub({ run: true }, { signal: AbortSignal.abort(Error("PRIVATE-CANCEL")), fetchImpl: () => { calls++; } }), { category: "cancelled-or-deadline" });
  assert.equal(calls, 0);
  await assert.rejects(smokeDeployedGitHub({ run: true }, { fetchImpl: async () => { throw Error("PRIVATE-NETWORK-DETAIL"); } }), error => {
    assert.equal(error.category, "transport-failed"); assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE/); return true;
  });
  for (const phase of ["request", "body"]) {
    const controller = new AbortController(), started = Promise.withResolvers(); let aborted = false;
    const running = smokeDeployedGitHub({ run: true }, { signal: controller.signal, fetchImpl: async (_url, { signal }) => {
      const onAbort = reject => signal.addEventListener("abort", () => { aborted = true; reject(Error("PRIVATE-ACTIVE-CANCEL")); }, { once: true });
      if (phase === "request") return new Promise((_resolve, reject) => { onAbort(reject); started.resolve(); });
      return new Response(new ReadableStream({ start(stream) { onAbort(error => stream.error(error)); started.resolve(); } }),
        { status: 401, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    } });
    const rejected = assert.rejects(running, error => {
      assert.equal(error.category, "cancelled-or-deadline"); assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE/); return true;
    });
    await started.promise; controller.abort(); await rejected; assert.equal(aborted, true);
  }
});
