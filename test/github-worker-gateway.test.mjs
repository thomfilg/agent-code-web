import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { GitHubWorkerGateway } from "../src/github-worker-gateway.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { MemoryRecords } from "../src/database.mjs";

const exec = promisify(execFile), tick = () => new Promise(resolve => setImmediate(resolve));
const cid = "github_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", cid2 = "github_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const repo = { id: 1, fullName: "allowed/repo", githubConnectionId: cid, branch: "main", defaultBranch: "main" };
const privateToken = "fixture-controller-only-credential";
async function fixture(t, options = {}) {
  const records = new MemoryRecords(), calls = [], chats = new Map();
  await records.put("github_connection", cid, { id: cid, revision: 1, token: privateToken, companies: ["allowed"], expiresAt: null });
  const github = new GitHubConnection({ records, config: { apiBase: "https://api.github.com" }, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ id: 1, full_name: "allowed/repo" });
  } });
  const chat = { id: "chat_one", ownerId: "alice", repositories: [{ ...repo }] }; chats.set(chat.id, chat);
  const gateway = new GitHubWorkerGateway({ store: { get: id => structuredClone(chats.get(id)) }, servicesFor: async () => ({ github }), ...options });
  github.onChange = id => gateway.revokeConnection("alice", id);
  t.after(() => gateway.shutdown());
  await github.ready;
  return { gateway, github, records, chat, chats, calls };
}
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function serve(t, gateway) { return listen(t, async (req, res) => { if (!await gateway.handle(req, res, new URL(req.url, "http://fixture"))) { res.writeHead(404); res.end(); } }); }
const discovery = "/gateway/github/git/1.git/info/refs?service=git-upload-pack";
const headers = token => ({ authorization: `Bearer ${token}` });

test("authenticated Git discovery rejects and closes unread GET bodies", async t => {
  const f = await fixture(t), origin = await serve(t, f.gateway), grant = await f.gateway.runtime(f.chat.id, origin);
  for (const framing of [{ "content-length": "1000" }, { "transfer-encoding": "chunked" }]) {
    const req = http.request(origin + discovery, { method: "GET", headers: { ...headers(grant.token), ...framing } });
    t.after(() => req.destroy());
    let status; req.on("error", () => {});
    req.once("response", response => { status = response.statusCode; response.resume(); });
    const closed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("Git fixture socket did not close")), 1000);
      req.once("close", () => { clearTimeout(timeout); resolve(); });
    });
    req.write("{"); await closed;
    assert.equal(status, 400); assert.equal(f.gateway.active, 0); assert.equal(f.calls.length, 0);
  }
});

test("runtime returns only selected IDs and ephemeral config, not a provider credential", async t => {
  const f = await fixture(t), result = await f.gateway.runtime(f.chat.id, "https://relay.example");
  assert.deepEqual(result.repositories, [{ id: 1, fullName: "allowed/repo" }]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateToken));
  assert.match(JSON.stringify(result.environmentVariables), /https:\/\/github.com\/allowed\/repo.git/);
  assert.equal(result.environmentVariables.GIT_TERMINAL_PROMPT, "0");
  assert.deepEqual(await f.gateway.listRepositories(result.token), result.repositories);
  for (const origin of ["http://public.example", "https://relay.example/path", "https://name:secret@relay.example", "https://relay.example/?a=1"]) await assert.rejects(f.gateway.runtime(f.chat.id, origin));
  f.chat.repositories = [];
  assert.deepEqual(await f.gateway.runtime(f.chat.id, "https://relay.example"), { token: null, environmentVariables: {}, repositories: [] });
  await assert.rejects(f.gateway.listRepositories(result.token));
});

test("owner, primary company, selected repo, branch, archive and lifetime changes fail closed", async t => {
  for (const change of [c => c.ownerId = "bob", c => c.repositories[0].fullName = "other/repo", c => c.repositories[0].id = 2,
    c => c.repositories[0].githubConnectionId = cid2, c => c.repositories[0].branch = "other", c => c.archived = true]) {
    const f = await fixture(t), grant = await f.gateway.runtime(f.chat.id, "https://relay.example");
    change(f.chat); await assert.rejects(f.gateway.listRepositories(grant.token));
  }
  let live = true;
  const f = await fixture(t), grant = await f.gateway.runtime(f.chat.id, "https://relay.example", { validWhile: () => live });
  live = false; await assert.rejects(f.gateway.listRepositories(grant.token));
});

