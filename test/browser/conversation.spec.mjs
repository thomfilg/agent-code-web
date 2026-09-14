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

test("document previews use the desktop column, styled defaults, and mutually exclusive panels", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const html = '<h1>Viewport report</h1><p>A readable document.</p><table><thead><tr><th>Device</th><th>Width</th></tr></thead><tbody><tr><td>Phone</td><td align="right">390</td></tr><tr><td>Tablet</td><td>744</td></tr></tbody></table>';
  await openFixture(page, [
    { id: "u", role: "user", text: "Show samples" },
    { id: "t", role: "tool", kind: "tool", meta: { itemId: "one", tool: "Read", output: "Real result", state: "completed" } },
    { id: "a", role: "assistant", text: `\`\`\`html\n${html}\n\`\`\`\n\n\`\`\`markdown\n# Markdown document\n\n| Item | Status |\n| --- | --- |\n| Unit | Passed |\n\`\`\`\n\n\`\`\`text\n<b>Literal text</b>\n\`\`\`\n\n\`\`\`svg\n<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="30" fill="blue" /></svg>\n\`\`\`` },
  ]);
  const input = page.getByLabel("Message", { exact: true }); await input.fill("Keep my draft");
  const open = page.getByRole("button", { name: "Open HTML preview ↗" }); await open.click();
  const panel = page.locator("#preview-panel"), frame = page.frameLocator("#preview-content iframe");
  await expect(frame.locator("h1")).toHaveText("Viewport report");
  await expect(frame.locator("th").first()).toHaveCSS("background-color", "rgb(237, 241, 245)");
  await expect(frame.locator("td").first()).toHaveCSS("padding-left", "12px");
  await expect(frame.locator('[align="right"]')).toHaveCSS("text-align", "right");
  const geometry = await page.evaluate(() => Object.fromEntries(["sidebar", "conversation", "preview-panel"].map(id => { const n = document.getElementById(id).getBoundingClientRect(); return [id, { left: n.left, right: n.right, height: n.height }]; })));
  expect(geometry.sidebar.right).toBeLessThanOrEqual(geometry.conversation.left);
  expect(geometry.conversation.right).toBeLessThanOrEqual(geometry["preview-panel"].left + 1);
  expect(geometry["preview-panel"].height).toBeGreaterThan(800);
  await expect(page.locator("#messages iframe")).toHaveCount(0);
  await expect(frame.locator("h1")).toBeInViewport();
  await frame.locator("body").evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: "test-results/desktop-document-preview.png", fullPage: true });
  await page.getByLabel("Expand preview", { exact: true }).click(); await expect(panel).toHaveClass(/expanded/);
  await page.getByLabel("Restore preview size", { exact: true }).click(); await expect(panel).not.toHaveClass(/expanded/);
  await page.keyboard.press("Escape"); await expect(panel).not.toBeVisible(); await expect(open).toBeFocused();
  await page.getByRole("button", { name: "Open Markdown preview ↗" }).click();
  await expect(frame.locator("h1")).toHaveText("Markdown document"); await expect(frame.locator("td").last()).toHaveText("Passed");
  await frame.locator("h1").click(); await page.keyboard.press("Escape"); await expect(panel).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Open Markdown preview ↗" })).toBeFocused();
  await page.getByRole("button", { name: "Open Text preview ↗" }).click();
  await expect(panel.locator("pre")).toHaveText("<b>Literal text</b>\n"); await expect(panel.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Open SVG preview ↗" }).click(); await expect(frame.locator("circle")).toHaveAttribute("fill", "blue");
  await page.getByRole("button", { name: "Tools used: 1 ›" }).click(); await expect(panel).not.toBeVisible(); await expect(panel.locator("iframe")).toHaveCount(0);
  await page.locator("#view-changes").click(); await expect(page.locator("#diff-panel")).toBeVisible(); await expect(page.locator("#tools-panel")).not.toBeVisible();
  await open.click(); await expect(page.locator("#diff-panel")).not.toBeVisible(); await expect(panel).toBeVisible();
  await expect(input).toHaveValue("Keep my draft");
  await page.getByRole("button", { name: "Open Existing beta", exact: true }).click(); await expect(panel).not.toBeVisible(); await expect(panel.locator("iframe")).toHaveCount(0);
});

