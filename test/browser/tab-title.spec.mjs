import { openSettingsSection, switchSettingsCompany } from "./settings-navigation.mjs";
import { test, expect } from "@playwright/test";
import { DEFAULT_TITLE_ITEMS, TITLE_ITEMS, formatTabTitle } from "../../public/tab-title.js";

const created = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page, { busy = false, items = DEFAULT_TITLE_ITEMS } = {}) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: `Tab title fixture ${Date.now()}` } })).json(); created.set(page, [chat.id]);
  let saved = { scope: "shared", revision: 0, items: [...items], account: null };
  const calls = { saves: [], actions: [], errors: [] }; page.on("pageerror", error => calls.errors.push(error.message));
  const snapshot = { ...chat, revision: 99999, agent: "codex", status: busy ? "running" : "stopped", model: "fixture-gpt", agentSessionId: "title-native",
    repositories: [{ fullName: "Fixture/project" }], workspaceStatus: { branch: "main" }, taskProgress: { agent: "codex", sessionId: "title-native", total: 4, completed: 1 } };
  await page.addInitScript(() => { const Original = window.EventSource; window.titleFixtureEvents = []; window.EventSource = class extends Original { constructor(url, options) { super(url, options); window.titleFixtureEvents.push(this); } }; });
  await page.route(`**/api/chats/${chat.id}`, route => { if (route.request().method() !== "GET") calls.actions.push("chat mutation"); return route.fulfill({ json: { chat: snapshot } }); });
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route("**/api/tab-title", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: saved });
    const input = route.request().postDataJSON(); calls.saves.push(input);
    if (input.scope !== saved.scope || input.revision !== saved.revision) return route.fulfill({ status: 409, json: { error: "Tab-title settings changed in another tab. Reload before saving." } });
    saved = { ...saved, items: input.items, revision: saved.revision + 1 }; return route.fulfill({ json: saved });
  });
  for (const tail of ["messages", "queue", "wake", "stop", "compact"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { calls.actions.push(tail); return route.fulfill({ json: {} }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, snapshot, calls, get saved() { return saved; }, set saved(value) { saved = value; } };
}
async function open(page, command = false, busy = false) {
  if (command) { await page.locator("#message-input").fill("/title"); await page.getByRole("button", { name: busy ? "Queue" : "Send message", exact: true }).click(); }
  else { await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#tab-title-button").click(); }
  await expect(page.locator("#controls-title")).toHaveText("Browser tab title"); await expect(page.locator("#controls-content [role=status]")).toContainText("Saved tab title loaded");
}
const close = page => page.locator("#controls-dialog").evaluate(dialog => dialog.close());
const preview = page => page.getByLabel("Browser tab title preview", { exact: true });
async function save(page) { await page.getByRole("button", { name: "Save tab title", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("saved and active"); }
async function update(page, fixture, patch) {
  Object.assign(fixture.snapshot, patch); fixture.snapshot.revision++;
  await page.evaluate(chat => { const stream = window.titleFixtureEvents.findLast(event => event.url.includes(`/api/chats/${chat.id}/events`)); if (!stream) throw Error("Missing selected-chat event source"); stream.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat_updated", chat }) })); }, fixture.snapshot);
}

test("tab-title fields toggle, reorder, save and persist without renaming, sending or losing draft/files", async ({ page }) => {
  const f = await setup(page); await expect(page).toHaveTitle("Fixture/project");
  await page.locator("#message-input").fill("Retain this draft"); await page.locator("#attachment-input").setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
  await open(page); await expect(page.locator("#controls-content")).toContainText("shared by this Relay installation");
  await page.getByRole("button", { name: "Use app title only", exact: true }).click();
  for (const label of ["Chat name", "Status", "App name"]) await page.getByLabel(`Show ${label}`, { exact: true }).check();
  await page.getByRole("button", { name: "Move Status up", exact: true }).click();
  await expect(preview(page)).toHaveText(`Stopped · ${f.chat.title} · Agent Relay`); await expect(page).toHaveTitle("Fixture/project");
  await page.screenshot({ path: "test-results/tab-title-desktop.png" }); await save(page); await close(page);
  await expect(page).toHaveTitle(`Stopped · ${f.chat.title} · Agent Relay`); await expect(page.locator("#chat-title")).toHaveText(f.chat.title);
  await expect(page.locator("#message-input")).toHaveValue("Retain this draft"); await expect(page.locator("#attachment-chips")).toContainText("keep.txt");
  await page.reload(); await expect(page).toHaveTitle(`Stopped · ${f.chat.title} · Agent Relay`);
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("slash title works while busy; neutral/defaults, cancel and arguments never queue or rename", async ({ page }) => {
  const f = await setup(page, { busy: true }); await open(page, true, true); await expect(page.locator("#message-input")).toHaveValue("");
  await page.getByRole("button", { name: "Use app title only", exact: true }).click(); await expect(preview(page)).toHaveText("Agent Relay"); await close(page); await expect(page).toHaveTitle(/Fixture\/project/);
  await open(page); await page.getByRole("button", { name: "Use app title only", exact: true }).click(); await save(page); await close(page); await expect(page).toHaveTitle("Agent Relay");
  await open(page); await page.getByRole("button", { name: "Restore defaults", exact: true }).click(); await save(page); await close(page); await expect(page).toHaveTitle(/Fixture\/project/);
  await page.locator("#message-input").fill("/title a new name"); await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator("#toasts")).toContainText("Use /rename"); await expect(page.locator("#message-input")).toHaveValue("/title a new name");
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("native status and plan snapshots update the tab, spinner pauses for approval and respects reduced motion", async ({ page }) => {
  await page.clock.install(); const f = await setup(page, { busy: true, items: ["spinner", "status", "task-progress", "thread"] });
  await expect(page).toHaveTitle(new RegExp(`Working · 1/4 steps · ${f.chat.title}`));
  const first = await page.title(); await page.clock.runFor(350); expect(await page.title()).not.toEqual(first);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  const hidden = await page.title(); await page.clock.runFor(900); expect(await page.title()).toBe(hidden);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(350); expect(await page.title()).not.toBe(hidden);
  await page.emulateMedia({ reducedMotion: "reduce" }); await expect(page).toHaveTitle(new RegExp(`^◌ · Working`));
  const reduced = await page.title(); await page.clock.runFor(900); expect(await page.title()).toBe(reduced);
  await update(page, f, { pendingRequest: { method: "item/commandExecution/requestApproval", requestId: "fixture-title-approval", params: { command: "fixture" } } });
  await expect(page).toHaveTitle(new RegExp(`^Approval needed · 1/4 steps`));
  await page.emulateMedia({ reducedMotion: "no-preference" }); const blocked = await page.title(); await page.clock.runFor(900); expect(await page.title()).toBe(blocked);
  await update(page, f, { pendingRequest: null, status: "stopped", title: "Renamed elsewhere", taskProgress: { ...f.snapshot.taskProgress, completed: 4 } });
  await expect(page).toHaveTitle("Stopped · 4/4 steps · Renamed elsewhere");
  await update(page, f, { goal: { threadId: "title-native", status: "paused", objective: "Private objective must not enter the title" } });
  await expect(page).toHaveTitle("Stopped · Goal paused · Renamed elsewhere");
  await page.getByRole("button", { name: "Open Existing beta", exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText("Existing beta");
  await expect(page).toHaveTitle("Stopped · Progress not reported · Existing beta"); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("mobile title picker supports actual drag, all fields and retained edits after a stale save", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page); await open(page);
  await page.locator('[data-id="project"] .statusline-drag').dragTo(page.locator('[data-id="spinner"]'));
  for (const item of TITLE_ITEMS) await page.getByLabel(`Show ${item.label}`, { exact: true }).check();
  await expect(preview(page)).toContainText("1/4 steps"); f.saved = { ...f.saved, revision: 1 };
  await page.getByRole("button", { name: "Save tab title", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("another tab");
  await expect(page.getByLabel("Show Task progress", { exact: true })).toBeChecked();
  expect(await page.locator("#controls-dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
  await expect(page.getByLabel("Close controls dialog", { exact: true })).toBeInViewport(); await expect(page.getByRole("button", { name: "Save tab title", exact: true })).toBeInViewport();
  await expect(page.locator("#controls-content [role=status]")).toBeInViewport(); await page.screenshot({ path: "test-results/tab-title-mobile.png" });
  page.once("dialog", dialog => dialog.dismiss()); await page.getByRole("button", { name: "Reload tab title", exact: true }).click(); await expect(page.getByLabel("Show Task progress", { exact: true })).toBeChecked();
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "Reload tab title", exact: true }).click(); await expect(page.getByLabel("Show Task progress", { exact: true })).not.toBeChecked();
  await close(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("failed settings retain the slash command; a late discovery cannot replace newer text or dialog", async ({ page }) => {
  const f = await setup(page); let failed = true;
  await page.route("**/api/tab-title", route => failed ? route.fulfill({ status: 503, json: { error: "Fixture title settings unavailable" } }) : route.fallback());
  await page.locator("#message-input").fill("/title"); await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("unavailable"); await expect(page.locator("#message-input")).toHaveValue("/title");
  await expect(page.getByRole("button", { name: "Save tab title", exact: true })).toBeDisabled(); failed = false;
  await page.getByRole("button", { name: "Reload tab title", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("Saved tab title loaded"); await close(page);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let delay = true;
  await page.route("**/api/tab-title", async route => { if (delay) { delay = false; entered.resolve(); await release.promise; } return route.fallback(); });
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await entered.promise; await close(page);
  await page.locator("#message-input").fill("New draft"); await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#keymap-button").click(); release.resolve();
  await expect(page.locator("#controls-title")).toHaveText("Keyboard shortcuts"); await expect(page.locator("#message-input")).toHaveValue("New draft"); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("late saves cannot replace a newer title panel or roll back newer preferences", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  await page.route("**/api/tab-title", async route => {
    if (!first || route.request().method() !== "PATCH") return route.fallback(); first = false;
    f.saved = { ...f.saved, revision: 1, items: route.request().postDataJSON().items }; const result = structuredClone(f.saved); entered.resolve(); await release.promise; return route.fulfill({ json: result });
  });
  await open(page); await page.getByRole("button", { name: "Use app title only", exact: true }).click(); await page.getByRole("button", { name: "Save tab title", exact: true }).click(); await entered.promise;
  await close(page); await open(page); await page.getByLabel("Show Chat name", { exact: true }).check(); await save(page);
  release.resolve(); await expect(page.locator("#toasts")).toContainText("original panel"); await expect(page.getByLabel("Show Chat name", { exact: true })).toBeChecked();
  await close(page); await expect(page).toHaveTitle(f.chat.title); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("account changes immediately neutralize the title and discard old-account acknowledgements", async ({ page }) => {
  const f = await setup(page, { items: ["thread"] }), entered = Promise.withResolvers(), release = Promise.withResolvers(), nextLoad = Promise.withResolvers(), releaseLoad = Promise.withResolvers(); let user = null;
  await page.route("**/api/tab-title", async route => {
    if (route.request().method() === "GET") { if (user) { nextLoad.resolve(); await releaseLoad.promise; } return route.fallback(); }
    const response = { ...f.saved, revision: 1, items: route.request().postDataJSON().items }; entered.resolve(); await release.promise; return route.fulfill({ json: response });
  });
  await page.route("**/api/browser-account", route => route.fulfill({ json: { user } }));
  await page.route("**/api/browser-account/login", route => { user = { id: "title-user", username: "title-user" }; f.saved = { scope: user.id, revision: 0, items: ["model"], account: user }; return route.fulfill({ json: { user } }); });
  await page.route("**/api/browser-connections", route => route.fulfill({ json: { connections: [] } }));
  await page.locator("#message-input").fill("Account-change draft"); await open(page); await page.getByLabel("Show Git branch", { exact: true }).check();
  await page.getByRole("button", { name: "Save tab title", exact: true }).click(); await entered.promise; await close(page);
  await openSettingsSection(page, "Browser connections"); await page.getByLabel("Username", { exact: true }).fill("title-user"); await page.getByLabel("Account password", { exact: true }).fill("fixture-only-password");
  await page.locator("#browser-account-form button[value=login]").click(); await nextLoad.promise; await expect(page).toHaveTitle("Agent Relay");
  releaseLoad.resolve(); await expect(page.locator("#browser-account-name")).toHaveText("Signed in as title-user"); await page.locator("#browser-connections-close").click(); await page.getByLabel("Close settings", { exact: true }).click(); await expect(page).toHaveTitle("fixture-gpt");
  release.resolve(); await expect(page.locator("#toasts")).toContainText("original panel"); await expect(page).toHaveTitle("fixture-gpt");
  await expect(page.locator("#message-input")).toHaveValue("Account-change draft"); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("titles and previews treat metadata literally and bound long content", async ({ page }) => {
  const f = await setup(page, { items: ["thread", "git-branch"] }); const literal = '<img src=x onerror="window.titleInjected=true">';
  await update(page, f, { title: literal, workspaceStatus: { branch: "long/".repeat(1000) } });
  await expect(page).toHaveTitle(formatTabTitle(f.saved.items, f.snapshot)); await open(page); await expect(preview(page)).toHaveText(await page.title());
  expect(await preview(page).locator("img").count()).toBe(0); expect(await page.evaluate(() => Boolean(window.titleInjected))).toBe(false);
  expect(await page.locator("#controls-dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true); expect(f.calls.errors).toEqual([]);
});

test("slow title preferences never delay opening the chat or attaching a file", async ({ page }) => {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Title startup fixture" } })).json(); created.set(page, [chat.id]);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route("**/api/tab-title", async route => { entered.resolve(); await release.promise; return route.fallback(); });
  try {
    await page.goto(`/#chat=${chat.id}`); await entered.promise;
    await expect(page.locator("#chat-title")).toHaveText(chat.title); await expect(page).toHaveTitle("Agent Relay");
    await page.locator("#attachment-input").setInputFiles({ name: "startup.txt", mimeType: "text/plain", buffer: Buffer.from("Startup attachment fixture") });
    await expect(page.locator("#attachment-chips")).toContainText("startup.txt");
  } finally { release.resolve(); }
  await expect(page.locator("#attachment-chips")).toContainText("startup.txt");
});

test("a different account discovered on focus cannot put a previously cached private chat in the tab title", async ({ page }) => {
  const f = await setup(page, { items: ["thread"] }); f.snapshot.ownerId = "first-title-owner";
  f.saved = { ...f.saved, scope: "first-title-owner", account: { id: "first-title-owner", username: "First" } };
  await page.reload(); await expect(page).toHaveTitle(f.chat.title);
  f.saved = { ...f.saved, scope: "second-title-owner", account: { id: "second-title-owner", username: "Second" } };
  await page.evaluate(() => dispatchEvent(new Event("focus"))); await expect(page).toHaveTitle("Agent Relay");
  await open(page); await expect(preview(page)).toHaveText("Agent Relay"); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("the real title endpoint saves private preferences through the picker and reload without starting an agent", async ({ page }) => {
  const username = `title-owner-${Date.now()}`;
  const registered = await page.request.post("/api/browser-account/register", { data: { username, password: "isolated-title-owner-password" } }); expect(registered.ok()).toBe(true);
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Persisted title fixture" } })).json(); created.set(page, [chat.id]);
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title); await open(page);
  await expect(page.locator("#controls-content")).toContainText(`Saved for your Relay account: ${username}`);
  await page.getByRole("button", { name: "Use app title only", exact: true }).click(); await page.getByLabel("Show Chat name", { exact: true }).check(); await page.getByLabel("Show App name", { exact: true }).check();
  await save(page); await close(page); await expect(page).toHaveTitle("Persisted title fixture · Agent Relay");
  const settings = await (await page.request.get("/api/tab-title")).json(); expect(settings.items).toEqual(["thread", "app-name"]); expect(settings.account.username).toBe(username);
  await page.reload(); await expect(page).toHaveTitle("Persisted title fixture · Agent Relay");
  const stored = (await (await page.request.get(`/api/chats/${chat.id}`)).json()).chat;
  expect(stored.title).toBe(chat.title); expect(stored.agentSessionId).toBeFalsy(); expect(stored.status).toBe("stopped"); expect(stored.messages).toEqual([]);
});
