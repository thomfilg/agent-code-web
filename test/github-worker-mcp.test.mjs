import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { githubWorkerMcpConfig, handleGitHubWorkerMcp, runGitHubPrTool } from "../src/github-worker-mcp.mjs";

const repository = { id: 12, fullName: "example/project", githubConnectionId: "github_selected", branch: "main", defaultBranch: "main" };
const create = { repositoryId: 12, repository: "example/project", head: "feature/mvp", base: "main", title: "MVP", body: "Description" };
const edit = { repositoryId: 12, repository: "example/project", head: "feature/mvp", number: 73, title: "Updated" };
const pull = () => ({ number: 73, state: "open", merged: false, title: "PRIVATE-UPSTREAM-TITLE", body: "PRIVATE-UPSTREAM-BODY",
  html_url: "https://private.example/token", head: { ref: "feature/mvp", repo: { id: 12, full_name: "example/project" } },
  base: { ref: "main", repo: { id: 12, full_name: "example/project" } } });
const text = result => JSON.stringify(result);
function fixture() {
  const state = { now: 0, owner: "alice", company: "example", revision: 1, connected: true, repository: { ...repository } }, calls = [];
  const broker = new CapabilityBroker({ ttlMs: 1000, now: () => state.now });
  const current = () => state.owner === "alice" && state.company === "example" && state.revision === 1 && state.connected &&
    state.repository?.id === repository.id && state.repository.fullName === repository.fullName && state.repository.githubConnectionId === repository.githubConnectionId;
  const token = broker.issue({ chatId: "chat_alice", provider: "github-worker", validWhile: current });
  const assertCurrent = async candidate => { if (!broker.validate(candidate, "github-worker") || !current()) throw Error("PRIVATE-AUTH-STATE"); };
  const gateway = {
    async listRepositories(candidate) { await assertCurrent(candidate); return [{ id: repository.id, fullName: repository.fullName }]; },
    async withRepository(candidate, id, callback) {
      await assertCurrent(candidate); if (id !== repository.id) throw Error("PRIVATE-WRONG-REPOSITORY");
      const result = await callback({ repository: { ...repository }, github: {
        request: async (route, options) => {
          calls.push({ route, options });
          if (fixtureState.hook) return fixtureState.hook(route, options);
          return route.includes("/branches/") ? { name: decodeURIComponent(route.split("/branches/")[1]), commit: { sha: "a".repeat(40) } } : { ...pull(), ...Object.fromEntries(Object.entries(options.body || {}).filter(([key]) => ["title", "body", "draft"].includes(key))) };
        },
      }, connectionId: repository.githubConnectionId, chatCompany: "example", signal: new AbortController().signal, assertCurrent: () => assertCurrent(candidate) });
      await assertCurrent(candidate); return result;
    },
  };
  const fixtureState = { state, calls, token, gateway, broker, hook: null };
  return fixtureState;
}
async function serverFixture(t, f = fixture()) {
  const server = createServer((request, response) => { void handleGitHubWorkerMcp(request, response, new URL(request.url, "http://localhost"), { gateway: f.gateway }).then(handled => {
    if (!handled) { response.writeHead(404); response.end(); }
  }).catch(() => { response.writeHead(500); response.end("fixed failure"); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { ...f, origin, url: `${origin}/gateway/github/mcp` };
}

test("configuration contains only the revocable capability and fixed MCP endpoint", () => {
  const f = fixture(), config = githubWorkerMcpConfig("http://127.0.0.1:8787", f.token).relay_github;
  assert.equal(config.url, "http://127.0.0.1:8787/gateway/github/mcp"); assert.equal(config.headers.Authorization, `Bearer ${f.token}`);
  for (const origin of ["https://token@relay.test", "https://relay.test/other", "https://relay.test?token=x", "file:///tmp/x", "http://remote.example"]) assert.throws(() => githubWorkerMcpConfig(origin, f.token));
  for (const token of ["PAT_PRIVATE", "cap_short", "", null]) assert.throws(() => githubWorkerMcpConfig("https://relay.test", token));
});
test("create verifies local branches, uses only the selected connection and returns an allowlisted receipt", async () => {
  const f = fixture(), result = await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", create);
  assert.equal(result.isError, undefined);
  assert.deepEqual(f.calls.map(call => call.route), ["/repos/example/project/branches/feature%2Fmvp", "/repos/example/project/branches/main", "/repos/example/project/pulls"]);
  assert.deepEqual(f.calls[2].options.body, { head: "feature/mvp", base: "main", title: "MVP", body: "Description", draft: true, maintainer_can_modify: false });
  assert.equal(f.calls[2].options.method, "POST");
  for (const { options } of f.calls) { assert.equal(options.connectionId, "github_selected"); assert.equal(options.chatCompany, "example"); assert.equal(options.token, undefined); assert.ok(options.signal instanceof AbortSignal); }
  assert.deepEqual(JSON.parse(result.content[0].text), { repositoryId: 12, repository: "example/project", number: 73, url: "https://github.com/example/project/pull/73", head: "feature/mvp", base: "main", operation: "created" });
  assert.doesNotMatch(text(result), /PRIVATE|private\.example|cap_/);
});
test("edit verifies PR repository/head and permits only title/body, including clearing the body", async () => {
  const f = fixture(), result = await runGitHubPrTool(f.gateway, f.token, "github_edit_pull_request", { ...edit, body: "" });
  assert.equal(result.isError, undefined); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.method, "PATCH"); assert.deepEqual(f.calls[1].options.body, { title: "Updated", body: "" });
  assert.equal(f.calls[1].route, "/repos/example/project/pulls/73");
});
test("unsupported tools, fields, fork heads and ref/path expressions never make an upstream request", async () => {
  const cases = [
    ["github_merge_pull_request", create], ["github_create_pull_request", { ...create, url: "https://evil.test" }],
    ["github_create_pull_request", { ...create, head: "fork:feature" }], ["github_create_pull_request", { ...create, head: "-option" }],
    ["github_create_pull_request", { ...create, head: "refs/heads/topic" }], ["github_create_pull_request", { ...create, head: "a/../b" }],
    ["github_create_pull_request", { ...create, head: "a//b" }], ["github_create_pull_request", { ...create, head: "a.lock" }],
    ["github_create_pull_request", { ...create, base: "topic@{1}" }], ["github_create_pull_request", { ...create, base: create.head }],
    ["github_create_pull_request", { ...create, title: "\nsecret" }], ["github_create_pull_request", { ...create, title: " " }],
    ["github_create_pull_request", { ...create, body: "a".repeat(20001) }], ["github_create_pull_request", { ...create, repository: "../other" }],
    ["github_create_pull_request", { ...create, repositoryId: Number.MAX_SAFE_INTEGER + 1 }],
    ["github_edit_pull_request", { ...edit, state: "closed" }], ["github_edit_pull_request", { ...edit, base: "release" }],
    ["github_edit_pull_request", { ...edit, title: undefined }], ["github_edit_pull_request", { ...edit, number: "73" }],
  ];
  for (const [name, input] of cases) { const f = fixture(); assert.equal((await runGitHubPrTool(f.gateway, f.token, name, input)).isError, true); assert.equal(f.calls.length, 0); }
});
test("saved repository ID and name must both match; a secondary connection is never borrowed", async () => {
  for (const input of [{ ...create, repositoryId: 13 }, { ...create, repository: "other/project" }, { ...create, repository: "example/Project" }]) {
    const f = fixture(); assert.equal((await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", input)).isError, true); assert.equal(f.calls.length, 0);
  }
});
test("owner/company/connection/repository changes, expiry and revocation deny admission without any upstream call", async () => {
  for (const mutate of [f => f.state.owner = "bob", f => f.state.company = "other", f => f.state.revision++, f => f.state.connected = false,
    f => f.state.repository.githubConnectionId = "github_other", f => f.state.repository.id = 13, f => f.state.now = 1001, f => f.broker.revokeChat("chat_alice")]) {
    const f = fixture(); mutate(f);
    const result = await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", create);
    assert.equal(result.isError, true); assert.equal(f.calls.length, 0); assert.doesNotMatch(text(result), /PRIVATE/);
  }
  const a = fixture(), b = fixture(); assert.equal((await runGitHubPrTool(b.gateway, a.token, "github_create_pull_request", create)).isError, true); assert.equal(b.calls.length, 0);
});
test("wrong branch metadata cannot produce a PR write", async () => {
  for (const result of [{ name: "other", commit: { sha: "a".repeat(40) } }, { name: create.head, commit: { sha: "PRIVATE" } }, null]) {
    const f = fixture(); f.hook = async () => result;
    assert.equal((await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", create)).isError, true); assert.equal(f.calls.length, 1);
  }
});
test("edit rejects wrong/forked/closed PR identity before PATCH, even if repository full names match", async () => {
  for (const mutate of [p => p.number++, p => p.head.repo.id++, p => p.head.repo.full_name = "fork/project", p => p.base.repo.id++,
    p => p.base.repo.full_name = "other/project", p => p.head.ref = "other", p => p.state = "closed", p => p.merged = true, p => p.head.repo = null]) {
    const f = fixture(), value = pull(); mutate(value); f.hook = async () => value;
    const result = await runGitHubPrTool(f.gateway, f.token, "github_edit_pull_request", edit);
    assert.equal(result.isError, true); assert.equal(f.calls.length, 1); assert.doesNotMatch(text(result), /PRIVATE/);
  }
});
test("scope revoked during an awaited branch read prevents the later mutation", async () => {
  const f = fixture(); f.hook = async () => { f.broker.revokeChat("chat_alice"); return { name: create.head, commit: { sha: "a".repeat(40) } }; };
  assert.equal((await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", create)).isError, true); assert.equal(f.calls.length, 1);
});
test("late revocation or malformed post-write receipts never claim success or retry a write", async () => {
  for (const failure of ["revoked", "identity", "exception"]) {
    const f = fixture(); f.hook = async (_route, options) => {
      if (!options.method) return pull();
      if (failure === "revoked") f.state.revision++;
      if (failure === "exception") throw Error("PRIVATE-TOKEN-AND-UPSTREAM-BODY");
      const value = pull(); if (failure === "identity") value.base.repo.id++; return value;
    };
    const result = await runGitHubPrTool(f.gateway, f.token, "github_edit_pull_request", edit);
    assert.equal(result.isError, true); assert.equal(f.calls.filter(call => call.options.method === "PATCH").length, 1); assert.doesNotMatch(text(result), /PRIVATE|cap_/);
  }
});
test("client abort before a write cannot start a mutation", async () => {
  const f = fixture(), abort = new AbortController(); f.hook = async () => { abort.abort(); return pull(); };
  const result = await runGitHubPrTool(f.gateway, f.token, "github_edit_pull_request", edit, { signal: abort.signal });
  assert.equal(result.isError, true); assert.equal(f.calls.length, 1);
});
test("an upstream write receipt must confirm requested title/body and draft rather than only the PR identity", async () => {
  for (const field of ["title", "body", "draft"]) {
    const f = fixture(); f.hook = async (route, options) => {
      if (route.includes("/branches/")) return { name: decodeURIComponent(route.split("/branches/")[1]), commit: { sha: "a".repeat(40) } };
      return { ...pull(), title: options.body.title, body: options.body.body, draft: options.body.draft, [field]: field === "draft" ? false : "PRIVATE-UNEXPECTED" };
    };
    const result = await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", create);
    assert.equal(result.isError, true); assert.equal(f.calls.filter(call => call.options.method === "POST").length, 1); assert.doesNotMatch(text(result), /PRIVATE/);
  }
  const f = fixture(); f.hook = async () => pull();
  assert.equal((await runGitHubPrTool(f.gateway, f.token, "github_edit_pull_request", edit)).isError, true);
});
test("official SDK client discovers only two scoped tools and performs both RPC operations", async t => {
  const f = await serverFixture(t), client = new Client({ name: "pr-mcp-test", version: "1" }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(f.url), { requestInit: { headers: { Authorization: `Bearer ${f.token}` } } }));
  const listed = await client.listTools(); assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["github_create_pull_request", "github_edit_pull_request"]);
  for (const tool of listed.tools) { assert.match(tool.description, /12: example\/project/); assert.doesNotMatch(JSON.stringify(tool), /PRIVATE|cap_/); }
  assert.equal((await client.callTool({ name: "github_create_pull_request", arguments: create })).isError, undefined);
  assert.equal((await client.callTool({ name: "github_edit_pull_request", arguments: edit })).isError, undefined);
  const count = f.calls.length;
  const bad = await client.callTool({ name: "github_edit_pull_request", arguments: { ...edit, "PRIVATE-ARGUMENT-NAME": true } });
  assert.equal(bad.isError, true); assert.doesNotMatch(text(bad), /PRIVATE/); assert.equal(f.calls.length, count);
  f.broker.revokeChat("chat_alice"); await assert.rejects(client.listTools()); assert.equal(f.calls.length, count);
});
test("HTTP gate rejects unauthenticated/browser/query/non-POST and malformed/oversized requests", async t => {
  const f = await serverFixture(t), headers = { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" };
  assert.equal((await fetch(f.url)).status, 401);
  assert.equal((await fetch(f.url, { method: "POST", headers: { Cookie: "session=fake" }, body: "{}" })).status, 401);
  assert.equal((await fetch(f.url, { headers })).status, 405);
  assert.equal((await fetch(f.url, { method: "POST", headers: { ...headers, Origin: f.origin }, body: "{}" })).status, 403);
  assert.equal((await fetch(f.url + "?cap=private", { method: "POST", headers, body: "{}" })).status, 403);
  const invalid = await fetch(f.url, { method: "POST", headers, body: "PRIVATE-INVALID-JSON" }); assert.equal(invalid.status, 400); assert.doesNotMatch(await invalid.text(), /PRIVATE/);
  assert.equal((await fetch(f.url, { method: "POST", headers, body: "x".repeat(100001) })).status, 413);
  assert.equal((await fetch(f.origin + "/gateway/github/other", { headers })).status, 404);
  assert.equal(f.calls.length, 0);
});
test("revocation while reading the HTTP body blocks even tool discovery", async t => {
  const f = await serverFixture(t); let admitted;
  const original = f.gateway.listRepositories;
  const reached = new Promise(resolve => { admitted = resolve; });
  f.gateway.listRepositories = async token => { const value = await original(token); admitted(); return value; };
  const req = httpRequest(f.url, { method: "POST", headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" } });
  const response = new Promise((resolve, reject) => { req.once("response", resolve); req.once("error", reject); });
  req.write('{"jsonrpc":"2.0",'); await reached;
  f.broker.revokeChat("chat_alice"); req.end('"id":1,"method":"tools/list"}');
  const res = await response; res.resume(); assert.equal(res.statusCode, 401); assert.equal(f.calls.length, 0);
});
test("ambiguous raw endpoints and duplicate Authorization headers fail closed", async t => {
  const f = await serverFixture(t);
  const query = (path, headers) => new Promise((resolve, reject) => {
    const request = httpRequest(f.origin, { path, method: "POST", headers }, response => { response.resume(); resolve(response.statusCode); });
    request.once("error", reject); request.end("{}");
  });
  assert.equal(await query("/gateway/github/mcp", ["Host", new URL(f.origin).host, "Authorization", `Bearer ${f.token}`, "Authorization", `Bearer ${f.token}`]), 401);
  assert.equal(await query("/gateway/github/../github/mcp", { Authorization: `Bearer ${f.token}` }), 403);
  assert.equal(f.calls.length, 0);
});
