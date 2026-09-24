import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { STATUS_ITEMS, DEFAULT_STATUS_ITEMS, validateStatusItems, visibleStatusItems, statusItemValue } from "../public/status-line.js";
import { ChatControls, branchesWithoutPullRequests } from "../public/chat-controls.js";
import { StatusLinePreferences } from "../src/status-line.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { webCommands } from "../public/web-commands.js";
import { codexUsage, cliVersionFromUserAgent, safeSessionDetails } from "../src/session-info.mjs";
import { inspectBranches, inspectWorkspaceStatus } from "../src/pull-requests.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { prepareWorkspace } from "../src/workspace.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("status-line preferences accept ordered unique allowlisted fields and hiding, never a model command", () => {
  assert.equal(STATUS_ITEMS.length, 15); assert.deepEqual(validateStatusItems(null), []);
  assert.deepEqual(validateStatusItems(["session-id", "model-name"]), ["session-id", "model-name"]);
  for (const input of [{}, "model-name", ["model-name", "model-name"], ["__proto__"], ["$(cat secret)"], Array(16).fill("model-name")]) assert.throws(() => validateStatusItems(input));
  for (const agent of ["codex", "claude", "mock"]) {
    assert(webCommands(agent).some(command => command.name === "statusline"));
    assert.throws(() => messageCommand(agent, "/statusline"), /web composer/); assert.throws(() => messageCommand(agent, "/statusline arbitrary"), /web composer/);
  }
});

test("the redundant default footer is hidden without deleting explicitly saved custom selections", () => {
  const legacy = ["model-with-reasoning", "context-remaining", "git-branch"], copy = [...legacy];
  assert.deepEqual(DEFAULT_STATUS_ITEMS, []);
  assert.deepEqual(visibleStatusItems(legacy, 0), []);
  assert.deepEqual(visibleStatusItems(legacy, 1), legacy, "An explicit save of the same fields remains opt-in");
  assert.deepEqual(visibleStatusItems(["session-id", "git-branch"], 0), ["session-id", "git-branch"]);
  assert.deepEqual(legacy, copy, "No migration or mutation of saved preferences");
});

test("the PR strip uses observed branches only and does not duplicate an existing PR branch", () => {
  const chat = { repositories: [{ fullName: "Acme/api", branch: "selected-not-observed" }, { fullName: "Other/lib", branch: "main" }] };
  assert.deepEqual(branchesWithoutPullRequests(chat), []);
  chat.workspaceStatus = { branch: "main" };
  chat.gitBranches = [{ repository: "Acme/api", branch: "old-snapshot" }, { repository: "Other/lib", branch: "feat/secondary" }, { repository: "Not/selected", branch: "ignored" }];
  assert.deepEqual(branchesWithoutPullRequests(chat), [{ repository: "Acme/api", branch: "main" }, { repository: "Other/lib", branch: "feat/secondary" }]);
  chat.pullRequests = [{ repository: "acme/API", headRef: "main", merged: true }, { repository: "Other/lib", headRef: "feat/other" }];
  assert.deepEqual(branchesWithoutPullRequests(chat), [{ repository: "Other/lib", branch: "feat/secondary" }]);
  assert.deepEqual(branchesWithoutPullRequests({ workspaceStatus: { branch: "detached · abc123" } }), [{ repository: null, branch: "detached · abc123" }]);
  assert.deepEqual(branchesWithoutPullRequests({ workspaceStatus: { branch: null } }), []);
});

test("a workspace-only branch snapshot refreshes the existing PR strip", t => {
  const previous = globalThis.document, nodes = new Map();
  globalThis.document = { querySelectorAll: () => [], querySelector: selector => {
    if (!nodes.has(selector)) nodes.set(selector, { style: { setProperty() {} }, replaceChildren() {} });
    return nodes.get(selector);
  } };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const chat = { id: "branch-fixture", agent: "claude", repositories: [], workspaceStatus: { branch: "main" } }, seen = [];
  const controls = Object.assign(Object.create(ChatControls.prototype), { chatId: chat.id, renderAttachments() {}, repositories() {}, pullRequests: value => seen.push(value.workspaceStatus.branch) });
  controls.render(chat); controls.render(chat);
  chat.workspaceStatus = { branch: "feat/current" }; controls.render(chat);
  chat.workspaceStatus = { branch: null }; controls.render(chat);
  assert.deepEqual(seen, ["main", "feat/current", null]);
});

