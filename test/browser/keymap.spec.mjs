import { test, expect } from "@playwright/test";

const created = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: `Keyboard fixture ${Date.now()}` } })).json(); created.set(page, [chat.id]);
  let saved = { scope: "shared", revision: 0, bindings: {}, account: null }; const calls = { saves: [], messages: [], worker: [] };
  await page.route("**/api/keymap", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: saved });
    const input = route.request().postDataJSON(); calls.saves.push(input);
    if (input.scope !== saved.scope || input.revision !== saved.revision) return route.fulfill({ status: 409, json: { error: "Shortcuts changed in another tab. Reload before saving." } });
    saved = { ...saved, revision: saved.revision + 1, bindings: input.bindings }; return route.fulfill({ json: saved });
  });
  await page.route(`**/api/chats/${chat.id}/messages`, route => { calls.messages.push(route.request().postDataJSON()); return route.fulfill({ json: { queued: false } }); });
  for (const tail of ["stop", "compact", "wake"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { calls.worker.push(tail); return route.fulfill({ json: {} }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, calls, get saved() { return saved; }, set saved(value) { saved = value; } };
}
async function open(page, menu = false) {
  if (menu) { await page.getByLabel("Chat actions", { exact: true }).click(); await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click(); }
  else { await page.locator("#message-input").fill("/keymap"); await page.getByRole("button", { name: "Send message", exact: true }).click(); }
  await expect(page.locator("#controls-title")).toHaveText("Keyboard shortcuts"); await expect(page.locator("#controls-content [role=status]")).toContainText("Saved shortcuts loaded");
}
async function save(page) { await page.getByRole("button", { name: "Save shortcuts", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("saved and active"); }
const close = page => page.locator("#controls-dialog").evaluate(dialog => dialog.close());

test("keymap remaps actual send/newline shortcuts, persists on reload and retains the composer draft and files", async ({ page }) => {
  const f = await setup(page); await page.locator("#attachment-input").setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("private keyboard fixture") });
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt"); await open(page); expect(f.calls.saves).toHaveLength(0); expect(f.calls.messages).toHaveLength(0);
  await expect(page.locator("#controls-content")).toContainText("shared by this Relay installation");
  await page.getByLabel("Shortcut context", { exact: true }).selectOption("composer"); await page.getByLabel("Send or queue message", { exact: true }).fill("ctrl-enter");
  await page.getByLabel("Insert a new line", { exact: true }).fill("alt-j");
  await page.locator("#message-input").evaluate(input => { input.value = "Keep my draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.screenshot({ path: "test-results/keymap-desktop.png" }); await save(page); await close(page);
  await expect(page.locator("#message-input")).toHaveValue("Keep my draft"); await expect(page.locator("#attachment-chips")).toContainText("keep.txt");
  await expect(page.locator(".composer-hint")).toContainText("Ctrl + Enter to send");
  const input = page.locator("#message-input"); await input.fill("First"); await input.press("Alt+j"); await input.press("a"); await expect(input).toHaveValue("First\na");
  await input.press("Enter"); expect(f.calls.messages).toHaveLength(0); await input.press("Control+Enter"); await expect.poll(() => f.calls.messages.length).toBe(1);
  expect(f.calls.messages[0].text).toBe("First\na"); expect(f.calls.worker).toEqual([]);
  await page.reload(); await expect(page.locator("#chat-title")).toHaveText(f.chat.title); await expect(page.locator(".composer-hint")).toContainText("Ctrl + Enter to send");
  await input.fill("After reload"); await input.press("Control+Enter"); await expect.poll(() => f.calls.messages.length).toBe(2);
});

test("global shortcut removal/restoration works and editing/IME/repeated keys cannot trigger accidental actions", async ({ page }) => {
  const f = await setup(page); await page.locator("#message-input").fill("Menu keeps my draft"); await open(page, true); await page.getByRole("textbox", { name: "New chat", exact: true }).fill("alt-k"); await save(page); await close(page);
  await expect(page.locator("#message-input")).toHaveValue("Menu keeps my draft");
  const input = page.locator("#message-input"); await input.fill("Retain draft"); await input.press("Control+k"); await expect(page.locator("#new-chat-page")).not.toBeVisible();
  await input.press("Alt+k"); await expect(page.locator("#new-chat-page")).toBeVisible();
  await page.getByRole("button", { name: `Open ${f.chat.title}`, exact: true }).click();
  await expect(input).toHaveValue("Retain draft");
  await open(page); await page.getByRole("textbox", { name: "New chat", exact: true }).fill(""); await save(page); await close(page);
  await input.press("Alt+k"); await expect(page.locator("#new-chat-page")).not.toBeVisible();
  await input.fill("Unsent"); for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) await input.dispatchEvent("keydown", { key: "Enter", bubbles: true, ...extra });
  expect(f.calls.messages).toHaveLength(0);
  await open(page); await page.getByRole("textbox", { name: "New chat", exact: true }).fill("ctrl-l"); await expect(page.locator("#controls-content [role=status]")).toContainText("reserved"); await expect(page.getByRole("button", { name: "Save shortcuts", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Restore all defaults", exact: true }).click(); await save(page); await close(page);
  await input.press("Control+k"); await expect(page.locator("#new-chat-page")).toBeVisible(); expect(f.calls.worker).toEqual([]);
});

test("mobile keymap shows conflicts, keeps a stale-save draft and requires explicit reload", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page); await open(page);
  await page.getByLabel("Focus composer", { exact: true }).fill("ctrl-k"); await expect(page.locator("#controls-content [role=status]")).toContainText("already assigned");
  await page.getByLabel("Focus composer", { exact: true }).fill("alt-i"); f.saved = { ...f.saved, revision: f.saved.revision + 1 };
  await page.getByRole("button", { name: "Save shortcuts", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("another tab"); await expect(page.getByLabel("Focus composer", { exact: true })).toHaveValue("alt-i");
  expect(await page.locator("#controls-dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/keymap-mobile.png" });
  page.once("dialog", dialog => dialog.dismiss()); await page.getByRole("button", { name: "Reload shortcuts", exact: true }).click(); await expect(page.getByLabel("Focus composer", { exact: true })).toHaveValue("alt-i");
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "Reload shortcuts", exact: true }).click(); await expect(page.getByLabel("Focus composer", { exact: true })).toHaveValue(""); expect(f.calls.worker).toEqual([]);
});

test("late keymap acknowledgements cannot roll back a newer saved keymap or replace a new panel", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  await page.route("**/api/keymap", async route => {
    if (!first || route.request().method() !== "PATCH") return route.fallback(); first = false;
    const input = route.request().postDataJSON(); f.saved = { ...f.saved, bindings: input.bindings, revision: f.saved.revision + 1 }; const result = structuredClone(f.saved);
    entered.resolve(); await release.promise; return route.fulfill({ json: result });
  });
  await open(page); await page.getByLabel("Shortcut context", { exact: true }).selectOption("composer"); await page.getByLabel("Send or queue message", { exact: true }).fill("ctrl-enter");
  await page.getByRole("button", { name: "Save shortcuts", exact: true }).click(); await entered.promise; await close(page); await open(page);
  await page.getByLabel("Shortcut context", { exact: true }).selectOption("composer"); await page.getByLabel("Send or queue message", { exact: true }).fill("alt-enter"); await save(page);
  release.resolve(); await expect(page.locator("#toasts")).toContainText("original panel"); await expect(page.getByLabel("Send or queue message", { exact: true })).toHaveValue("alt-enter");
  await close(page); await expect(page.locator(".composer-hint")).toContainText("Alt + Enter to send");
  await page.locator("#message-input").fill("New binding"); await page.locator("#message-input").press("Control+Enter"); expect(f.calls.messages).toHaveLength(0); await page.locator("#message-input").press("Alt+Enter"); await expect.poll(() => f.calls.messages.length).toBe(1);
});

test("remapped history and question focus work while busy without submitting answers or stopping the agent", async ({ page }) => {
  const f = await setup(page), queued = [], answers = [];
  f.saved = { ...f.saved, revision: 1, bindings: { global: { focus_composer: ["alt-i"], answer_request: ["alt-a"] }, composer: { send: ["ctrl-enter"], history_previous: ["alt-p"], history_next: ["alt-n"] } } };
  const snapshot = { ...f.chat, revision: 999999, status: "running", messages: [{ id: "user-one", role: "user", text: "First sent message" }, { id: "user-two", role: "user", text: "Second sent message" }],
    pendingRequest: { requestId: "question-keymap", method: "item/tool/requestUserInput", prompt: "Fixture question", questions: [{ id: "details", header: "Details", question: "Any constraints?", options: [] }] } };
  await page.route(`**/api/chats/${f.chat.id}`, route => route.fulfill({ json: { chat: snapshot } }));
  await page.route(`**/api/chats/${f.chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${f.chat.id}/queue`, route => { queued.push(route.request().postDataJSON()); return route.fulfill({ json: { chat: snapshot } }); });
  await page.route(`**/api/chats/${f.chat.id}/requests/question-keymap/respond`, route => { answers.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  await page.reload(); await expect(page.locator("#chat-title")).toHaveText(f.chat.title); const input = page.locator("#message-input");
  await page.locator("body").click({ position: { x: 310, y: 12 } }); await page.keyboard.press("Alt+i"); await expect(input).toBeFocused();
  await input.fill("Unsent draft"); await input.press("Home"); await input.press("Alt+p"); await expect(input).toHaveValue("Second sent message");
  await input.press("Alt+p"); await expect(input).toHaveValue("First sent message"); await input.press("End"); await input.press("Alt+n"); await input.press("End"); await input.press("Alt+n"); await expect(input).toHaveValue("Unsent draft");
  await input.press("Alt+a"); await expect(page.getByRole("textbox", { name: "Details — your answer", exact: true })).toBeFocused(); expect(answers).toEqual([]); expect(queued).toEqual([]);
  await input.fill("Queue this exact input"); await input.press("Control+Enter"); await expect.poll(() => queued.length).toBe(1); expect(f.calls.worker).toEqual([]); expect(answers).toEqual([]);
  await expect(page.locator(".composer-hint")).toContainText("Ctrl + Enter to queue");
});
