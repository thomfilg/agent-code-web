import { test, expect } from "@playwright/test";

async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Side controls ${Date.now()}` } })).json();
  const question = (id, header) => ({ requestId: id, method: "item/tool/requestUserInput", prompt: `${header} input needed`, questions: [{ id: "choice", header, question: `${header}?`, options: [{ label: "First", description: "First option" }, { label: "Second", description: "Second option" }] }] });
  const main = { ...chat, agent: "codex", status: "running", pendingRequest: question("main-request", "Main choice"), messages: [{ id: "main-text", role: "user", text: "Main conversation remains here" }] };
  await page.route("**/api/sidebar", async route => {
    const response = await route.fetch(), result = await response.json();
    if (Array.isArray(result.chats)) result.chats = result.chats.map(entry => entry.id === chat.id ? { ...entry, status: "running" } : entry);
    await route.fulfill({ json: result });
  });
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: main } }) : route.continue());
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ': fixture heartbeat\n\n' }));
  let side = null, revision = 0;
  const calls = [], snapshot = () => ({ epoch: "browser-side-fixture", side, revision: ++revision });
  await page.route(`**/api/chats/${chat.id}/side**`, route => {
    const method = route.request().method(), tail = new URL(route.request().url()).pathname.split("/side")[1];
    const input = route.request().postDataJSON();
    if (method !== "GET") calls.push({ method, tail, input });
    if (method === "DELETE") side = null;
    else if (method === "POST" && tail === "") side ||= { id: "side_browser", status: "idle", messages: [], tools: [], pendingRequest: null };
    else if (tail === "/messages") { side.status = "running"; side.messages.push({ id: "side-text", role: "user", text: input.text }); side.tools = [{ itemId: "side-tool", tool: "command", title: "Read side fixture", state: "completed", output: "Side tool result" }]; side.pendingRequest = question("side-request", "Side choice"); }
    else if (tail === "/respond") { side.status = "idle"; side.pendingRequest = null; side.messages.push({ id: "side-answer", role: "assistant", text: "Side-only answer. **Main conversation is untouched.**" }); }
    else if (tail === "/stop") { side.status = "idle"; side.pendingRequest = null; }
    return route.fulfill({ json: snapshot() });
  });
  const mainWrites = [];
  for (const tail of ["messages", "queue", "stop"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { mainWrites.push(tail); return route.fulfill({ json: { chat: main } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, calls, mainWrites };
}

test("side panel preserves the main draft and independently answers questions, resizes and hides", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  const { calls, mainWrites } = await setup(page);
  await page.locator("#message-input").fill("Unsent main draft");
  await page.locator("#approval-card").getByRole("radio", { name: /First/ }).check();
  await page.getByRole("button", { name: "Open side chat", exact: true }).click();
  await expect(page.locator("#side-panel")).toBeVisible();
  await expect(page.locator("#message-input")).toHaveValue("Unsent main draft");
  await expect(page.locator("#side-main-status")).toHaveText("Main chat: running");
  const conversation = await page.locator("#conversation").boundingBox(), panel = await page.locator("#side-panel").boundingBox();
  expect(panel.x).toBeGreaterThan(conversation.x + conversation.width - 2);
  const resizer = page.getByRole("separator", { name: "Resize workspace panel" });
  await resizer.focus(); await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await page.locator("#side-panel").boundingBox()).width).toBeGreaterThan(panel.width);
  await page.getByRole("textbox", { name: "Side message", exact: true }).fill("A focused side question");
  await page.getByRole("button", { name: "Send to side chat", exact: true }).click();
  await expect(page.locator("#side-approval")).toBeVisible();
  await page.locator("#side-approval").getByRole("radio", { name: /Second/ }).check();
  await expect(page.locator("#approval-card").getByRole("radio", { name: /First/ })).toBeChecked();
  await page.locator("#side-approval").getByLabel("Side choice — your answer", { exact: true }).fill("Custom side answer");
  await page.getByRole("button", { name: "Open side chat", exact: true }).click();
  await expect(page.locator("#side-approval").getByLabel("Side choice — your answer", { exact: true })).toHaveValue("Custom side answer");
  await page.locator("#side-approval").getByRole("button", { name: "Send answers", exact: true }).click();
  await expect(page.locator("#side-messages")).toContainText("Side-only answer");
  await page.locator("#side-messages summary").click();
  await expect(page.locator("#side-messages")).toContainText("Read side fixture");
  await expect(page.locator("#messages")).not.toContainText("Side-only answer");
  expect(calls.find(call => call.tail === "/respond").input.answers).toEqual({ choice: "Custom side answer" });
  await expect(page.locator("#approval-card")).toContainText("Main choice?");
  await expect(page.locator("#message-input")).toHaveValue("Unsent main draft");
  await page.screenshot({ path: "test-results/desktop-side-chat.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Hide side chat", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Send to side chat", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Hide side chat", exact: true }).click();
  await expect(page.locator("#side-panel")).not.toBeVisible();
  expect(mainWrites).toEqual([]);
  const opens = calls.filter(call => call.tail === "" && call.method === "POST").length;
  await page.setViewportSize({ width: 1500, height: 1000 }); await page.reload();
  await expect(page.getByRole("button", { name: "Open side chat", exact: true })).toBeVisible();
  expect(calls.filter(call => call.tail === "" && call.method === "POST")).toHaveLength(opens);
  await page.getByRole("button", { name: "Open side chat", exact: true }).click();
  await expect(page.locator("#side-messages")).toContainText("Side-only answer");
});

test("btw with an attachment goes only to the side, and ending it does not stop main", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  const { calls, mainWrites } = await setup(page);
  await page.locator("#attachment-input").setInputFiles({ name: "side.txt", mimeType: "text/plain", buffer: Buffer.from("side attachment") });
  await expect(page.locator("#attachment-chips")).toContainText("side.txt");
  await page.locator("#message-input").fill("/btw Read this attachment separately");
  await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#side-messages")).toContainText("Read this attachment separately");
  await expect(page.locator("#message-input")).toHaveValue("");
  await expect(page.locator("#attachment-chips")).toBeEmpty();
  const sent = calls.find(call => call.tail === "/messages").input;
  expect(sent.text).toBe("Read this attachment separately"); expect(sent.attachments).toHaveLength(1);
  await page.getByRole("button", { name: "Stop side reply", exact: true }).click();
  await expect(page.locator("#side-approval")).not.toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "End side chat", exact: true }).click();
  await expect(page.locator("#side-panel")).not.toBeVisible();
  expect(mainWrites).toEqual([]);
  expect(calls.find(call => call.method === "DELETE").input.sideId).toBe("side_browser");
});

test("a late side-open response cannot send its prompt into a different chat or erase a new draft", async ({ page }) => {
  const { chat, calls, mainWrites } = await setup(page);
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/chats/${chat.id}/side`, async route => {
    if (route.request().method() !== "POST") return route.fallback();
    await delayed;
    return route.fulfill({ json: { epoch: "late", revision: 100, side: { id: "side_late", status: "idle", messages: [], tools: [] } } });
  });
  await page.locator("#message-input").fill("/side Question for the original chat");
  const requested = page.waitForRequest(request => request.url().endsWith(`/${chat.id}/side`) && request.method() === "POST");
  await page.locator("#composer").evaluate(form => form.requestSubmit()); await requested;
  await page.getByRole("button", { name: "Open Existing alpha", exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText("Existing alpha");
  await page.locator("#message-input").fill("New unrelated draft");
  release();
  await expect(page.locator("#toasts")).toContainText("Side action cancelled");
  await expect(page.locator("#side-panel")).not.toBeVisible();
  await expect(page.locator("#message-input")).toHaveValue("New unrelated draft");
  expect(calls.filter(call => call.tail === "/messages")).toHaveLength(0); expect(mainWrites).toEqual([]);
});