test("preview survives live message updates and fits narrow screens without horizontal overflow", async ({ page }) => {
  await page.addInitScript(() => { const Native = window.EventSource; window.relaySources = []; window.EventSource = class extends Native { constructor(...args) { super(...args); window.relaySources.push(this); } }; });
  const chat = await openFixture(page, [{ id: "a", role: "assistant", text: `\`\`\`html\n<h1>Long document</h1>${"<p>Content</p>".repeat(100)}\n\`\`\`` }]);
  const open = page.getByRole("button", { name: "Open HTML preview ↗" }); await open.click();
  const frame = page.frameLocator("#preview-content iframe"); await expect(frame.locator("h1")).toHaveText("Long document");
  await frame.locator("body").evaluate(() => { window.scrollTo(0, 500); window.previewSentinel = true; });
  await page.evaluate(id => window.relaySources.find(s => s.url.includes(`/chats/${id}/events`)).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message", message: { id: "later", role: "assistant", text: "New update" } }) })), chat.id);
  await expect(page.locator("#messages")).toContainText("New update");
  expect(await frame.locator("body").evaluate(() => window.previewSentinel && window.scrollY === 500)).toBe(true);
  await page.getByLabel("Close preview", { exact: true }).click(); await expect(open).toBeFocused();
  for (const width of [1024, 1000, 744, 390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await open.click();
    await expect(page.getByLabel("Close preview", { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator("#preview-panel").evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true);
    if (width === 390) await page.screenshot({ path: "test-results/mobile-document-preview.png", fullPage: true });
    await page.getByLabel("Close preview", { exact: true }).click(); await expect(page.locator("#preview-panel")).not.toBeVisible();
  }
});

test("delete errors stay actionable and deleting the last chat clears its preview", async ({ page }) => {
  const chat = await openFixture(page, [{ id: "a", role: "assistant", text: "```html\n<h1>Delete preview fixture</h1>\n```" }]);
  await page.route("**/api/sidebar", async route => { const response = await route.fetch(), data = await response.json(); data.chats = data.chats.filter(c => c.id === chat.id); await route.fulfill({ json: data }); });
  await page.reload();
  await page.getByRole("button", { name: "Open HTML preview ↗" }).click();
  await page.getByRole("button", { name: `Organize ${chat.title}`, exact: true }).click();
  let failDelete = true;
  await page.route(`**/api/chats/${chat.id}`, route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    if (failDelete) return route.fulfill({ status: 503, json: { error: "Could not stop worker. Please retry." } });
    return route.continue();
  });
  page.once("dialog", dialog => dialog.accept()); await page.locator("#organize-delete-chat").click();
  await expect(page.locator("#organize-error")).toContainText("Please retry"); await expect(page.locator("#organize-delete-chat")).toBeEnabled();
  expect((await page.request.get(`/api/chats/${chat.id}`)).ok()).toBe(true);
  failDelete = false; page.once("dialog", dialog => dialog.accept()); await page.locator("#organize-delete-chat").click();
  await expect(page.locator("#organize-dialog")).not.toBeVisible(); await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator("#preview-panel")).not.toBeVisible(); await expect(page.locator("#preview-content iframe")).toHaveCount(0);
  await expect(page.locator("#messages")).toBeEmpty(); await expect(page.locator(".chat-row")).toHaveCount(0);
});
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
  await page.getByRole("button", { name: "Open HTML preview ↗" }).click();
  await expect(page.locator("#messages iframe")).toHaveCount(0);
  const frame = page.frameLocator("#preview-content iframe"); await expect(frame.locator("h1")).toHaveText("Preview works");
  await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(255, 0, 0)");
  await expect(frame.locator("body script")).toHaveCount(0); await expect(page.locator(".message.assistant")).toContainText("Still here");
  expect(await page.locator("body").evaluate(n => getComputedStyle(n).backgroundColor)).toBe(background);
  expect(await page.locator("#preview-content iframe").getAttribute("sandbox")).toBe("allow-scripts");
  expect(await page.locator("#preview-content iframe").evaluate(n => n.contentDocument)).toBeNull();
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

test("composer and command picker have readable controls and fit desktop and mobile", async ({ page }) => {
  await openFixture(page, [], { agent: "claude", model: "opus", effort: "high" });
  await page.route("**/api/chats/chat_*/commands", route => route.fulfill({ json: { commands: [
    { name: "usage", description: "View context and plan usage", kind: "Web control", web: true },
    { name: "work", description: "Work through an issue with your installed workflow", kind: "Skill" },
    { name: "workflow:bootstrap", description: "Prepare the repository for a new task", kind: "Skill" },
  ] } }));
  const input = page.getByLabel("Message", { exact: true });
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await input.fill("/");
    await expect(page.locator("#slash-caption")).toHaveText("Claude · available in this chat");
    await expect(page.locator("#slash-count")).toHaveText("3");
    await expect(page.locator("#slash-options .slash-kind")).toHaveText(["Control", "Skill", "Skill"]);
    await expect(page.locator("#slash-menu")).toBeInViewport({ ratio: 1 });
    for (const selector of ["#composer", "#slash-menu"]) expect(await page.locator(selector).evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeInViewport();
    const compact = await page.locator(".composer-wrap").evaluate(n => n.clientWidth <= 540);
    await expect(page.getByLabel("Chat model", { exact: true })).toHaveCSS("font-size", compact ? "12px" : "13px");
    if (width === 1440 || width === 390) await page.screenshot({ path: `test-results/composer-commands-${width}.png`, fullPage: true });
    await input.press("Escape");
  }
  await input.fill("/w"); await page.getByRole("option", { name: "/work Work through an issue with your installed workflow", exact: true }).click();
  await expect(input).toHaveValue("/work "); await expect(page.locator("#slash-menu")).not.toBeVisible();
  await input.fill("/no-such-command"); await expect(page.locator("#slash-status")).toContainText("No matches");
  await input.press("Tab"); await expect(input).not.toBeFocused(); await expect(page.locator("#slash-menu")).not.toBeVisible();
  await expect(page.locator("#messages .message.user")).toHaveCount(0);
});

test("slow slash discovery is deduplicated and Escape does not allow late results to reopen it", async ({ page }) => {
  await openFixture(page); let release, requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/chats/chat_*/commands", async route => { requests++; await gate; await route.fulfill({ json: { commands: [{ name: "work", description: "Installed skill", kind: "Skill" }] } }); });
  const input = page.getByLabel("Message", { exact: true });
  await input.fill("/"); await expect(page.locator("#slash-status")).toContainText("Loading");
  await input.fill("/w"); await input.press("Enter"); await expect(input).toHaveValue("/w");
  await input.press("Escape");
  const response = page.waitForResponse(r => r.url().endsWith("/commands")); release(); await response;
  await expect(page.locator("#slash-menu")).not.toBeVisible(); expect(requests).toBe(1);
  await input.click(); await expect(page.getByRole("option", { name: "/work Installed skill", exact: true })).toBeVisible();
  await input.press("Enter"); await expect(input).toHaveValue("/work "); expect(requests).toBe(1);
  await expect(page.locator("#messages .message.user")).toHaveCount(0);
});

test("slash loading errors are visible, cannot submit a stale choice, and can be retried", async ({ page }) => {
  await openFixture(page); let fail = true;
  await page.route("**/api/chats/chat_*/commands", route => fail ? route.fulfill({ status: 503, json: { error: "Discovery unavailable" } }) : route.fulfill({ json: { commands: [{ name: "work", description: "Installed skill" }] } }));
  const input = page.getByLabel("Message", { exact: true }); await input.fill("/w");
  await expect(page.locator("#slash-status")).toContainText("Could not load commands"); await expect(input).not.toHaveAttribute("aria-activedescendant");
  await input.press("Enter"); await expect(input).toHaveValue("/w"); await expect(page.locator("#messages .message.user")).toHaveCount(0);
  fail = false; await input.click(); await expect(page.getByRole("option", { name: "/work Installed skill", exact: true })).toBeVisible();
  await input.press("Tab"); await expect(input).toHaveValue("/work "); await expect(input).toBeFocused();
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
  await page.locator("#mcp-auth").selectOption("headers");
  await page.locator("#mcp-headers").fill('{"Authorization":"Bearer fixture-secret"}');
  await page.getByRole("button", { name: "Save connection" }).click(); await expect(page.locator("#mcp-save-status")).toContainText("Saved");
  await expect(page.locator("#mcp-headers")).toHaveValue("");
  await page.getByLabel("Close MCP connections").click(); await page.getByRole("button", { name: "Environments", exact: true }).click();
  await page.locator("#environment-mcp-options").getByRole("checkbox", { name: "browser-tools · http" }).check();
  await page.getByRole("button", { name: "Save environment" }).click(); await expect(page.locator("#environment-save-status")).toContainText("Saved securely");
  const { environments } = await (await page.request.get("/api/environments")).json(); expect(environments.some(e => e.mcpIds?.length)).toBe(true);
});

test("same-name MCP connections can have independent organization scopes in one environment", async ({ page }) => {
  const ids = []; let env;
  try {
    await page.goto("/"); await page.getByRole("button", { name: "MCP connections", exact: true }).click();
    for (const org of ["12-apps", "g2i"]) {
      await page.getByRole("button", { name: "Custom MCP" }).click();
      await page.getByLabel("Connection name", { exact: true }).fill("linear-scoped");
      await page.getByLabel("Organization", { exact: true }).fill(org);
      await page.getByLabel("MCP endpoint URL").fill("https://mcp.linear.app/mcp");
      await page.getByRole("button", { name: "Save connection" }).click(); await expect(page.locator("#mcp-save-status")).toContainText("Saved");
      await expect(page.locator("#mcp-list")).toContainText(`${org} · linear-scoped · Sign-in required`);
    }
    const { connections } = await (await page.request.get("/api/mcps")).json(); ids.push(...connections.filter(c => c.name === "linear-scoped").map(c => c.id)); expect(ids.length).toBe(2);
    await page.locator("#mcp-list").getByRole("button", { name: /^12-apps · linear-scoped/ }).click(); await expect(page.getByLabel("Organization", { exact: true })).toHaveValue("12-apps");
    await page.getByLabel("Close MCP connections").click(); await page.getByRole("button", { name: "Environments", exact: true }).click();
    await page.getByRole("button", { name: "Add environment", exact: false }).click(); await page.getByLabel("Environment name", { exact: true }).fill("Scoped MCP test");
    for (const org of ["12-apps", "g2i"]) await page.locator("#environment-mcp-options").getByRole("checkbox", { name: `linear-scoped · http · ${org}`, exact: true }).check();
    await page.getByRole("button", { name: "Save environment" }).click(); await expect(page.locator("#environment-save-status")).toContainText("Saved securely");
    const { environments } = await (await page.request.get("/api/environments")).json(); env = environments.find(e => e.name === "Scoped MCP test"); expect(env.mcpIds.sort()).toEqual(ids.sort());
  } finally {
    if (env) await page.request.delete(`/api/environments/${env.id}`);
    for (const id of ids) await page.request.delete(`/api/mcps/${id}`);
  }
});

test("MCP presets, custom OAuth consent, real tool discovery and mobile layout", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "MCP connections", exact: true }).click();
  await page.locator("#mcp-presets").getByRole("button", { name: /^Linear/ }).click();
  await expect(page.locator("#mcp-url")).toHaveValue("https://mcp.linear.app/mcp"); await expect(page.locator("#mcp-auth")).toHaveValue("oauth");
  await page.getByRole("button", { name: "Custom MCP" }).click(); await expect(page.locator("#mcp-url")).toHaveValue("");
  await page.locator("#mcp-name").fill("oauth-fixture"); await page.locator("#mcp-url").fill("http://127.0.0.1:8881/mcp");
  await page.getByRole("button", { name: "Save connection" }).click(); await expect(page.locator("#mcp-connection-status")).toContainText("Sign-in required");
  const popupReady = page.waitForEvent("popup"); await page.getByRole("button", { name: "Connect with OAuth" }).click();
  const popup = await popupReady; await popup.getByRole("link", { name: "Approve access" }).click();
  await expect(popup.getByRole("heading", { name: "MCP connected" })).toBeVisible();
  await expect(page.locator("#mcp-connection-status")).toContainText("Connected · 1 tools");
  await page.getByText("Available tools", { exact: true }).click(); await expect(page.locator(".mcp-tool-list")).toContainText("fixture_echo");
  const { connections } = await (await page.request.get("/api/mcps")).json(); const connection = connections.find(c => c.name === "oauth-fixture");
  expect(connection.oauthConnected).toBe(true); expect(JSON.stringify(connections)).not.toContain("fixture-access-secret");
  await popup.close(); await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Test connection" })).toBeVisible();
  expect(await page.locator("#mcp-dialog").evaluate(n => n.scrollWidth <= n.clientWidth + 2)).toBe(true);
  await page.screenshot({ path: "test-results/mcp-mobile.png", fullPage: true });
  await page.request.delete(`/api/mcps/${connection.id}`);
});

