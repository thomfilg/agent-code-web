import test from "node:test";
import assert from "node:assert/strict";
import { GitHubWorkerGateway } from "../src/github-worker-gateway.mjs";
import { runGitHubPrTool } from "../src/github-worker-mcp.mjs";
import { scopeAllows } from "../public/company-scope.js";

const selected = { id: 12, fullName: "example/project", githubConnectionId: "github_alice", branch: "main", defaultBranch: "main" };
const input = { repositoryId: 12, repository: "example/project", head: "feature/mvp", base: "main", title: "MVP", body: "Description" };
async function fixture(t) {
  const chat = { id: "chat_123", ownerId: "alice", repositories: [{ ...selected }] }, calls = [], serviceOwners = [];
  const record = { id: "github_alice", revision: 1, token: "PRIVATE-PAT-STAYS-ON-CONTROLLER", companies: ["example"], expiresAt: null };
  const state = { currentChat: chat, record, hook: null, alive: true, now: 0, upstreamId: 12 };
  const github = {
    queue: Promise.resolve(),
    async requireConnection({ connectionId, repository, chatCompany }) {
      const current = state.record;
      if (!current || current.id !== connectionId || !current.token || !scopeAllows(current, repository.split("/")[0]) || !scopeAllows(current, chatCompany) ||
          (current.expiresAt && Date.parse(current.expiresAt) <= Date.now())) throw Error("PRIVATE-CONNECTION-DETAIL");
      return { ...current };
    },
    async request(route, options) {
      calls.push({ route, options });
      if (state.hook) await state.hook(route, options);
      if (route === "/repos/example/project") return { id: state.upstreamId, full_name: "example/project" };
      if (route.includes("/branches/")) return { name: decodeURIComponent(route.split("/branches/")[1]), commit: { sha: "a".repeat(40) } };
      return { number: 73, state: "open", merged: false, head: { ref: "feature/mvp", repo: { id: 12, full_name: "example/project" } },
        base: { ref: "main", repo: { id: 12, full_name: "example/project" } }, title: input.title, body: input.body, draft: true };
    },
  };
  const gateway = new GitHubWorkerGateway({ store: { get: id => id === chat.id ? state.currentChat : null },
    servicesFor: async current => { serviceOwners.push(current.ownerId); if (current.ownerId !== "alice") throw Error("PRIVATE-OWNER"); return { github }; },
    now: () => state.now, ttlMs: 60000,
    fetchImpl: () => { throw Error("External Git HTTP is forbidden in this test"); },
  });
  t.after(() => gateway.shutdown());
  const runtime = await gateway.runtime(chat.id, "http://127.0.0.1:8787", { validWhile: () => state.alive });
  return { gateway, token: runtime.token, chat, state, calls, serviceOwners };
}
test("real GitHub worker gateway admits MCP only through saved owner/connection and immutable upstream repository ID", async t => {
  const f = await fixture(t), result = await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", input);
  assert.equal(result.isError, undefined); assert.deepEqual(f.serviceOwners, ["alice"]);
  assert.equal(f.calls[0].route, "/repos/example/project"); assert.equal(f.calls.at(-1).options.method, "POST");
  for (const call of f.calls) { assert.equal(call.options.connectionId, "github_alice"); assert.equal(call.options.chatCompany, "example"); assert.equal(call.options.token, undefined); }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|cap_/);
  f.state.upstreamId = 99;
  const before = f.calls.length;
  assert.equal((await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", input)).isError, true);
  assert.equal(f.calls.length, before + 1, "mismatched immutable ID denies before branch reads or writes");
});
test("real gateway refuses owner/company/selection/revision/token/expiry and runtime changes without provider mutation", async t => {
  for (const mutate of [f => f.chat.ownerId = "bob", f => f.chat.repositories[0].fullName = "other/project", f => f.chat.repositories[0].id = 99,
    f => f.chat.repositories[0].githubConnectionId = "github_other", f => f.state.record.companies = ["other"],
    f => f.state.record.revision++, f => f.state.record.token = "PRIVATE-ROTATED", f => f.state.record.expiresAt = "2000-01-01T00:00:00Z",
    f => f.state.currentChat = null, f => f.state.alive = false, f => f.state.now = 60001, f => f.gateway.revokeChat(f.chat.id)]) {
    const f = await fixture(t); mutate(f);
    const result = await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", input);
    assert.equal(result.isError, true); assert.equal(f.calls.length, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});
test("real gateway aborts a PR operation revoked during a branch read and never submits the write", async t => {
  const f = await fixture(t); let receivedSignal;
  f.state.hook = async (route, options) => {
    if (route.includes("/branches/")) { receivedSignal = options.signal; f.gateway.revokeConnection("alice", "github_alice"); }
  };
  const result = await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", input);
  assert.equal(result.isError, true); assert.equal(receivedSignal.aborted, true);
  assert.equal(f.calls.some(call => call.options.method === "POST"), false);
  assert.equal(f.gateway.active, 0);
});
test("another owner's connection revocation cannot cancel this grant, but own revocation after a write prevents success", async t => {
  const f = await fixture(t);
  f.gateway.revokeConnection("bob", "github_alice");
  assert.equal((await f.gateway.listRepositories(f.token)).length, 1);
  f.state.hook = async (_route, options) => { if (options.method === "POST") f.gateway.revokeConnection("alice", "github_alice"); };
  const result = await runGitHubPrTool(f.gateway, f.token, "github_create_pull_request", input);
  assert.equal(result.isError, true); assert.equal(f.calls.filter(call => call.options.method === "POST").length, 1);
  assert.equal(f.gateway.active, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|cap_/);
});
