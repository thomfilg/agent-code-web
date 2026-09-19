import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

const project = { companyId: "acme", repository: "acme/api" };
const prompt = (text, projects = []) => ({ id: `prompt_${randomUUID()}`, text, availability: projects.length ? "projects" : "all", projects });
const read = async request => (await request.get("/api/saved-prompts")).json();
async function replace(request, items) {
  const library = await read(request), response = await request.patch("/api/saved-prompts", { data: { scope: library.scope, revision: library.revision, items } });
  expect(response.ok()).toBe(true); return response.json();
}
test.beforeEach(async ({ request }) => { await replace(request, []); });
test.afterEach(async ({ request }) => { await replace(request, []); });
async function existing(page) {
  await page.goto("/"); await page.getByRole("button", { name: "Open PR controls fixture", exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText("PR controls fixture");
}
async function open(page) { await page.getByRole("button", { name: "Saved prompts", exact: true }).click(); await expect(page.locator("#saved-prompt-add")).toBeEnabled(); }
const rows = page => page.locator("#saved-prompts-list .saved-prompt-row");
async function editFirst(page) { await rows(page).first().getByRole("button", { name: /actions$/ }).click(); await rows(page).first().getByRole("button", { name: "Edit", exact: true }).click(); }
function sideEffects(page) {
  const calls = [];
  page.on("request", request => { if (request.method() === "POST" && /\/api\/chats(?:$|\/[^/]+\/(?:messages|queue|wake|start)$)/.test(new URL(request.url()).pathname)) calls.push(request.url()); });
  return calls;
}

test("literal prompt CRUD survives reload and insertion preserves text and attachments without sending", async ({ page, request }) => {
  await existing(page); const effects = sideEffects(page), text = '<script>window.promptExecuted=true</script>\nReview this change';
  await page.locator("#message-input").fill("Before  after");
  await page.locator("#attachment-input").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Keep me") });
  await expect(page.locator("#attachment-chips .attachment-open")).toHaveCount(1);
  await open(page); await page.locator("#saved-prompt-add").click();
  await page.locator("#saved-prompt-text").fill(text); await page.locator("#saved-prompt-availability").selectOption("all");
  await page.getByRole("button", { name: "Save prompt", exact: true }).click(); await expect(page.locator("#saved-prompt-dialog")).not.toBeVisible();
  await expect(rows(page)).toHaveCount(1); expect((await read(request)).items[0].text).toBe(text);
  await page.locator("#message-input").evaluate(input => input.setSelectionRange(7, 7));
  await rows(page).getByRole("button", { name: /^Insert prompt:/ }).click();
  await expect(page.locator("#message-input")).toHaveValue(`Before ${text} after`);
  await expect(page.locator("#attachment-chips .attachment-open")).toHaveCount(1);
  expect(await page.evaluate(() => window.promptExecuted)).toBeUndefined(); expect(effects).toEqual([]);
  await page.reload(); await expect(page.locator("#chat-title")).toHaveText("PR controls fixture"); await open(page);
  await expect(rows(page)).toHaveCount(1); await editFirst(page); await page.locator("#saved-prompt-text").fill("Updated prompt");
  await page.getByRole("button", { name: "Save prompt", exact: true }).click(); await expect(rows(page)).toContainText("Updated prompt");
  expect((await read(request)).items[0].text).toBe("Updated prompt"); expect(effects).toEqual([]);
});

test("project filtering is exact and new-chat insertion preserves local files with zero create or send", async ({ page, request }) => {
  await replace(request, [prompt("Reusable everywhere"), prompt("Acme API only", [project])]); await existing(page); const effects = sideEffects(page);
  await open(page); await expect(rows(page)).toHaveCount(2); await page.keyboard.press("Escape");
  await page.locator("#new-chat-button").click(); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  await page.locator("#initial-prompt").fill("Draft: ");
  await page.locator("#initial-prompt").evaluate(input => { const transfer = new DataTransfer(); transfer.items.add(new File(["Local only"], "local.txt", { type: "text/plain" })); input.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true })); });
  await expect(page.locator("#new-attachment-chips .attachment-open")).toHaveCount(1); await open(page);
  await expect(rows(page)).toHaveCount(1); await page.locator("#saved-prompts-all").check(); await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).getByRole("button", { name: "Insert prompt: Acme API only", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Insert prompt: Reusable everywhere", exact: true }).click();
  await expect(page.locator("#initial-prompt")).toHaveValue("Draft: Reusable everywhere");
  await expect(page.locator("#new-attachment-chips .attachment-open")).toHaveCount(1); expect(effects).toEqual([]);
});

