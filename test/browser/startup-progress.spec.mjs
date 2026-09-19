import { test, expect } from "@playwright/test";

async function fixture(page, request) {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Startup progress fixture" } })).json();
  const start = Date.now() - 20000, at = seconds => new Date(start + seconds * 1000).toISOString();
  const current = { ...chat, status: "starting", statusDetail: "Starting isolated runtime", revision: 9000,
    startupProgress: { startedAt: at(0), stages: [
      { id: "repository", label: "Preparing repositories", status: "running", startedAt: at(0) },
      { id: "machine", label: "Starting machine", status: "running", startedAt: at(2) },
    ] } };
  await page.addInitScript(() => { window.EventSource = class { constructor() { window.fixtureSource = this; } close() {} }; });
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: current } }) : route.continue());
  await page.route(`**/api/chats/${chat.id}/presence`, route => route.fulfill({ json: {} }));
  const publish = async () => {
    current.revision++;
    await page.evaluate(chat => window.fixtureSource.onmessage({ data: JSON.stringify({ type: "chat_updated", chat }) }), current);
  };
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { id: chat.id, current, at, publish };
}

test("startup shows parallel stages with a ticking persisted timer, preserves disclosure focus, and freezes finished timings", async ({ page, request }, testInfo) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const f = await fixture(page, request);
  try {
    const disclosure = page.locator("#startup-progress"), summary = disclosure.locator("summary");
    await expect(summary).toContainText("Preparing repositories + Starting machine · 0m 2");
    await expect(page.locator("#working-status")).toContainText("Starting · 0m 2");
    await expect(page.locator("#runtime-detail")).toBeHidden();
    expect((await page.locator("#runtime-banner").boundingBox()).height).toBeLessThan(90);
    await page.screenshot({ path: testInfo.outputPath("startup-desktop-collapsed.png") });
    await summary.click();
    await expect(disclosure.locator("li")).toHaveCount(2);
    const before = await summary.textContent();
    await expect.poll(() => summary.textContent()).not.toBe(before);
    await expect(disclosure).toHaveAttribute("open", ""); await expect(summary).toBeFocused();
    f.current.startupProgress.stages[0] = { ...f.current.startupProgress.stages[0], status: "completed", finishedAt: f.at(8) };
    await f.publish();
    await expect(summary).toContainText("Starting machine ·");
    await expect(disclosure.locator('[data-stage="repository"]')).toHaveText("Preparing repositoriesCompleted · 0m 8s");
    await expect(summary).toBeFocused(); await expect(disclosure).toHaveAttribute("open", "");
    f.current.status = "idle"; f.current.statusDetail = "Ready";
    f.current.startupProgress.finishedAt = f.at(25);
    f.current.startupProgress.stages[1] = { ...f.current.startupProgress.stages[1], status: "completed", finishedAt: f.at(24) };
    await f.publish();
    await expect(summary).toHaveText("Startup completed · 0m 25s");
    await page.clock.install(); await page.clock.fastForward(5000);
    await expect(summary).toHaveText("Startup completed · 0m 25s");
    await expect(disclosure).toHaveAttribute("open", ""); await expect(summary).toBeFocused();
    await expect(page.locator("#runtime-detail")).toHaveText("Ready");
    await page.reload(); await expect(summary).toHaveText("Startup completed · 0m 25s");
    await summary.click(); await expect(disclosure.locator('[data-stage="machine"]')).toContainText("Completed · 0m 22s");
    await page.setViewportSize({ width: 390, height: 844 });
    // Exercise the mobile drawer controls, then wait until the closing
    // transition is over so it cannot obscure the startup timing evidence.
    await page.locator("#open-sidebar").click(); await page.locator("#close-sidebar").click();
    await page.clock.fastForward(1000);
    await expect.poll(async () => { const box = await page.locator("#sidebar").boundingBox(); return box.x + box.width; }).toBeLessThanOrEqual(0);
    await expect(summary).toBeVisible(); await expect(disclosure.locator("ul")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("startup-mobile-expanded.png"), animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await request.delete(`/api/chats/${f.id}`); }
});

test("pending deletion takes priority over startup progress, including timer ticks and failed-delete retry", async ({ page, request }) => {
  const f = await fixture(page, request), release = Promise.withResolvers();
  await page.route(`**/api/chats/${f.id}`, async route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await release.promise; await route.fulfill({ status: 503, json: { error: "Worker stop failed; chat retained" } });
  });
  try {
    await expect(page.locator("#startup-progress")).toBeVisible();
    page.on("dialog", dialog => dialog.accept());
    await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#delete-button").click();
    await expect(page.locator("#runtime-detail")).toBeVisible();
    await expect(page.locator("#runtime-detail")).toContainText("Deleting chat");
    await expect(page.locator("#startup-progress")).toBeHidden();
    await page.clock.install(); await page.clock.fastForward(3000);
    await expect(page.locator("#runtime-detail")).toBeVisible(); await expect(page.locator("#startup-progress")).toBeHidden();
    release.resolve();
    await expect(page.getByText("Worker stop failed; chat retained", { exact: true })).toBeVisible();
    await expect(page.locator("#startup-progress")).toBeVisible(); await expect(page.locator("#delete-button")).toBeEnabled();
  } finally { release.resolve(); await request.delete(`/api/chats/${f.id}`); }
});

test("reload preserves active elapsed time; Stop, failure, new startup and chat navigation never retain a stale live clock", async ({ page, request }) => {
  const f = await fixture(page, request);
  try {
    const disclosure = page.locator("#startup-progress"), summary = disclosure.locator("summary");
    await page.reload(); await expect(summary).toContainText("· 0m 2");
    await summary.click();
    f.current.status = "stopped"; f.current.statusDetail = "Startup interrupted";
    f.current.startupProgress.finishedAt = f.at(21);
    await f.publish();
    await expect(summary).toHaveText("Startup interrupted · 0m 21s");
    await expect(disclosure.locator('[data-stage="machine"]')).toContainText("Interrupted · 0m 19s");
    await page.clock.install(); await page.clock.fastForward(5000);
    await expect(summary).toHaveText("Startup interrupted · 0m 21s");
    f.current.status = "error"; f.current.statusDetail = "Machine failed";
    f.current.startupProgress.stages[1] = { ...f.current.startupProgress.stages[1], status: "failed", finishedAt: f.at(21) };
    await f.publish(); await expect(summary).toHaveText("Startup failed · 0m 21s");
    await expect(page.locator("#runtime-detail")).toHaveText("Machine failed");
    f.current.status = "starting";
    f.current.startupProgress = { startedAt: f.at(30), stages: [{ id: "agent", label: "Starting agent", status: "running", startedAt: f.at(30) }] };
    await f.publish(); await expect(disclosure).not.toHaveAttribute("open", "");
    await summary.click(); await expect(disclosure.locator("li")).toHaveCount(1);
    await expect(disclosure.locator("li")).toContainText("Starting agent");
    await page.getByRole("button", { name: "Open Existing alpha", exact: true }).click();
    await expect(page.locator("#chat-title")).toHaveText("Existing alpha");
    await expect(disclosure).toBeHidden();
    await page.clock.fastForward(2000); await expect(disclosure).toBeHidden();
    await page.getByRole("button", { name: "Open Startup progress fixture", exact: true }).click();
    await expect(summary).toContainText("Starting agent"); await expect(disclosure).not.toHaveAttribute("open", "");
  } finally { await request.delete(`/api/chats/${f.id}`); }
});