test("capabilities are replaced on resume and isolate exact owner connection revocation", async t => {
  const f = await fixture(t), first = await f.gateway.runtime(f.chat.id, "https://relay.example"), second = await f.gateway.runtime(f.chat.id, "https://relay.example");
  await assert.rejects(f.gateway.listRepositories(first.token));
  f.gateway.revokeConnection("bob", cid); assert.equal((await f.gateway.listRepositories(second.token)).length, 1);
  f.gateway.revokeConnection("alice", cid); await assert.rejects(f.gateway.listRepositories(second.token));
  f.chat.ownerId = undefined;
  const legacy = await f.gateway.runtime(f.chat.id, "https://relay.example");
  f.gateway.revokeConnection(null, cid); await assert.rejects(f.gateway.listRepositories(legacy.token));
});

test("GitHub hibernation restores the exact worker token only after immutable repository credentials revalidate", async t => {
  const f = await fixture(t), first = await f.gateway.runtime(f.chat.id, "https://relay.example"), snapshot = f.gateway.suspendRuntime(f.chat.id);
  f.gateway.revokeChat(f.chat.id); await assert.rejects(f.gateway.listRepositories(first.token));
  const resumed = await f.gateway.resumeRuntime(f.chat.id, "https://relay.example", snapshot);
  assert.equal(resumed.token, first.token);
  assert.deepEqual(await f.gateway.listRepositories(first.token), [{ id: 1, fullName: "allowed/repo" }]);

  f.gateway.revokeChat(f.chat.id);
  await f.records.put("github_connection", cid, { ...await f.github.get(cid), revision: 2 });
  await assert.rejects(f.gateway.resumeRuntime(f.chat.id, "https://relay.example", snapshot));
  await assert.rejects(f.gateway.listRepositories(first.token));
});

test("connection revision, credential and expiry are rechecked from saved owner service", async t => {
  for (const patch of [{ revision: 2 }, { token: "different-private-fixture" }, { expiresAt: "2000-01-01T00:00:00Z" }]) {
    const f = await fixture(t), grant = await f.gateway.runtime(f.chat.id, "https://relay.example");
    await f.records.put("github_connection", cid, { ...await f.github.get(cid), ...patch });
    await assert.rejects(f.gateway.listRepositories(grant.token));
  }
  const f = await fixture(t), grant = await f.gateway.runtime(f.chat.id, "https://relay.example");
  await f.records.delete("github_connection", cid); await assert.rejects(f.gateway.listRepositories(grant.token));
});

test("obsolete GitHub company metadata never limits the selected repository capability", async t => {
  const f = await fixture(t), grant = await f.gateway.runtime(f.chat.id, "https://relay.example");
  for (const companies of [[], ["excluded"]]) {
    await f.records.put("github_connection", cid, { ...await f.github.get(cid), companies });
    assert.deepEqual(await f.gateway.listRepositories(grant.token), [{ id: repo.id, fullName: repo.fullName }]);
    assert.equal(await f.gateway.withRepository(grant.token, repo.id, () => "allowed-by-github"), "allowed-by-github");
    await assert.rejects(f.gateway.withRepository(grant.token, repo.id + 1, () => assert.fail("unselected repository")), { statusCode: 403 });
  }
});

test("immutable repository identity is checked before any callback; no caller chooses URLs or connection", async t => {
  const f = await fixture(t), grant = await f.gateway.runtime(f.chat.id, "https://relay.example"); let executed = false;
  await assert.rejects(f.gateway.withRepository(grant.token, 2, () => { executed = true; }));
  f.github.fetch = async () => Response.json({ id: 99, full_name: "allowed/repo" });
  await assert.rejects(f.gateway.withRepository(grant.token, 1, () => { executed = true; }));
  assert.equal(executed, false);
});

