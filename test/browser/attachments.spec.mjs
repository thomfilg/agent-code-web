import { test, expect } from "@playwright/test";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
let chatId, fixtureGitHubId;
test.afterEach(async ({ request }) => {
  if (chatId) await request.delete(`/api/chats/${chatId}`); chatId = null;
  if (fixtureGitHubId) await request.delete(`/api/github/connections/${fixtureGitHubId}`); fixtureGitHubId = null;
});

async function prepareNewChat(page) {
  // This server injects a synthetic device-login factory and GitHub API fetch;
  // no provider, account profile, clone or native agent is used by these cases.
  const login = await page.request.post("/api/github/device", { headers: { origin: "http://127.0.0.1:8879" }, data: { companyId: "acme" } });
  expect(login.ok()).toBe(true); fixtureGitHubId = (await login.json()).connection.id;
  await expect.poll(async () => (await (await page.request.get("/api/github")).json()).connections.some(item => item.id === fixtureGitHubId && item.connected)).toBe(true);
  const { environments } = await (await page.request.get("/api/environments")).json();
  await page.route("**/api/preferences", route => route.fulfill({ json: { preferences: { agent: "mock", environmentId: environments.find(env => env.companyId === "acme").id, repositories: [] } } }));
  await page.goto("/#new"); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  await page.locator("#agent-select").selectOption("mock");
  if (!await page.locator("#selected-repositories").getByLabel("Remove Acme/api", { exact: true }).count()) {
    await page.getByRole("button", { name: "Add repositories", exact: true }).click();
    await page.locator("#repository-results").getByRole("checkbox", { name: /Acme\/api/ }).check();
    await page.getByRole("button", { name: "Add repositories", exact: true }).click();
  }
  await expect(page.locator("#create-chat-button")).toBeEnabled();
}

test("pasted images can be previewed before and after sending, without losing the draft", async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Attachment preview fixture" } })).json(); chatId = chat.id;
  await page.goto(`/#chat=${chat.id}`); const input = page.getByLabel("Message", { exact: true }); await input.fill("Review this cropped image");
  await input.evaluate((node, base64) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0)), transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "cropped.png", { type: "image/png" }));
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, png.toString("base64"));
  const chip = page.locator("#attachment-chips").getByRole("button", { name: "Preview cropped.png", exact: true });
  await expect(chip).toBeVisible(); await chip.click();
  const image = page.locator("#preview-content img"); await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBe(1);
  await expect(input).toHaveValue("Review this cropped image");
  await page.getByRole("button", { name: "Actual size", exact: true }).click(); await expect(page.locator("#preview-content")).toHaveClass(/image-actual-size/);
  await page.getByLabel("Close preview", { exact: true }).click(); await expect(chip).toBeFocused();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("#attachment-chips")).toBeEmpty();
  await page.locator("#messages").getByRole("button", { name: "Preview cropped.png", exact: true }).click();
  await expect(image).toBeVisible(); await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByLabel("Close preview", { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel("Close preview", { exact: true }).click();
  await expect(page.locator("#runtime-status")).toHaveText("Ready"); await expect(page.locator("#countdown")).toHaveText("KEPT AWAKE");
});

test("image removal is separate from previewing, and normal pasted text is left alone", async ({ page, request }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Attachment removal fixture" } })).json(); chatId = chat.id;
  await page.goto(`/#chat=${chat.id}`);
  // Unlike clicking the visible attachment picker, setInputFiles can target a
  // hidden input before startup has selected a chat. Assert the real UI is ready.
  await expect(page.locator("#chat-title")).toHaveText(chat.title);
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.locator("#attachment-input").setInputFiles({ name: "picture.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Remove picture.png", exact: true }).click();
  await expect(page.locator("#attachment-chips")).toBeEmpty(); await expect(page.locator("#preview-panel")).not.toBeVisible();
  expect(await page.getByLabel("Message", { exact: true }).evaluate(node => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", "ordinary text");
    return node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  })).toBe(true);
});

