import path from "node:path";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { MemoryRecords } from "../../src/database.mjs";
import { ChatStore } from "../../src/store.mjs";
import { PullRequestMonitor } from "../../src/pull-requests.mjs";
import { GitHubEvents } from "../../src/github-events.mjs";
import { temporaryDirectory } from "../helpers.mjs";
export const eventOwner = `user_${"a".repeat(32)}`, eventAccount = "account_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const eventConnection = "github_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const eventSecret = "fixture-only-webhook-secret-not-a-real-credential";
export async function eventFixture(t, options = {}) {
  const root = options.root || await temporaryDirectory(t), records = options.records || new MemoryRecords();
  await records.put("company", "acme", { id: "acme", name: "Acme", revision: 1 });
  await records.put("agent-account", eventAccount, { id: eventAccount, ownerId: eventOwner, provider: "codex", status: "connected", auth: { synthetic: true }, accountIdentity: "fixture-native", subject: "fixture-subject" });
  await records.put("github_connection", eventConnection, { id: eventConnection, companyId: "acme", accountId: 55, revision: 1, token: "fixture-only-no-network" });
  const store = new ChatStore(root, records); await store.initialize();
  const chat = await store.create({ ownerId: eventOwner, agent: "codex", agentAccountId: eventAccount, title: "GitHub events fixture",
    repositories: [{ id: 101, fullName: "acme/project", companyId: "acme", githubConnectionId: eventConnection, branch: "fixture" }] });
  await mkdir(chat.workspace, { recursive: true });
  await store.update(chat.id, { workspaceReady: true, pullRequests: [{ repository: "acme/project", number: 7, verifiedAt: new Date().toISOString() }] });
  const canonical = { checks: "pending", headSha: "a".repeat(40), run: 1, state: "open", autoMerge: false, repositoryId: 101 }, requests = [], notifications = [];
  const github = {
    async requireConnection({ connectionId, ownerId, chatCompany }) {
      assert.equal(ownerId, eventOwner); assert.equal(chatCompany, "acme"); assert.equal(connectionId, eventConnection);
      const value = await records.get("github_connection", eventConnection);
      if (!value?.token) throw Error("Connection revoked"); return value;
    },
    async request(route, requestOptions) {
      requests.push({ route, options: requestOptions }); assert(!requestOptions.method || requestOptions.method === "GET", "fixture never writes GitHub");
      await github.requireConnection(requestOptions);
      if (options.beforeRequest) await options.beforeRequest(route);
      if (/\/pulls\/7$/.test(route)) return { number: 7, state: canonical.state, title: "Untrusted title ignored by event prompt", head: { sha: canonical.headSha },
        base: { repo: { id: canonical.repositoryId, full_name: "acme/project" } }, auto_merge: canonical.autoMerge ? {} : null, mergeable: true };
      if (route.includes("/check-runs?")) return { check_runs: canonical.checks === "none" ? [] : [{ id: canonical.run, name: "fixture", status: canonical.checks === "pending" ? "in_progress" : "completed", conclusion: canonical.checks === "passing" ? "success" : canonical.checks === "failing" ? "failure" : null, completed_at: `2026-09-19T12:00:${String(canonical.run).padStart(2, "0")}Z` }] };
      if (route.endsWith("/status")) return { state: "pending", total_count: 0, statuses: [] };
      throw Error(`Unexpected fixture route ${route}`);
    },
  };
  const monitor = new PullRequestMonitor({ store, github, publish: () => {} });
  const events = new GitHubEvents({ records, store, github, monitor, secret: eventSecret, isLegacy: () => true, notify: async (id, event) => notifications.push({ id, event }) });
  await events.initialize();
  monitor.onObserved = (id, prs) => events.observe(id, prs);
  t.after(async () => { await monitor.stop(); await events.stop(); });
  const configure = async (patch = {}) => events.configure(chat.id, { repository: "acme/project", number: 7, notifyFailures: true, wakePassing: true, revision: (await events.state(chat.id))?.revision || 0, ...patch }, { ownerId: eventOwner });
  const update = async (checks, patch = {}) => { Object.assign(canonical, { checks, run: canonical.run + 1 }, patch); await monitor.refresh(chat.id, { force: true }); };
  return { root, records, store, chat: store.get(chat.id), github, monitor, events, canonical, requests, notifications, configure, update };
}
