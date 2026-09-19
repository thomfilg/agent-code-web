import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, symlink, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Attachments } from "../src/attachments.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { ChatStore } from "../src/store.mjs";
import { PullRequestMonitor, checkSummary } from "../src/pull-requests.mjs";
import { Environments } from "../src/environments.mjs";
import { snapshotChanges, diffFiles } from "../src/workspace-changes.mjs";
import { codexUsage, claudeUsage, safeRateLimits } from "../src/session-info.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("uploads stay chat-scoped, bounded, and cannot overwrite or follow upload-directory symlinks", async t => {
  const root = await temporaryDirectory(t); const records = new MemoryRecords(); const store = new ChatStore(root, records); await store.initialize();
  const chat = await store.create({ agent: "mock", title: "files" }); const other = await store.create({ agent: "mock", title: "other" });
  const attachments = new Attachments(records, store);
  const file = await attachments.upload(chat.id, { name: "../hello.txt", data: Buffer.from("hello").toString("base64") });
  assert.equal(file.name, "hello.txt"); assert.equal(file.data, undefined);
  await assert.rejects(attachments.resolve(other.id, [file.id]), /not found/);
  await assert.rejects(attachments.resolve(chat.id, [file.id, file.id]), /different/);
  await assert.rejects(attachments.upload(chat.id, { name: "bad", data: "**invalid**" }), /encoding/);
  const files = await attachments.resolve(chat.id, [file.id]);
  const copied = await attachments.materialize(chat, null, files);
  assert.equal(await readFile(copied[0].path, "utf8"), "hello");
  const again = await attachments.materialize(chat, null, files); assert.notEqual(again[0].path, copied[0].path);
  await mkdir(path.join(root, "elsewhere")); await symlink(path.join(root, "elsewhere"), path.join(store.runtimeHome(other.id), "uploads"));
  await assert.rejects(attachments.materialize(other, null, files), /Unsafe/);
  await attachments.removeChat(chat.id); await assert.rejects(attachments.resolve(chat.id, [file.id]), /not found/);
});

