import { test, expect } from "@playwright/test";
import { webCommands } from "../../public/web-commands.js";

const created = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function fixture(page, status = "idle") {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Model controls ${Date.now()}` } })).json(); created.set(page, [chat.id]);
  const snapshot = { ...chat, revision: 99999, status, model: "gpt-5.6-sol", personality: "pragmatic" };
  const f = { chat, snapshot, calls: [], status: 200, errors: [] }; page.on("pageerror", error => f.errors.push(error.message));
  const models = [{ id: "gpt-5.6-sol", label: "Sol", efforts: ["high"], supportsPersonality: true, serviceTiers: [{ id: "priority", name: "Fast" }] }, { id: "plain", label: "Plain", efforts: ["high"], supportsPersonality: false, serviceTiers: [] }];
  await page.route("**/api/models?agent=codex", route => route.fulfill({ json: { models, configuredDefault: "gpt-5.6-sol" } }));
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: snapshot } }));
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}/commands`, route => route.fulfill({ json: { commands: webCommands("codex", { personality: snapshot.model !== "plain", fast: snapshot.model !== "plain" }) } }));
  await page.route(`**/api/chats/${chat.id}/model`, route => { Object.assign(snapshot, route.request().postDataJSON()); return route.fulfill({ json: { chat: snapshot } }); });
  for (const tail of ["messages", "queue"]) await page.route(`**/api/chats/${chat.id}/${tail}`, async route => {
    f.calls.push({ tail, ...route.request().postDataJSON() }); await f.gate;
    await route.fulfill({ status: f.status, json: f.status === 200 ? { chat: snapshot } : { error: "Fixture settings rejected" } });
  });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return f;
}
async function submit(page, text) {
  await page.locator("#message-input").fill(text); await page.locator("#message-input").press("Escape");
  await page.locator("#composer").evaluate(form => form.requestSubmit());
}

test("Fast on/off/toggle use the ordinary command route and stay in the busy queue", async ({ page }) => {
  const f = await fixture(page, "running");
  for (const text of ["/fast", "/fast on", "/fast off", "/personality none"]) {
    await submit(page, text); await expect.poll(() => f.calls.at(-1)?.text).toBe(text);
    expect(f.calls.at(-1).tail).toBe("queue"); expect(f.calls.at(-1).attachments).toEqual([]); await expect(page.locator("#message-input")).toHaveValue("");
  }
  expect(f.errors).toEqual([]);
});

