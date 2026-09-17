import { test, expect } from "@playwright/test";
import { webCommands } from "../../public/web-commands.js";

const created = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function fixture(page) {
  await page.addInitScript(() => { const Native = window.EventSource; window.fixtureSources = []; window.EventSource = class extends Native { constructor(...args) { super(...args); window.fixtureSources.push(this); } }; });
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "claude", title: `Claude commands ${Date.now()}` } })).json(); created.set(page, [chat.id]);
  const f = { snapshot: { ...chat, revision: 10000, commandCatalogRevision: 0 }, catalog: [{ name: "fixture-old", description: "Old native command" }], reads: 0, calls: [], errors: [] };
  page.on("pageerror", error => f.errors.push(error.message));
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: f.snapshot } }));
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}/commands`, async route => { f.reads++; const commands = [...webCommands("claude"), { name: "reload-skills" }, ...f.catalog]; await f.gate; await route.fulfill({ json: { commands } }); });
  for (const tail of ["messages", "queue"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { f.calls.push({ tail, ...route.request().postDataJSON() }); return route.fulfill({ status: 202, json: {} }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  f.emit = async () => {
    f.snapshot = { ...f.snapshot, revision: f.snapshot.revision + 1, commandCatalogRevision: f.snapshot.commandCatalogRevision + 1 };
    await page.evaluate(chat => window.fixtureSources.find(source => source.url.includes(`/chats/${chat.id}/events`)).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat_updated", chat }) })), f.snapshot);
  };
  return f;
}

test("native skill reload refreshes an open slash menu immediately without changing the query or sending it", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  await input.fill("/fixture"); await expect(page.locator("#slash-options")).toContainText("/fixture-old");
  await input.fill("/reload-skills"); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(1); expect(f.calls[0]).toEqual({ tail: "messages", text: "/reload-skills", attachments: [] });
  await input.fill("/fresh"); await expect(page.locator("#slash-status")).toContainText("No matches");
  f.catalog = [{ name: "fresh:rules", description: "Newly installed native command" }]; await f.emit();
  await expect(page.locator("#slash-options")).toContainText("/fresh:rules"); await expect(input).toHaveValue("/fresh");
  await page.locator("#slash-options [role=option]").click(); await expect(input).toHaveValue("/fresh:rules ");
  expect(f.reads).toBe(2); expect(f.calls).toHaveLength(1); expect(f.errors).toEqual([]);
});

test("a stale pending discovery cannot replace commands fetched after the native catalog changes", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  let release; f.gate = new Promise(resolve => { release = resolve; });
  await input.fill("/fixture"); await expect.poll(() => f.reads).toBe(1);
  f.gate = null; f.catalog = [{ name: "fixture-new", description: "Refreshed command" }]; await f.emit();
  await expect(page.locator("#slash-options")).toContainText("/fixture-new");
  const response = page.waitForResponse(reply => reply.url().endsWith("/commands")); release(); await (await response).finished();
  await expect(page.locator("#slash-options")).not.toContainText("/fixture-old"); await expect(input).toHaveValue("/fixture");
  expect(f.reads).toBe(2); expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

test("catalog refresh leaves a closed menu, draft and attachments untouched and rejects old replay snapshots", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  await input.fill("/fixture"); await expect(page.locator("#slash-options")).toContainText("/fixture-old");
  await input.fill("Unsent draft with no command");
  await page.locator("#attachment-input").setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("Private fixture attachment") });
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt");
  const stale = f.snapshot; f.catalog = [{ name: "fixture-new", description: "Current command" }]; await f.emit();
  await expect(page.locator("#slash-menu")).not.toBeVisible(); await expect(input).toHaveValue("Unsent draft with no command");
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt"); expect(f.reads).toBe(1);
  await input.fill("/fixture"); await expect(page.locator("#slash-options")).toContainText("/fixture-new");
  await page.evaluate(chat => window.fixtureSources.find(source => source.url.includes(`/chats/${chat.id}/events`)).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat_updated", chat }) })), stale);
  await expect(page.locator("#slash-options")).toContainText("/fixture-new"); expect(f.reads).toBe(2); expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});
