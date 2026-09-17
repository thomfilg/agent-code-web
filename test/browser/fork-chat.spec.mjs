import { test, expect } from "@playwright/test";

async function setup(page) {
  const chats = [];
  for (const title of ["Fork source", "Independent fork", "Other conversation"]) {
    const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `${title} ${Date.now()}` } })).json(); chats.push(chat);
  }
  for (const chat of chats) {
    await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
    await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: { ...chat, messages: [{ id: `message-${chat.id}`, role: "user", text: "Previously sent message" }] } } }) : route.continue());
  }
  const prompts = [];
  for (const tail of ["messages", "queue", "stop"]) await page.route(`**/api/chats/${chats[0].id}/${tail}`, route => { prompts.push(tail); return route.fulfill({ json: {} }); });
  await page.goto(`/#chat=${chats[0].id}`); await expect(page.locator("#chat-title")).toHaveText(chats[0].title);
  return { chats, prompts };
}

test("/fork retries with the same request ID, keeps errors editable, and opens the independent chat without a prompt", async ({ page }) => {
  const { chats: [source, copy], prompts } = await setup(page), requests = [];
  let fail = true;
  await page.route(`**/api/chats/${source.id}/fork`, async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill(fail ? { status: 409, json: { error: "Workspace changed; retry" } } : { status: 201, json: { chat: copy } });
  });
  const input = page.locator("#message-input"); await input.fill("/fork New approach");
  await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#toasts")).toContainText("Workspace changed; retry"); await expect(input).toHaveValue("/fork New approach");
  fail = false; await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#chat-title")).toHaveText(copy.title); await expect(input).toHaveValue("");
  expect(requests).toHaveLength(2); expect(requests[0].requestId).toBe(requests[1].requestId); expect(requests[1].title).toBe("New approach"); expect(prompts).toEqual([]);
  await page.getByRole("button", { name: `Open ${source.title}`, exact: true }).click(); await expect(input).toHaveValue("");
});

test("a delayed fork cannot erase a newer draft or switch a different active chat", async ({ page }) => {
  const { chats: [source, copy, other], prompts } = await setup(page);
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  await page.route(`**/api/chats/${source.id}/fork`, async route => { calls++; await gate; await route.fulfill({ status: 201, json: { chat: copy } }); });
  const input = page.locator("#message-input"); await input.fill("/fork");
  await page.locator("#composer").evaluate(form => form.requestSubmit()); await expect.poll(() => calls).toBe(1);
  await page.locator("#composer").evaluate(form => form.requestSubmit()); expect(calls).toBe(1);
  await input.fill("New source draft");
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText(other.title); await input.fill("Other chat draft");
  release(); await expect(page.locator("#toasts")).toContainText("Fork ready:");
  await expect(page.locator("#chat-title")).toHaveText(other.title); await expect(input).toHaveValue("Other chat draft");
  await page.getByRole("button", { name: `Open ${source.title}`, exact: true }).click(); await expect(input).toHaveValue("New source draft"); expect(prompts).toEqual([]);
});
