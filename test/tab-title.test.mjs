import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { TITLE_ITEMS, DEFAULT_TITLE_ITEMS, validateTitleItems, titleItemValue, titleBusy, formatTabTitle } from "../public/tab-title.js";
import { TabTitlePreferences, planProgress } from "../src/tab-title.mjs";
import { StatusLinePreferences } from "../src/status-line.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { webCommands } from "../public/web-commands.js";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { prepareWorkspace } from "../src/workspace.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("title commands configure eight allowlisted fields, not chat renaming or model input", () => {
  assert.equal(TITLE_ITEMS.length, 8); assert.deepEqual(validateTitleItems(null), []);
  assert.deepEqual(validateTitleItems(["thread", "status"]), ["thread", "status"]);
  for (const items of [undefined, {}, "thread", ["thread", "thread"], ["__proto__"], ["$(secret)"], ["context-used"], Array(9).fill("status")]) assert.throws(() => validateTitleItems(items));
  for (const agent of ["codex", "claude", "mock"]) {
    assert(webCommands(agent).some(item => item.name === "title" && /does not rename/.test(item.description)));
    assert.throws(() => messageCommand(agent, "/title"), /web composer/); assert.throws(() => messageCommand(agent, "/title a name"), /rename/);
  }
});

test("tab title values track selected chat metadata, permission states and actual plan counts without guessing progress", () => {
  const chat = { agent: "codex", agentSessionId: "native", title: "My task", status: "running", repositories: [{ fullName: "Company/project" }],
    sessionDetails: { agent: "codex", model: "reported-model", cwd: "/remote/work" }, workspaceStatus: { branch: "main", projectRoot: "/remote/project" },
    taskProgress: planProgress([{ status: "completed" }, { status: "pending" }], "native", "turn") };
  assert.equal(formatTabTitle(["project", "status", "thread", "model", "git-branch", "task-progress", "app-name"], chat), "Company/project · Working · My task · reported-model · main · 1/2 steps · Agent Relay");
  assert(titleBusy(chat)); assert.notEqual(formatTabTitle(["spinner"], chat, 0), formatTabTitle(["spinner"], chat, 1));
  assert.equal(formatTabTitle(["spinner"], chat, null), "◌");
  chat.pendingRequest = { method: "item/tool/requestUserInput" }; assert.equal(titleItemValue("status", chat), "Needs answer"); assert(!titleBusy(chat));
  chat.pendingRequest.method = "item/commandExecution/requestApproval"; assert.equal(titleItemValue("status", chat), "Approval needed");
  chat.pendingRequest = null; chat.awaitingUser = true; assert.equal(titleItemValue("status", chat), "Needs reply");
  chat.awaitingUser = false;
  for (const [status, expected] of [["idle", "Ready"], ["stopped", "Stopped"], ["error", "Error"], ["stopping", "Stopping"]]) { chat.status = status; assert.equal(titleItemValue("status", chat), expected); assert(!titleBusy(chat)); }
  chat.archived = true; assert.equal(titleItemValue("status", chat), "Archived");
  chat.taskProgress.completed = 0; assert.equal(titleItemValue("task-progress", chat), "0/2 steps");
  chat.taskProgress = planProgress([], "native", "turn"); assert.equal(titleItemValue("task-progress", chat), "0/0 steps");
  for (const status of ["active", "paused", "complete", "blocked"]) { chat.goal = { threadId: "native", status, objective: "private objective" }; assert.equal(titleItemValue("task-progress", chat), `Goal ${status}`); }
  chat.agentSessionId = "new-session"; assert.equal(titleItemValue("task-progress", chat), "Progress not reported");
  chat.agent = "claude"; assert.equal(titleItemValue("model", chat), "Account default");
  chat.model = "selected-model"; assert.equal(titleItemValue("model", chat), "selected-model");
  assert.equal(titleItemValue("git-branch"), "Not reported"); assert.equal(formatTabTitle([], chat), "Agent Relay"); assert.equal(formatTabTitle(DEFAULT_TITLE_ITEMS, null), "Agent Relay");
  assert.equal(titleItemValue("project", { sessionDetails: { agent: "codex", cwd: "/remote/name" }, agent: "codex" }), "name");
});

test("title metadata is bounded plain text and plan progress stores neither explanations nor steps", () => {
  const title = formatTabTitle(["thread", "git-branch"], { title: "<img src=x onerror=alert(1)>\n\u202e", workspaceStatus: { branch: "x".repeat(1000) } });
  assert(title.includes("<img")); assert(!/[\n\u202e]/.test(title)); assert(title.length < 150);
  assert.equal(Array.from(titleItemValue("thread", { title: "😀".repeat(100) })).length, 80);
  const plan = planProgress([{ status: "inProgress", step: "private text" }], "session", "turn"); assert(!JSON.stringify(plan).includes("private"));
  assert.deepEqual(Object.keys(plan).sort(), ["agent", "completed", "inProgress", "recordedAt", "sessionId", "total", "turnId"]);
  for (const value of [null, [{ status: "unknown" }], [{}], Array(1001).fill({ status: "pending" })]) assert.equal(planProgress(value, "session", "turn"), null);
  assert.equal(planProgress([], "", "turn"), null);
  assert.equal(titleItemValue("task-progress", { agent: "codex", goal: { status: "active" } }), "Progress not reported");
});

