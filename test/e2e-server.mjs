import { mkdtemp, rm } from "node:fs/promises";
import { createAgentWebServer } from "../src/server.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { testConfig } from "./helpers.mjs";
import { ModelCatalog } from "../src/models.mjs";
const root = await mkdtemp("/tmp/relay-browser-");
const config = testConfig(root, { AGENT_WEB_PORT: "8879" });
const records = new MemoryRecords();
const repos = ["Acme/api", "Acme/web", "Other/library"].map((full_name, index) => ({ id: index + 1, full_name, name: full_name.split("/")[1], default_branch: "main", private: true, size: 1 }));
const pull = { number: 42, node_id: "PR_browser", title: "Fixture changes", state: "open", head: { sha: "a".repeat(40), ref: "feature/controls", repo: { full_name: "Acme/api" } }, base: { ref: "main", repo: { full_name: "Acme/api" } }, additions: 12, deletions: 3, changed_files: 1, mergeable: false, mergeable_state: "dirty", auto_merge: null };
const github = new GitHubConnection({ records, config: config.github, localToken: async () => "test-github-credential",
  fetchImpl: async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/user") return Response.json({ login: "browser-fixture", id: 1 });
    if (path === "/user/repos") return Response.json(repos);
    if (path === "/graphql") { const enabling = JSON.parse(options.body).query.includes("enablePullRequestAutoMerge"); pull.auto_merge = enabling ? {} : null; return Response.json({ data: { [enabling ? "enablePullRequestAutoMerge" : "disablePullRequestAutoMerge"]: { pullRequest: { number: 42 } } } }); }
    if (path.endsWith("/pulls/42")) return Response.json(pull);
    if (path.endsWith("/pulls/42/files")) return Response.json([{ filename: "src/example.ts", additions: 12, deletions: 3, status: "modified", patch: "@@ -1,2 +1,2 @@\n-old value\n+new value\n unchanged" }]);
    if (path.endsWith("/check-runs")) return Response.json({ check_runs: [{ id: 1, status: "in_progress" }, { id: 2, status: "completed", conclusion: "success" }, { id: 3, status: "completed", conclusion: "success" }, { id: 4, status: "completed", conclusion: "skipped" }] });
    if (path.endsWith("/status")) return Response.json({ state: "pending", total_count: 0, statuses: [] });
    if (path.endsWith("/branches")) return Response.json([{ name: "main" }, { name: "develop" }]);
    if (path.includes("/branches/")) return Response.json({ name: "main" });
    const repo = repos.find(repo => path === `/repos/${repo.full_name}`);
    return repo ? Response.json({ ...repo, allow_auto_merge: true, allow_squash_merge: true }) : Response.json({ message: "Not found" }, { status: 404 });
  },
});
const models = new ModelCatalog(config);
models.codex = async () => ({ models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: ["low", "medium", "high"], defaultEffort: "low" }, { id: "fixture-gpt", label: "Fixture GPT", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" }], source: "fixture" });
models.claude = async () => ({ models: [{ id: "opus", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] }, { id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" }, { id: "haiku", label: "Haiku", efforts: [] }], source: "fixture" });
const app = await createAgentWebServer({ config, records, github, models }); await app.start();
for (const title of ["Existing alpha", "Existing beta"]) await app.manager.createChat({ agent: "mock", title });
const prChat = await app.store.create({ agent: "mock", title: "PR controls fixture", repositories: [{ fullName: "Acme/api", defaultBranch: "main", branch: "feature/controls" }] });
await app.store.update(prChat.id, { workflowState: "pr_failing", pullRequests: [{ repository: "Acme/api", number: 42, url: "https://github.com/Acme/api/pull/42", state: "open", headRef: "feature/controls", baseRef: "main", additions: 12, deletions: 3, conflicts: true, checks: "pending", ci: { passed: 2, skipped: 1, inProgress: 1, failed: 0, total: 4 }, autoMerge: false, verifiedAt: new Date().toISOString() }] });
const close = async () => { await app.stop(); await rm(root, { recursive: true, force: true }); process.exit(); };
process.on("SIGTERM", close); process.on("SIGINT", close);
console.log("Browser fixture ready");