test("connection rename revokes active work BEFORE a delayed durable write and reissue waits for it", async t => {
  const f = await fixture(t), grant = await f.gateway.runtime(f.chat.id, "https://relay.example");
  let entered = false, aborted = false;
  const pending = f.gateway.withRepository(grant.token, 1, async ({ signal }) => {
    entered = true; await new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
  });
  const rejected = assert.rejects(pending);
  while (!entered) await tick();
  let release, writing = false; const original = f.records.put.bind(f.records);
  f.records.put = async (...args) => { writing = true; await new Promise(resolve => { release = resolve; }); return original(...args); };
  const updating = f.github.update({ id: cid, revision: 1, name: "Personal" });
  assert.equal(aborted, true);
  while (!writing) await tick();
  let reissued = false;
  const next = f.gateway.runtime(f.chat.id, "https://relay.example").then(() => { reissued = true; });
  await tick(); assert.equal(reissued, false);
  release(); await updating; await rejected; await next; assert.equal(reissued, true);
});

test("disconnect immediately aborts a request during provider identity fetch and never runs callback", async t => {
  const f = await fixture(t), grant = await f.gateway.runtime(f.chat.id, "https://relay.example"); let started = false, aborted = false, ran = false;
  f.github.fetch = async (_url, { signal }) => { started = true; return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("PRIVATE-PROVIDER-ERROR")); }, { once: true })); };
  const request = assert.rejects(f.gateway.withRepository(grant.token, 1, () => { ran = true; }), error => !error.message.includes("PRIVATE"));
  while (!started) await tick();
  await f.github.disconnect(cid); await request; assert.equal(aborted, true); assert.equal(ran, false);
});

test("smart HTTP rejects unknown operations, origins, free query parameters and wrong MIME without upstream", async t => {
  let forwarded = 0;
  const f = await fixture(t, { fetchImpl: async () => { forwarded++; throw Error("PRIVATE"); } }), origin = await serve(t, f.gateway), grant = await f.gateway.runtime(f.chat.id, origin);
  for (const [route, options] of [
    [discovery + "&url=https://evil.example", {}], ["/gateway/github/git/1.git/HEAD", {}], ["/gateway/github/git/01.git/info/refs?service=git-upload-pack", {}],
    [discovery, { headers: { ...headers(grant.token), origin: "https://evil.example" } }],
    ["/gateway/github/git/1.git/git-receive-pack", { method: "POST", body: "secret", headers: headers(grant.token) }],
  ]) {
    const response = await fetch(origin + route, { headers: headers(grant.token), ...options }); assert.ok(response.status >= 400); assert.doesNotMatch(await response.text(), /PRIVATE|secret|evil/);
  }
  assert.equal(forwarded, 0);
});

test("smart HTTP forwards only fixed GitHub URL and allowlisted headers; gzip request is bounded and decoded", async t => {
  let forwarded;
  const f = await fixture(t, { fetchImpl: async (url, options) => { forwarded = { url, options }; return new Response("0000", { headers: { "content-type": "application/x-git-receive-pack-result", "set-cookie": "PRIVATE", location: "https://evil.example" } }); } });
  const origin = await serve(t, f.gateway), grant = await f.gateway.runtime(f.chat.id, origin);
  const response = await fetch(origin + "/gateway/github/git/1.git/git-receive-pack", { method: "POST", body: gzipSync("0000"), headers: {
    ...headers(grant.token), "content-type": "application/x-git-receive-pack-request", "content-encoding": "gzip", cookie: "PRIVATE", "x-evil": "PRIVATE", "git-protocol": "version=2",
  } });
  assert.equal(response.status, 200); assert.equal(await response.text(), "0000"); assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(forwarded.url, "https://github.com/allowed/repo.git/git-receive-pack"); assert.equal(forwarded.options.redirect, "error");
  assert.equal(forwarded.options.body.toString(), "0000"); assert.equal(forwarded.options.headers.cookie, undefined); assert.equal(forwarded.options.headers["x-evil"], undefined);
  assert.equal(Buffer.from(forwarded.options.headers.authorization.slice(6), "base64").toString(), `x-access-token:${privateToken}`);
  assert.doesNotMatch(JSON.stringify(forwarded.options.headers), new RegExp(grant.token));
});

