import { test, expect } from "@playwright/test";
const created = [];
test.afterEach(async ({ request }) => { for (const id of created.splice(0)) await request.delete(`/api/chats/${id}`); });

async function openFixture(page, messages = [], extra = {}) {
  await page.route("**/api/chats/chat_*/commands", route => route.fulfill({ json: { commands: [{ name: "usage" }, { name: "work", description: "Installed skill" }, { name: "workflow", description: "Plugin workflow" }] } }));
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: `UX ${Date.now()}` } })).json();
  created.push(chat.id);
  await page.route("**/api/sidebar", async route => { const response = await route.fetch(), data = await response.json(); data.chats = data.chats.map(item => item.id === chat.id ? { ...item, ...extra } : item); await route.fulfill({ json: data }); });
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: { ...chat, ...extra, messages } } }) : route.continue());
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole("button", { name: `Open ${chat.title}`, exact: true }).click();
  return chat;
}
test("Markdown renders tables and bubbles; HTML preview cannot leak styles, execute scripts or access parent", async ({ page }) => {
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await openFixture(page, [
    { id: "u", role: "user", text: "A short **user message**" },
    { id: "a", role: "assistant", text: "## Result\n\n| Name | State |\n| --- | --- |\n| Test | Passed |\n\n```html\n<style>body { background: rgb(255, 0, 0) } .message {display:none}</style><h1>Preview works</h1><script>parent.document.body.innerHTML='hacked'</script><img src='https://evil.example/tracker'><div>Unclosed\n```\n\n**Still here** [unsafe](javascript:alert(1))" },
  ]);
  await expect(page.locator(".message.assistant h2")).toHaveText("Result"); await expect(page.locator(".message.assistant table td").last()).toHaveText("Passed");
  const bounds = await page.locator(".message.user").evaluate(n => ({ width: n.getBoundingClientRect().width, parent: n.parentElement.clientWidth, marginLeft: getComputedStyle(n).marginLeft, display: getComputedStyle(n).display }));
  expect(bounds.width).toBeLessThan(bounds.parent * .8); expect(parseFloat(bounds.marginLeft)).toBeGreaterThan(0);
  const background = await page.locator("body").evaluate(n => getComputedStyle(n).backgroundColor);
  await page.locator(".html-preview summary").click();
  const frame = page.frameLocator(".html-preview iframe"); await expect(frame.locator("h1")).toHaveText("Preview works");
  await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(255, 0, 0)");
  await expect(frame.locator("body script")).toHaveCount(0); await expect(page.locator(".message.assistant")).toContainText("Still here");
  expect(await page.locator("body").evaluate(n => getComputedStyle(n).backgroundColor)).toBe(background);
  expect(await page.locator(".html-preview iframe").getAttribute("sandbox")).toBe("allow-scripts");
  expect(await page.locator(".html-preview iframe").evaluate(n => n.contentDocument)).toBeNull();
  await expect(page.locator('.markdown a[href^="javascript:"]')).toHaveCount(0); expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/conversation-markdown.png", fullPage: true });
});
test("25 tool uses collapse into one row and open real inputs/results in the side panel", async ({ page }) => {
  const messages = [{ id: "u", role: "user", text: "Inspect the code" }, ...Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, role: "tool", kind: "tool", text: "Bash", meta: { itemId: `call${i}`, tool: "Bash", title: "npm test", input: '{"command":"npm test"}', output: i === 0 ? "Permission denied" : "All tests passed", failed: i === 0, state: "completed" } })), { id: "a", role: "assistant", text: "Inspection complete" }];
  await openFixture(page, messages); await expect(page.locator("#messages .tool-details")).toHaveCount(0);
  await page.getByRole("button", { name: "Tools used: 25 ›" }).click(); await expect(page.locator("#tools-panel details")).toHaveCount(25);
  await page.locator("#tools-panel details summary").first().click(); await expect(page.locator("#tools-panel details").first()).toContainText("Permission denied");
  await expect(page.locator("#tools-panel details").first()).toContainText("npm test");
  await page.keyboard.press("Escape"); await expect(page.locator("#tools-panel")).not.toBeVisible();
});
test("slash prefix filters; arrows and Enter insert without submitting; Escape closes", async ({ page }) => {
  await openFixture(page); const input = page.getByLabel("Message", { exact: true });
  await input.fill("/w"); await expect(page.getByRole("option", { name: "/work Installed skill", exact: true })).toBeVisible();
  await input.press("ArrowDown"); await input.press("Enter"); await expect(input).toHaveValue("/workflow ");
  await expect(page.locator("#messages .message.user")).toHaveCount(0);
  await input.fill("/w"); await input.press("Escape"); await expect(page.locator("#slash-menu")).not.toBeVisible();
});
test("usage compact card and detailed breakdown use separate live context and cumulative totals", async ({ page }) => {
  await page.addInitScript(() => { const Native = window.EventSource; window.relaySources = []; window.EventSource = class extends Native { constructor(...args) { super(...args); window.relaySources.push(this); } }; });
  const usage = { version: 2, contextTokens: 155100, contextWindow: 1000000, recordedAt: new Date().toISOString(), context: { inputTokens: 10000, cacheReadTokens: 145100 }, totals: { inputTokens: 138, outputTokens: 267, cacheReadTokens: 8400000, cacheWriteTokens: 238400, costUsd: 3.65, durationMs: 275000, apiDurationMs: 241000 } };
  const chat = await openFixture(page, [], { usage });
  await page.route(`**/api/chats/${chat.id}/session-info`, route => route.fulfill({ json: { usage, rateLimits: [{ id: "all-models", name: "All models", windows: [{ minutes: 300, usedPercent: 11, resetsAt: Date.now() / 1000 + 7800 }, { minutes: 10080, usedPercent: 39 }] }] } }));
  await page.getByLabel("Context and usage", { exact: true }).click();
  await expect(page.locator("#session-usage")).toContainText("155.1K / 1M (16%)"); await expect(page.locator("#session-usage")).toContainText("11%");
  await page.evaluate(({ chat, usage }) => {
    const source = window.relaySources.find(s => s.url.includes(`/chats/${chat.id}/events`));
    source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat_updated", chat: { ...chat, revision: 1000, updatedAt: new Date().toISOString(), usage: { ...usage, contextTokens: 200000, recordedAt: new Date(Date.now() + 1000).toISOString() } } }) }));
  }, { chat, usage });
  await expect(page.locator("#session-usage")).toContainText("200K / 1M (20%)");
  await page.getByRole("button", { name: "See detailed breakdown ›" }).click();
  await expect(page.locator("#usage-details")).toContainText("$3.65"); await expect(page.locator("#usage-details")).toContainText("8.4M"); await expect(page.locator("#usage-details")).toContainText("API 4m 1s");
});
test("busy composer accepts queued messages and its main button stops the agent", async ({ page }) => {
  const chat = await openFixture(page, [], { status: "running" });
  let queued = "", stopped = false;
  await page.route(`**/api/chats/${chat.id}/queue`, route => { queued = route.request().postDataJSON().text; return route.fulfill({ json: { chat } }); });
  await page.route(`**/api/chats/${chat.id}/stop`, route => { stopped = true; return route.fulfill({ json: { stopped: true } }); });
  const input = page.getByLabel("Message", { exact: true }); await expect(input).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toBeEnabled();
  await input.fill("Do this next"); await input.press("Enter"); await expect.poll(() => queued).toBe("Do this next");
  await page.getByRole("button", { name: "Stop agent", exact: true }).click(); await expect.poll(() => stopped).toBe(true);
});
test("MCP connection can be saved masked then selected in an environment", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "MCP connections", exact: true }).click();
  await page.getByLabel("Connection name", { exact: true }).fill("browser-tools");
  await page.getByLabel("MCP endpoint URL").fill("https://mcp.example.com/mcp");
  await page.getByLabel("Authentication headers", { exact: false }).fill('{"Authorization":"Bearer fixture-secret"}');
  await page.getByRole("button", { name: "Save connection" }).click(); await expect(page.locator("#mcp-save-status")).toContainText("Saved");
  await expect(page.locator("#mcp-headers")).toHaveValue("");
  await page.getByLabel("Close MCP connections").click(); await page.getByRole("button", { name: "Environments", exact: true }).click();
  await page.locator("#environment-mcp-options").getByRole("checkbox", { name: "browser-tools · http" }).check();
  await page.getByRole("button", { name: "Save environment" }).click(); await expect(page.locator("#environment-save-status")).toContainText("Saved securely");
  const { environments } = await (await page.request.get("/api/environments")).json(); expect(environments.some(e => e.mcpIds?.length)).toBe(true);
});
