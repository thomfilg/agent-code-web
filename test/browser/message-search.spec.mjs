import { test, expect } from "@playwright/test";

async function fixture(page, request) {
  const { chats } = await (await request.get("/api/chats")).json(), chat = chats.find(item => item.title === "PR controls fixture");
  const target = { id: "search-old-final", role: "assistant", kind: "message", agent: "codex", text: "An old final needle <script>window.searchInjected=true</script>", createdAt: "2026-09-19T12:00:00Z" };
  await page.route(`**/api/chats/${chat.id}`, async route => {
    const response = await route.fetch(), body = await response.json();
    body.chat.messages = [target, ...Array.from({ length: 160 }, (_, i) => ({ id: `search-padding-${i}`, role: i % 2 ? "assistant" : "user", kind: "message", text: `Later fixture message ${i}`, createdAt: target.createdAt }))];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/"); await page.getByRole("button", { name: "Open PR controls fixture", exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText("PR controls fixture");
  const effects = []; page.on("request", request => { if (request.method() === "POST" && /\/api\/chats(?:$|\/[^/]+\/(?:messages|queue|wake|start)$)/.test(new URL(request.url()).pathname)) effects.push(request.url()); });
  return { effects, chat, target, match: { chatId: chat.id, messageId: target.id, title: chat.title, role: "assistant", repository: "Acme/api", companyId: "acme", createdAt: target.createdAt, excerpt: target.text } };
}
const result = (results, nextOffset = null) => ({ results, nextOffset, truncated: nextOffset !== null, coverage: "Only user messages and explicitly identified final answers. Older or unclassified answers, tools and intermediate output are excluded." });
async function open(page) { if (await page.locator("#open-sidebar").isVisible() && !(await page.locator("#sidebar").getAttribute("class")).includes("open")) await page.locator("#open-sidebar").click(); await page.locator("#message-search-button").click(); }
const rows = page => page.locator(".message-search-result");

test("literal final search jumps beyond rendered history and preserves draft without wake or send", async ({ page, request }) => {
  const f = await fixture(page, request); await page.locator("#message-input").fill("Keep this unsent draft");
  await page.route("**/api/message-search", route => route.fulfill({ json: result([f.match]) }));
  await open(page); await page.locator("#message-search-query").fill("needle"); await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).locator("mark")).toHaveText("needle"); expect(await page.evaluate(() => window.searchInjected)).toBeUndefined();
  await rows(page).click(); await expect(page.locator("#message-search-dialog")).not.toBeVisible();
  await expect(page.locator('[data-message-id="search-old-final"]')).toBeInViewport(); await expect(page.locator('[data-message-id="search-old-final"]')).toBeFocused();
  await expect(page.locator("#message-input")).toHaveValue("Keep this unsent draft"); expect(f.effects).toEqual([]);
});
test("load-more keeps earlier result buttons actionable and no-hit scan pages can continue", async ({ page, request }) => {
  const f = await fixture(page, request); let calls = 0;
  await page.route("**/api/message-search", route => {
    const { offset } = route.request().postDataJSON(); calls++;
    return route.fulfill({ json: offset === 0 ? result([], 5000) : offset === 5000 ? result([f.match], 5040) : result([{ ...f.match, messageId: "search-padding-159", excerpt: "Another needle final" }]) });
  });
  await open(page); await page.locator("#message-search-query").fill("needle"); await expect(page.locator("#message-search-more")).toBeVisible();
  await page.locator("#message-search-more").click(); await expect(rows(page)).toHaveCount(1); await page.locator("#message-search-more").click(); await expect(rows(page)).toHaveCount(2);
  await rows(page).first().click(); await expect(page.locator('[data-message-id="search-old-final"]')).toBeInViewport(); expect(calls).toBe(3); expect(f.effects).toEqual([]);
});
test("verified final projections remain jumpable when their streamed display suffix was empty", async ({ page, request }) => {
  const f = await fixture(page, request);
  await page.route(`**/api/chats/${f.chat.id}`, async route => {
    const response = await route.fetch(), body = await response.json(); body.chat.messages = [{ ...f.target, text: "", meta: { segmentedTurn: true, finalAnswer: { version: 1, source: "codex-final-answer", text: f.target.text } } }];
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/message-search", route => route.fulfill({ json: result([f.match]) }));
  await open(page); await page.locator("#message-search-query").fill("needle"); await rows(page).click();
  await expect(page.locator('[data-message-id="search-old-final"]')).toContainText("An old final needle"); await expect(page.locator('[data-message-id="search-old-final"]')).toBeInViewport(); expect(f.effects).toEqual([]);
});
test("closing and reopening search fences a delayed response and preserves the new-chat draft", async ({ page, request }) => {
  const f = await fixture(page, request), gate = Promise.withResolvers(); let pending = false, delivered = false;
  await page.locator("#new-chat-button").click(); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false); await page.locator("#initial-prompt").fill("New project draft");
  await page.route("**/api/message-search", async route => { if (route.request().postDataJSON().query === "old") { pending = true; await gate.promise; await route.fulfill({ json: result([{ ...f.match, title: "STALE OLD RESULT" }]) }); delivered = true; return; } return route.fulfill({ json: result([f.match]) }); });
  try {
    await open(page); await page.locator("#message-search-query").fill("old"); await expect.poll(() => pending).toBe(true); await page.keyboard.press("Escape");
    await open(page); await page.locator("#message-search-query").fill("needle"); await expect(rows(page)).toHaveCount(1); gate.resolve(); await expect.poll(() => delivered).toBe(true); await expect(rows(page)).not.toContainText("STALE");
    await page.keyboard.press("Escape"); await expect(page.locator("#initial-prompt")).toHaveValue("New project draft"); expect(f.effects).toEqual([]);
  } finally { gate.resolve(); }
});
test("changing role starts a fresh query and does not append an old page", async ({ page, request }) => {
  const f = await fixture(page, request), seen = [];
  await page.route("**/api/message-search", route => { const input = route.request().postDataJSON(); seen.push(input); return route.fulfill({ json: result([{ ...f.match, role: input.role === "user" ? "user" : "assistant" }], input.role === "all" ? 40 : null) }); });
  await open(page); await page.locator("#message-search-query").fill("needle"); await expect(rows(page)).toHaveCount(1); await page.locator("#message-search-role").selectOption("user");
  await expect(rows(page)).toHaveCount(1); await expect(rows(page).locator("small")).toContainText("You ·"); await expect(page.locator("#message-search-more")).not.toBeVisible();
  expect(seen.map(({ role, offset }) => [role, offset])).toEqual([["all", 0], ["user", 0]]); expect(f.effects).toEqual([]);
});
test("search dialog is keyboard accessible and fits desktop and mobile", async ({ page, request }, testInfo) => {
  const f = await fixture(page, request); await page.route("**/api/message-search", route => route.fulfill({ json: result([f.match]) }));
  await open(page); await expect(page.locator("#message-search-query")).toBeFocused(); await page.locator("#message-search-query").fill("needle"); await expect(rows(page)).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("message-search-desktop.png") }); await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows(page)).toBeInViewport(); await expect(page.locator("#message-search-close")).toBeInViewport();
  expect(await page.locator("#message-search-dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("message-search-mobile.png") }); await page.keyboard.press("Escape"); await expect(page.locator("#message-search-dialog")).not.toBeVisible(); await expect(page.locator("#open-sidebar")).toBeFocused();
});