test("upstream errors and redirects never expose private body or headers", async t => {
  for (const status of [301, 401, 403, 404, 500]) {
    const f = await fixture(t, { fetchImpl: async () => new Response("PRIVATE-PROVIDER-BODY", { status, headers: { location: "https://secret.example" } }) });
    const origin = await serve(t, f.gateway), grant = await f.gateway.runtime(f.chat.id, origin), result = await fetch(origin + discovery, { headers: headers(grant.token) });
    assert.ok(result.status >= 400); assert.equal(result.headers.get("location"), null); assert.doesNotMatch(await result.text(), /PRIVATE|secret/);
  }
});

test("revocation aborts an ongoing smart HTTP response stream", async t => {
  let upstreamAborted = false;
  const f = await fixture(t, { fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("0008NAK\n"));
    signal.addEventListener("abort", () => { upstreamAborted = true; controller.error(new Error("PRIVATE")); }, { once: true });
  } }), { headers: { "content-type": "application/x-git-upload-pack-advertisement" } }) });
  const origin = await serve(t, f.gateway), grant = await f.gateway.runtime(f.chat.id, origin), response = await fetch(origin + discovery, { headers: headers(grant.token) }), reader = response.body.getReader();
  await reader.read(); f.gateway.revokeChat(f.chat.id);
  await assert.rejects(reader.read()); assert.equal(upstreamAborted, true);
});

test("gzip bombs are denied before forwarding and concurrent operations are capped per grant and globally", async t => {
  let forwarded = false;
  const f = await fixture(t, { fetchImpl: async () => { forwarded = true; throw Error(); } }), origin = await serve(t, f.gateway), grant = await f.gateway.runtime(f.chat.id, origin);
  const response = await fetch(origin + "/gateway/github/git/1.git/git-receive-pack", { method: "POST", body: gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1)), headers: {
    ...headers(grant.token), "content-type": "application/x-git-receive-pack-request", "content-encoding": "gzip",
  } });
  assert.equal(response.status, 413); assert.equal(forwarded, false);
  const grants = [grant];
  for (const id of ["chat_two", "chat_three"]) { f.chats.set(id, { ...f.chat, id }); grants.push(await f.gateway.runtime(id, origin)); }
  const releases = [], operations = [];
  const hold = async token => {
    const promise = f.gateway.withRepository(token, 1, () => new Promise(resolve => releases.push(resolve)));
    operations.push(promise); while (releases.length !== operations.length) await tick();
  };
  await hold(grants[0].token); await hold(grants[0].token);
  await assert.rejects(f.gateway.withRepository(grants[0].token, 1, () => {}), { statusCode: 429 });
  await hold(grants[1].token); await hold(grants[1].token);
  await assert.rejects(f.gateway.withRepository(grants[2].token, 1, () => {}), { statusCode: 429 });
  for (const release of releases) release(); await Promise.all(operations);
  assert.equal(f.gateway.active, 0);
});