test("drag and keyboard reordering persist and delete leaves composer draft alone", async ({ page, request }) => {
  const items = [prompt("First"), prompt("Second"), prompt("Third")]; await replace(request, items); await existing(page); const effects = sideEffects(page);
  await page.locator("#message-input").fill("Keep draft"); await open(page);
  await rows(page).first().locator(".saved-prompt-drag").evaluate((handle, targetId) => {
    const dataTransfer = new DataTransfer(); handle.dispatchEvent(new DragEvent("dragstart", { dataTransfer, bubbles: true }));
    document.querySelector(`[data-prompt-id="${targetId}"]`).dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
  }, items[2].id);
  await expect.poll(async () => (await read(request)).items.map(item => item.text)).toEqual(["Second", "Third", "First"]);
  await rows(page).last().getByRole("button", { name: /actions$/ }).click(); await rows(page).last().getByRole("button", { name: "Move up" }).focus(); await page.keyboard.press("Enter");
  await expect.poll(async () => (await read(request)).items.map(item => item.text)).toEqual(["Second", "First", "Third"]);
  await rows(page).first().getByRole("button", { name: /actions$/ }).click(); page.once("dialog", dialog => dialog.accept());
  await rows(page).first().getByRole("button", { name: "Delete", exact: true }).click(); await expect(rows(page)).toHaveCount(2);
  await expect(page.locator("#message-input")).toHaveValue("Keep draft"); expect(effects).toEqual([]);
  await page.reload(); await expect(page.locator("#chat-title")).toHaveText("PR controls fixture"); await open(page);
  expect(await rows(page).locator(".saved-prompt-insert").allTextContents()).toEqual(["First", "Third"]);
});

test("conflicting save retains editor text and reload keeps selection while adding newly available choices", async ({ page, request }) => {
  const item = prompt("Initial", [project]); await replace(request, [item]); await existing(page); await open(page); await editFirst(page);
  await page.locator("#saved-prompt-text").fill("My unsaved edit"); await replace(request, [item, prompt("Other tab prompt")]);
  await page.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect(page.locator("#saved-prompt-error")).toContainText("changed"); await expect(page.locator("#saved-prompt-text")).toHaveValue("My unsaved edit");
  await page.route("**/api/saved-prompts", async route => { const response = await route.fetch(), result = await response.json(); if (route.request().method() === "GET") result.projects.push({ companyId: "other", repository: "other/new-project" }); await route.fulfill({ response, json: result }); });
  await page.locator("#saved-prompt-reload").click(); await expect(page.locator("#saved-prompt-error")).toContainText("Your editor text is kept");
  await expect(page.locator("#saved-prompt-projects").getByRole("checkbox", { name: "acme / acme/api", exact: true })).toBeChecked();
  await expect(page.locator("#saved-prompt-projects").getByRole("checkbox", { name: "other / other/new-project", exact: true })).not.toBeChecked();
  await expect(page.locator("#saved-prompt-text")).toHaveValue("My unsaved edit");
  await page.getByRole("button", { name: "Save prompt", exact: true }).click(); await expect(page.locator("#saved-prompt-dialog")).not.toBeVisible();
  expect((await read(request)).items.map(item => item.text)).toEqual(["My unsaved edit", "Other tab prompt"]);
});

