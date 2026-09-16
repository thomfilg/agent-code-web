import { test, expect } from "@playwright/test";

const threadId = "01950000-0000-7000-8000-000000000001";
const chats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of chats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Desktop handoff ${Date.now()}` } })).json(); chats.set(page, [chat.id]);
  const snapshot = { ...chat, revision: 99999, status: "running", agentSessionId: threadId };
  const info = { threadId, source: "connected", backend: "local", privateProfile: false, busy: true, accountScope: "shared", checkedAt: "2026-09-16T10:00:00Z",
    profile: "/fixture/codex", workspace: "/fixture/workspace/<img src=x onerror=alert(1)>", url: `codex://threads/${threadId}`, reason: "Open this same saved session in the desktop app on the worker's computer." };
  const calls = { reads: 0, inputs: [], status: 200 }, errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: snapshot } }));
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}/desktop-handoff`, async route => { calls.reads++; calls.entered?.(); await calls.gate; await route.fulfill({ status: calls.status, json: calls.status === 200 ? info : { error: "Fixture location failure; nothing opened" } }); });
  for (const tail of ["messages", "queue", "stop"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { calls.inputs.push(tail); return route.fulfill({ json: { chat: snapshot } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, snapshot, info, calls, errors };
}
async function open(page, menu = false) {
  if (menu) { await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#desktop-app-button").click(); }
  else { await page.locator("#message-input").fill("/app"); await page.getByRole("button", { name: "Queue", exact: true }).click(); }
  await expect(page.locator("#controls-title")).toHaveText("Open in desktop app");
}
const status = page => page.locator(".desktop-handoff [role=status]");
const confirm = page => page.getByRole("checkbox", { name: "My desktop app is on the worker's computer" });

test("local handoff is explicit, opens the native ID, keeps draft/files/queue and does not claim launch success", async ({ page }) => {
  const f = await setup(page);
  await page.locator("#attachment-input").setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this file") });
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt"); await open(page);
  await expect(status(page)).toContainText("same saved session"); await expect(page.locator("#message-input")).toHaveValue("");
  await expect(page.getByLabel("Worker workspace", { exact: true })).toHaveValue(f.info.workspace); await expect(page.locator(".desktop-handoff img")).toHaveCount(0);
  await expect(page.locator(".desktop-handoff-warning")).toContainText("will not pause");
  const launch = page.getByRole("link", { name: "Open saved session", exact: true }); await expect(launch).toHaveAttribute("aria-disabled", "true"); expect(await launch.getAttribute("href")).toBeNull();
  await confirm(page).check(); await expect(launch).toHaveAttribute("href", `codex://threads/${threadId}`);
  // Intercept only the OS protocol launch: exercise the real link handler
  // without opening an installed app or modifying any personal desktop state.
  await page.evaluate(() => { window.desktopLinks = []; document.addEventListener("click", event => { const anchor = event.target.closest("a[href^='codex:']"); if (anchor) { event.preventDefault(); window.desktopLinks.push(anchor.href); } }, true); });
  await page.locator("#message-input").evaluate(input => { input.value = "Unsent draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await launch.click(); await expect(status(page)).toContainText("cannot verify"); expect(await page.evaluate(() => window.desktopLinks)).toEqual([f.info.url]);
  await expect(page.locator("#message-input")).toHaveValue("Unsent draft"); await expect(page.locator("#attachment-chips")).toContainText("keep.txt"); expect(f.calls.inputs).toEqual([]); expect(f.errors).toEqual([]);
});

test("refresh removes old links while loading and resets confirmation; failed /app retains the command", async ({ page }) => {
  const f = await setup(page); f.calls.status = 409; await open(page); await expect(status(page)).toContainText("Fixture location failure");
  await expect(page.locator("#message-input")).toHaveValue("/app");
  f.calls.status = 200; await page.getByRole("button", { name: "Refresh session location" }).click(); await confirm(page).check();
  let release; f.calls.gate = new Promise(resolve => { release = resolve; });
  await page.getByRole("button", { name: "Refresh session location" }).click(); await expect(status(page)).toContainText("Checking"); await expect(page.locator(".desktop-handoff a[href^='codex:']")).toHaveCount(0);
  release(); await expect(status(page)).toContainText("same saved session"); await expect(confirm(page)).not.toBeChecked(); expect(f.calls.inputs).toEqual([]);
});

