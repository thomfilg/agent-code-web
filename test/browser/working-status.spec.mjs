import { test, expect } from "@playwright/test";

async function runningChat(page, request, configure = () => {}) {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Working status fixture" } })).json();
  const fixture = { ...chat, status: "running", workingStartedAt: new Date(Date.now() - 462000).toISOString(), revision: 9000,
    messages: [{ id: "user-fixture", role: "user", text: "Keep my context" },
      ...["a", "b"].map(id => ({ id, role: "tool", kind: "tool", text: "Test tool", meta: { itemId: id, state: "running", tool: "fixture" } }))] };
  configure(fixture);
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: fixture } }) : route.continue());
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}/presence`, route => route.fulfill({ json: {} }));
  await page.route(`**/api/chats/${chat.id}/machine-health`, route => route.fulfill({ json: {
    worker: { state: "running", backend: "local", control: "connected", lease: { active: true, reasons: ["fixture"] } },
    agent: { state: "running" }, system: { unavailable: true, reason: "fixture" },
  } }));
  const calls = []; let fail = false;
  await page.route(`**/api/chats/${chat.id}/interrupt`, route => {
    calls.push("interrupt");
    if (fail) return route.fulfill({ status: 503, json: { error: "Interruption unavailable" } });
    fixture.status = "idle"; fixture.revision++;
    return route.fulfill({ json: { chat: fixture } });
  });
  page.on("request", req => { if (req.url().endsWith(`/${chat.id}/stop`)) calls.push("stop-worker"); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { id: chat.id, fixture, calls, fail: () => { fail = true; } };
}

test("a pending answer is visible instead of an apparently stuck working timer", async ({ page, request }) => {
  const f = await runningChat(page, request, fixture => {
    fixture.pendingRequest = { requestId: "question-fixture", method: "claude/tool/requestUserInput",
      createdAt: new Date(Date.now() - 12 * 60_000).toISOString(), prompt: "Claude needs your answers",
      questions: [{ id: "question_1", question: "Choose the UI scope", options: [{ label: "Full move", description: "Move both surfaces" }] }] };
  });
  try {
    await expect(page.locator("#runtime-status")).toHaveText("Needs answer");
    await expect(page.locator("#working-status")).toContainText("Waiting for your answer · 12m");
    await expect(page.locator("#working-status")).not.toContainText("active tools");
  } finally { await request.delete(`/api/chats/${f.id}`); }
});

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
    await page.getByLabel("Chat settings", { exact: true }).click(); await page.keyboard.press("Escape");
    expect(f.calls).toEqual([]);
    await page.locator(".control-menu[open]").evaluateAll(menus => menus.forEach(menu => { menu.open = false; }));
    await page.locator("#send-button").click();
    await expect(page.getByText("Could not interrupt the agent: Interruption unavailable", { exact: true })).toBeVisible();
    await expect(page.locator("#send-button")).toBeEnabled(); await expect(page.locator("#message-input")).toBeEnabled();
    expect(f.calls).toEqual(["interrupt"]);
  } finally { await request.delete(`/api/chats/${f.id}`); }
});