test("footer values distinguish current context from totals, avoid double-counting cache/reasoning, and never invent missing usage", () => {
  const chat = { agent: "codex", model: "fixture-model", effort: "high", agentSessionId: "native-session",
    usage: codexUsage({ last: { totalTokens: 200, inputTokens: 150 }, modelContextWindow: 1000, total: { inputTokens: 1800, cachedInputTokens: 800, outputTokens: 200, reasoningOutputTokens: 100, totalTokens: 2000 } }),
    rateLimits: [{ id: "codex", name: "All models", windows: [{ minutes: 300, usedPercent: 0, resetsAt: 200 }, { minutes: 10080, usedPercent: 42, resetsAt: 50 }] }],
    sessionDetails: safeSessionDetails("codex", { cwd: "/remote/work", model: "native-default", cliVersion: "0.154.0" }),
    workspaceStatus: { branch: "main", projectRoot: "/remote/work/project" } };
  const value = id => statusItemValue(id, chat, 100000).value;
  assert.equal(value("context-remaining"), "80% left"); assert.equal(value("context-used"), "200 (20%)");
  assert.equal(value("total-tokens"), "2K"); assert.equal(value("total-input-tokens"), "1.8K"); assert.equal(value("total-output-tokens"), "200");
  assert.equal(value("model-with-reasoning"), "fixture-model · high"); assert.equal(value("git-branch"), "main");
  assert.equal(value("session-id"), "native-session"); assert.equal(value("current-dir"), "/remote/work"); assert.equal(value("project-root"), "/remote/work/project"); assert.equal(value("codex-version"), "0.154.0");
  assert.equal(value("five-hour-limit"), "All models: 0% used"); assert.match(value("weekly-limit"), /awaiting refresh/);
  chat.usage.contextTokens = 2000; assert.equal(value("context-remaining"), "0% left");
  chat.usage.partial = true; assert.match(statusItemValue("total-tokens", chat).title, /partial/);
  for (const id of ["total-tokens", "context-remaining", "five-hour-limit", "codex-version", "current-dir"]) assert.equal(statusItemValue(id).value, "Not reported");
  chat.agent = "claude"; assert.equal(value("codex-version"), "Not reported", "Do not use previous provider metadata");
  assert.equal(statusItemValue("total-tokens", { usage: { totals: { inputTokens: 0, cacheReadTokens: 200, cacheWriteTokens: 300, outputTokens: 500 } } }).value, "1K");
  assert.equal(statusItemValue("context-used", { usage: { contextTokens: 0 } }).value, "0");
});

test("status-line records persist across service reload, isolate accounts and serialize revision-guarded saves", async () => {
  const records = new MemoryRecords(), preferences = new StatusLinePreferences(records), current = await preferences.get("first");
  assert.deepEqual(current.items, DEFAULT_STATUS_ITEMS);
  const input = { ...current, items: ["session-id", "context-used"] }, results = await Promise.allSettled([preferences.save("first", input), preferences.save("first", input)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(results.find(result => result.status === "rejected").reason.statusCode, 409);
  assert.deepEqual((await new StatusLinePreferences(records).get("first")).items, input.items);
  assert.deepEqual((await preferences.get("second")).items, DEFAULT_STATUS_ITEMS);
  await assert.rejects(preferences.save("second", input), /account changed/);
  await assert.rejects(preferences.save("first", { ...input, revision: 1 }, async () => { throw new Error("Session revoked"); }), /revoked/);
  assert.equal((await preferences.get("first")).revision, 1);
  assert.deepEqual((await preferences.save("first", { ...input, revision: 1, items: null })).items, []);
  assert.equal(await records.get("keymap", "first"), null);
});

test("status-line HTTP preferences require auth and same origin, reject revoked/wrong accounts and never wake a worker", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const app = await createAgentWebServer({ records, config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "statusline-fixture" }), adapterFactory: () => { throw new Error("Status-line settings must not wake a worker"); } });
  const { url } = await app.start(); t.after(() => app.stop());
  const call = (route, { cookie, body, method, origin } = {}) => fetch(`${url}${route}`, { method: method || (body ? "POST" : "GET"), headers: { authorization: "Bearer statusline-fixture", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(`${url}/api/statusline`)).status, 401);
  const shared = await (await call("/api/statusline")).json(); assert.equal(shared.scope, "shared");
  assert.equal((await call("/api/statusline", { method: "PATCH", origin: "https://other.invalid", body: { ...shared, items: [] } })).status, 403);
  const register = async username => { const response = await call("/api/browser-account/register", { body: { username, password: "private-statusline-fixture-password" } }); assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0]; };
  const first = await register("first-status-user"), second = await register("second-status-user");
  const initial = await (await call("/api/statusline", { cookie: first })).json(), update = { ...initial, items: ["git-branch", "model-name"] };
  assert.equal((await call("/api/statusline", { cookie: first, method: "PATCH", body: update })).status, 200);
  assert.equal((await call("/api/statusline", { cookie: second, method: "PATCH", body: update })).status, 409);
  assert.equal((await call("/api/statusline", { cookie: first, method: "PATCH", body: { ...update, revision: 1, items: ["secret"] } })).status, 400);
  assert.deepEqual((await (await call("/api/statusline", { cookie: second })).json()).items, DEFAULT_STATUS_ITEMS);
  assert.deepEqual((await (await call("/api/statusline")).json()).items, DEFAULT_STATUS_ITEMS);
  assert.deepEqual((await new StatusLinePreferences(records).get(initial.scope)).items, update.items);
  await call("/api/browser-account", { cookie: first, method: "DELETE" });
  assert.equal((await call("/api/statusline", { cookie: first, method: "PATCH", body: { ...update, revision: 1 } })).status, 409);
  assert.equal(app.store.list().length, 0);
});