test("tab-title preferences persist, isolate accounts and other preferences, and reject stale concurrent writes", async () => {
  const records = new MemoryRecords(), preferences = new TabTitlePreferences(records), first = await preferences.get("first");
  const footerBefore = await new StatusLinePreferences(records).get("first"); assert.deepEqual(first.items, DEFAULT_TITLE_ITEMS);
  const input = { ...first, items: ["thread", "status"] }, results = await Promise.allSettled([preferences.save("first", input), preferences.save("first", input)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(results.find(result => result.status === "rejected").reason.statusCode, 409);
  assert.deepEqual((await new TabTitlePreferences(records).get("first")).items, input.items); assert.deepEqual((await preferences.get("second")).items, DEFAULT_TITLE_ITEMS);
  await assert.rejects(preferences.save("second", input), /account changed/);
  await assert.rejects(preferences.save("first", { ...input, revision: 1 }, async () => { throw new Error("Revoked"); }), /Revoked/);
  assert.deepEqual((await preferences.save("first", { ...input, revision: 1, items: null })).items, []);
  assert.deepEqual(await new StatusLinePreferences(records).get("first"), footerBefore); assert.equal(await records.get("keymap", "first"), null);
});

test("tab-title HTTP settings enforce authentication, origin and account scope without waking or changing a chat", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const app = await createAgentWebServer({ records, config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "title-fixture" }), adapterFactory: () => { throw new Error("Title settings must not start a worker"); } });
  const { url } = await app.start(); t.after(() => app.stop());
  const call = (route, { cookie, body, method, origin } = {}) => fetch(`${url}${route}`, { method: method || (body ? "POST" : "GET"), headers: { authorization: "Bearer title-fixture", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(`${url}/api/tab-title`)).status, 401);
  const shared = await (await call("/api/tab-title")).json(); assert.equal(shared.scope, "shared");
  assert.equal((await call("/api/tab-title", { method: "PATCH", origin: "https://other.invalid", body: { ...shared, items: [] } })).status, 403);
  const register = async username => { const response = await call("/api/browser-account/register", { body: { username, password: "private-tab-title-fixture-password" } }); assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0]; };
  const first = await register("first-title-user"), second = await register("second-title-user");
  const initial = await (await call("/api/tab-title", { cookie: first })).json(), update = { ...initial, items: ["thread", "status"] };
  assert.equal((await call("/api/tab-title", { cookie: first, method: "PATCH", body: update })).status, 200);
  assert.equal((await call("/api/tab-title", { cookie: second, method: "PATCH", body: update })).status, 409);
  assert.equal((await call("/api/tab-title", { cookie: first, method: "PATCH", body: { ...update, revision: 1, items: ["secret"] } })).status, 400);
  assert.deepEqual((await (await call("/api/tab-title", { cookie: second })).json()).items, DEFAULT_TITLE_ITEMS);
  assert.deepEqual((await (await call("/api/tab-title")).json()).items, DEFAULT_TITLE_ITEMS);
  await call("/api/browser-account", { cookie: first, method: "DELETE" });
  assert.equal((await call("/api/tab-title", { cookie: first, method: "PATCH", body: { ...update, revision: 1 } })).status, 409);
  assert.equal(app.store.list().length, 0);
});

test("Codex plan notifications are aggregate-only, scoped to the active native turn, and reset for the next turn", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ title: "Title protocol fixture", agent: "codex", source: "" }); await prepareWorkspace({ destination: chat.workspace }); const events = [];
  const adapter = new CodexAdapter({ chat, store, config: testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs") }), broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://127.0.0.1:9",
    hooks: { onEvent: event => events.push(event), onRequest: request => setImmediate(() => adapter.respond(request.requestId, { decision: "accept" })) } });
  t.after(() => adapter.stop()); await adapter.start(); await adapter.send("title-progress-fixture");
  const progress = events.filter(event => event.type === "task_progress"); assert.equal(progress.length, 2); assert.equal(progress[0].progress, null);
  assert.equal(progress[1].progress.completed, 1); assert.equal(progress[1].progress.total, 3); assert.equal(progress[1].progress.inProgress, 1);
  assert(!JSON.stringify(progress).includes("private"));
  adapter.rpc.emit("notification", { method: "turn/plan/updated", params: { threadId: adapter.threadId, turnId: progress[1].progress.turnId, plan: [] } });
  assert.equal(events.filter(event => event.type === "task_progress").length, 2, "Finished-turn updates are ignored");
  await adapter.send("next fixture"); assert.equal(events.filter(event => event.type === "task_progress").at(-1).progress, null);
});

test("plan counts survive controller reload, never become messages, and clear on a new turn or agent change", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize(); let turns = 0;
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "10000" }), broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: ({ chat, hooks }) => ({
    start: async () => hooks.onSessionId("native"),
    send: async () => { if (!turns++) await hooks.onEvent({ type: "task_progress", agent: "mock", sessionId: "native", progress: { ...planProgress([{ status: "pending" }], "native", "turn"), agent: "mock" } }); return { text: "Fixture final" }; }, stop: async () => {},
  }) });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "mock" }); await manager.send(chat.id, "Fixture input"); await manager.stop(chat.id);
  const restarted = new ChatStore(path.join(root, "fresh-controller"), records); await restarted.initialize(); assert.equal(restarted.get(chat.id).taskProgress.total, 1);
  assert.equal(store.get(chat.id).messages.filter(message => message.role === "user").length, 1);
  assert(!store.get(chat.id).messages.some(message => /task_progress|pending/.test(message.text)));
  await manager.send(chat.id, "Next fixture input"); assert.equal(store.get(chat.id).taskProgress, null); await manager.stop(chat.id);
  await store.update(chat.id, { taskProgress: planProgress([], "native", "turn") }); await manager.switchAgent(chat.id, "codex"); assert.equal(store.get(chat.id).taskProgress, null);
});
