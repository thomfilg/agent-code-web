import { test, expect } from "@playwright/test";

async function fixture(page, request) {
  const created = await request.post("/api/chats", { data: { agent: "mock", title: "Disposable GitHub notification UI" } }); expect(created.ok()).toBe(true);
  const { chat } = await created.json(), writes = [];
  let snapshot = { ...chat, ownerId: `user_${"a".repeat(32)}`, agentAccountId: "account_fixture", repositories: [{ fullName: "acme/project" }],
    pullRequests: [{ repository: "acme/project", number: 7, state: "open", checks: "passing", additions: 2, deletions: 1, changedFiles: 1,
      ci: { inProgress: 0, passed: 1, skipped: 0, failed: 0, total: 1 }, autoMerge: false }],
    githubEvents: { configured: true, revision: 0, subscriptions: [], deliveries: [] } };
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.continue());
  await page.route("**/api/sidebar", async route => { const response = await route.fetch(), data = await response.json(); data.chats = data.chats.map(item => item.id === chat.id ? { ...item, ownerId: snapshot.ownerId, agentAccountId: snapshot.agentAccountId, repositories: snapshot.repositories, pullRequests: snapshot.pullRequests, githubEvents: snapshot.githubEvents } : item); await route.fulfill({ json: data }); });
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": isolated UI fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}/pull-requests/subscription`, async route => {
    const body = route.request().postDataJSON(); writes.push(body);
    snapshot = { ...snapshot, githubEvents: { ...snapshot.githubEvents, revision: snapshot.githubEvents.revision + 1, subscriptions: [{ ...body, id: "acme/project#7" }] } };
    await route.fulfill({ json: { chat: snapshot } });
  });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator(".pull-request-bar")).toBeVisible();
  const open = async () => { const menu = page.locator(".ci-menu"); if (await menu.getAttribute("open") === null) await menu.locator("summary").click(); };
  return { chat, writes, open, snapshot: () => snapshot, replace: value => { snapshot = value; } };
}

test("PR notification opt-ins are separate, explicit and retained on reload without sending a prompt", async ({ page, request }, testInfo) => {
  const f = await fixture(page, request);
  try {
    await f.open(); const fail = page.getByLabel("Notify agent when checks fail for PR 7", { exact: true }), wake = page.getByLabel("Wake this chat when checks pass for PR 7", { exact: true });
    await expect(fail).not.toBeChecked(); await expect(wake).not.toBeChecked();
    await fail.check(); await expect.poll(() => f.writes.length).toBe(1); await f.open();
    expect(f.writes[0]).toMatchObject({ notifyFailures: true, wakePassing: false, revision: 0 });
    page.once("dialog", dialog => dialog.dismiss()); await wake.click(); await expect(wake).not.toBeChecked(); expect(f.writes.length).toBe(1);
    page.once("dialog", dialog => { expect(dialog.message()).toContain("worker time and model tokens"); return dialog.accept(); });
    await wake.check(); await expect.poll(() => f.writes.length).toBe(2);
    expect(f.writes[1]).toMatchObject({ notifyFailures: true, wakePassing: true, revision: 1 });
    await page.reload(); await f.open(); await expect(fail).toBeChecked(); await expect(wake).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("github-events-desktop.png"), fullPage: true, animations: "disabled" });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 }); await expect(wake).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (width === 390) await page.screenshot({ path: testInfo.outputPath("github-events-mobile.png"), fullPage: true, animations: "disabled" });
    }
    const saved = await (await request.get(`/api/chats/${f.chat.id}`)).json(); expect(saved.chat.messages).toEqual([]); expect(saved.chat.status).toBe("stopped");
  } finally { await page.close(); await request.delete(`/api/chats/${f.chat.id}`).catch(() => {}); }
});

test("closed PR allows consent removal and uncertain notification requires explicit review", async ({ page, request }) => {
  const f = await fixture(page, request), reviews = [];
  try {
    f.replace({ ...f.snapshot(), pullRequests: [{ ...f.snapshot().pullRequests[0], state: "closed" }], githubEvents: { configured: false, revision: 5,
      subscriptions: [{ repository: "acme/project", number: 7, notifyFailures: true, wakePassing: true }],
      deliveries: [{ id: "fixture-event", repository: "acme/project", number: 7, checks: "passing", status: "uncertain" }] } });
    await page.route(`**/api/chats/${f.chat.id}/pull-requests/event`, async route => { reviews.push(route.request().postDataJSON()); await route.fulfill({ json: { chat: f.snapshot() } }); });
    await page.reload(); await f.open(); await expect(page.getByText("GitHub notification: passing · uncertain", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Wake this chat when checks pass for PR 7", { exact: true })).toBeEnabled();
    page.once("dialog", dialog => dialog.dismiss()); await page.getByRole("button", { name: "Review and retry notification" }).click(); expect(reviews).toEqual([]);
    page.once("dialog", dialog => { expect(dialog.message()).toContain("may already have reached"); return dialog.accept(); });
    await page.getByRole("button", { name: "Review and retry notification" }).click(); await expect.poll(() => reviews.length).toBe(1);
    expect(reviews[0]).toEqual({ id: "fixture-event", action: "retry" });
    await page.getByLabel("Wake this chat when checks pass for PR 7", { exact: true }).uncheck(); await expect.poll(() => f.writes.length).toBe(1);
    expect(f.writes[0].wakePassing).toBe(false);
  } finally { await page.close(); await request.delete(`/api/chats/${f.chat.id}`).catch(() => {}); }
});