test("attachment previews require authentication and the attachment's owning chat", async t => {
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "preview-test" }) });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "mock" }), other = await app.manager.createChat({ agent: "mock" });
  const headers = { Authorization: "Bearer preview-test", "content-type": "application/json" };
  const upload = await fetch(`${url}/api/chats/${chat.id}/attachments`, { method: "POST", headers, body: JSON.stringify({ name: "notes.txt", mime: "text/plain", data: Buffer.from("Private fixture notes").toString("base64") }) });
  const { attachment } = await upload.json(), endpoint = `${url}/api/chats/${chat.id}/attachments/${attachment.id}`;
  assert.equal((await fetch(endpoint)).status, 401);
  const response = await fetch(endpoint, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(Buffer.from((await response.json()).attachment.data, "base64").toString(), "Private fixture notes");
  assert.notEqual((await fetch(`${url}/api/chats/${other.id}/attachments/${attachment.id}`, { headers })).status, 200);
});
test("CI overview distinguishes passing, failed, pending, skipped and legacy status contexts", () => {
  assert.deepEqual(checkSummary([
    { status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" },
    { status: "completed", conclusion: "failure" }, { status: "in_progress" },
  ], { statuses: [{ state: "success" }, { state: "pending" }, { state: "error" }] }), { passed: 2, skipped: 1, inProgress: 2, failed: 2, total: 7 });
});
test("PR auto-merge uses only explicit GitHub auto-merge mutations and rejects foreign PRs", async t => {
  const root = await temporaryDirectory(t); const store = new ChatStore(root, new MemoryRecords()); await store.initialize();
  const chat = await store.create({ agent: "mock", title: "PR", repositories: [{ fullName: "Org/repo" }] });
  await store.update(chat.id, { pullRequests: [{ repository: "Org/repo", number: 8, state: "open", verifiedAt: new Date().toISOString() }] });
  let enabled = false, allow = true, failure = false;
  const writes = [];
  const github = { request: async (route, options = {}) => {
    if (options.method === "POST") {
      writes.push({ route, ...options });
      if (failure) return { errors: [{ message: "denied" }] };
      enabled = options.body.query.includes("enablePullRequestAutoMerge");
      return { data: { [enabled ? "enablePullRequestAutoMerge" : "disablePullRequestAutoMerge"]: { pullRequest: { number: 8 } } } };
    }
    if (route === "/repos/Org/repo") return { allow_auto_merge: allow, allow_squash_merge: true };
    if (route.endsWith("/pulls/8")) return { number: 8, node_id: "PR_fixture", state: "open", auto_merge: enabled ? {} : null, mergeable: false,
      mergeable_state: "dirty", head: { sha: "a".repeat(40) }, base: { repo: { full_name: "Org/repo" } } };
    if (route.includes("check-runs")) return { check_runs: [] };
    if (route.endsWith("/status")) return { state: "pending", total_count: 0, statuses: [] };
    if (route.includes("/files?")) return [{ filename: "file.txt", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+test" }];
    throw new Error(`Unexpected route ${route}`);
  } };
  const monitor = new PullRequestMonitor({ store, github, publish: () => {} }); t.after(() => monitor.stop());
  await assert.rejects(monitor.autoMerge(chat.id, "Other/repo", 8, true), /verified/);
  await assert.rejects(monitor.autoMerge(chat.id, "Org/repo", 8, "yes"), /explicitly/);
  await monitor.autoMerge(chat.id, "Org/repo", 8, true);
  assert.equal(writes[0].route, "/graphql"); assert.deepEqual(writes[0].body.variables.input, { pullRequestId: "PR_fixture", mergeMethod: "SQUASH", expectedHeadOid: "a".repeat(40) });
  assert.equal(store.get(chat.id).pullRequests[0].autoMerge, true); assert.equal(store.get(chat.id).pullRequests[0].conflicts, true); assert.equal(store.get(chat.id).workflowState, "pr_failing");
  await monitor.autoMerge(chat.id, "Org/repo", 8, false); assert.equal(store.get(chat.id).pullRequests[0].autoMerge, false);
  assert.match(writes[1].body.query, /disablePullRequestAutoMerge/);
  assert.equal((await monitor.files(chat.id, "Org/repo", 8)).files[0].filename, "file.txt");
  allow = false; await assert.rejects(monitor.autoMerge(chat.id, "Org/repo", 8, true), /repository's GitHub settings/);
  allow = true; failure = true; await assert.rejects(monitor.autoMerge(chat.id, "Org/repo", 8, true), /GitHub could not/);
  assert.equal(writes.length, 3); assert.ok(writes.every(write => write.route === "/graphql"));
});
test("setup scripts persist but protected variables remain unavailable, and network restrictions are not fabricated", async () => {
  const environments = new Environments(new MemoryRecords());
  await environments.companies.save({ id: "fixture", name: "Fixture" });
  const env = await environments.save({ name: "Scripted", backend: "local", companies: ["fixture"], setupScript: "npm --version", variables: [{ key: "SECRET", value: "hidden" }, { key: "VISIBLE", value: "ok", secret: false }] });
  const runtime = await environments.runtime(env.id, { repositories: [{ fullName: "fixture/project" }] });
  assert.equal(runtime.setupScript, "npm --version"); assert.deepEqual(runtime.variables, { VISIBLE: "ok" });
  await assert.rejects(environments.save({ ...env, networkAccess: "restricted" }, env.id), /cannot enforce/);
  await assert.rejects(environments.save({ ...env, setupScript: "a\0b" }, env.id), /Setup script/);
});
test("usage is provider-reported and never invents account limits or Claude context usage", () => {
  const codex = codexUsage({ last: { inputTokens: 40, outputTokens: 10, totalTokens: 50 }, modelContextWindow: 100 });
  assert.equal(codex.contextTokens, 50); assert.equal(codex.contextWindow, 100);
  const claude = claudeUsage({ usage: { input_tokens: 3, output_tokens: 9 }, modelUsage: { opus: { contextWindow: 1000000 } }, total_cost_usd: .001 });
  assert.equal(claude.contextTokens, null); assert.equal(claude.costUsd, .001);
  const limits = safeRateLimits({ rateLimits: { primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1000 }, token: "must-not-appear" } });
  assert.equal(JSON.stringify(limits).includes("must-not-appear"), false); assert.equal(limits[0].windows[0].usedPercent, 23);
});
test("environment setup runs before each worker start with only agent-readable variables", async t => {
  const root = await temporaryDirectory(t);
  const app = await createAgentWebServer({ config: testConfig(root), models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: () => ({ start: async () => {}, send: async () => ({ text: "ready" }), stop: async () => {} }) });
  await app.start(); t.after(() => app.stop());
  await (await app.resources.forOwner(null)).companies.save({ id: "fixture", name: "Fixture" });
  const environment = await app.manager.environments.save({ name: "Setup isolation", backend: "local", companies: ["fixture"], variables: [{ key: "SECRET", value: "private" }, { key: "VISIBLE", value: "ok", secret: false }],
    setupScript: 'test -z "${SECRET+x}" && test "$VISIBLE" = "ok" && printf "ready\\n" >> setup-check.txt' });
  const chat = await app.manager.createChat({ agent: "codex", title: "Setup fixture" });
  // A prepared synthetic workspace supplies company identity without a clone.
  await mkdir(chat.workspace, { recursive: true });
  await app.store.update(chat.id, { environmentId: environment.id, source: "https://github.com/fixture/project.git", workspaceReady: true });
  await app.manager.send(chat.id, "first");
  assert.equal(await readFile(path.join(chat.workspace, "setup-check.txt"), "utf8"), "ready\n");
  await app.manager.stop(chat.id); await app.manager.send(chat.id, "second");
  assert.equal(await readFile(path.join(chat.workspace, "setup-check.txt"), "utf8"), "ready\nready\n");
});
test("adding a repository preserves primary grouping and existing files without waking a worker", async t => {
  const root = await temporaryDirectory(t); let acquired = 0;
  const app = await createAgentWebServer({ config: testConfig(root), github: { resolveSelections: async values => values.map(value => ({ ...value, directory: value.fullName.replace('/', '--') })) },
    workerBackend: { acquire: async () => { acquired++; }, sleep: async () => {} } });
  await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "mock", repositories: [{ fullName: "Org/primary" }] });
  await mkdir(chat.workspace, { recursive: true });
  await writeFile(path.join(chat.workspace, "keep.txt"), "local changes");
  const updated = await app.manager.addRepository(chat.id, { fullName: "Other/secondary" });
  assert.deepEqual(updated.repositories.map(repo => repo.fullName), ["Org/primary", "Other/secondary"]);
  assert.equal(updated.workspaceReady, false); assert.equal(acquired, 0);
  assert.equal(await readFile(path.join(chat.workspace, "keep.txt"), "utf8"), "local changes");
  await assert.rejects(app.manager.addRepository(chat.id, { fullName: "Org/primary" }), /already/);
});
test("local diff snapshots include new files without mutating the Git index", async t => {
  const root = await temporaryDirectory(t); const exec = promisify(execFile);
  await exec("git", ["init", "--quiet", root]);
  await writeFile(path.join(root, "added.txt"), "new line\n");
  const before = (await exec("git", ["-C", root, "status", "--porcelain"])).stdout;
  const snapshot = await snapshotChanges({ workspace: root }, null);
  assert.match(snapshot.files[0].filename, /added.txt/); assert.match(snapshot.files[0].patch, /\+new line/);
  assert.equal((await exec("git", ["-C", root, "status", "--porcelain"])).stdout, before);
  assert.equal(diffFiles("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new")[0].additions, 1);
});
test("agent/mode/upload/auto-merge control routes require authentication and origin validation", async t => {
  const root = await temporaryDirectory(t); const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "owner" }) });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "mock" });
  for (const [tail, method] of [["agent", "PATCH"], ["mode", "PATCH"], ["attachments", "POST"], ["pull-requests/auto-merge", "PATCH"], ["commands/inspect", "POST"]]) {
    assert.equal((await fetch(`${url}/api/chats/${chat.id}/${tail}`, { method, body: "{}" })).status, 401);
  }
  const login = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ token: "owner" }) }); const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/agent`, { method: "PATCH", headers: { cookie, origin: "https://evil.test" }, body: '{"agent":"claude"}' })).status, 403);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/commands/inspect?command=ps`)).status, 401);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/commands/inspect`, { method: "POST", headers: { cookie, origin: "https://evil.test" }, body: '{"confirm":true,"terminate":"all"}' })).status, 403);
  const unconfirmed = await fetch(`${url}/api/chats/${chat.id}/commands/inspect`, { method: "POST", headers: { cookie }, body: '{"terminate":"all"}' });
  assert.equal(unconfirmed.status, 400); assert.match((await unconfirmed.json()).error, /Confirm/);
  const mode = await fetch(`${url}/api/chats/${chat.id}/mode`, { method: "PATCH", headers: { cookie }, body: '{"mode":"plan"}' });
  assert.equal(mode.status, 200); assert.equal((await mode.json()).chat.mode, "plan");
});