test("composer arrows recall messages and restore the current draft without sending", async ({ page }) => {
  await openFixture(page, [{ id: "history-1", role: "user", text: "First message" }, { id: "history-2", role: "user", text: "Second\nmessage" }]);
  const input = page.getByLabel("Message", { exact: true });
  await input.press("ArrowUp"); await expect(input).toHaveValue("Second\nmessage");
  await input.press("ArrowUp"); await expect(input).toHaveValue("First message");
  await input.press("Control+End"); await input.press("ArrowDown"); await expect(input).toHaveValue("Second\nmessage");
  await input.press("ArrowDown"); await expect(input).toHaveValue("");
  await input.fill("My draft"); await input.press("Control+Home"); await input.press("ArrowUp"); await expect(input).toHaveValue("Second\nmessage");
  await input.press("Control+End"); await input.press("ArrowDown"); await expect(input).toHaveValue("My draft");
  await expect(page.locator("#messages .message.user")).toHaveCount(2);
});

test("message rail expands on hover and touch; clicking a preview jumps to the corresponding message", async ({ page }) => {
  const messages = Array.from({ length: 15 }, (_, i) => [{ id: `nav-u-${i}`, role: "user", text: `Request ${i + 1}: inspect this part` }, { id: `nav-a-${i}`, role: "assistant", text: "A lengthy answer.\n\n".repeat(10) }]).flat();
  await openFixture(page, messages);
  await page.getByRole("button", { name: "Message navigator", exact: true }).hover();
  const first = page.getByRole("button", { name: "Jump to message 1:", exact: false }); await expect(first).toBeVisible(); await first.click();
  const target = page.locator('[data-message-id="nav-u-0"]'); await expect(target).toBeFocused();
  expect(await target.evaluate(n => { const s = document.querySelector("#messages").getBoundingClientRect(); return n.getBoundingClientRect().top >= s.top && n.getBoundingClientRect().bottom <= s.bottom; })).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("button", { name: "Message navigator", exact: true }).click();
  await expect(page.locator("#message-nav-list")).toBeVisible(); await page.keyboard.press("Escape"); await expect(page.locator("#message-nav-list")).not.toBeVisible();
});