async function drop(page, selector, files) {
  return page.locator(selector).evaluate((node, entries) => {
    const transfer = new DataTransfer();
    for (const file of entries) transfer.items.add(new File([Uint8Array.from(atob(file.data), char => char.charCodeAt(0))], file.name, { type: file.mime }));
    node.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    node.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    return node.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, files);
}
const droppedText = (name, text = "First line\nSecond line\n") => ({ name, mime: "text/plain", data: Buffer.from(text).toString("base64") });
const droppedImage = { name: "screenshot.png", mime: "image/png", data: png.toString("base64") };

test("one-row thumbnail/file cards preview literal text before and after sending, with mobile containment", async ({ page, request }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "File card fixture" } })).json(); chatId = chat.id;
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  const source = '<script>window.attachmentExecuted=true</script>\n<img src=x onerror="window.attachmentExecuted=true">\n';
  await page.locator("#message-input").fill("Keep this draft");
  expect(await drop(page, "#messages", [droppedImage, droppedText("markup.html", source), droppedText("readme.md")])).toBe(false);
  const cards = page.locator("#attachment-chips .attachment-open"); await expect(cards).toHaveCount(3);
  await expect(page.locator("#attachment-chips img")).toBeVisible();
  await expect(page.locator("#message-input")).toHaveValue("Keep this draft");
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.messages).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath("attachment-cards-desktop.png"), fullPage: true });
  const textCard = page.getByRole("button", { name: "Preview markup.html", exact: true }); await textCard.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#preview-title")).toHaveText("markup.html");
  await expect(page.locator("#preview-note")).toContainText("2 lines"); await expect(page.locator("#preview-note")).toContainText(`${Buffer.byteLength(source)} B`);
  await expect(page.locator("#preview-content pre")).toHaveText(source); await expect(page.locator("#preview-content iframe, #preview-content script")).toHaveCount(0);
  expect(await page.evaluate(() => window.attachmentExecuted)).toBeUndefined();
  await page.keyboard.press("Escape"); await expect(textCard).toBeFocused();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("#attachment-chips")).toBeEmpty();
  await page.locator("#messages").getByRole("button", { name: "Preview markup.html", exact: true }).click();
  await expect(page.locator("#preview-content pre")).toHaveText(source); await page.getByLabel("Close preview", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator(".sidebar.open").isVisible()) await page.getByRole("button", { name: "Close chats" }).click();
  await drop(page, "#message-input", [droppedImage, droppedText("mobile.txt"), droppedText("extra.txt")]); await expect(cards).toHaveCount(3);
  const boxes = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top)); expect(new Set(boxes).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("attachment-cards-mobile.png"), fullPage: true });
  await cards.nth(1).click(); await expect(page.locator("#preview-content pre")).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("attachment-text-mobile.png"), fullPage: true });
});

test("drop validation preserves draft and files, rejects folders and oversize, and never sends", async ({ page, request }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Drop validation fixture" } })).json(); chatId = chat.id;
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title); await page.locator("#message-input").fill("Do not send yet");
  await drop(page, "#messages", [droppedText("existing.txt")]); await expect(page.locator("#attachment-chips .attachment-open")).toHaveCount(1);
  await page.locator("#messages").evaluate(node => {
    const transfer = new DataTransfer(); transfer.items.add(new File([""], "folder"));
    const original = DataTransferItem.prototype.webkitGetAsEntry;
    DataTransferItem.prototype.webkitGetAsEntry = () => ({ isDirectory: true });
    try { node.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true })); }
    finally { DataTransferItem.prototype.webkitGetAsEntry = original; }
  });
  await expect(page.locator("#toasts")).toContainText("Folders cannot be attached");
  await page.locator("#attachment-input").setInputFiles({ name: "too-big.txt", mimeType: "text/plain", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(page.locator("#toasts")).toContainText("maximum file size");
  await expect(page.locator("#attachment-chips .attachment-open")).toHaveCount(1); await expect(page.locator("#message-input")).toHaveValue("Do not send yet");
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.messages).toHaveLength(0);
});