test("private profiles, remote workers, unknown locations and empty sessions do not get bogus local links", async ({ page }) => {
  const f = await setup(page); f.info.privateProfile = true; f.info.url = null; f.info.reason = "This session uses a private Relay worker profile. No history or credentials have been copied.";
  await open(page); await expect(status(page)).toContainText("private Relay worker profile"); await expect(page.getByRole("link", { name: "Open saved session" })).toHaveCount(0);
  f.info.privateProfile = false; f.info.backend = "ec2"; f.info.reason = "This session belongs to a remote worker.";
  await page.getByRole("button", { name: "Refresh session location" }).click(); await expect(page.getByRole("link", { name: "Open desktop SSH connections" })).toHaveAttribute("href", "codex://settings/connections/ssh");
  await expect(page.locator(".desktop-handoff-actions")).toContainText("not this remote chat");
  f.info.backend = null; f.info.profile = null; f.info.workspace = null; f.info.source = "unknown"; f.info.reason = "The saved session's native location has not been verified.";
  await page.getByRole("button", { name: "Refresh session location" }).click(); await expect(status(page)).toContainText("not been verified"); await expect(page.locator(".desktop-handoff a[href^='codex:']")).toHaveCount(0);
  f.info.threadId = null; f.info.reason = "This chat has no saved native Codex session to open yet.";
  await page.getByRole("button", { name: "Refresh session location" }).click(); await expect(status(page)).toContainText("no saved"); await expect(page.getByLabel("Native session ID", { exact: true })).toHaveCount(0); expect(f.calls.inputs).toEqual([]);
});

test("returning with a different account clears all old locator fields and actions", async ({ page }) => {
  const f = await setup(page); await open(page); await confirm(page).check();
  f.info.accountScope = "different-account"; await page.evaluate(() => dispatchEvent(new Event("focus")));
  await expect(status(page)).toContainText("account changed"); await expect(page.locator(".desktop-handoff textarea")).toHaveCount(0);
  await expect(page.locator(".desktop-handoff a")).toHaveCount(0); await expect(page.getByRole("button", { name: "Refresh session location" })).toBeDisabled(); expect(f.calls.inputs).toEqual([]);
});

test("late replies cannot clear a newer draft or restore a locator after chat navigation", async ({ page }) => {
  const f = await setup(page), { chat: other } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Other desktop fixture" } })).json(); chats.get(page).push(other.id);
  let release; f.calls.gate = new Promise(resolve => { release = resolve; }); await open(page);
  await page.locator("#message-input").evaluate(input => { input.value = "Newer unsent draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  release(); await expect(status(page)).toContainText("same saved session"); await expect(page.locator("#message-input")).toHaveValue("Newer unsent draft");
  f.calls.gate = new Promise(resolve => { release = resolve; }); await page.getByRole("button", { name: "Refresh session location" }).click();
  // Exercise the real selection handler during a modal request (as an account
  // or sidebar update can do), without relying on an unsupported hash router.
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true, includeHidden: true }).evaluate(button => button.click()); await expect(page.locator("#chat-title")).toHaveText(other.title);
  await expect(status(page)).toContainText("chat or its session changed"); release();
  await expect(page.locator(".desktop-handoff textarea")).toHaveCount(0); await expect(page.locator(".desktop-handoff a")).toHaveCount(0); expect(f.calls.inputs).toEqual([]);
});

test("mobile saved-session view fits, menu preserves draft, and manual copy remains available", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page); f.info.source = "saved"; f.info.busy = false;
  await page.locator("#message-input").fill("Unsent mobile draft"); await open(page, true);
  await expect(page.locator(".desktop-handoff-details")).toContainText("not rechecked in this request");
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw Error("Denied by fixture"); } } }));
  await page.getByRole("button", { name: "Copy native session id" }).click(); await expect(status(page)).toContainText("Copy the selected text manually");
  expect(await page.getByLabel("Native session ID", { exact: true }).evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd))).toBe(threadId);
  expect(await page.locator("#controls-dialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/desktop-handoff-mobile.png" });
  await confirm(page).check(); await expect(page.getByRole("link", { name: "Open saved session", exact: true })).toHaveAttribute("href", f.info.url);
  await page.getByRole("link", { name: "Desktop app setup", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/desktop-handoff-mobile-actions.png" });
  await expect(page.locator("#message-input")).toHaveValue("Unsent mobile draft"); expect(f.calls.inputs).toEqual([]); expect(f.errors).toEqual([]);
});

test("unsupported arguments and malicious or mismatched returned URLs never become agent input or external navigation", async ({ page }) => {
  const f = await setup(page); await page.locator("#message-input").fill("/app malicious"); await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator("#message-input")).toHaveValue("/app malicious"); expect(f.calls.reads).toBe(0);
  f.info.url = "javascript:alert(1)"; await open(page); await expect(status(page)).toContainText("same saved session"); await expect(page.getByRole("link", { name: "Open saved session" })).toHaveCount(0);
  f.info.threadId = "01950000-0000-7000-8000-000000000002"; await page.getByRole("button", { name: "Refresh session location" }).click();
  await expect(status(page)).toContainText("native session changed"); await expect(page.locator(".desktop-handoff textarea")).toHaveCount(0); expect(f.calls.inputs).toEqual([]);
});
