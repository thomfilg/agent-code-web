import { test, expect } from "@playwright/test";

const fixtures = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of fixtures.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page, { busy = false, bindings = {} } = {}) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: `Vim fixture ${Date.now()}` } })).json();
  fixtures.set(page, [...fixtures.get(page) || [], chat.id]); const sent = [], workers = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const snapshot = { ...chat, revision: 999999, status: busy ? "running" : "stopped", messages: [{ id: "previous-message", role: "user", text: "Earlier input" }] };
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: snapshot } }));
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route("**/api/keymap", route => route.fulfill({ json: { scope: "shared", revision: 1, bindings } }));
  for (const endpoint of ["messages", "queue"]) await page.route(`**/api/chats/${chat.id}/${endpoint}`, route => { sent.push({ endpoint, ...route.request().postDataJSON() }); return route.fulfill({ json: { queued: busy } }); });
  for (const endpoint of ["wake", "stop", "compact"]) await page.route(`**/api/chats/${chat.id}/${endpoint}`, route => { workers.push(endpoint); return route.fulfill({ json: {} }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, sent, workers, errors };
}
const input = page => page.locator("#message-input");
const editor = page => page.getByLabel("Message (Vim editor)", { exact: true });
async function menuToggle(page) { await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#vim-button").click(); await expect(page.locator("#vim-mode")).toHaveText("VIM · NORMAL"); }
async function value(page, text) { await expect.poll(() => input(page).inputValue()).toBe(text); }
async function keys(page, text) { for (const key of text) await editor(page).press(key); }

test("Vim is opt-in and performs real motions, operators, text objects, undo, search and substitutions without sending", async ({ page }) => {
  const f = await setup(page); expect(await page.evaluate(() => Boolean(window.CodeMirror))).toBe(false);
  await input(page).fill("one two three\nlast line"); await input(page).press("Home"); await menuToggle(page);
  await keys(page, "gg0dw"); await value(page, "two three\nlast line");
  await keys(page, "u"); await value(page, "one two three\nlast line");
  await keys(page, "wciw"); await expect(page.locator("#vim-mode")).toHaveText("VIM · INSERT");
  await page.keyboard.type("changed"); await editor(page).press("Escape"); await value(page, "one changed three\nlast line");
  await keys(page, "gg0vld"); await value(page, "e changed three\nlast line");
  await keys(page, "u"); await value(page, "one changed three\nlast line");
  await editor(page).press("/"); const find = page.locator(".CodeMirror-dialog input"); await find.fill("last"); await find.press("Enter");
  await expect.poll(() => input(page).evaluate(field => field.selectionStart)).toBe("one changed three\n".length);
  await editor(page).press(":"); await find.fill("%s/changed/replaced/g"); await find.press("Enter"); await value(page, "one replaced three\nlast line");
  await editor(page).press(":"); await find.fill("w"); await find.press("Enter"); expect(f.sent).toEqual([]);
  await editor(page).press("Enter"); expect(f.sent).toEqual([]); expect(f.workers).toEqual([]);
  await page.screenshot({ path: "test-results/vim-desktop.png" });
  await page.getByRole("button", { name: "Vim off", exact: true }).click(); await expect(input(page)).toBeVisible(); await value(page, "one replaced three\nlast line");
  expect(f.errors).toEqual([]);
});

test("slash toggle retains files, remapped insert shortcuts queue once and pasted files use the same attachment path", async ({ page }) => {
  const f = await setup(page, { busy: true, bindings: { composer: { send: ["ctrl-enter"], newline: ["alt-j"] } } });
  await page.locator("#attachment-input").setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("fixture attachment") });
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt");
  await input(page).fill("/vim"); await page.getByRole("button", { name: "Queue", exact: true }).click(); await expect(editor(page)).toBeVisible(); await value(page, "");
  expect(f.sent).toEqual([]); await expect(page.locator("#attachment-chips")).toContainText("keep.txt");
  await editor(page).press("i"); await expect(page.locator(".composer-hint")).toContainText("Ctrl + Enter to queue"); await page.keyboard.type("Draft"); await editor(page).press("Alt+j"); await page.keyboard.type("second"); await value(page, "Draft\nsecond");
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) await editor(page).dispatchEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, ...extra });
  expect(f.sent).toEqual([]);
  await editor(page).evaluate(field => { const data = new DataTransfer(); data.items.add(new File(["pasted contents"], "paste.txt", { type: "text/plain" })); field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); });
  await expect(page.locator("#attachment-chips")).toContainText("paste.txt"); await value(page, "Draft\nsecond");
  await editor(page).press("Control+Enter"); await expect.poll(() => f.sent.length).toBe(1);
  expect(f.sent[0]).toMatchObject({ endpoint: "queue", text: "Draft\nsecond" }); expect(f.sent[0].attachments).toHaveLength(2); await value(page, ""); expect(f.workers).toEqual([]); expect(f.errors).toEqual([]);
});

