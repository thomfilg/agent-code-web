import { openSettingsSection, switchSettingsCompany } from "./settings-navigation.mjs";
import { test, expect } from "@playwright/test";
import { DEFAULT_STATUS_ITEMS, STATUS_ITEMS } from "../../public/status-line.js";

const created = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page, { busy = false } = {}) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: `Status line fixture ${Date.now()}` } })).json(); created.set(page, [chat.id]);
  let saved = { scope: "shared", revision: 0, items: [...DEFAULT_STATUS_ITEMS], account: null };
  const calls = { saves: [], actions: [], errors: [] };
  page.on("pageerror", error => calls.errors.push(error.message));
  const snapshot = { ...chat, revision: 99999, agent: "codex", status: busy ? "running" : "stopped", model: "fixture-gpt", effort: "high", agentSessionId: "native-status-session",
    usage: { version: 2, contextTokens: 200, contextWindow: 1000, totalTokens: 2000, totals: { inputTokens: 1000, cacheReadTokens: 800, outputTokens: 200 } },
    sessionDetails: { agent: "codex", cwd: "/remote/workspace", cliVersion: "0.154.0" }, workspaceStatus: { branch: "main", projectRoot: "/remote/workspace/repo" } };
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: snapshot } }));
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route("**/api/statusline", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: saved });
    const input = route.request().postDataJSON(); calls.saves.push(input);
    if (input.scope !== saved.scope || input.revision !== saved.revision) return route.fulfill({ status: 409, json: { error: "Status-line settings changed in another tab. Reload before saving." } });
    saved = { ...saved, items: input.items, revision: saved.revision + 1 }; return route.fulfill({ json: saved });
  });
  for (const tail of ["messages", "queue", "wake", "stop", "compact"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { calls.actions.push(tail); return route.fulfill({ json: {} }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, snapshot, calls, get saved() { return saved; }, set saved(value) { saved = value; } };
}
async function open(page, command = false, busy = false) {
  if (command) { await page.locator("#message-input").fill("/statusline"); await page.getByRole("button", { name: busy ? "Queue" : "Send message", exact: true }).click(); }
  else { await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#statusline-button").click(); }
  await expect(page.locator("#controls-title")).toHaveText("Status line"); await expect(page.locator("#controls-content [role=status]")).toContainText("Saved status line loaded");
}
const close = page => page.locator("#controls-dialog").evaluate(dialog => dialog.close());
const items = root => root.locator("[data-item]").evaluateAll(nodes => nodes.map(node => node.dataset.item));
const footer = page => page.locator("#chat-statusline");
const preview = page => page.getByLabel("Status line preview", { exact: true });
async function save(page) { await page.getByRole("button", { name: "Save status line", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("saved and active"); }

test("status-line fields toggle, reorder, save and reload without sending or losing the draft/files", async ({ page }) => {
  const f = await setup(page); await expect(footer(page)).toBeHidden();
  await page.locator("#message-input").fill("Keep my draft"); await page.locator("#attachment-input").setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("attachment fixture") });
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt"); await open(page);
  await expect(page.locator("#controls-content")).toContainText("shared by this Relay installation");
  await page.getByRole("button", { name: "Hide status line", exact: true }).click();
  await page.getByLabel("Show Session ID", { exact: true }).check(); await page.getByLabel("Show Input tokens", { exact: true }).check(); await page.getByLabel("Show Model", { exact: true }).check();
  await page.getByRole("button", { name: "Move Model up", exact: true }).click();
  expect(await items(preview(page))).toEqual(["session-id", "model-name", "total-input-tokens"]); await expect(preview(page)).toContainText("native-status-session"); await expect(preview(page)).toContainText("1.8K");
  expect(f.calls.saves).toEqual([]); await page.screenshot({ path: "test-results/statusline-desktop.png" }); await save(page); await close(page);
  expect(await items(footer(page))).toEqual(["session-id", "model-name", "total-input-tokens"]);
  await expect(page.locator("#message-input")).toHaveValue("Keep my draft"); await expect(page.locator("#attachment-chips")).toContainText("keep.txt");
  await page.reload(); await expect(page.locator("#chat-title")).toHaveText(f.chat.title); expect(await items(footer(page))).toEqual(f.saved.items);
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("slash statusline works while busy; cancelling, hiding and restoring affect only the footer", async ({ page }) => {
  const f = await setup(page, { busy: true }); await open(page, true, true); await expect(page.locator("#message-input")).toHaveValue("");
  await page.getByLabel("Show Session ID", { exact: true }).check(); await close(page); expect(await items(footer(page))).toEqual(DEFAULT_STATUS_ITEMS);
  await open(page); await page.getByLabel("Show Session ID", { exact: true }).check(); await save(page); await close(page); await expect(footer(page)).toBeVisible();
  await open(page); await page.getByRole("button", { name: "Hide status line", exact: true }).click(); await save(page); await close(page); await expect(footer(page)).toBeHidden();
  await open(page); await page.getByRole("button", { name: "Restore defaults", exact: true }).click(); await save(page); await close(page); await expect(footer(page)).toBeHidden();
  await page.locator("#message-input").fill("/statusline unexpected"); await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator("#toasts")).toContainText("without arguments"); await expect(page.locator("#message-input")).toHaveValue("/statusline unexpected");
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("mobile status line supports actual drag reordering, every field, and stale-save recovery", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page); await open(page);
  await page.getByLabel("Show Model and reasoning", { exact: true }).check(); await page.getByLabel("Show Git branch", { exact: true }).check();
  await page.locator('[data-id="git-branch"] .statusline-drag').dragTo(page.locator('[data-id="model-with-reasoning"]'));
  expect((await items(preview(page)))[0]).toBe("git-branch");
  for (const item of STATUS_ITEMS) await page.getByLabel(`Show ${item.label}`, { exact: true }).check();
  expect(await items(preview(page))).toHaveLength(15);
  f.saved = { ...f.saved, revision: f.saved.revision + 1 };
  await page.getByRole("button", { name: "Save status line", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("another tab");
  await expect(page.getByLabel("Show Session ID", { exact: true })).toBeChecked();
  expect(await page.locator("#controls-dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
  await expect(page.getByLabel("Close controls dialog", { exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Save status line", exact: true })).toBeInViewport();
  await expect(page.locator("#controls-content [role=status]")).toBeInViewport();
  await page.screenshot({ path: "test-results/statusline-mobile.png" });
  page.once("dialog", dialog => dialog.dismiss()); await page.getByRole("button", { name: "Reload status line", exact: true }).click(); await expect(page.getByLabel("Show Session ID", { exact: true })).toBeChecked();
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "Reload status line", exact: true }).click(); await expect(page.getByLabel("Show Session ID", { exact: true })).not.toBeChecked();
  await close(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("default and unsaved legacy footer stay hidden while observed branches use the PR strip", async ({ page }, testInfo) => {
  const f = await setup(page);
  f.saved = { ...f.saved, items: ["model-with-reasoning", "context-remaining", "git-branch"] };
  await page.reload(); await expect(footer(page)).toBeHidden();
  const strip = page.locator("#pull-request-bars"), branch = strip.locator(".branch-only .pr-branch");
  for (const width of [1600, 320]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 768) {
      if (await page.locator("#sidebar").evaluate(node => node.classList.contains("open"))) await page.getByRole("button", { name: "Close chats", exact: true }).click();
      await expect.poll(() => page.locator("#sidebar").evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    }
    await expect(branch).toHaveText("Workspace · main");
    await expect(branch).toBeInViewport();
    expect(await branch.evaluate(node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
    await expect(strip.locator(".branch-only")).toHaveAttribute("aria-label", "Git branch for workspace");
    await expect(page.getByLabel("Context and usage", { exact: true })).toBeVisible();
    await expect(page.locator("#composer-model-controls")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`branch-strip-${width}.png`) });
  }
  expect(f.saved.revision).toBe(0); expect(f.calls.saves).toEqual([]);
  await open(page); await page.getByLabel("Show Git branch", { exact: true }).uncheck(); await page.getByLabel("Show Git branch", { exact: true }).check(); await save(page); await close(page);
  await expect(footer(page)).toBeVisible(); await expect(footer(page)).toContainText("80% left");
  await open(page); await page.getByRole("button", { name: "Restore defaults", exact: true }).click(); await save(page); await close(page);
  await expect(footer(page)).toBeHidden();
  f.snapshot.workspaceStatus = { branch: null }; await page.reload();
  await expect(strip.locator(".branch-only")).toHaveCount(0);
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("live snapshots update values and switching chats never reuses another chat's session or usage", async ({ page }) => {
  const f = await setup(page); f.saved = { ...f.saved, items: ["session-id", "context-remaining", "codex-version"] };
  await page.reload(); await expect(footer(page)).toContainText("native-status-session");
  const release = Promise.withResolvers();
  await page.route(`**/api/chats/${f.chat.id}/events*`, async route => { await release.promise; return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "chat_updated", chat: { ...f.snapshot, revision: 100000, usage: { ...f.snapshot.usage, contextTokens: 750 } } })}\n\n` }); });
  release.resolve(); await expect(footer(page)).toContainText("25% left", { timeout: 12000 });
  await page.getByRole("button", { name: "Open Existing beta", exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText("Existing beta");
  await expect(footer(page)).not.toContainText("native-status-session"); await expect(footer(page)).not.toContainText("0.154.0"); await expect(footer(page)).toContainText("Not reported");
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("failed loading retains the slash command and allows explicit reload without a message", async ({ page }) => {
  const f = await setup(page); let failed = true;
  await page.route("**/api/statusline", route => failed ? route.fulfill({ status: 503, json: { error: "Fixture settings unavailable" } }) : route.fallback());
  await page.locator("#message-input").fill("/statusline"); await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("unavailable"); await expect(page.locator("#message-input")).toHaveValue("/statusline");
  await expect(page.getByRole("button", { name: "Save status line", exact: true })).toBeDisabled(); failed = false;
  await page.getByRole("button", { name: "Reload status line", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("Saved status line loaded");
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("late saves cannot replace a newer panel or roll back a newer footer preference", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  await page.route("**/api/statusline", async route => {
    if (!first || route.request().method() !== "PATCH") return route.fallback(); first = false;
    const input = route.request().postDataJSON(); f.saved = { ...f.saved, revision: f.saved.revision + 1, items: input.items }; const result = structuredClone(f.saved);
    entered.resolve(); await release.promise; return route.fulfill({ json: result });
  });
  await open(page); await page.getByRole("button", { name: "Hide status line", exact: true }).click(); await page.getByRole("button", { name: "Save status line", exact: true }).click(); await entered.promise;
  await close(page); await open(page); await page.getByLabel("Show Session ID", { exact: true }).check(); await save(page);
  release.resolve(); await expect(page.locator("#toasts")).toContainText("original panel"); await expect(page.getByLabel("Show Session ID", { exact: true })).toBeChecked();
  await close(page); expect(await items(footer(page))).toEqual(["session-id"]); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("late account-scoped acknowledgements do not restore another account's footer or overwrite the draft", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let user = null;
  await page.route("**/api/statusline", async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const response = { ...f.saved, revision: 1, items: route.request().postDataJSON().items }; entered.resolve(); await release.promise; return route.fulfill({ json: response });
  });
  await page.route("**/api/browser-account", route => route.fulfill({ json: { user } }));
  await page.route("**/api/browser-account/login", route => { user = { id: "statusline-user", username: "statusline-user" }; f.saved = { scope: user.id, revision: 0, items: ["model-name"], account: user }; return route.fulfill({ json: { user } }); });
  await page.route("**/api/browser-connections", route => route.fulfill({ json: { connections: [] } }));
  await page.locator("#message-input").fill("Account-change draft"); await open(page); await page.getByLabel("Show Session ID", { exact: true }).check();
  await page.getByRole("button", { name: "Save status line", exact: true }).click(); await entered.promise; await close(page);
  await openSettingsSection(page, "Browser connections"); await page.getByLabel("Username", { exact: true }).fill("statusline-user"); await page.getByLabel("Account password", { exact: true }).fill("fixture-only-password");
  await page.locator("#browser-account-form button[value=login]").click(); await expect(page.locator("#browser-account-name")).toHaveText("Signed in as statusline-user"); await page.locator("#browser-connections-close").click(); await page.getByLabel("Close settings", { exact: true }).click();
  await expect.poll(() => items(footer(page))).toEqual(["model-name"]); release.resolve(); await expect(page.locator("#toasts")).toContainText("original panel");
  expect(await items(footer(page))).toEqual(["model-name"]); await expect(page.locator("#message-input")).toHaveValue("Account-change draft"); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("late discovery cannot erase a newer draft or replace a newer dialog", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let delay = true;
  await page.route("**/api/statusline", async route => { if (delay) { delay = false; entered.resolve(); await release.promise; } return route.fallback(); });
  await page.locator("#message-input").fill("/statusline"); await page.getByRole("button", { name: "Send message", exact: true }).click(); await entered.promise;
  await close(page); await page.locator("#message-input").fill("Newer draft"); await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#keymap-button").click();
  release.resolve(); await expect(page.locator("#controls-title")).toHaveText("Keyboard shortcuts"); await expect(page.locator("#message-input")).toHaveValue("Newer draft");
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("footer and preview render worker metadata literally, with bounded layout for long paths", async ({ page }) => {
  const f = await setup(page); const literal = '<img src=x onerror="window.statuslineInjected=true">';
  f.snapshot.workspaceStatus = { branch: literal, projectRoot: `/remote/${"long-directory/".repeat(100)}` }; f.snapshot.agentSessionId = literal;
  f.saved = { ...f.saved, items: ["session-id", "git-branch", "project-root"] };
  await page.reload(); await expect(footer(page)).toContainText(literal); expect(await footer(page).locator("img").count()).toBe(0);
  await open(page); await expect(preview(page)).toContainText(literal); expect(await preview(page).locator("img").count()).toBe(0);
  expect(await page.evaluate(() => Boolean(window.statuslineInjected))).toBe(false);
  expect(await page.locator("#controls-dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true); expect(f.calls.errors).toEqual([]);
});

test("finishing startup settings preserves a mobile drawer the user already opened", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Startup drawer fixture" } })).json(); created.set(page, [chat.id]);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route("**/api/statusline", async route => { entered.resolve(); await release.promise; return route.fallback(); });
  await page.goto(`/#chat=${chat.id}`); await entered.promise;
  await page.getByRole("button", { name: "Open chats", exact: true }).click(); await expect(page.locator("#sidebar")).toHaveClass(/\bopen\b/);
  release.resolve(); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  await expect(page.locator("#sidebar")).toHaveClass(/\bopen\b/);
  await page.getByRole("button", { name: `Organize ${chat.title}`, exact: true }).click(); await expect(page.locator("#organize-dialog")).toBeVisible();
});