test("late committed PATCH cannot overwrite a newer library loaded after editor close and reopen", async ({ page, request }) => {
  const item = prompt("Original"); await replace(request, [item]); await existing(page); await open(page); await editFirst(page);
  const gate = Promise.withResolvers(); let committed = false, delivered = false;
  await page.route("**/api/saved-prompts", async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch(); committed = true; await gate.promise; await route.fulfill({ response }); delivered = true;
  });
  try {
    await page.locator("#saved-prompt-text").fill("Committed edit"); await page.getByRole("button", { name: "Save prompt", exact: true }).click(); await expect.poll(() => committed).toBe(true);
    await page.locator("#saved-prompt-close").click(); await page.keyboard.press("Escape");
    await replace(request, [{ ...item, text: "Newer edit" }, prompt("Newer addition")]);
    await open(page); await expect(rows(page)).toHaveCount(2); await expect(rows(page).first()).toContainText("Newer edit");
    gate.resolve(); await expect.poll(() => delivered).toBe(true);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator("#saved-prompt-add")).toBeEnabled();
    await expect(rows(page)).toHaveCount(2); await expect(rows(page).first()).toContainText("Newer edit");
    await editFirst(page); await expect(page.locator("#saved-prompt-text")).toHaveValue("Newer edit");
  } finally { gate.resolve(); }
});

test("late GET is discarded when navigating from a chat to the new composer", async ({ page, request }) => {
  await replace(request, [prompt("Old context")]); await existing(page); const gate = Promise.withResolvers(); let held = false;
  await page.route("**/api/saved-prompts", async route => { const response = await route.fetch(); held = true; await gate.promise; await route.fulfill({ response }); });
  try {
    await page.getByRole("button", { name: "Saved prompts", exact: true }).click(); await expect.poll(() => held).toBe(true);
    await page.locator("#new-chat-button").click(); await expect(page.locator("#new-chat-page")).toBeVisible();
    gate.resolve(); await expect(page.locator("#saved-prompts-picker")).toBeHidden(); await expect(page.locator("#initial-prompt")).toHaveValue("");
  } finally { gate.resolve(); }
});

test("unconstrained composer accepts insertion; explicit message limit fails without altering draft", async ({ page, request }) => {
  await replace(request, [prompt("Reusable")]); await existing(page); const input = page.locator("#message-input");
  await input.fill("Before "); await input.evaluate(node => node.removeAttribute("maxlength")); await open(page); await rows(page).locator(".saved-prompt-insert").click();
  await expect(input).toHaveValue("Before Reusable"); await input.evaluate(node => node.maxLength = node.value.length); await open(page); await rows(page).locator(".saved-prompt-insert").click();
  await expect(page.locator("#toasts")).toContainText("message length limit"); await expect(input).toHaveValue("Before Reusable");
});

test("desktop and mobile picker truncate rows, keep accessible controls and fit the viewport", async ({ page, request }) => {
  await replace(request, [prompt("A long reusable instruction ".repeat(15)), prompt("Short instruction", [project])]);
  await page.setViewportSize({ width: 1440, height: 1000 }); await existing(page); await open(page);
  await expect(rows(page).first().locator(".saved-prompt-insert")).toHaveCSS("text-overflow", "ellipsis");
  await page.screenshot({ path: test.info().outputPath("saved-prompts-desktop.png"), fullPage: true });
  await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "Saved prompts", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 }); if (await page.locator(".sidebar.open").isVisible()) await page.getByRole("button", { name: "Close chats" }).click();
  await open(page); const box = await page.locator("#saved-prompts-picker").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390); expect(box.y + box.height).toBeLessThanOrEqual(844);
  await expect(rows(page).first().locator(".saved-prompt-insert")).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("saved-prompts-mobile.png"), fullPage: true });
  await editFirst(page); await expect(page.locator("#saved-prompt-text")).toBeFocused();
  await expect(page.getByRole("button", { name: "Save prompt", exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("saved-prompt-editor-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape"); await expect(page.locator("#saved-prompt-dialog")).not.toBeVisible();
});
