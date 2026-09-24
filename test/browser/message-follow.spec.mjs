import { test, expect } from "@playwright/test";
test.setTimeout(60000);

const created = new WeakMap();
test.afterEach(async ({ page }) => {
  await page.evaluate(() => { window.followFixtureStreaming = false; }).catch(() => {});
  for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`);
});

async function fixture(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: `Message follow fixture ${Date.now()}` } })).json();
  created.set(page, [chat.id]);
  const messages = Array.from({ length: 100 }, (_, index) => [
    { id: `follow-user-${index}`, role: "user", text: `Follow fixture request ${index}` },
    { id: `follow-reply-${index}`, role: "assistant", text: `## Reply ${index}\n\n${"Readable transcript paragraph. ".repeat(12)}` },
  ]).flat();
  const snapshot = { ...chat, revision: 99999, status: "running", messages };
  const calls = { actions: [], errors: [] };
  page.on("pageerror", error => calls.errors.push(error.message));
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.followFixtureSources = [];
    window.EventSource = class extends Native {
      constructor(...args) { super(...args); window.followFixtureSources.push(this); }
    };
  });
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: snapshot } }));
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": isolated follow fixture\n\n" }));
  await page.route("**/api/sidebar", async route => {
    const response = await route.fetch(), data = await response.json();
    data.chats = data.chats.map(item => item.id === chat.id ? snapshot : item);
    await route.fulfill({ json: data });
  });
  for (const action of ["messages", "queue", "wake", "stop"]) await page.route(`**/api/chats/${chat.id}/${action}`, route => {
    calls.actions.push(action); return route.fulfill({ json: {} });
  });
  await page.goto(`/#chat=${chat.id}`);
  await expect(page.locator("#chat-title")).toHaveText(chat.title, { timeout: 15000 });
  await expect.poll(() => page.evaluate(id => window.followFixtureSources.some(source => source.url.includes(`/chats/${id}/events`)), chat.id)).toBe(true);
  await page.evaluate(id => {
    window.followFixtureEmit = event => {
      const source = window.followFixtureSources.findLast(item => item.url.includes(`/chats/${id}/events`));
      source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    };
  }, chat.id);
  await emit(page, { type: "turn_started", messageId: "follow-stream" });
  await emit(page, { type: "assistant_delta", delta: "## Live answer\n\n" + "Streaming response paragraph. ".repeat(80) });
  await settled(page);
  await expect.poll(() => gap(page)).toBeLessThan(4);
  return { chat, calls };
}

const emit = (page, event) => page.evaluate(value => window.followFixtureEmit(value), event);
const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
const gap = page => page.locator("#messages").evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);

test("streaming follows the bottom through composer and viewport size changes", async ({ page }) => {
  const { calls } = await fixture(page);
  await page.locator("#message-input").fill("Keep this unsent draft\n".repeat(10));
  await settled(page);
  await emit(page, { type: "assistant_delta", delta: "\n\nResponse after composer expansion. " + "More output. ".repeat(60) });
  await expect.poll(() => gap(page)).toBeLessThan(4);
  await page.setViewportSize({ width: 820, height: 600 });
  await settled(page);
  await emit(page, { type: "assistant_delta", delta: "\n\nResponse after viewport resize. " + "More output. ".repeat(60) });
  await expect.poll(() => gap(page)).toBeLessThan(4);
  await settled(page);
  // Model a late image/font layout in the actual mounted reply without another
  // SSE event. The resize observer, not a new transcript render, must follow it.
  await page.locator('[data-message-id="follow-stream"]').evaluate(element => { element.style.paddingBottom = "360px"; });
  await expect.poll(() => gap(page)).toBeLessThan(4);
  await expect(page.locator("#message-input")).toHaveValue("Keep this unsent draft\n".repeat(10));
  expect(await page.locator("#messages .message").count()).toBeLessThanOrEqual(61);
  expect(calls.actions).toEqual([]); expect(calls.errors).toEqual([]);
});

test("a real upward wheel detaches even while every animation frame receives a delta", async ({ page }) => {
  const { calls } = await fixture(page);
  const bounds = await page.locator("#messages").boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.evaluate(() => {
    window.followFixtureStreaming = true; window.followFixtureDeltas = 0;
    const next = () => {
      if (!window.followFixtureStreaming || window.followFixtureDeltas >= 120) return;
      window.followFixtureEmit({ type: "assistant_delta", delta: `\n\nLive paragraph ${++window.followFixtureDeltas}.` });
      requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  });
  try {
    await expect.poll(() => page.evaluate(() => window.followFixtureDeltas)).toBeGreaterThan(3);
    await page.mouse.wheel(0, -600);
    await expect.poll(() => gap(page)).toBeGreaterThan(250);
    const before = await page.evaluate(() => window.followFixtureDeltas);
    await expect.poll(() => page.evaluate(() => window.followFixtureDeltas)).toBeGreaterThan(before + 5);
    expect(await gap(page)).toBeGreaterThan(250);
  } finally { await page.evaluate(() => { window.followFixtureStreaming = false; }); }
  const latest = page.getByRole("button", { name: "Jump to latest", exact: true });
  await expect(latest).toBeInViewport();
  await latest.evaluate(element => { window.followFixtureLatestButton = element; });
  await emit(page, { type: "assistant_delta", delta: "\n\nThe latest control stays mounted." });
  expect(await latest.evaluate(element => element === window.followFixtureLatestButton)).toBe(true);
  await page.screenshot({ path: "test-results/message-follow-desktop.png" });
  await page.setViewportSize({ width: 320, height: 844 });
  if (await page.locator("#sidebar").evaluate(element => element.classList.contains("open"))) await page.getByRole("button", { name: "Close chats", exact: true }).click();
  await expect.poll(() => page.locator("#sidebar").evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await expect(latest).toBeInViewport();
  const latestBounds = await latest.boundingBox(), composer = await page.locator("#composer").boundingBox();
  expect(latestBounds.y + latestBounds.height).toBeLessThanOrEqual(composer.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/message-follow-mobile.png" });
  await latest.click(); await expect.poll(() => gap(page)).toBeLessThan(4);
  expect(calls.actions).toEqual([]); expect(calls.errors).toEqual([]);
});

test("virtualized history stays selected during streaming and Jump to latest restores following", async ({ page }) => {
  const { calls } = await fixture(page);
  await page.locator("#message-navigator > button").click();
  await page.getByRole("button", { name: "Jump to message 1: Follow fixture request 0", exact: true }).click();
  await expect(page.locator('[data-message-id="follow-user-0"]')).toBeInViewport();
  await settled(page);
  const anchor = await page.locator('[data-message-id="follow-user-0"]').boundingBox();
  for (let index = 0; index < 4; index++) await emit(page, { type: "assistant_delta", delta: `\n\nBackground stream paragraph ${index}.` });
  await expect(page.locator('[data-message-id="follow-user-0"]')).toBeInViewport();
  expect(Math.abs((await page.locator('[data-message-id="follow-user-0"]').boundingBox()).y - anchor.y)).toBeLessThan(3);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(() => gap(page)).toBeLessThan(4);
  await emit(page, { type: "assistant_delta", delta: "\n\nFollowing resumes after explicit jump." });
  await expect.poll(() => gap(page)).toBeLessThan(4);
  await expect(page.locator('[data-message-id="follow-stream"]')).toContainText("Following resumes after explicit jump.");
  expect(await page.locator("#messages .message").count()).toBeLessThanOrEqual(61);
  expect(calls.actions).toEqual([]); expect(calls.errors).toEqual([]);
});
