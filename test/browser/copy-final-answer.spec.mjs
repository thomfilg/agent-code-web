import { test, expect } from "@playwright/test";

const finalText = "The final answer only.\n\n```js\nconst literal = '<b>safe</b>';\n```";
async function fixture(page, request, { final = true, clipboard = "success" } = {}) {
  const { chats } = await (await request.get("/api/chats")).json();
  const chat = chats.find(item => item.title === "PR controls fixture");
  const body = await (await request.get(`/api/chats/${chat.id}`)).json();
  const message = (id, text, meta = {}) => ({ id, role: "assistant", kind: "message", agent: "codex", text, meta, createdAt: "2026-09-19T12:00:00Z" });
  body.chat.messages = [
    ...(final ? [message("copy-final", "", { segmentedTurn: true, finalAnswer: { version: 1, source: "codex-final-answer", text: finalText } })] : []),
    message("copy-commentary", "PRIVATE intermediate update", { commentary: true }),
    message("copy-interrupted", "PRIVATE unfinished output", { interrupted: true }),
    message("copy-unknown", "PRIVATE unclassified output"),
  ];
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: body }));
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "chat_updated", chat: body.chat })}\n\n` }));
  await page.addInitScript(mode => {
    window.clipboardWrites = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => {
      window.clipboardWrites.push(text);
      if (mode === "denied") throw Error("Clipboard permission denied");
      if (mode === "held") await new Promise((resolve, reject) => { window.finishClipboard = rejected => rejected ? reject(Error("Denied after navigation")) : resolve(); });
    } } });
  }, clipboard);
  const effects = [];
  page.on("request", request => { if (request.method() !== "GET" && /\/api\/chats(?:$|\/[^/]+\/(?:messages|queue|wake|start|stop)$)/.test(new URL(request.url()).pathname)) effects.push(request.url()); });
  await page.goto("/"); await page.getByRole("button", { name: "Open PR controls fixture", exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText(chat.title);
  await expect(page.locator('[data-message-id="copy-unknown"]')).toContainText("PRIVATE unclassified output");
  return { effects };
}
async function copy(page) { await page.locator("#message-input").fill("/copy"); await page.locator("#send-button").click(); }

test("/copy uses the exact proven final projection, not later commentary or interrupted output", async ({ page, request }) => {
  const f = await fixture(page, request); await copy(page);
  await expect(page.locator("#toasts")).toContainText("Latest response copied");
  expect(await page.evaluate(() => window.clipboardWrites)).toEqual([finalText]);
  await expect(page.locator("#message-input")).toHaveValue(""); expect(f.effects).toEqual([]);
});
test("/copy without proven final keeps the command and reports the error without a model turn", async ({ page, request }) => {
  const f = await fixture(page, request, { final: false }); await copy(page);
  await expect(page.locator("#toasts")).toContainText("No completed assistant response to copy yet");
  await expect(page.locator("#message-input")).toHaveValue("/copy");
  expect(await page.evaluate(() => window.clipboardWrites)).toEqual([]); expect(f.effects).toEqual([]);
});
test("denied clipboard preserves the literal final answer in the manual-copy dialog", async ({ page, request }) => {
  const f = await fixture(page, request, { clipboard: "denied" }); await copy(page);
  await expect(page.locator("#controls-dialog")).toBeVisible(); await expect(page.locator("#controls-title")).toHaveText("Copy");
  await expect(page.locator("#controls-content pre")).toHaveText(finalText);
  await expect(page.locator("#controls-content b")).toHaveCount(0); expect(f.effects).toEqual([]);
});
for (const rejected of [false, true]) test(`pending clipboard ${rejected ? "failure" : "success"} cannot clear a revisited chat draft or show stale UI`, async ({ page, request }) => {
  const f = await fixture(page, request, { clipboard: "held" }); await copy(page);
  await expect.poll(() => page.evaluate(() => window.clipboardWrites.length)).toBe(1);
  await page.locator("#new-chat-button").click(); await expect(page.locator("#initial-prompt")).toBeVisible();
  await page.getByRole("button", { name: "Open PR controls fixture", exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText("PR controls fixture"); await page.locator("#message-input").fill("/copy");
  await page.evaluate(rejected => window.finishClipboard(rejected), rejected);
  // Flush the clipboard continuation and command handler, without timing sleeps.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("#message-input")).toHaveValue("/copy");
  await expect(page.locator("#controls-dialog")).not.toBeVisible(); await expect(page.locator("#toasts")).not.toContainText("Latest response copied");
  expect(await page.evaluate(() => window.clipboardWrites)).toEqual([finalText]); expect(f.effects).toEqual([]);
});
