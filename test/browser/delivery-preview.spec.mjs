import { test, expect } from "@playwright/test";
import http from "node:http";

const createdChats = [];
test.afterEach(async ({ request }) => {
  for (const id of createdChats.splice(0)) expect((await request.delete(`/api/chats/${id}`)).ok()).toBe(true);
});

test("stored Markdown and HTML render through real HTTP and SSE, survive reload, and stay isolated", async ({ page, request }, testInfo) => {
  const created = await request.post("/api/chats", { data: { agent: "mock", title: "Disposable rendering delivery check" } });
  expect(created.ok()).toBe(true);
  const { chat } = await created.json();
  createdChats.push(chat.id);
  const externalRequests = [], errors = [], eventStreams = [];
  const forbiddenOrigin = http.createServer((incoming, response) => { externalRequests.push(incoming.url); response.end("Unexpected external request"); });
  await new Promise((resolve, reject) => { forbiddenOrigin.once("error", reject); forbiddenOrigin.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${forbiddenOrigin.address().port}`;
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (new URL(response.url()).pathname === `/api/chats/${chat.id}/events`) eventStreams.push(response.headers()["content-type"]); });
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`/#chat=${chat.id}`);
    const input = page.getByLabel("Message", { exact: true });
    const source = [
      "Rendering delivery sample", "", "## Stored result", "", "| Name | State |", "| --- | --- |", "| Delivery | Saved |", "",
      "```html",
      `<div><style>@import "${origin}/style"; body{background:rgb(10,20,30);color:rgb(230,235,240)} .message{display:none}</style>`,
      '<h1>Stored isolated document</h1><script>parent.document.body.innerHTML="escaped"</script>',
      `<img src="${origin}/image"><iframe src="${origin}/frame"></iframe>`,
      '<table><tr><td>Unclosed stored cell',
      "```", "", "**Transcript remains visible**",
    ].join("\n");
    await input.fill(source);
    await input.press("Enter");
    const answer = page.locator("#messages .message.assistant").first();
    await expect(answer.locator("h2")).toHaveText("Stored result");
    await expect(answer.locator("table td").last()).toHaveText("Saved");
    await expect(answer).toContainText("Transcript remains visible");
    await expect.poll(async () => {
      const { chat: saved } = await (await request.get(`/api/chats/${chat.id}`)).json();
      return { running: saved.status === "running", users: saved.messages.filter(message => message.role === "user").map(message => message.text), answer: saved.messages.find(message => message.role === "assistant")?.text.includes("Transcript remains visible") };
    }).toEqual({ running: false, users: [source], answer: true });
    expect(eventStreams.some(type => type?.startsWith("text/event-stream"))).toBe(true);

    const shellColor = await page.locator("body").evaluate(element => getComputedStyle(element).backgroundColor);
    await answer.getByRole("button", { name: "Open HTML preview ↗", exact: true }).click();
    const frame = page.frameLocator("#preview-content iframe");
    await expect(frame.getByRole("heading", { name: "Stored isolated document" })).toBeVisible();
    await page.frames().find(candidate => new URL(candidate.url()).pathname === "/preview.html").waitForLoadState("load");
    await expect(frame.locator("td")).toHaveText("Unclosed stored cell");
    await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(10, 20, 30)");
    await expect(frame.locator("body")).toHaveCSS("color", "rgb(230, 235, 240)");
    await expect(frame.locator("body script, body iframe")).toHaveCount(0);
    await expect(page.locator("#preview-content iframe")).toHaveAttribute("sandbox", "allow-scripts");
    expect(await page.locator("#preview-content iframe").evaluate(element => element.contentDocument)).toBeNull();
    expect(await page.locator("body").evaluate(element => getComputedStyle(element).backgroundColor)).toBe(shellColor);
    await expect(answer).toContainText("Transcript remains visible");
    await expect(page.locator("#messages iframe")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await input.fill("A real follow-up after the isolated document");
    await input.press("Enter");
    await expect(page.locator("#messages .message.assistant").nth(1)).toContainText("A real follow-up after the isolated document");
    await expect.poll(async () => {
      const { chat: saved } = await (await request.get(`/api/chats/${chat.id}`)).json();
      return saved.status !== "running" && saved.messages.filter(message => message.role === "assistant").length === 2;
    }).toBe(true);

    await page.reload();
    await expect(page.locator("#messages .message.assistant")).toHaveCount(2);
    await expect(answer.locator("h2")).toHaveText("Stored result");
    await expect(page.locator("#messages .message.assistant").nth(1)).toContainText("A real follow-up after the isolated document");
    await answer.getByRole("button", { name: "Open HTML preview ↗", exact: true }).click();
    await expect(frame.getByRole("heading", { name: "Stored isolated document" })).toBeVisible();
    await page.frames().find(candidate => new URL(candidate.url()).pathname === "/preview.html").waitForLoadState("load");
    await expect(frame.locator("td")).toHaveText("Unclosed stored cell");
    await page.screenshot({ path: testInfo.outputPath("stored-preview-desktop.png"), fullPage: true });
    for (const width of [900, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(frame.getByRole("heading", { name: "Stored isolated document" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath("stored-preview-mobile.png"), fullPage: true });
    expect(externalRequests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await new Promise((resolve, reject) => forbiddenOrigin.close(error => error ? reject(error) : resolve()));
  }
});

test("long PR branches do not widen the chat or its document overlay on mobile", async ({ page, request }) => {
  const created = await request.post("/api/chats", { data: { agent: "mock", title: "Disposable PR preview layout" } });
  expect(created.ok()).toBe(true);
  const { chat } = await created.json();
  createdChats.push(chat.id);
  const branch = "feat/a-long-feature-name-that-must-not-expand-the-conversation";
  const snapshot = { ...chat, repositories: [{ fullName: "Acme/long-repository-name" }], workspaceStatus: { branch }, messages: [{ id: "preview-answer", role: "assistant", text: "```html\n<table><tr><td>Saved document</td></tr></table>\n```" }], pullRequests: [{ repository: "Acme/long-repository-name", number: 1789, headRef: branch, state: "open", checks: "failing", conflicts: false, additions: 903, deletions: 19, ci: { inProgress: 0, passed: 2, skipped: 0, failed: 1 }, autoMerge: false }] };
  try {
    await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.continue());
    await page.route("**/api/sidebar", async route => { const response = await route.fetch(), data = await response.json(); data.chats = data.chats.map(item => item.id === chat.id ? { ...item, repositories: snapshot.repositories, workspaceStatus: snapshot.workspaceStatus, pullRequests: snapshot.pullRequests } : item); await route.fulfill({ json: data }); });
    await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": layout fixture\n\n" }));
    await page.goto(`/#chat=${chat.id}`);
    const row = page.locator(".pull-request-bar");
    for (const width of [1600, 900, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(row).toBeVisible();
      await expect(page.locator("#chat-statusline")).toBeHidden();
      await expect(page.locator(".branch-only")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const composer = await page.locator(".composer-wrap").boundingBox(), bounds = await row.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(composer.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(composer.x + composer.width + 1);
      await expect(row.getByRole("link", { name: "⑂ #1789" })).toBeInViewport();
      await expect(row.getByRole("button", { name: "View changes for PR 1789" })).toBeInViewport();
      await expect(row.locator(".ci-menu > summary")).toBeInViewport();
      await expect(row.getByRole("button", { name: "×", exact: true })).toBeInViewport();
      await expect(row.locator(".pr-branch")).toHaveAttribute("title", `Acme/long-repository-name · ${branch}`);
      await page.getByRole("button", { name: "Open HTML preview ↗", exact: true }).click();
      await expect(page.frameLocator("#preview-content iframe").locator("td")).toHaveText("Saved document");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
    }
    expect(await row.locator(".pr-branch").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await row.locator(".ci-menu > summary").click();
    await expect(row.locator(".ci-count.failed strong")).toHaveText("1");
  } finally { await page.close(); }
});
