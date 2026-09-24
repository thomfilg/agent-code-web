import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const fixtureChats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of fixtureChats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });

async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Workspace context ${Date.now()}` } })).json();
  fixtureChats.set(page, [...fixtureChats.get(page) || [], chat.id]);
  expect(chat.workspace).toMatch(/^\/tmp\/relay-browser-/);
  await mkdir(path.join(chat.workspace, "src"), { recursive: true });
  await writeFile(path.join(chat.workspace, "src/task.ts"), "unselected before\nselected context\nunselected after\n");
  await writeFile(path.join(chat.workspace, "notes.md"), "# Explicit notes\nNothing ambient\n");
  const snapshot = { ...chat, revision: 999999, status: "running", messages: [{ id: "real-question", role: "user", text: "Existing task" }] };
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.fallback());
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const sent = [];
  for (const endpoint of ["queue", "messages"]) await page.route(`**/api/chats/${chat.id}/${endpoint}`, route => {
    sent.push({ endpoint, ...route.request().postDataJSON() }); return route.fulfill({ status: 202, json: { chat: snapshot } });
  });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, sent };
}
async function openFile(page) {
  await page.getByLabel("Add to message", { exact: true }).click();
  await page.getByRole("button", { name: "Workspace files & selections", exact: true }).click();
  await page.locator("#workspace-files").getByRole("button", { name: "▸ src", exact: true }).click();
  await page.locator("#workspace-files").getByRole("button", { name: "src/task.ts", exact: true }).click();
  await expect(page.getByLabel("Workspace file contents")).toHaveValue("unselected before\nselected context\nunselected after\n");
}
async function selectText(page) {
  const editor = page.getByLabel("Workspace file contents");
  // Clicking a tree item starts an asynchronous read. Select only the new
  // file's loaded contents, never the previously open file or loading state.
  await expect(editor).toHaveValue("unselected before\nselected context\nunselected after\n");
  await editor.evaluate(editor => { editor.focus(); editor.setSelectionRange(18, 34); editor.dispatchEvent(new Event("select")); });
  await expect(page.locator("#workspace-selection-status")).toHaveText("16 selected characters");
}

test("read-only workspace viewer stages explicit selections and /ide queues them without ambient content", async ({ page, request }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  const { chat, sent } = await setup(page);
  await page.getByLabel("Message", { exact: true }).fill("Unsent draft");
  await openFile(page); await selectText(page);
  expect(sent).toEqual([]); await expect(page.locator("#attachment-chips")).toBeEmpty();
  const conversation = await page.locator("#conversation").boundingBox(), panel = await page.locator("#workspace-panel").boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(conversation.x + conversation.width - 1);
  await page.getByRole("button", { name: "Attach selected text", exact: true }).click();
  await expect(page.locator("#attachment-chips")).toContainText("src/task.ts:2–2");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Unsent draft");
  await page.getByLabel("Message", { exact: true }).fill("/ide Explain this selection");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ endpoint: "queue", text: "Explain this selection" }); expect(sent[0].attachments).toHaveLength(1);
  const { attachment } = await (await request.get(`/api/chats/${chat.id}/attachments/${sent[0].attachments[0]}`)).json();
  expect(attachment.workspaceContext.selectedText).toBe("selected context"); expect(Buffer.from(attachment.data, "base64").toString()).toBe("selected context");
  await expect(page.locator("#attachment-chips")).toBeEmpty(); await expect(page.locator("#messages")).not.toContainText("selected context");
  await page.screenshot({ path: "test-results/workspace-context-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Close workspace context", { exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Attach selected text", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel("Close workspace context", { exact: true }).click(); await expect(page.locator("#workspace-panel")).toBeHidden();
});

test("workspace autocomplete supports keyboard choice, escaped dismissal and folder references", async ({ page, request }) => {
  const { chat, sent } = await setup(page), input = page.getByLabel("Message", { exact: true });
  await input.fill("Contact me@example.com"); await expect(page.locator("#file-menu")).toBeHidden();
  await input.fill("Compare @task"); await expect(page.getByRole("option", { name: "src/task.ts", exact: true })).toBeVisible();
  await expect(input).toHaveAttribute("aria-controls", "file-options");
  await input.press("Escape"); await expect(page.locator("#file-menu")).toBeHidden(); await expect(input).toHaveValue("Compare @task");
  await input.fill("/mention src"); await expect(page.getByRole("option", { name: "src/", exact: true })).toBeVisible();
  await input.press("Enter"); await expect(input).toHaveValue("");
  await expect(page.locator("#attachment-chips")).toContainText("src"); expect(sent).toEqual([]);
  await input.fill("Compare @notes"); await expect(page.getByRole("option", { name: "notes.md", exact: true })).toBeVisible();
  await input.press("Tab"); await expect(input).toHaveValue("Compare @notes.md ");
  await expect(page.locator("#attachment-chips .attachment-chip")).toHaveCount(2);
  await page.getByRole("button", { name: "Queue", exact: true }).click(); await expect.poll(() => sent.length).toBe(1);
  const attachments = await Promise.all(sent[0].attachments.map(async id => (await (await request.get(`/api/chats/${chat.id}/attachments/${id}`)).json()).attachment));
  expect(attachments.map(file => file.workspaceContext.kind)).toEqual(["directory", "file"]);
});

test("bare /ide opens its viewer then stages all open files without submitting a prompt", async ({ page, request }) => {
  const { chat, sent } = await setup(page), input = page.getByLabel("Message", { exact: true });
  await input.fill("/ide"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#workspace-panel")).toBeVisible(); await expect(input).toHaveValue("/ide"); expect(sent).toEqual([]);
  await page.locator("#workspace-files").getByRole("button", { name: "notes.md", exact: true }).click();
  await page.locator("#workspace-files").getByRole("button", { name: "▸ src", exact: true }).click();
  await page.locator("#workspace-files").getByRole("button", { name: "src/task.ts", exact: true }).click(); await selectText(page);
  await input.fill("/ide"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(input).toHaveValue(""); await expect(page.locator("#attachment-chips .attachment-chip")).toHaveCount(2); expect(sent).toEqual([]);
  await input.fill("My next explicit task"); await page.getByRole("button", { name: "Queue", exact: true }).click(); await expect.poll(() => sent.length).toBe(1);
  const attachments = await Promise.all(sent[0].attachments.map(async id => (await (await request.get(`/api/chats/${chat.id}/attachments/${id}`)).json()).attachment));
  expect(attachments.map(file => file.workspaceContext.path)).toEqual(["notes.md", "src/task.ts"]);
  expect(attachments.map(file => file.workspaceContext.selectedText)).toEqual([null, "selected context"]);
});

test("Send waits for context capture; rejected or late selections preserve the draft and chat boundary", async ({ page }) => {
  const { chat, sent } = await setup(page); await openFile(page); await selectText(page);
  let release, attachStarted = false;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/chats/${chat.id}/workspace-files/attach`, async route => { attachStarted = true; await held; await route.fallback(); });
  await page.getByRole("button", { name: "Attach selected text", exact: true }).click(); await expect.poll(() => attachStarted).toBe(true);
  await page.getByLabel("Message", { exact: true }).fill("Waiting for selected context"); await page.getByRole("button", { name: "Queue", exact: true }).click();
  expect(sent).toEqual([]); release(); await expect.poll(() => sent.length).toBe(1); expect(sent[0].attachments).toHaveLength(1);
  await page.unroute(`**/api/chats/${chat.id}/workspace-files/attach`);
  await writeFile(path.join(chat.workspace, "src/task.ts"), "The source changed");
  await page.getByLabel("Message", { exact: true }).fill("/ide Keep my draft"); await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.getByText("The workspace file changed; reopen it before selecting context", { exact: true })).toBeVisible(); await expect(page.getByLabel("Message", { exact: true })).toHaveValue("/ide Keep my draft"); expect(sent).toHaveLength(1);
});

test("late workspace reads cannot replace another chat's editor or attach to its draft", async ({ page }) => {
  const first = await setup(page); await openFile(page);
  let release, readStarted = false;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/chats/${first.chat.id}/workspace-files/read`, async route => { readStarted = true; await held; await route.fallback(); });
  await page.locator("#workspace-files .workspace-file-row").getByRole("button", { name: "Mention", exact: true }).click(); await expect.poll(() => readStarted).toBe(true);
  const { chat: other } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Other workspace isolation" } })).json();
  fixtureChats.set(page, [...fixtureChats.get(page), other.id]);
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill("Other chat draft"); release();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Other chat draft"); await expect(page.locator("#attachment-chips")).toBeEmpty();
  await page.getByRole("button", { name: `Open ${first.chat.title}`, exact: true }).click();
  await expect(page.locator("#attachment-chips")).toContainText("src/task.ts"); expect(first.sent).toEqual([]);
});