test("new-chat files stay local until explicit send, failed upload keeps them in the created chat for retry", async ({ page, request }) => {
  let creates = 0, sends = 0, uploads = 0, fail = true;
  await page.route("**/api/chats", async route => { if (route.request().method() === "POST") { creates++; const response = await route.fetch(); chatId = (await response.json()).chat.id; await route.fulfill({ response }); } else await route.continue(); });
  await page.route("**/api/chats/*/messages", route => { if (route.request().method() === "POST") sends++; return route.continue(); });
  await page.route("**/api/chats/*/attachments", route => { uploads++; return fail ? route.fulfill({ status: 503, json: { error: "Synthetic upload unavailable" } }) : route.continue(); });
  await prepareNewChat(page); await page.locator("#initial-prompt").fill("Review these files");
  await drop(page, "#initial-prompt", [droppedText("new-draft.txt"), droppedImage]);
  await expect(page.locator("#new-attachment-chips .attachment-open")).toHaveCount(2);
  await page.getByRole("button", { name: "Preview new-draft.txt", exact: true }).click(); await expect(page.locator("#preview-note")).toContainText("2 lines");
  await page.getByLabel("Close preview", { exact: true }).click();
  expect({ creates, sends, uploads }).toEqual({ creates: 0, sends: 0, uploads: 0 });
  await page.locator("#initial-prompt").press("Enter");
  await expect(page.locator("#toasts")).toContainText("Files could not be uploaded");
  await expect(page.locator("#message-input")).toHaveValue("Review these files"); await expect(page.locator("#attachment-chips .attachment-open")).toHaveCount(2);
  expect(creates).toBe(1); expect(sends).toBe(0); fail = false;
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await expect.poll(() => sends).toBe(1);
  await expect(page.locator("#attachment-chips")).toBeEmpty(); expect(creates).toBe(1);
  await expect.poll(async () => (await (await request.get(`/api/chats/${chatId}`)).json()).chat.messages.some(message => message.role === "user" && message.attachments?.length === 2)).toBe(true);
});

test("new-chat attachment drafts stay with their selected company, not another company's selection", async ({ page }) => {
  await page.route("**/api/environments", route => route.fulfill({ json: { environments: ["acme", "other"].map(company => ({ id: `env-${company}`, name: company, companyId: company, companies: [company], allowUnassigned: false })), software: [] } }));
  await page.route("**/api/preferences*", route => route.fulfill({ json: { preferences: {} } }));
  await page.goto("/#new"); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  await page.locator("#environment-select").selectOption("env-acme");
  await page.locator("#initial-prompt").fill("Preserved text"); await drop(page, "#initial-prompt", [droppedText("acme-only.txt")]);
  await expect(page.locator("#new-attachment-chips .attachment-open")).toHaveCount(1);
  await page.getByRole("button", { name: "Preview acme-only.txt", exact: true }).click(); await expect(page.locator("#preview-panel")).toBeVisible();
  await page.locator("#environment-select").selectOption("env-other"); await expect(page.locator("#new-attachment-chips .attachment-open")).toHaveCount(0);
  await expect(page.locator("#preview-panel")).toBeHidden();
  await drop(page, "#initial-prompt", [droppedText("other-only.txt")]); await expect(page.locator("#new-attachment-chips")).toContainText("other-only.txt");
  await page.locator("#environment-select").selectOption("env-acme"); await expect(page.locator("#new-attachment-chips")).toContainText("acme-only.txt");
  await expect(page.locator("#new-attachment-chips")).not.toContainText("other-only.txt"); await expect(page.locator("#initial-prompt")).toHaveValue("Preserved text");
});

test("a failed pending file-only read does not create or send a chat", async ({ page }) => {
  let creates = 0;
  await page.route("**/api/chats", route => { if (route.request().method() === "POST") creates++; return route.continue(); });
  await prepareNewChat(page);
  await page.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function () { window.failAttachmentRead = () => { FileReader.prototype.readAsDataURL = original; this.onerror(new Error("Synthetic file read failure")); }; };
  });
  await drop(page, "#initial-prompt", [droppedText("unreadable.txt")]);
  await expect.poll(() => page.evaluate(() => typeof window.failAttachmentRead)).toBe("function");
  await page.locator("#create-chat-button").click(); await page.evaluate(() => window.failAttachmentRead());
  await expect(page.locator("#create-chat-error")).toContainText("valid file"); expect(creates).toBe(0);
  await expect(page.locator("#new-attachment-chips .attachment-open")).toHaveCount(0);
});