test("worker Git snapshots include default and detached branches without expanding PR discovery or using the controller mirror", async t => {
  const root = await temporaryDirectory(t), workspace = path.join(root, "worker"), controller = path.join(root, "nonexistent-controller");
  await prepareWorkspace({ destination: workspace });
  const git = args => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  const chat = { workspace: controller, repositories: [{ fullName: "Fixture/repo", defaultBranch: "main" }] }, executor = { workspace };
  assert.deepEqual(await inspectBranches(chat, executor), []);
  assert.deepEqual({ ...(await inspectWorkspaceStatus(chat, executor)), recordedAt: null }, { branch: "main", projectRoot: workspace, recordedAt: null });
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "isolated fixture"]);
  git(["checkout", "--quiet", "--detach"]); assert.match((await inspectWorkspaceStatus(chat, executor)).branch, /^detached · [a-f0-9]+$/);
  assert.equal((await inspectWorkspaceStatus({ ...chat, repositories: [{ directory: ".." }] }, executor)).projectRoot, null);
});

test("native session metadata is a bounded allowlist and Codex/Claude adapter init actually publishes it", async t => {
  assert.equal(cliVersionFromUserAgent("relay/0.154.0 (private host)"), "0.154.0"); assert.equal(cliVersionFromUserAgent("unknown"), null);
  assert.equal(safeSessionDetails("codex", { cliVersion: "secret", cwd: "bad\npath", token: "never expose", model: "x".repeat(200) }).model.length, 150);
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), CLAUDE_BIN: path.resolve("test/fixtures/fake-claude.mjs") });
  for (const [agent, Adapter, version, model] of [["codex", CodexAdapter, "0.154.0-fixture", "fixture-gpt"], ["claude", ClaudeAdapter, "2.1.0-fixture", "fixture-claude"]]) {
    const chat = await store.create({ title: "Metadata fixture", agent, source: "" }); await prepareWorkspace({ destination: chat.workspace }); const events = [];
    const adapter = new Adapter({ chat, store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://127.0.0.1:9", hooks: { onEvent: event => events.push(event) } });
    try {
      await adapter.start(); if (agent === "claude") await adapter.send("fixture metadata");
      const details = events.find(event => event.type === "session_details")?.details;
      assert.equal(details.cliVersion, version); assert.equal(details.model, model); assert.equal(details.cwd, chat.workspace);
      assert.deepEqual(Object.keys(details).sort(), ["agent", "cliVersion", "cwd", "model", "recordedAt"]); assert(!JSON.stringify(details).includes("private-host"));
    } finally { await adapter.stop(); }
  }
});

test("footer snapshots survive worker stop and controller reload without fetching a worker or becoming conversation text", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize();
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "10000" }), broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: ({ chat, hooks }) => ({
    start: async () => hooks.onEvent({ type: "session_details", details: safeSessionDetails("mock", { cwd: chat.workspace, model: "fixture-model", cliVersion: "1.2.3-fixture" }) }),
    send: async () => ({ text: "Fixture final answer" }), stop: async () => {},
  }) });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "mock" }); await manager.send(chat.id, "Fixture message"); await manager.stop(chat.id);
  const restarted = new ChatStore(path.join(root, "fresh-controller"), records); await restarted.initialize(); const saved = restarted.get(chat.id);
  assert.equal(saved.sessionDetails.cliVersion, "1.2.3-fixture"); assert.equal(saved.workspaceStatus.projectRoot, chat.workspace); assert(saved.workspaceStatus.branch);
  assert.equal(saved.messages.filter(message => message.role === "user").length, 1); assert(!saved.messages.some(message => message.text.includes("session_details")));
});
