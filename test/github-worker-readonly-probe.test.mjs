import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readOnlyGitTransport } from "../scripts/github-worker-readonly-probe.mjs";
import { runReadOnlyGitHubSmoke } from "../scripts/smoke-real-github.mjs";

test("read-only Git acceptance fence rejects receive-pack and unrelated requests before forwarding", async () => {
  let calls = 0; const transport = readOnlyGitTransport(async () => { calls++; return new Response(); }, "fixture/app");
  const root = "https://github.com/fixture/app.git/";
  for (const [url, method] of [[root + "git-receive-pack", "POST"], [root + "info/refs?service=git-receive-pack", "GET"],
    [root + "git-upload-pack", "GET"], ["https://github.com/other/app.git/git-upload-pack", "POST"], [root + "HEAD", "GET"]]) {
    assert.throws(() => transport(url, { method, redirect: "error" }), /only permits/);
  }
  assert.throws(() => transport(root + "git-upload-pack", { method: "POST", redirect: "follow" }), /never follows/);
  assert.equal(calls, 0);
  await transport(root + "info/refs?service=git-upload-pack", { method: "GET", redirect: "error" });
  await transport(root + "git-upload-pack", { method: "POST", redirect: "error" });
  assert.equal(calls, 2);
});

test("company-bound acceptance exercises native Git through gateway across encrypted database restart", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-github-worker-fixture-"));
  const env = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LANG: "C.UTF-8" };
  const exec = promisify(execFile), git = (args, cwd = directory) => exec("git", args, { cwd, env, timeout: 20000, maxBuffer: 1024 * 1024 });
  const server = createServer(), children = new Set();
  t.after(async () => {
    for (const child of children) child.kill();
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, "fixture"));
  await git(["init", "--bare", "fixture/app.git"]); await git(["init", "--initial-branch=main", "seed"]);
  const seed = path.join(directory, "seed"); await writeFile(path.join(seed, "readme.txt"), "read-only gateway fixture\n");
  await git(["add", "readme.txt"], seed);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], seed);
  await git(["push", path.join(directory, "fixture/app.git"), "main"], seed);
  await git(["--git-dir=fixture/app.git", "symbolic-ref", "HEAD", "refs/heads/main"]);
  let uploadRequests = 0;
  server.on("request", (request, response) => {
    const url = new URL(request.url, "http://fixture"); uploadRequests++;
    assert.equal(Buffer.from(request.headers.authorization.slice(6), "base64").toString(), "x-access-token:fixture-only-provider-secret");
    assert.ok(url.pathname.endsWith("git-upload-pack") || url.search === "?service=git-upload-pack");
    const child = spawn("git", ["http-backend"], { env: { ...env, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers["content-type"] || "", CONTENT_LENGTH: request.headers["content-length"] || "", HTTP_GIT_PROTOCOL: request.headers["git-protocol"] || "", REMOTE_USER: "fixture" }, stdio: ["pipe", "pipe", "ignore"] });
    children.add(child); request.pipe(child.stdin); const chunks = [];
    child.stdin.on("error", () => {}); child.stdout.on("data", chunk => chunks.push(chunk));
    child.on("close", code => {
      children.delete(child); const output = Buffer.concat(chunks), split = output.indexOf("\r\n\r\n");
      if (code !== 0 || split < 0) { response.writeHead(500); response.end(); return; }
      const headers = {}; let status = 200;
      for (const line of output.subarray(0, split).toString().split("\r\n")) {
        const i = line.indexOf(":"), key = line.slice(0, i), value = line.slice(i + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers[key] = value;
      }
      response.writeHead(status, headers); response.end(output.subarray(split + 4));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const backend = `http://127.0.0.1:${server.address().port}`;
  const repo = { id: 123, full_name: "fixture/app", name: "app", default_branch: "main", private: true, size: 1 };
  const report = await runReadOnlyGitHubSmoke({ account: "fixture", repository: repo.full_name, workerGateway: true,
    getCredential: async () => "fixture-only-provider-secret",
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "GET"); assert.equal(options.headers.authorization, "Bearer fixture-only-provider-secret");
      const route = new URL(url).pathname;
      if (route === "/user") return Response.json({ login: "fixture", id: 1 });
      if (route === "/user/repos") return Response.json([repo]);
      if (route === "/repos/fixture/app") return Response.json(repo);
      if (route === "/repos/fixture/app/branches/main") return Response.json({ name: "main" });
      if (route === "/repos/fixture/app/pulls") return Response.json([{ head: { sha: "fixture-head" } }]);
      if (route === "/repos/fixture/app/commits/fixture-head/check-runs") return Response.json({ check_runs: [] });
      if (route === "/repos/not-authorized/repository") return Response.json({}, { status: 404 });
      throw Error("Unexpected fixture API route");
    },
    gitFetchImpl: (url, options) => fetch(backend + url.slice("https://github.com".length), options),
    // Only the old controller-direct clone is stubbed. The optional worker
    // probe invokes actual git over HTTP against the real git-http-backend.
    cloneRepositories: async ({ destination, repositories }) => {
      const target = path.join(destination, repositories[0].directory, ".git"); await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "config"), '[remote "origin"]\nurl = https://github.com/fixture/app.git\n');
    },
  });
  assert.equal(report.workerGatewayAcceptance, true);
  for (const key of ["nativeCloneThroughGateway", "nativeFetchAfterDatabaseRestart", "oldCapabilitiesDenied", "selectedConnectionMutationRevokes", "crossCompanyDenied", "unselectedGitReadWriteDenied", "unselectedPrWriteDenied", "noProviderCredentialInWorkerEnvironment", "noSecretsInGitArgvOrConfig"]) assert.equal(report.workerGateway[key], true, key);
  assert.equal(report.workerGateway.remoteWrites, false); assert.equal(report.workerGateway.nativeAgentOrAwsWorker, false);
  assert.equal(report.workerGateway.upstreamGitRequests, uploadRequests); assert.ok(uploadRequests >= 6);
  assert.equal(JSON.stringify(report).includes("fixture-only-provider-secret"), false);
});
