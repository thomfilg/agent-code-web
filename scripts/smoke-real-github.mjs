// Explicit, local-only verification harness. Never invoked by Relay HTTP APIs.
// The owner must authorize copying an existing credential for this test.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../src/database.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { userRecords } from "../src/user-services.mjs";
import { prepareRepositories } from "../src/workspace.mjs";

if (!process.argv.includes("--allow-local-test-credential")) throw new Error("Explicit --allow-local-test-credential authorization is required. This does not test new browser consent.");
const account = process.argv.find(arg => arg.startsWith("--account="))?.slice(10);
const repository = process.argv.find(arg => arg.startsWith("--repository="))?.slice(13);
if (!account || !/^[\w-]+$/.test(account) || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split("/")[0] !== account) throw new Error("Pass --account and an owned --repository explicitly.");
const run = promisify(execFile), directory = await mkdtemp(path.join(os.tmpdir(), "relay-github-real-test-"));
let records, github;
try {
  const env = { ...process.env }; for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_DEBUG"]) delete env[key];
  const { stdout } = await run("gh", ["auth", "token", "--hostname", "github.com", "--user", account], { env, timeout: 10000, maxBuffer: 8192 });
  const token = stdout.trim();
  const listener = createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const config = { mode: "embedded", directory: path.join(directory, "encrypted"), port };
  records = await openDatabase(config);
  const options = { config: { apiBase: "https://api.github.com" } };
  github = new GitHubConnection({ ...options, records: userRecords(records, "authorized-smoke-owner") });
  // Internal test-only seeding: public HTTP endpoints reject token imports.
  const connection = (await github.connect({ token, name: "Authorized read-only smoke" })).connection;
  assert.equal(connection.login, account);
  assert.ok(!JSON.stringify(await github.status()).includes(token));
  const stored = await records.pool.query("SELECT payload FROM relay_records WHERE kind=$1", ["user:authorized-smoke-owner:github_connection"]);
  assert.equal(stored.rows.length, 1); assert.equal(stored.rows[0].payload.includes(token), false);
  const visible = await github.repositories(repository);
  assert.ok(visible.some(repo => repo.fullName === repository && repo.githubConnectionId === connection.id));
  const selected = await github.resolveSelections([{ fullName: repository, githubConnectionId: connection.id }]);
  await prepareRepositories({ destination: path.join(directory, "workspace"), repositories: selected, getToken: repo => github.tokenForRepository(repo, { repositories: selected }) });
  const gitConfig = await readFile(path.join(directory, "workspace", selected[0].directory, ".git/config"), "utf8");
  assert.equal(gitConfig.includes(token), false); assert.equal(gitConfig.includes("extraheader"), false);
  const prs = await github.request(`/repos/${repository}/pulls?state=all&per_page=1`, { connectionId: connection.id });
  assert.ok(prs.length > 0, "Choose an owned repository with an existing pull request to verify checks");
  const pull = prs[0];
  const checks = await github.request(`/repos/${repository}/commits/${pull.head.sha}/check-runs`, { connectionId: connection.id });
  assert.ok(Array.isArray(checks.check_runs));
  await github.close(); await records.close(); records = await openDatabase(config);
  github = new GitHubConnection({ ...options, records: userRecords(records, "authorized-smoke-owner") });
  assert.equal((await github.status()).connections[0].id, connection.id);
  assert.equal((await github.request("/user", { connectionId: connection.id })).login, account);
  await assert.rejects(github.request("/repos/not-authorized/repository", { connectionId: connection.id }), error => [403, 404].includes(error.statusCode));
  const another = new GitHubConnection({ ...options, records: userRecords(records, "other-smoke-user") });
  assert.equal((await another.status()).connections.length, 0);
  await assert.rejects(another.get(connection.id), { statusCode: 404 }); await another.close();
  console.log(JSON.stringify({ credentialSource: "explicitly authorized local test copy; not new OAuth consent", encryptedRestart: true, account, repository, providerAuthorizedListing: true, selectedClone: true, noPersistedGitCredential: true, pullRequestRead: true, checksRead: true, providerDeniedRepository: true, crossUserDenied: true, remoteWrites: false }));
} catch {
  console.error("GitHub real read-only smoke failed. Sensitive subprocess and credential output suppressed."); process.exitCode = 1;
} finally {
  await github?.close(); await records?.close();
  await rm(directory, { recursive: true, force: true });
}