for (const pendingRead of [false, true]) test(`file-only first send waits for local file reads (${pendingRead ? "held reader" : "ready file"})`, async ({ page, request }) => {
  let creates = 0;
  await page.route("**/api/chats", async route => {
    if (route.request().method() !== "POST") return route.continue();
    creates++; const response = await route.fetch(); chatId = (await response.json()).chat.id; await route.fulfill({ response });
  });
  await prepareNewChat(page);
  if (pendingRead) await page.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (file) { window.releaseAttachmentRead = () => { FileReader.prototype.readAsDataURL = original; original.call(this, file); }; };
  });
  await drop(page, "#initial-prompt", [droppedText("only-file.txt")]);
  if (pendingRead) await expect.poll(() => page.evaluate(() => typeof window.releaseAttachmentRead)).toBe("function");
  else await expect(page.locator("#new-attachment-chips .attachment-open")).toHaveCount(1);
  await page.locator("#create-chat-button").click();
  if (pendingRead) { expect(creates).toBe(0); await page.evaluate(() => window.releaseAttachmentRead()); }
  await expect.poll(() => creates).toBe(1); await expect(page.locator("#conversation")).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/chats/${chatId}`)).json()).chat.messages.some(message => message.role === "user" && message.attachments?.[0]?.name === "only-file.txt")).toBe(true);
  await expect(page.locator("#attachment-chips")).toBeEmpty();
});

test("navigation during delayed first creation leaves attachments on that new chat, not the selected chat", async ({ page, request }) => {
  const gate = Promise.withResolvers(); let entered = false, sends = 0;
  await page.route("**/api/chats", async route => {
    if (route.request().method() !== "POST") return route.continue();
    entered = true; await gate.promise; const response = await route.fetch(); chatId = (await response.json()).chat.id; await route.fulfill({ response });
  });
  await page.route("**/api/chats/*/messages", route => { sends++; return route.continue(); });
  try {
    await prepareNewChat(page); await page.locator("#initial-prompt").fill("My attachment task");
    await drop(page, "#initial-prompt", [droppedText("owned-draft.txt")]); await expect(page.locator("#new-attachment-chips .attachment-open")).toHaveCount(1);
    await page.locator("#create-chat-button").click(); await expect.poll(() => entered).toBe(true);
    await page.getByRole("button", { name: "Open Existing alpha", exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText("Existing alpha");
    gate.resolve(); await expect(page.locator("#toasts")).toContainText("files are kept in its draft");
    expect(sends).toBe(0); await expect(page.locator("#attachment-chips")).toBeEmpty();
    const { chat } = await (await request.get(`/api/chats/${chatId}`)).json(); expect(chat.messages).toHaveLength(0);
    await page.locator(`#chat-list [data-chat-id="${chatId}"]`).getByRole("button", { name: /^Open / }).click();
    await expect(page.locator("#attachment-chips")).toContainText("owned-draft.txt"); await expect(page.locator("#message-input")).toHaveValue("My attachment task");
  } finally { gate.resolve(); }
});

test("navigation while a new file is still being read prevents chat creation and retains its draft", async ({ page }) => {
  let creates = 0;
  await page.route("**/api/chats", route => { if (route.request().method() === "POST") creates++; return route.continue(); });
  await prepareNewChat(page); await page.locator("#initial-prompt").fill("Read later");
  await page.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (file) { window.releaseAttachmentRead = () => { FileReader.prototype.readAsDataURL = original; original.call(this, file); }; };
  });
  await drop(page, "#initial-prompt", [droppedText("held-draft.txt")]);
  await expect.poll(() => page.evaluate(() => typeof window.releaseAttachmentRead)).toBe("function");
  await page.locator("#create-chat-button").click();
  await page.getByRole("button", { name: "Open Existing alpha", exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText("Existing alpha");
  await page.evaluate(() => window.releaseAttachmentRead());
  await expect(page.locator("#toasts")).toContainText("Nothing was sent"); expect(creates).toBe(0);
  await page.locator("#new-chat-button").click();
  await expect(page.locator("#new-attachment-chips")).toContainText("held-draft.txt");
  await expect(page.locator("#initial-prompt")).toHaveValue("Read later");
});

test("a first /plan task carries its staged files through the command dispatcher", async ({ page, request }) => {
  await page.route("**/api/chats", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(); chatId = (await response.json()).chat.id; await route.fulfill({ response });
  });
  await prepareNewChat(page); await page.locator("#initial-prompt").fill("/plan Review this file");
  await drop(page, "#initial-prompt", [droppedText("plan.txt")]); await expect(page.locator("#new-attachment-chips .attachment-open")).toHaveCount(1);
  await page.locator("#create-chat-button").click(); await expect(page.locator("#conversation")).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/chats/${chatId}`)).json()).chat.messages.some(message => message.role === "user" && message.attachments?.[0]?.name === "plan.txt")).toBe(true);
  await expect(page.locator("#attachment-chips")).toBeEmpty();
});