test("personality picker disables all choices while pending and queues exactly one command", async ({ page }) => {
  const f = await fixture(page, "running"); let release; f.gate = new Promise(resolve => { release = resolve; });
  await submit(page, "/personality"); await expect(page.locator("#controls-title")).toHaveText("Codex personality");
  await page.getByRole("button", { name: "Friendly", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pragmatic", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "None", exact: true })).toBeDisabled();
  expect(f.calls).toEqual([{ tail: "queue", text: "/personality friendly", attachments: [] }]);
  release(); await expect(page.locator("#controls-dialog")).not.toBeVisible(); expect(f.errors).toEqual([]);
});

test("late personality replies cannot dismiss a different control or lose its unsent draft", async ({ page }) => {
  const f = await fixture(page); let release; f.gate = new Promise(resolve => { release = resolve; });
  await submit(page, "/personality"); await page.getByRole("button", { name: "Friendly", exact: true }).click(); await expect.poll(() => f.calls.length).toBe(1);
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close()); await submit(page, "/resume");
  await expect(page.locator("#controls-title")).toHaveText("Resume conversation");
  await page.locator("#message-input").evaluate(input => { input.value = "Keep my newer draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  release(); await expect(page.getByRole("dialog", { name: "Resume conversation" })).toBeVisible();
  await expect(page.locator("#message-input")).toHaveValue("Keep my newer draft"); expect(f.errors).toEqual([]);
});

test("personality errors keep the picker retryable and preserve unsent attachments", async ({ page }) => {
  const f = await fixture(page); f.status = 400;
  await page.locator("#attachment-input").setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this attachment") });
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt");
  await submit(page, "/personality"); await expect(page.locator("#controls-title")).toHaveText("Codex personality");
  await page.getByRole("button", { name: "None", exact: true }).click(); await expect(page.locator("#controls-dialog [role=alert]")).toContainText("Fixture settings rejected");
  await expect(page.getByRole("button", { name: "Friendly", exact: true })).toBeEnabled();
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt");
  f.status = 200; await page.getByRole("button", { name: "None", exact: true }).click(); await expect(page.locator("#controls-dialog")).not.toBeVisible();
  expect(f.calls.every(call => call.text === "/personality none" && !call.attachments.length)).toBe(true); await expect(page.locator("#attachment-chips")).toContainText("keep.txt"); expect(f.errors).toEqual([]);
});

test("command discovery refreshes after changing to a model without Fast or personality", async ({ page }) => {
  const f = await fixture(page);
  await page.locator("#message-input").fill("/fast"); await expect(page.locator("#slash-options")).toContainText("/fast");
  await page.locator("#message-input").press("Escape"); await page.locator("#composer-model-controls .model-select").selectOption("plain");
  await expect.poll(() => f.snapshot.model).toBe("plain");
  for (const text of ["/fast", "/personality"]) { await page.locator("#message-input").fill(text); await expect(page.locator("#slash-status")).toContainText("No matches"); await expect(page.locator("#slash-options [role=option]")).toHaveCount(0); }
  expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

test("personality picker is usable at 320px without sending or losing a draft", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await fixture(page);
  await submit(page, "/personality"); const dialog = page.getByRole("dialog", { name: "Codex personality" }); await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(page.getByRole("button", { name: "Friendly", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "None", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/personality-mobile.png" });
  await page.locator("#controls-dialog").evaluate(element => element.close()); expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

test("a failed Fast command restores only its empty original composer, never a newer or another chat's draft", async ({ page }) => {
  const f = await fixture(page); f.status = 400;
  const input = page.locator("#message-input");
  await submit(page, "/fast on"); await expect(page.locator("#toasts")).toContainText("Fixture settings rejected"); await expect(input).toHaveValue("/fast on");
  let release; f.gate = new Promise(resolve => { release = resolve; });
  const response = page.waitForResponse(reply => reply.url().endsWith(`/${f.chat.id}/messages`) && reply.status() === 400);
  await submit(page, "/fast off"); await expect.poll(() => f.calls.length).toBe(2); await input.fill("My newer unsent draft");
  release(); await (await response).finished(); await expect(page.locator("#toasts .toast")).toHaveCount(2); await expect(input).toHaveValue("My newer unsent draft");
  f.gate = new Promise(resolve => { release = resolve; });
  const nextResponse = page.waitForResponse(reply => reply.url().endsWith(`/${f.chat.id}/messages`) && reply.status() === 400);
  await submit(page, "/fast on"); await expect.poll(() => f.calls.length).toBe(3);
  const { chat: other } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Other model settings fixture" } })).json(); created.get(page).push(other.id);
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true, includeHidden: true }).evaluate(button => button.click()); await expect(page.locator("#chat-title")).toHaveText(other.title);
  await input.fill("Other chat draft"); release(); await (await nextResponse).finished(); await expect(page.locator("#toasts .toast")).toHaveCount(3); await expect(input).toHaveValue("Other chat draft");
  expect(f.errors).toEqual([]);
});

test("a personality picker from another chat cannot submit a stale selection", async ({ page }) => {
  const f = await fixture(page), { chat: other } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Other personality fixture" } })).json(); created.get(page).push(other.id);
  await submit(page, "/personality");
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true, includeHidden: true }).evaluate(button => button.click()); await expect(page.locator("#chat-title")).toHaveText(other.title);
  await page.getByRole("button", { name: "Friendly", exact: true }).click(); await expect(page.locator("#controls-dialog [role=alert]")).toContainText("chat or model changed");
  await expect(page.getByRole("button", { name: "None", exact: true })).toBeDisabled(); expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});
