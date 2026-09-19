// Local acceptance helper, never imported by the product HTTP server.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { GitHubWorkerGateway } from "../src/github-worker-gateway.mjs";
import { handleGitHubWorkerMcp } from "../src/github-worker-mcp.mjs";

const exec = promisify(execFile);

// Git clone/fetch use POST, but only upload-pack is read-only. Explicitly fence
// receive-pack, discovery for receive-pack, redirects and every unrelated URL.
export function readOnlyGitTransport(fetchImpl, repository) {
  const root = `https://github.com/${repository}.git/`;
  return (url, options = {}) => {
    assert.ok(url === `${root}info/refs?service=git-upload-pack` && options.method === "GET"
      || url === `${root}git-upload-pack` && options.method === "POST", "Real smoke only permits Git upload-pack reads");
    assert.equal(options.redirect, "error", "Real smoke never follows provider redirects");
    return fetchImpl(url, options);
  };
}

export async function createReadOnlyWorkerProbe({ github: initialGithub, repository, ownerId, directory, fetchImpl = fetch }) {
  const chat = { id: "chat_readonly_worker_smoke", ownerId, repositories: [repository] };
  const store = { get: id => id === chat.id ? structuredClone(chat) : null };
  const home = path.join(directory, "worker-home"), workspace = path.join(directory, "worker-clone");
  await mkdir(home, { mode: 0o700 });
  let github = initialGithub, gateway, grant, origin, upstreamRequests = 0, providerRequests = 0, previousHook, previousFetch;
  const secrets = new Set(), tokens = new Set();
  const transport = readOnlyGitTransport((...args) => { upstreamRequests++; return fetchImpl(...args); }, repository.fullName);
  const bind = service => {
    github = service; previousHook = service.onChange; previousFetch = service.fetch;
    const savedHook = previousHook, savedFetch = previousFetch;
    service.fetch = (...args) => { providerRequests++; return savedFetch(...args); };
    gateway = new GitHubWorkerGateway({ store, servicesFor: async () => ({ github }), fetchImpl: transport });
    const boundGateway = gateway;
    service.onChange = id => { savedHook(id); boundGateway.revokeConnection(ownerId, id); };
  };
  bind(github);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, origin);
      if (!await gateway.handle(request, response, url) && !await handleGitHubWorkerMcp(request, response, url, { gateway })) {
        response.writeHead(404); response.end();
      }
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end("Acceptance request failed"); });
  });
  const git = async (args, currentGrant, cwd = directory) => {
    const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...currentGrant.environmentVariables };
    for (const secret of secrets) {
      assert.equal(JSON.stringify(env).includes(secret), false, "Worker environment must not contain the provider credential");
      assert.equal(JSON.stringify(args).includes(secret), false);
    }
    for (const token of tokens) assert.equal(JSON.stringify(args).includes(token), false, "Capability must not appear in Git argv");
    return (await exec("git", args, { cwd, env, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  };
  const issue = async () => {
    const connection = await github.get(repository.githubConnectionId); secrets.add(connection.token);
    grant = await gateway.runtime(chat.id, origin); tokens.add(grant.token); return grant;
  };
  const persistedConfig = async () => {
    const config = await readFile(path.join(workspace, ".git/config"), "utf8");
    assert.ok(config.includes(`https://github.com/${repository.fullName}.git`));
    assert.doesNotMatch(config, /extraheader|gateway\/github|cap_/i);
    for (const secret of secrets) assert.equal(config.includes(secret), false);
  };
  const denied = async currentGrant => {
    const before = upstreamRequests, beforeApi = providerRequests, wrongId = repository.id === Number.MAX_SAFE_INTEGER ? repository.id - 1 : repository.id + 1;
    const headers = { authorization: `Bearer ${currentGrant.token}` };
    const read = await fetch(`${origin}/gateway/github/git/${wrongId}.git/info/refs?service=git-upload-pack`, { headers });
    assert.equal(read.status, 403); await read.arrayBuffer();
    const write = await fetch(`${origin}/gateway/github/git/${wrongId}.git/git-receive-pack`, { method: "POST", headers: { ...headers, "content-type": "application/x-git-receive-pack-request" }, body: "0000" });
    assert.equal(write.status, 403); await write.arrayBuffer();
    const mcp = await fetch(`${origin}/gateway/github/mcp`, { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "github_create_pull_request", arguments: { repositoryId: wrongId, repository: repository.fullName, head: "smoke-never-written", base: repository.branch, title: "Must be denied before provider" },
    } }) });
    assert.equal(mcp.status, 200); assert.equal((await mcp.json()).result.isError, true);
    assert.equal(upstreamRequests, before, "Unselected reads and writes must not reach Git transport");
    assert.equal(providerRequests, beforeApi, "Unselected operations must not reach any provider API");
  };
  const stale = async currentGrant => {
    const before = upstreamRequests, beforeApi = providerRequests;
    await assert.rejects(git(["ls-remote", "origin"], currentGrant, workspace));
    assert.equal(upstreamRequests, before, "Revoked capabilities cannot reach provider Git");
    assert.equal(providerRequests, beforeApi, "Revoked capabilities cannot reach provider API");
  };
  const close = async () => {
    gateway.shutdown(); github.onChange = previousHook; github.fetch = previousFetch;
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    secrets.clear(); tokens.clear();
  };
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    const first = await issue(), beforeClone = upstreamRequests;
    await git(["clone", "--depth=1", "--branch", repository.branch, "--", `https://github.com/${repository.fullName}.git`, workspace], first);
    assert.ok(upstreamRequests > beforeClone, "Actual worker Git must traverse gateway transport");
    assert.match(await git(["rev-parse", "HEAD"], first, workspace), /^[a-f0-9]{40}$/);
    await persistedConfig(); await denied(first);
    return {
      async beforeRestart() { gateway.shutdown(); github.onChange = previousHook; github.fetch = previousFetch; await stale(first); },
      async resume(restoredGithub) {
        bind(restoredGithub); await stale(first);
        const next = await issue(); assert.notEqual(next.token, first.token);
        const beforeFetch = upstreamRequests;
        await git(["fetch", "--depth=1", "origin", repository.branch], next, workspace);
        assert.ok(upstreamRequests > beforeFetch); await persistedConfig(); await denied(next);
        // Real saved-connection mutation (isolated DB only) revokes its grant.
        const connection = await github.get(repository.githubConnectionId);
        await github.update({ id: connection.id, revision: connection.revision, name: "Read-only smoke renamed" });
        await stale(next);
        const refreshed = await issue();
        assert.ok(await git(["ls-remote", "origin", `refs/heads/${repository.branch}`], refreshed, workspace));
        // A company change in the saved chat invalidates the immutable grant.
        chat.repositories[0] = { ...repository, companyId: "smoke-other" };
        await stale(refreshed);
        await assert.rejects(gateway.runtime(chat.id, origin), { statusCode: 403 });
        chat.repositories[0] = repository;
        return { environment: "local-native-git-subprocess-not-EC2", nativeCloneThroughGateway: true, nativeFetchAfterDatabaseRestart: true,
          oldCapabilitiesDenied: true, selectedConnectionMutationRevokes: true, crossCompanyDenied: true, unselectedGitReadWriteDenied: true,
          unselectedPrWriteDenied: true, noProviderCredentialInWorkerEnvironment: true, noSecretsInGitArgvOrConfig: true, upstreamGitRequests: upstreamRequests,
          remoteWrites: false, deployedProductSelection: false, nativeAgentOrAwsWorker: false };
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
