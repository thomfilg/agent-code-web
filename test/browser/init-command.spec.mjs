import { test, expect } from "@playwright/test";
import { webCommands } from "../../public/web-commands.js";

const created = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function fixture(page, status = "idle") {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Init acceptance ${Date.now()}` } })).json();
  created.set(page, [chat.id]);
  const f = { chat, calls: [], status: 202, errors: [] }, snapshot = { ...chat, revision: 99999, status, mode: "plan" };
  page.on("pageerror", error => f.errors.push(error.message));
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: snapshot } }));
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}/commands`, route => route.fulfill({ json: { commands: webCommands("codex") } }));
  for (const tail of ["messages", "queue"]) await page.route(`**/api/chats/${chat.id}/${tail}`, async route => {
    f.calls.push({ tail, ...route.request().postDataJSON() }); await f.gate;
    await route.fulfill({ status: f.status, json: f.status === 202 ? { chat: snapshot } : { error: "Fixture submission failed; please retry." } });
  });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return f;
}
async function attach(page, name) {
  await page.locator("#attachment-input").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(`Fixture instructions: ${name}`) });
  await expect(page.locator("#attachment-chips")).toContainText(name);
}
async function submit(page, text) {
  await page.locator("#message-input").fill(text); await page.locator("#message-input").press("Escape");
  await page.locator("#composer").evaluate(form => form.requestSubmit());
}

for (const status of ["idle", "running"]) test(`/init ${status} submission retains multiline instructions and does not consume newer drafts or files`, async ({ page }) => {
  const f = await fixture(page, status), input = page.locator("#message-input");
  await input.fill("/ini"); await page.locator("#slash-options [role=option]").filter({ hasText: "/init" }).click();
  await expect(input).toHaveValue("/init "); expect(f.calls).toEqual([]);
  await attach(page, "existing-rules.txt");
  let release; f.gate = new Promise(resolve => { release = resolve; });
  const text = "/init Preserve our policies.\nConfira os testes existentes.";
  const response = page.waitForResponse(reply => reply.url().endsWith(`/${f.chat.id}/${status === "running" ? "queue" : "messages"}`));
  await submit(page, text); await expect.poll(() => f.calls.length).toBe(1);
  expect(f.calls[0]).toMatchObject({ tail: status === "running" ? "queue" : "messages", text }); expect(f.calls[0].attachments).toHaveLength(1);
  await input.fill("A newer unsent draft"); await attach(page, "later-rules.txt");
  release(); await (await response).finished();
  await expect(page.locator("#attachment-chips")).not.toContainText("existing-rules.txt");
  await expect(page.locator("#attachment-chips")).toContainText("later-rules.txt"); await expect(input).toHaveValue("A newer unsent draft");
  await expect(page.locator("#mode-label")).toHaveText("Plan"); expect(f.calls).toHaveLength(1); expect(f.errors).toEqual([]);
});

test("failed /init submission keeps the original command and files available for retry", async ({ page }) => {
  const f = await fixture(page, "running"); f.status = 503;
  await attach(page, "keep-on-error.txt"); const text = "/init Use these conventions\nand preserve existing edits";
  await submit(page, text); await expect(page.locator("#toasts")).toContainText("Fixture submission failed");
  await expect(page.locator("#message-input")).toHaveValue(text); await expect(page.locator("#attachment-chips")).toContainText("keep-on-error.txt");
  f.status = 202; await submit(page, text); await expect.poll(() => f.calls.length).toBe(2);
  expect(f.calls[1]).toEqual(f.calls[0]); await expect(page.locator("#attachment-chips")).toBeEmpty();
  await expect(page.locator("#message-input")).toHaveValue(""); expect(f.errors).toEqual([]);
});
