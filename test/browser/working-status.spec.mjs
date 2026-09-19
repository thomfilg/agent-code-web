import { test, expect } from "@playwright/test";

async function runningChat(page, request) {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Working status fixture" } })).json();
  const fixture = { ...chat, status: "running", workingStartedAt: new Date(Date.now() - 462000).toISOString(), revision: 9000,
    messages: [{ id: "user-fixture", role: "user", text: "Keep my context" },
      ...["a", "b"].map(id => ({ id, role: "tool", kind: "tool", text: "Test tool", meta: { itemId: id, state: "running", tool: "fixture" } }))] };
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: fixture } }) : route.continue());
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}/presence`, route => route.fulfill({ json: {} }));
  const calls = []; let fail = false;
  await page.route(`**/api/chats/${chat.id}/interrupt`, route => {
    calls.push("interrupt");
    if (fail) return route.fulfill({ status: 503, json: { error: "Interruption unavailable" } });
    fixture.status = "idle"; fixture.revision++;
    return route.fulfill({ json: { chat: fixture } });
  });
  page.on("request", req => { if (req.url().endsWith(`/${chat.id}/stop`)) calls.push("stop-worker"); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { id: chat.id, calls, fail: () => { fail = true; } };
}

test("working timer advances, counts active tools and Escape interrupts without clearing the draft or stopping the worker", async ({ page, request }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const f = await runningChat(page, request);
  try {
    const status = page.locator("#working-status");
    await expect(status).toContainText("Working · 7m"); await expect(status).toContainText("Esc to interrupt · 2 active tools");
    const before = await status.textContent(); await expect.poll(() => status.textContent()).not.toBe(before);
    await page.locator("#message-input").fill("Unsent draft stays"); await page.locator("#message-input").press("Escape");
    await expect(status).toBeHidden(); await expect(page.locator("#send-button")).toHaveAttribute("aria-label", "Send message");
    await expect(page.locator("#message-input")).toHaveValue("Unsent draft stays"); await expect(page.locator("#message-input")).toBeEnabled();
    expect(f.calls).toEqual(["interrupt"]); expect(errors).toEqual([]);
  } finally { await request.delete(`/api/chats/${f.id}`); }
});

test("Escape closes an open menu without interrupting; Stop failure leaves controls usable for retry", async ({ page, request }) => {
  const f = await runningChat(page, request);
  try {
    f.fail();
    await page.getByLabel("Chat actions", { exact: true }).click(); await page.keyboard.press("Escape");
    expect(f.calls).toEqual([]);
    await page.locator(".control-menu[open]").evaluateAll(menus => menus.forEach(menu => { menu.open = false; }));
    await page.locator("#send-button").click();
    await expect(page.getByText("Could not interrupt the agent: Interruption unavailable", { exact: true })).toBeVisible();
    await expect(page.locator("#send-button")).toBeEnabled(); await expect(page.locator("#message-input")).toBeEnabled();
    expect(f.calls).toEqual(["interrupt"]);
  } finally { await request.delete(`/api/chats/${f.id}`); }
});
