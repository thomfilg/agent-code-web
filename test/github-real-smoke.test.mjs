import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readOnlyGitHubFetch, runReadOnlyGitHubSmoke } from "../scripts/smoke-real-github.mjs";

test("real GitHub smoke enforces the production company model through encrypted restart", async () => {
  const token = "fixture-only-github-smoke-secret", calls = [], stages = [];
  const repo = { id: 123, full_name: "fixture/app", name: "app", default_branch: "main", private: true, size: 1 };
  let cloneDestination;
  const result = await runReadOnlyGitHubSmoke({
    account: "fixture", repository: repo.full_name,
    getCredential: async account => { assert.equal(account, "fixture"); return token; },
    onStage: stage => stages.push(stage),
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      assert.equal(options.method, "GET"); calls.push(new URL(url).pathname);
      const route = new URL(url).pathname;
      if (route === "/user") return Response.json({ login: "fixture", id: 1 });
      if (route === "/user/repos") return Response.json([repo]);
      if (route === "/repos/fixture/app") return Response.json(repo);
      if (route === "/repos/fixture/app/branches/main") return Response.json({ name: "main" });
      if (route === "/repos/fixture/app/pulls") return Response.json([{ head: { sha: "fixture-head" } }]);
      if (route === "/repos/fixture/app/commits/fixture-head/check-runs") return Response.json({ check_runs: [] });
      if (route === "/repos/not-authorized/repository") return Response.json({}, { status: 404 });
      throw new Error(`Unexpected fixture route: ${route}`);
    },
    cloneRepositories: async ({ destination, repositories, getToken }) => {
      cloneDestination = destination;
      assert.equal(repositories.length, 1); assert.equal(repositories[0].companyId, "smoke-projects");
      assert.equal(await getToken(repositories[0]), token);
      const git = path.join(destination, repositories[0].directory, ".git");
      await mkdir(git, { recursive: true });
      await writeFile(path.join(git, "config"), '[remote "origin"]\nurl = https://github.com/fixture/app.git\n');
    },
  });
  for (const key of ["companyBoundConnection", "oneConnectionPerCompany", "companyBindingRestored", "encryptedRestart", "providerAuthorizedListing", "selectedClone", "noPersistedGitCredential", "pullRequestRead", "checksRead", "providerDeniedRepository", "crossCompanyDeniedBeforeProvider", "crossUserDenied"]) assert.equal(result[key], true, key);
  for (const key of ["remoteWrites", "deployedProductSelection", "workerGatewayAcceptance"]) assert.equal(result[key], false, key);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(calls.filter(route => route === "/user").length, 2, "Only initial connect and restored identity use GitHub /user");
  assert.equal(calls.filter(route => route === "/repos/fixture/app").length, 2, "Only valid initial and restored selections reach the provider");
  assert.deepEqual(stages, ["local-credential", "company-bound-connection", "repository-selection", "selected-clone", "pull-request-and-check-reads", "encrypted-restart", "provider-and-user-denials"]);
  await assert.rejects(access(path.dirname(cloneDestination)), { code: "ENOENT" }, "Temporary database and workspace are removed");
});

test("read-only provider fence rejects mutations and non-GitHub destinations before fetch", async () => {
  let calls = 0;
  const guarded = readOnlyGitHubFetch(async () => { calls++; return Response.json({}); });
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) assert.throws(() => guarded("https://api.github.com/user", { method }), /never mutate/);
  assert.throws(() => guarded("https://other.example/user"), /only contact GitHub/);
  assert.equal(calls, 0);
  await guarded("https://api.github.com/user", { method: "GET" }); assert.equal(calls, 1);
});

test("real smoke refuses an unowned repository before loading local credentials", async () => {
  let credentialReads = 0;
  await assert.rejects(runReadOnlyGitHubSmoke({ account: "fixture", repository: "other/app", getCredential: async () => { credentialReads++; } }), /owned/);
  assert.equal(credentialReads, 0);
});

test("CLI requires explicit authorization without exposing provider or credential output", async () => {
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, ["scripts/smoke-real-github.mjs", "--account=fixture", "--repository=fixture/app"]), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, "");
    const result = JSON.parse(error.stderr);
    assert.equal(result.ok, false); assert.equal(result.stage, "authorization");
    assert.match(result.message, /Sensitive.*suppressed/); return true;
  });
});
