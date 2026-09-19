// Explicit, local-only verification harness. Never invoked by Relay HTTP APIs.
// The owner must authorize copying an existing credential for this test.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../src/database.mjs";
import { Companies } from "../src/companies.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { userRecords } from "../src/user-services.mjs";
import { prepareRepositories } from "../src/workspace.mjs";

const owner = "authorized-smoke-owner", companyId = "smoke-projects", otherCompanyId = "smoke-other";
const run = promisify(execFile);

async function localCredential(account) {
  const env = { ...process.env };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_DEBUG", "GIT_TRACE", "GIT_CURL_VERBOSE"]) delete env[key];
  const { stdout } = await run("gh", ["auth", "token", "--hostname", "github.com", "--user", account], { env, timeout: 10000, maxBuffer: 8192 });
  return stdout.trim();
}

export function readOnlyGitHubFetch(fetchImpl) {
  return (url, options = {}) => {
    assert.equal(options.method || "GET", "GET", "Real acceptance must never mutate GitHub");
    assert.equal(new URL(url).origin, "https://api.github.com", "Real acceptance must only contact GitHub's API");
    return fetchImpl(url, options);
  };
}

// Injectable provider/clone boundaries are for deterministic harness regression
// tests. CLI execution always uses real GitHub, git and encrypted PostgreSQL.
export async function runReadOnlyGitHubSmoke({ account, repository, getCredential = localCredential, fetchImpl = fetch, cloneRepositories = prepareRepositories, onStage = () => {} }) {
  if (!account || !/^[\w-]+$/.test(account) || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split("/")[0] !== account) throw new Error("Pass --account and an owned --repository explicitly.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-github-real-test-"));
  let records, github, another;
  try {
    onStage("local-credential");
    const token = await getCredential(account);
    const listener = createServer();
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const config = { mode: "embedded", directory: path.join(directory, "encrypted"), port };
    onStage("company-bound-connection");
    records = await openDatabase(config);
    let scoped = userRecords(records, owner), companies = new Companies(scoped);
    await companies.save({ id: companyId, name: "Read-only smoke projects" });
    await companies.save({ id: otherCompanyId, name: "Isolated smoke company" });
    let providerCalls = 0;
    const options = { config: { apiBase: "https://api.github.com" }, fetchImpl: readOnlyGitHubFetch((...args) => { providerCalls++; return fetchImpl(...args); }) };
    github = new GitHubConnection({ ...options, records: scoped, companies });
    // Internal test-only seeding: public HTTP endpoints reject token imports.
    await assert.rejects(github.connect({ token }), { statusCode: 400 });
    const connection = (await github.connect({ token, companyId, name: "Authorized read-only smoke" })).connection;
    assert.equal(connection.login, account); assert.equal(connection.companyId, companyId);
    assert.equal(connection.scopeNeedsReview, false);
    assert.ok(!JSON.stringify(await github.status()).includes(token));
    const beforeDuplicate = providerCalls;
    await assert.rejects(github.connect({ token, companyId }), { statusCode: 409 });
    assert.equal(providerCalls, beforeDuplicate, "Duplicate company account is rejected before contacting GitHub");
    const stored = await records.pool.query("SELECT payload FROM relay_records WHERE kind=$1", [`user:${owner}:github_connection`]);
    assert.equal(stored.rows.length, 1); assert.equal(stored.rows[0].payload.includes(token), false);

    onStage("repository-selection");
    const visible = await github.repositories(repository);
    assert.ok(visible.some(repo => repo.fullName === repository && repo.githubConnectionId === connection.id && repo.companyId === companyId));
    // Repository owners and forged picker metadata cannot determine a chat's
    // company. Its saved GitHub connection is authoritative.
    const selection = { fullName: repository, githubConnectionId: connection.id, companyId: otherCompanyId };
    const selected = await github.resolveSelections([selection], { company: companyId });
    assert.equal(selected[0].companyId, companyId); assert.notEqual(companyId, account);
    const beforeDenied = providerCalls;
    await assert.rejects(github.resolveSelections([selection], { company: otherCompanyId }), { statusCode: 403 });
    await assert.rejects(github.request(`/repos/${repository}`, { connectionId: connection.id, chatCompany: otherCompanyId }), { statusCode: 403 });
    await assert.rejects(github.tokenForRepository(selected[0], { companyId: otherCompanyId, repositories: [{ ...selected[0], companyId: otherCompanyId }] }), { statusCode: 403 });
    assert.equal(providerCalls, beforeDenied, "Cross-company selections, requests and clone credentials are denied locally");

    onStage("selected-clone");
    await cloneRepositories({ destination: path.join(directory, "workspace"), repositories: selected, getToken: repo => github.tokenForRepository(repo, { companyId, repositories: selected }) });
    const gitConfig = await readFile(path.join(directory, "workspace", selected[0].directory, ".git/config"), "utf8");
    assert.equal(gitConfig.includes(token), false); assert.equal(/extraheader/i.test(gitConfig), false);
    onStage("pull-request-and-check-reads");
    const requestOptions = { connectionId: connection.id, chatCompany: companyId };
    const prs = await github.request(`/repos/${repository}/pulls?state=all&per_page=1`, requestOptions);
    assert.ok(prs.length > 0, "Choose an owned repository with an existing pull request to verify checks");
    const checks = await github.request(`/repos/${repository}/commits/${prs[0].head.sha}/check-runs`, requestOptions);
    assert.ok(Array.isArray(checks.check_runs));

    onStage("encrypted-restart");
    await github.close(); await records.close(); records = await openDatabase(config);
    scoped = userRecords(records, owner); companies = new Companies(scoped);
    github = new GitHubConnection({ ...options, records: scoped, companies });
    const restored = (await github.status()).connections[0];
    assert.equal(restored.id, connection.id); assert.equal(restored.companyId, companyId);
    assert.equal((await companies.get(companyId)).id, companyId);
    assert.equal((await github.request("/user", requestOptions)).login, account);
    assert.equal((await github.resolveSelections([selection], { company: companyId }))[0].companyId, companyId);
    const beforeRestoredDenial = providerCalls;
    await assert.rejects(github.request(`/repos/${repository}`, { connectionId: connection.id, chatCompany: otherCompanyId }), { statusCode: 403 });
    assert.equal(providerCalls, beforeRestoredDenial);
    onStage("provider-and-user-denials");
    await assert.rejects(github.request("/repos/not-authorized/repository", requestOptions), error => [403, 404].includes(error.statusCode));
    const otherRecords = userRecords(records, "other-smoke-user"), otherCompanies = new Companies(otherRecords);
    another = new GitHubConnection({ ...options, records: otherRecords, companies: otherCompanies });
    assert.equal((await another.status()).connections.length, 0); assert.deepEqual(await otherCompanies.list(), []);
    await assert.rejects(another.get(connection.id), { statusCode: 404 });
    return { credentialSource: "explicitly authorized local test copy; not new OAuth consent", encryptedRestart: true, account, repository, companyBoundConnection: true, oneConnectionPerCompany: true, companyBindingRestored: true, providerAuthorizedListing: true, selectedClone: true, noPersistedGitCredential: true, pullRequestRead: true, checksRead: true, providerDeniedRepository: true, crossCompanyDeniedBeforeProvider: true, crossUserDenied: true, remoteWrites: false, deployedProductSelection: false, workerGatewayAcceptance: false };
  } finally {
    await another?.close(); await github?.close(); await records?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let stage = "authorization";
  try {
    if (!process.argv.includes("--allow-local-test-credential")) throw new Error("Explicit test authorization required");
    const account = process.argv.find(arg => arg.startsWith("--account="))?.slice(10);
    const repository = process.argv.find(arg => arg.startsWith("--repository="))?.slice(13);
    console.log(JSON.stringify(await runReadOnlyGitHubSmoke({ account, repository, onStage: value => { stage = value; } })));
  } catch {
    console.error(JSON.stringify({ ok: false, stage, message: "GitHub real read-only smoke failed. Sensitive subprocess and credential output suppressed." }));
    process.exitCode = 1;
  }
}
