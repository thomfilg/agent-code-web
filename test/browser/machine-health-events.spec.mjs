import { test, expect } from "@playwright/test";

test("machine health refreshes on a durable event without a four-second browser poll", async ({ page, request }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Health push fixture" } })).json();
  let samples = 0;
  await page.route(`**/api/chats/${chat.id}/machine-health`, async route => { samples++; await route.continue(); });
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.healthSources = [];
    window.EventSource = class extends Native {
      constructor(url, options) { super(url, options); window.healthSources.push(this); }
    };
  });
  try {
    await page.goto(`/#chat=${chat.id}`);
    await expect(page.locator("#chat-title")).toHaveText(chat.title);
    await expect.poll(() => samples).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(id => window.healthSources.some(source => source.url.includes(`/chats/${id}/worker-events`)), chat.id)).toBe(true);
    await page.waitForTimeout(350);
    const settled = samples;
    await page.waitForTimeout(4_500);
    expect(samples).toBe(settled);
    await page.evaluate(id => {
      const source = window.healthSources.find(item => item.url.includes(`/chats/${id}/worker-events`));
      source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "machine-health-change" }) }));
    }, chat.id);
    await expect.poll(() => samples).toBeGreaterThan(settled);
  } finally { await request.delete(`/api/chats/${chat.id}`); }
});