test("Vim editing keeps command completion and draft-history recall in Insert mode", async ({ page }) => {
  const f = await setup(page); await menuToggle(page); await editor(page).press("i");
  await page.keyboard.type("/wor"); await expect(page.getByRole("option", { name: "/work Installed work skill", exact: true })).toBeVisible(); await editor(page).press("Tab"); await value(page, "/work ");
  await input(page).evaluate(field => { field.value = "Unsent draft"; field.setSelectionRange(0, 0); field.dispatchEvent(new Event("input")); });
  await editor(page).press("ArrowUp"); await value(page, "Earlier input");
  await input(page).evaluate(field => field.setSelectionRange(field.value.length, field.value.length)); await editor(page).press("ArrowDown"); await value(page, "Unsent draft");
  await input(page).evaluate(field => { field.value = "/vim off"; field.dispatchEvent(new Event("input")); });
  await editor(page).press("Enter"); await expect(input(page)).toBeVisible(); await value(page, ""); expect(f.sent).toEqual([]); expect(f.errors).toEqual([]);
});

test("chat changes retain each draft but clear Vim registers/undo, and page reload defaults to ordinary editing", async ({ page }) => {
  const f = await setup(page);
  const { chat: other } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Other Vim fixture" } })).json(); fixtures.get(page).push(other.id);
  await input(page).fill("Private first draft"); await menuToggle(page); await keys(page, "ggyy");
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText(other.title); await expect(input(page)).toBeVisible(); await value(page, "");
  await input(page).fill("Other draft"); await menuToggle(page); await editor(page).press("p"); await editor(page).press("u"); await value(page, "Other draft");
  await page.getByRole("button", { name: `Open ${f.chat.title}`, exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText(f.chat.title); await expect(editor(page)).toBeVisible(); await value(page, "Private first draft");
  await page.reload(); await expect(page.locator("#chat-title")).toHaveText(f.chat.title); await expect(input(page)).toBeVisible(); expect(await page.evaluate(() => Boolean(window.CodeMirror))).toBe(false); expect(f.errors).toEqual([]);
});

test("Vim asset errors preserve the command and retry; late loading preserves newer drafts", async ({ page }) => {
  const f = await setup(page); let fail = true;
  await page.route("**/vendor/codemirror.js", route => fail ? route.abort("failed") : route.fallback());
  await input(page).fill("/vim"); await page.getByRole("button", { name: "Send message", exact: true }).click(); await expect(page.locator("#toasts")).toContainText("Could not load Vim"); await value(page, "/vim"); await expect(input(page)).toBeVisible();
  fail = false; const entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route("**/vendor/codemirror.js", async route => { entered.resolve(); await release.promise; await route.fallback(); });
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await entered.promise; await input(page).fill("Newer draft"); release.resolve();
  await expect(editor(page)).toBeVisible(); await value(page, "Newer draft"); expect(f.sent).toEqual([]); expect(f.workers).toEqual([]); expect(f.errors).toEqual([]);
});

test("late Vim loading cannot enable another chat or clear its draft", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route("**/vendor/codemirror.js", async route => { entered.resolve(); await release.promise; await route.fallback(); });
  await input(page).fill("/vim"); await page.getByRole("button", { name: "Send message", exact: true }).click(); await entered.promise;
  await page.getByRole("button", { name: "Open Existing beta", exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText("Existing beta");
  await input(page).fill("Other chat draft"); release.resolve(); await expect.poll(() => page.evaluate(() => Boolean(window.CodeMirror?.Vim))).toBe(true);
  await expect(input(page)).toBeVisible(); await value(page, "Other chat draft"); await expect(page.locator("#vim-status")).toBeHidden();
  await page.getByRole("button", { name: `Open ${f.chat.title}`, exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText(f.chat.title); await expect(input(page)).toBeVisible(); await value(page, "/vim"); expect(f.sent).toEqual([]);
});

test("mobile Vim has accessible mode/help/off controls, Tab escapes and message size limits retain the draft", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page); await input(page).fill("Keep this draft"); await menuToggle(page);
  await expect(page.locator("#vim-mode")).toBeInViewport(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await editor(page).press("Tab"); await expect(editor(page)).not.toBeFocused();
  await page.getByRole("button", { name: "Keys", exact: true }).click(); await expect(page.locator("#controls-title")).toHaveText("Vim composer keys");
  expect(await page.locator("#controls-dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true); await page.locator("#controls-dialog").evaluate(dialog => dialog.close());
  await page.screenshot({ path: "test-results/vim-mobile.png" });
  await input(page).evaluate(field => { field.value = "x".repeat(100001); }); await expect(page.locator("#toasts")).toContainText("100,000"); await value(page, "Keep this draft");
  await input(page).evaluate(field => { field.disabled = true; }); await expect(editor(page)).toHaveAttribute("aria-disabled", "true");
  await editor(page).dispatchEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }); expect(f.sent).toEqual([]); await value(page, "Keep this draft");
  await input(page).evaluate(field => { field.disabled = false; });
  await page.getByRole("button", { name: "Vim off", exact: true }).click(); await expect(input(page)).toBeVisible(); await value(page, "Keep this draft"); expect(f.errors).toEqual([]);
});

test("workspace references are selectable in Vim Insert mode and Normal-mode search does not open the file picker", async ({ page }) => {
  const f = await setup(page), attached = [];
  await page.route(`**/api/chats/${f.chat.id}/workspace-files`, route => route.fulfill({ json: { connected: true } }));
  await page.route(`**/api/chats/${f.chat.id}/workspace-files/*`, route => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    const file = { path: "notes.md", kind: "file", text: "Explicit fixture context", version: "fixture-version" };
    if (action === "attach") attached.push(route.request().postDataJSON());
    const data = action === "list" ? { entries: [file] } : action === "read" ? file : action === "attach" ? { attachment: { id: "vim-context", name: "notes.md", size: 24, mime: "text/plain" } } : { connected: true };
    return route.fulfill({ json: data });
  });
  await menuToggle(page); await editor(page).press("i"); await page.keyboard.type("Explain @not");
  await expect(page.getByRole("option", { name: "notes.md", exact: true })).toBeVisible(); await editor(page).press("Enter");
  await value(page, "Explain @notes.md "); await expect(page.locator("#attachment-chips")).toContainText("notes.md");
  expect(attached).toEqual([{ path: "notes.md", version: "fixture-version", selection: null }]);
  await editor(page).press("Escape"); await editor(page).press("/"); await page.locator(".CodeMirror-dialog input").fill("@notes");
  await expect(page.locator("#file-menu")).toBeHidden(); await expect(page.locator("#slash-menu")).toBeHidden(); await page.locator(".CodeMirror-dialog input").press("Escape");
  await value(page, "Explain @notes.md "); expect(f.sent).toEqual([]); expect(f.workers).toEqual([]); expect(f.errors).toEqual([]);
});

test("changing the Relay account disables Vim and clears its registers without submitting the retained draft", async ({ page }) => {
  const f = await setup(page); let user = null;
  await page.route("**/api/browser-account", route => route.fulfill({ json: { user } }));
  await page.route("**/api/browser-account/login", route => { user = { id: "vim-other-user", username: "vim-other-user" }; return route.fulfill({ json: { user } }); });
  await page.route("**/api/browser-connections", route => route.fulfill({ json: { connections: [] } }));
  await input(page).fill("Retained draft"); await menuToggle(page); await keys(page, "ggyy");
  await page.getByRole("button", { name: "Browser connections", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("vim-other-user"); await page.getByLabel("Account password", { exact: true }).fill("fixture-only-password");
  await page.locator("#browser-account-form button[value=login]").click(); await expect(page.locator("#browser-account-name")).toHaveText("Signed in as vim-other-user");
  await page.locator("#browser-connections-close").click(); await expect(input(page)).toBeVisible(); await value(page, "Retained draft");
  await menuToggle(page); await editor(page).press("p"); await editor(page).press("u"); await value(page, "Retained draft"); expect(f.sent).toEqual([]); expect(f.errors).toEqual([]);
});
