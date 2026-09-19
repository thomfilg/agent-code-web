import { test, expect } from "@playwright/test";

test("MCP activity distinguishes failed, missing and successful results and preserves safe inputs after reload", async ({ page, request }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "MCP result visibility fixture" } })).json();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const tool = (id, meta) => ({ id, role: "tool", kind: "tool", text: "list_teams", meta: {
    itemId: id, tool: "mcpToolCall", title: "list_teams", state: "completed", input: '{"limit":1}', ...meta,
  } });
  const messages = [
    { id: "u", role: "user", text: "Check access without changing anything" },
    tool("failed-read", { failed: true, output: "Authentication expired. <script>window.mcpOutputExecuted = true</script>" }),
    tool("missing-read", { failed: false, resultMissing: true, output: "" }),
    tool("successful-read", { failed: false, output: '{"content":[{"type":"text","text":"Read succeeded"}]}' }),
  ];
  await page.addInitScript(() => { window.EventSource = class { constructor() { window.fixtureSource = this; } close() {} }; });
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() !== "GET" ? route.continue() : route.fulfill({ json: { chat: { ...chat, status: "idle", messages } } }));
  try {
    await page.goto(`/#chat=${chat.id}`);
    for (let pass = 0; pass < 2; pass++) {
      await expect(page.locator("#chat-title")).toHaveText(chat.title);
      const group = page.locator("#messages > .inline-tool-group");
      await expect(group).toHaveCount(1);
      await group.locator(":scope > summary").click();
      const details = group.locator(".tool-details");
      await expect(details.nth(0).locator("summary")).toHaveText("list_teams · Failed");
      await expect(details.nth(1).locator("summary")).toHaveText("list_teams · Result not reported");
      await expect(details.nth(2).locator("summary")).toHaveText("list_teams");
      for (const item of await details.all()) {
        await item.locator("summary").click();
        await expect(item.locator(".tool-input")).toHaveText('{"limit":1}');
        await expect(item.locator(".tool-input")).toBeVisible();
      }
      await expect(details.nth(0).locator(".tool-output")).toContainText("Authentication expired.");
      await expect(details.nth(1)).toContainText("No output reported");
      await expect(details.nth(2).locator(".tool-output")).toContainText("Read succeeded");
      await expect(group.locator("script")).toHaveCount(0);
      expect(await page.evaluate(() => window.mcpOutputExecuted)).toBeUndefined();
      if (!pass) { await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await request.delete(`/api/chats/${chat.id}`); }
});

test("inline activity alternates with commentary and keeps both disclosure levels open during streaming", async ({ page, request }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Inline activity fixture" } })).json();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const tool = (id, title, output, exitCode) => ({ id, role: "tool", kind: "tool", text: title, meta: { itemId: id, tool: "command", title, state: "completed", output, exitCode } });
  const messages = [
    { id: "u", role: "user", text: "Check the types and build" },
    { id: "a", role: "assistant", text: "Type-check clean. I'll verify the gates.", meta: { commentary: true } },
    tool("t1", "Run host-copy-budget gate", "Gate passed", 0), tool("t2", "Type-check prisma package", "TS2305: missing Prisma export\n<script>never execute this</script>", 2),
    { id: "b", role: "assistant", text: "Prisma needs generation. I'll generate it.", meta: { commentary: true } },
    tool("t3", "Generate Prisma client", "Generated client", 0),
  ];
  await page.addInitScript(() => { window.EventSource = class { constructor() { window.fixtureSource = this; } close() {} }; });
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() !== "GET" ? route.continue() : route.fulfill({ json: { chat: { ...chat, status: "running", messages } } }));
  try {
    await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
    await expect(page.locator("#messages > .inline-tool-group")).toHaveCount(2);
    const order = await page.locator("#messages > .message, #messages > .inline-tool-group").evaluateAll(nodes => nodes.map(node => node.classList.contains("inline-tool-group") ? "actions" : node.classList.contains("user") ? "user" : "commentary"));
    expect(order).toEqual(["user", "commentary", "actions", "commentary", "actions"]);
    const group = page.locator(".inline-tool-group").first();
    await expect(group.locator(".tool-details").first()).toBeHidden(); await group.locator(":scope > summary").click();
    await expect(group.locator(".tool-output").last()).toBeHidden(); await group.locator(".tool-details summary").last().click();
    await expect(group.locator(".tool-output").last()).toBeVisible(); await expect(group).toContainText("Exit status 2");
    await expect(group.locator("script")).toHaveCount(0);
    await page.evaluate(() => {
      window.fixtureSource.onmessage({ data: JSON.stringify({ type: "turn_started", messageId: "live" }) });
      window.fixtureSource.onmessage({ data: JSON.stringify({ type: "assistant_delta", delta: "Now rechecking." }) });
    });
    await expect(group).toHaveAttribute("open", ""); await expect(group.locator(".tool-output").last()).toBeVisible();
    await expect(group.locator(".tool-details summary").last()).toBeFocused();
    await expect(page.locator("#tools-panel")).toBeHidden();
    await page.reload(); await expect(page.locator("#messages > .inline-tool-group")).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 844 }); await group.locator(":scope > summary").click(); await group.locator(".tool-details summary").last().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await request.delete(`/api/chats/${chat.id}`); }
});
