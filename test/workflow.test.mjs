import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { workflowPatch } from "../public/chat-organization.js";
import { extractResponse, ResponseStream } from "../src/response-protocol.mjs";
import { PullRequestMonitor, checkState, inspectBranches, pullRequestLinks } from "../src/pull-requests.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const verified = { verifiedAt: "2026-01-01T00:00:00Z", state: "open", checks: "passing" };
const sha = "a".repeat(40);
const git = promisify(execFile);
test("automatic state precedence, failed checks, closed PRs, and multiple PRs", () => {
  const chat = { status: "stopped", pullRequests: [verified] };
  const state = patch => workflowPatch({ ...chat, ...patch }).workflowState;
  assert.equal(state({}), "pr_open");
  assert.equal(state({ pullRequests: [{ ...verified, checks: "failing" }] }), "pr_failing");
  assert.equal(state({ pullRequests: [{ ...verified, checks: "pending" }] }), "pr_open");
  assert.equal(state({ status: "running" }), "working");
  assert.equal(state({ status: "running", pendingRequest: {} }), "asking_question");
  assert.equal(state({ awaitingUser: true }), "asking_question");
  assert.equal(state({ archived: true, status: "running" }), "archived");
  assert.equal(state({ pullRequests: [{ ...verified, state: "closed", merged: true }] }), "pr_merged");
  assert.equal(state({ pullRequests: [{ ...verified, state: "closed", merged: false }] }), "idle");
  assert.equal(state({ pullRequests: [{ ...verified, state: "closed", merged: true }, verified] }), "pr_open");
  assert.equal(state({ pullRequests: [{ state: "open" }], workflowState: "pr_merged", resumeState: "pr_merged" }), "idle");
});
test("hidden waiting metadata never leaks across chunk splits, with or without automatic titles", () => {
  for (const automaticTitle of [true, false]) for (const waiting of ["yes", "no"]) {
    const source = `${automaticTitle ? "<relay-title>Choose a branch</relay-title>\n" : ""}Which branch should I use?\n<relay-waiting>${waiting}</relay-waiting>`;
    for (let split = 0; split <= source.length; split++) {
      const events = []; const stream = new ResponseStream(event => events.push(event), automaticTitle);
      stream.delta(source.slice(0, split)); stream.delta(source.slice(split)); stream.flush();
      assert.equal(events.filter(event => event.type === "assistant_delta").map(event => event.delta).join("").trim(), "Which branch should I use?");
      assert.equal(events.filter(event => event.type === "title").length, automaticTitle ? 1 : 0);
    }
    assert.equal(extractResponse(source, automaticTitle).awaitingUser, waiting === "yes");
  }
  const events = []; const stream = new ResponseStream(event => events.push(event), false);
  for (const character of "answer\n<relay-waiting>yes</relay-waiting>") stream.delta(character);
  stream.flush(); assert.equal(events.map(event => event.delta).join("").trim(), "answer");
  assert.equal(extractResponse("Optional: want help?").awaitingUser, false);
  assert.equal(extractResponse("done <relay-waiting>yes</relay-waiting> now done <relay-waiting>no</relay-waiting>").awaitingUser, false);
});
test("ordinary questions persist across autosleep/restart, then clear on the next turn (Codex and Claude)", async t => {
  for (const agent of ["codex", "claude"]) {
    const root = await temporaryDirectory(t); const records = new MemoryRecords(); const store = new ChatStore(root, records); await store.initialize();
    let finish, hooks;
    const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
      adapterFactory: ({ hooks: callbacks }) => { hooks = callbacks; return { start: async () => {}, send: (prompt, options) => { assert.match(agent === "claude" ? options.systemPrompt : prompt, /relay-waiting/); return new Promise(resolve => { finish = resolve; }); }, stop: async () => {}, respond: async () => {} }; },
    }); t.after(() => manager.shutdown());
    const chat = await manager.createChat({ agent, title: "Manual title" });
    const turn = await manager.submit(chat.id, "Ask which branch to use"); await waitFor(() => finish);
    assert.equal(store.get(chat.id).workflowState, "working");
    await hooks.onEvent({ type: "assistant_delta", delta: "Which branch?\n<relay-waiting>yes</relay-waiting>" });
    finish({ text: "Which branch?\n<relay-waiting>yes</relay-waiting>" }); await turn.completion;
    assert.equal(store.get(chat.id).workflowState, "asking_question");
    assert.equal(store.get(chat.id).messages.at(-1).text, "Which branch?");
    await waitFor(() => store.get(chat.id).status === "stopped");
    assert.equal(store.get(chat.id).workflowState, "asking_question");
    const restarted = new ChatStore(root, records); await restarted.initialize();
    assert.equal(restarted.get(chat.id).workflowState, "asking_question");
    finish = null; const answer = await manager.submit(chat.id, "main"); await waitFor(() => finish);
    assert.equal(store.get(chat.id).workflowState, "working");
    finish({ text: "Done.\n<relay-waiting>no</relay-waiting>" }); await answer.completion;
    assert.equal(store.get(chat.id).workflowState, "idle");
    assert.equal(store.get(chat.id).title, "Manual title");
  }
});
test("GitHub classification includes failed status contexts, cancellation and pending vs passing", () => {
  assert.equal(checkState([{ status: "completed", conclusion: "success" }], {}), "passing");
  assert.equal(checkState([{ status: "in_progress", conclusion: null }], {}), "pending");
  for (const conclusion of ["failure", "timed_out", "cancelled", "action_required"]) assert.equal(checkState([{ status: "completed", conclusion }], {}), "failing");
  assert.equal(checkState([], { state: "pending", total_count: 0 }), "none");
  assert.equal(checkState([], { state: "pending", total_count: 2, statuses: [{ state: "failure" }] }), "failing");
});
test("PR links are scoped to selected repositories and come from assistant/tool messages only", () => {
  const chat = { repositories: [{ fullName: "Acme/api" }], messages: [
    { role: "user", text: "https://github.com/Acme/api/pull/1" },
    { role: "assistant", text: "https://evil.test/Acme/api/pull/2 https://github.com/Other/api/pull/3 https://github.com/Acme/api/pull/4" },
    { role: "tool", meta: { output: "https://github.com/Acme/api/pull/4\nhttps://github.com/Acme/api/pull/5" } },
  ] };
  assert.deepEqual(pullRequestLinks(chat).map(pr => pr.number), [4, 5]);
});
async function monitorFixture(t) {
  const root = await temporaryDirectory(t); const store = new ChatStore(root, new MemoryRecords()); await store.initialize();
  const chat = await store.create({ title: "PR fixture", agent: "mock", repositories: [{ fullName: "Acme/api", defaultBranch: "main" }] });
  await store.appendMessage(chat.id, { role: "tool", meta: { output: "https://github.com/Acme/api/pull/7" } });
  const fixture = { state: "open", merged: false, conclusion: "success", fail: false, checksFail: false, head: sha, calls: [], pulls: [] };
  const github = { request: async route => {
    fixture.calls.push(route);
    if (fixture.fail) throw new Error("private failure details must not leak");
    if (route.includes("pulls?")) return fixture.pulls;
    if (route.endsWith("/pulls/7")) return { number: 7, title: "Work", state: fixture.state, merged: fixture.merged, head: { sha: fixture.head }, base: { repo: { full_name: "Acme/api" } } };
    if (fixture.checksFail) throw new Error("checks forbidden");
    if (route.includes("check-runs")) return { check_runs: [{ status: fixture.conclusion ? "completed" : "in_progress", conclusion: fixture.conclusion }] };
    if (route.endsWith("/status")) return { state: "pending", total_count: 0, statuses: [] };
    throw new Error(`Unexpected route: ${route}`);
  } };
  const published = []; const monitor = new PullRequestMonitor({ store, github, publish: chat => published.push(chat), intervalMs: 10 }); t.after(() => monitor.stop());
  const refresh = async () => { monitor.requests.clear(); await monitor.refresh(chat.id); return store.get(chat.id); };
  return { store, chat, fixture, monitor, refresh, published };
}
test("PR open -> failing -> pending -> passing -> merged auto transitions, preserves idle timers and no-op timestamps", async t => {
  const { store, chat, fixture, refresh, published } = await monitorFixture(t);
  await store.update(chat.id, { idleDeadlineAt: "2026-01-01", lastActivityAt: "2026-01-01" });
  const open = await refresh(); assert.equal(open.workflowState, "pr_open"); assert.equal(open.status, "stopped");
  const unchanged = await refresh(); assert.equal(unchanged.updatedAt, open.updatedAt); assert.equal(published.length, 1);
  fixture.conclusion = "failure"; assert.equal((await refresh()).workflowState, "pr_failing");
  fixture.conclusion = null; assert.equal((await refresh()).workflowState, "pr_open");
  fixture.conclusion = "success"; assert.equal((await refresh()).pullRequests[0].checks, "passing");
  fixture.state = "closed"; fixture.merged = true;
  const merged = await refresh(); assert.equal(merged.workflowState, "pr_merged");
  assert.equal(merged.idleDeadlineAt, "2026-01-01"); assert.equal(merged.lastActivityAt, "2026-01-01");
  fixture.merged = false; assert.equal((await refresh()).workflowState, "idle");
  fixture.state = "open"; assert.equal((await refresh()).workflowState, "pr_open");
});
test("polling preserves verified status on errors, exposes stale checks, and never overrides working/questions/archive", async t => {
  const { store, chat, fixture, refresh } = await monitorFixture(t);
  fixture.conclusion = "failure"; await refresh();
  fixture.fail = true; const stale = await refresh();
  assert.equal(stale.workflowState, "pr_failing"); assert.match(stale.githubSyncWarning, /last verified/); assert.doesNotMatch(JSON.stringify(stale), /private failure/);
  fixture.fail = false; fixture.checksFail = true; assert.equal((await refresh()).workflowState, "pr_failing");
  fixture.head = "b".repeat(40); const newCommit = await refresh(); assert.equal(newCommit.pullRequests[0].checks, "unknown");
  fixture.checksFail = false; fixture.conclusion = "success";
  await store.update(chat.id, { status: "running" }); assert.equal((await refresh()).workflowState, "working");
  await store.update(chat.id, { status: "stopped", awaitingUser: true, ...workflowPatch({ status: "stopped", awaitingUser: true }) });
  fixture.conclusion = "failure"; assert.equal((await refresh()).workflowState, "asking_question");
  await store.update(chat.id, { archived: true, workflowState: "archived" });
  fixture.state = "closed"; fixture.merged = true;
  assert.equal((await refresh()).workflowState, "archived");
});
test("branch discovery uses awake workspace metadata and excludes default branches", async t => {
  const root = await temporaryDirectory(t);
  await git("git", ["init", "--initial-branch=main", root]);
  const chat = { workspace: root, repositories: [{ fullName: "Acme/api", defaultBranch: "main" }] };
  assert.deepEqual(await inspectBranches(chat, null), []);
  await git("git", ["-C", root, "symbolic-ref", "HEAD", "refs/heads/feature/chat"]);
  assert.deepEqual(await inspectBranches(chat, null), [{ repository: "Acme/api", branch: "feature/chat" }]);
});
test("branch PR discovery rejects unrelated head repositories and old closed branch reuse", async t => {
  const { store, chat, fixture, refresh } = await monitorFixture(t);
  await store.update(chat.id, { messages: [], gitBranches: [{ repository: "Acme/api", branch: "feature/chat" }] });
  fixture.pulls = [
    { number: 7, state: "closed", updated_at: "2000-01-01", head: { ref: "feature/chat", repo: { full_name: "Acme/api" } } },
    { number: 8, state: "open", head: { ref: "feature/chat", repo: { full_name: "Other/api" } } },
    { number: 9, state: "open", head: { ref: "unrelated", repo: { full_name: "Acme/api" } } },
  ];
  assert.equal((await refresh()).pullRequests.length, 0);
  fixture.pulls.push({ number: 7, state: "open", head: { ref: "feature/chat", repo: { full_name: "Acme/api" } } });
  assert.equal((await refresh()).workflowState, "pr_open");
  assert.ok(fixture.calls.some(route => route.includes("head=Acme%3Afeature%2Fchat")));
});

test("periodic monitoring updates sleeping chats and stops cleanly", async t => {
  const { store, chat, fixture, monitor } = await monitorFixture(t);
  monitor.start();
  await waitFor(() => store.get(chat.id).workflowState === "pr_open");
  fixture.conclusion = "failure";
  await waitFor(() => store.get(chat.id).workflowState === "pr_failing");
  assert.equal(store.get(chat.id).status, "stopped");
  await monitor.stop();
  fixture.state = "closed"; fixture.merged = true;
  const calls = fixture.calls.length;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(fixture.calls.length, calls);
  assert.equal(store.get(chat.id).workflowState, "pr_failing");
});