test("client disconnect cancels provider work and never persists provider error output", async t => {
  let upstreamAborted = false, entered = false;
  const f = await fixture(t, { fetchImpl: async (_url, { signal }) => {
    entered = true; return new Promise((_, reject) => signal.addEventListener("abort", () => { upstreamAborted = true; reject(Error("PRIVATE")); }, { once: true }));
  } });
  const origin = await serve(t, f.gateway), grant = await f.gateway.runtime(f.chat.id, origin), cancellation = new AbortController();
  const result = fetch(origin + discovery, { headers: headers(grant.token), signal: cancellation.signal }); const rejected = assert.rejects(result);
  while (!entered) await tick(); cancellation.abort(); await rejected;
  // TCP close delivery needs an actual bounded timer window under parallel
  // suites; a tight setImmediate loop can finish before the socket event.
  for (let i = 0; i < 200 && !upstreamAborted; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(upstreamAborted, true);
});

test("native Git clones, fetches and pushes through actual git-http-backend without credential persistence", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-git-gateway-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LANG: "C.UTF-8" };
  const git = async (args, cwd = directory, extra = {}) => (await exec("git", args, { cwd, env: { ...env, ...extra }, timeout: 20000, maxBuffer: 1024 * 1024 })).stdout.trim();
  await mkdir(path.join(directory, "allowed")); await git(["init", "--bare", "allowed/repo.git"]); await git(["--git-dir=allowed/repo.git", "config", "http.receivepack", "true"]);
  await git(["init", "--initial-branch=main", "seed"]); const seed = path.join(directory, "seed");
  await writeFile(path.join(seed, "fixture.txt"), "first\n"); await git(["add", "fixture.txt"], seed); await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], seed);
  await git(["push", path.join(directory, "allowed/repo.git"), "main"], seed); await git(["--git-dir=allowed/repo.git", "symbolic-ref", "HEAD", "refs/heads/main"]);
  const backendRequests = [];
  const backend = await listen(t, (request, response) => {
    const url = new URL(request.url, "http://fixture"); backendRequests.push({ path: url.pathname, auth: request.headers.authorization });
    const child = spawn("git", ["http-backend"], { env: { ...env, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers["content-type"] || "", CONTENT_LENGTH: request.headers["content-length"] || "", HTTP_GIT_PROTOCOL: request.headers["git-protocol"] || "", REMOTE_USER: "fixture" }, stdio: ["pipe", "pipe", "ignore"] });
    request.pipe(child.stdin); const chunks = []; child.stdout.on("data", chunk => chunks.push(chunk));
    child.on("close", code => {
      const output = Buffer.concat(chunks), split = output.indexOf("\r\n\r\n");
      if (code !== 0 || split < 0) { response.writeHead(500); response.end("Fixture failed"); return; }
      const lines = output.subarray(0, split).toString().split("\r\n"), headers = {}; let status = 200;
      for (const line of lines) { const i = line.indexOf(":"); if (line.slice(0, i).toLowerCase() === "status") status = Number(line.slice(i + 1).trim().split(" ")[0]); else headers[line.slice(0, i)] = line.slice(i + 1).trim(); }
      response.writeHead(status, headers); response.end(output.subarray(split + 4));
    });
  });
  const f = await fixture(t, { fetchImpl: (url, options) => { assert.ok(url.startsWith("https://github.com/allowed/repo.git/")); return fetch(backend + url.slice("https://github.com".length), options); } });
  const origin = await serve(t, f.gateway), grant = await f.gateway.runtime(f.chat.id, origin);
  await git(["clone", "https://github.com/allowed/repo.git", "client"], directory, grant.environmentVariables);
  const client = path.join(directory, "client"); assert.equal(await readFile(path.join(client, "fixture.txt"), "utf8"), "first\n");
  await git(["checkout", "-b", "feature/fixture"], client, grant.environmentVariables);
  await writeFile(path.join(client, "fixture.txt"), "second\n"); await git(["add", "fixture.txt"], client);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "change"], client);
  await git(["push", "origin", "feature/fixture"], client, grant.environmentVariables);
  await git(["fetch", "origin"], client, grant.environmentVariables);
  assert.equal(await git(["--git-dir=allowed/repo.git", "show", "feature/fixture:fixture.txt"]), "second");
  const saved = await readFile(path.join(client, ".git/config"), "utf8"); assert.match(saved, /https:\/\/github.com\/allowed\/repo.git/); assert.doesNotMatch(saved, /cap_|controller-only|gateway/);
  assert.ok(backendRequests.some(item => item.path.endsWith("git-receive-pack"))); assert.ok(backendRequests.some(item => item.path.endsWith("git-upload-pack")));
  assert.ok(backendRequests.every(item => Buffer.from(item.auth.slice(6), "base64").toString() === `x-access-token:${privateToken}`));
  f.gateway.revokeChat(f.chat.id);
  await assert.rejects(git(["ls-remote", "origin"], client, grant.environmentVariables));
  const next = await f.gateway.runtime(f.chat.id, origin); assert.ok(await git(["ls-remote", "origin"], client, next.environmentVariables));
});
