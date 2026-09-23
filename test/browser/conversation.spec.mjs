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

test("command controls edit goals, queue native commands and retain drafts on delayed controls", async ({ page }) => {
  const goal = { objective: "Original goal", status: "paused", tokensUsed: 15 };
  const chat = await openFixture(page, [{ id: "reply", role: "assistant", text: "Last completed reply" }], { agent: "codex", status: "running", goal });
  const queued = [];
  await page.route(`**/api/chats/${chat.id}/queue`, async route => { queued.push(route.request().postDataJSON()); await route.fulfill({ json: { chat } }); });
  const input = page.getByLabel("Message", { exact: true });
  const submit = async text => { await input.fill(text); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit()); };
  for (const command of ["/review --base main", "/init preserve our lint rules", "/model fixture", "/permissions read-only"]) {
    await submit(command); await expect.poll(() => queued.at(-1)?.text).toBe(command);
    expect(queued.at(-1).attachments).toEqual([]); await expect(input).toHaveValue("");
  }
  await submit("/goal edit"); await expect(page.getByRole("dialog", { name: "Edit Codex goal" })).toBeVisible();
  await expect(page.getByLabel("Goal objective")).toHaveValue("Original goal");
  await page.getByLabel("Goal objective").fill("Revised goal\nwith details"); await page.getByRole("button", { name: "Save goal", exact: true }).click();
  await expect.poll(() => queued.at(-1)?.text).toBe("/goal edit Revised goal\nwith details");
  await expect(page.locator("#controls-dialog")).not.toBeVisible();
  await submit("/permissions"); await expect(page.locator("#mode-menu")).toHaveAttribute("open", ""); await input.press("Escape");
  await submit("/raw"); await expect(page.locator("#preview-panel")).toBeVisible(); await expect(page.locator("#preview-content")).toContainText("Last completed reply");
  await submit("/resume"); await expect(page.getByRole("dialog", { name: "Resume conversation" })).toBeVisible(); await expect(page.getByLabel("Find a conversation")).toBeFocused();
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close());
  let release; const gate = new Promise(resolve => { release = resolve; }); let renames = 0;
  await page.route(`**/api/chats/${chat.id}`, async route => { renames++; await gate; await route.fulfill({ json: { chat: { ...chat, title: "New title", agent: "codex" } } }); });
  await submit("/name New title"); await expect.poll(() => renames).toBe(1); await input.fill("A newer unsent draft"); release();
  await expect(page.locator("#chat-title")).toHaveText("New title"); await expect(input).toHaveValue("A newer unsent draft");
  expect(queued).toHaveLength(5);
});

test("native terminal controls inspect without prompts, confirm one task and retain the draft", async ({ page }) => {
  const chat = await openFixture(page, [], { agent: "codex", status: "idle" });
  let items = [{ id: "100", title: "npm run dev", detail: "/fixture" }, { id: "200", title: "npm test", detail: "/fixture" }];
  const mutations = [], prompts = [];
  await page.route(`**/api/chats/${chat.id}/messages`, route => { prompts.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  await page.route(`**/api/chats/${chat.id}/commands/inspect*`, route => {
    if (route.request().method() === "POST") { const body = route.request().postDataJSON(); mutations.push(body); items = items.filter(item => item.id !== body.terminate); }
    return route.fulfill({ json: { title: "Background terminals", items, awake: true, note: "Only this native thread" } });
  });
  const input = page.getByLabel("Message", { exact: true }); await input.fill("/ps"); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  const dialog = page.getByRole("dialog", { name: "Background terminals" }); await expect(dialog).toContainText("npm run dev");
  page.once("dialog", request => request.dismiss()); await page.getByRole("button", { name: "Stop task 100", exact: true }).click(); expect(mutations).toHaveLength(0);
  page.once("dialog", request => request.accept()); await page.getByRole("button", { name: "Stop task 100", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop task 100", exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "Stop task 200", exact: true })).toBeVisible();
  expect(mutations).toEqual([{ terminate: "100", confirm: true }]); expect(prompts).toEqual([]);
  await page.locator("#controls-dialog").evaluate(node => node.close()); await input.fill("Unsent next task");
  expect(await input.inputValue()).toBe("Unsent next task");
});

test("long chats mount only a bounded window and navigate to unmounted messages without losing history", async ({ page }) => {
  const messages = Array.from({ length: 180 }, (_, i) => [
    { id: `user-${i}`, role: "user", text: `Window fixture message ${i}` },
    { id: `reply-${i}`, role: "assistant", text: `## Reply ${i}\n\n${"A paragraph for a long rendering fixture. ".repeat(15)}` },
  ]).flat();
  await openFixture(page, messages);
  expect(await page.locator("#messages .message").count()).toBeLessThanOrEqual(60);
  await expect(page.locator('[data-message-id="reply-179"]')).toBeVisible();
  await expect(page.locator('[data-message-id="user-0"]')).toHaveCount(0);
  await page.locator("#message-navigator > button").click();
  await page.getByRole("button", { name: "Jump to message 1: Window fixture message 0", exact: true }).click();
  await expect(page.locator('[data-message-id="user-0"]')).toBeInViewport();
  expect(await page.locator("#messages .message").count()).toBeLessThanOrEqual(60);
  await page.locator("#message-navigator > button").click();
  await page.getByRole("button", { name: "Jump to message 91: Window fixture message 90", exact: true }).click();
  await expect(page.locator('[data-message-id="user-90"]')).toBeInViewport();
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect(page.locator('[data-message-id="reply-179"]')).toBeInViewport();
  expect(await page.locator("#messages .message").count()).toBeLessThanOrEqual(60);
});

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
  await page.locator("#organize-delete-chat").click();
  const confirmation = page.getByRole("dialog", { name: "Delete chat?" });
  await confirmation.getByRole("button", { name: "Delete chat" }).click();
  await expect(page.locator("#toasts")).toContainText("Please retry");
  expect((await page.request.get(`/api/chats/${chat.id}`)).ok()).toBe(true);
  failDelete = false;
  await page.getByRole("button", { name: `Organize ${chat.title}`, exact: true }).click();
  await page.locator("#organize-delete-chat").click();
  await confirmation.getByRole("button", { name: "Delete chat" }).click();
  await expect(page.locator("#organize-dialog")).not.toBeVisible(); await expect(page.locator("#new-chat-page")).toBeVisible();
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
test("Relay protocol metadata never renders or creates document previews", async ({ page }) => {
  await openFixture(page, [{ id: "protocol-leak", role: "assistant", text: "Visible result\n<relay-title>Hidden title</relay-title>\n<relay-waiting>yes</relay-waiting>\n<relay-goal>continue</relay-goal>" }]);
  const message = page.locator('[data-message-id="protocol-leak"]');
  await expect(message).toContainText("Visible result");
  await expect(message).not.toContainText("relay-title");
  await expect(message).not.toContainText("Hidden title");
  await expect(message.getByRole("button", { name: /Open HTML preview/ })).toHaveCount(0);
});
test("raw and fenced HTML stay isolated across messages and cannot load remote resources", async ({ page }) => {
  const escapedRequests = [];
  await page.route("https://preview-escape.invalid/**", route => { escapedRequests.push(route.request().url()); return route.abort(); });
  const fragment = '<div><style>@import "https://preview-escape.invalid/style"; body{background:rgb(10,20,30)} .message{display:none}</style><h1>Isolated fragment</h1><img src="https://preview-escape.invalid/image"><iframe src="https://preview-escape.invalid/frame"></iframe><meta http-equiv="refresh" content="0;url=https://preview-escape.invalid/redirect"><form action="https://preview-escape.invalid/post"><input autofocus onfocus="parent.document.body.innerHTML=\'bad\'"></form><script>fetch("https://preview-escape.invalid/script");parent.location="https://preview-escape.invalid/top"</script><table><tr><td>Unclosed cell';
  await openFixture(page, [
    { id: "raw-fragment", role: "assistant", text: fragment },
    { id: "separate-reply", role: "assistant", text: "## Next message\n\nThis **still renders** normally.\n\n- First item\n- Second item" },
    { id: "markdown-document", role: "assistant", text: '```markdown\n# Markdown document\n\n| Name | Result |\n| --- | --- |\n| Isolation | Passed |\n\n<style>body{color:rgb(20,30,40)}</style><div>Unclosed markdown HTML\n```' },
  ]);
  const shellColor = await page.locator("body").evaluate(element => getComputedStyle(element).backgroundColor);
  const url = page.url();
  await page.locator('[data-message-id="raw-fragment"]').getByRole("button", { name: "Open HTML preview ↗", exact: true }).click();
  let frame = page.frameLocator("#preview-content iframe");
  await expect(frame.getByRole("heading", { name: "Isolated fragment" })).toBeVisible();
  await expect(frame.locator("td")).toHaveText("Unclosed cell");
  await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(10, 20, 30)");
  await expect(frame.locator("body").locator("script, iframe, form, input, meta")).toHaveCount(0);
  await expect(frame.locator('meta[http-equiv="refresh"]')).toHaveCount(0);
  await expect(page.locator('[data-message-id="separate-reply"] h2')).toHaveText("Next message");
  await expect(page.locator('[data-message-id="separate-reply"] li')).toHaveCount(2);
  expect(await page.locator("body").evaluate(element => getComputedStyle(element).backgroundColor)).toBe(shellColor);
  expect(page.url()).toBe(url); expect(escapedRequests).toEqual([]);
  await page.locator('[data-message-id="markdown-document"]').getByRole("button", { name: "Open Markdown preview ↗", exact: true }).click();
  frame = page.frameLocator("#preview-content iframe");
  await expect(frame.getByRole("heading", { name: "Markdown document" })).toBeVisible();
  await expect(frame.locator("td").last()).toHaveText("Passed");
  await expect(page.locator("#messages iframe")).toHaveCount(0);
  expect(escapedRequests).toEqual([]);
});

test("25 tool uses collapse into one row and open real inputs/results in the side panel", async ({ page }) => {
  const messages = [{ id: "u", role: "user", text: "Inspect the code" }, ...Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, role: "tool", kind: "tool", text: "Bash", meta: { itemId: `call${i}`, tool: "Bash", title: "npm test", input: '{"command":"npm test"}', output: i === 0 ? "Permission denied" : "All tests passed", failed: i === 0, state: "completed" } })), { id: "a", role: "assistant", text: "Inspection complete" }];
  await openFixture(page, messages); await expect(page.locator("#messages .tool-details")).toHaveCount(0);
  await page.getByRole("button", { name: "Tools used: 25 ›" }).click(); await expect(page.locator("#tools-panel details")).toHaveCount(25);
  await page.locator("#tools-panel details summary").first().click(); await expect(page.locator("#tools-panel details").first()).toContainText("Permission denied");
  await expect(page.locator("#tools-panel details").first()).toContainText("npm test");
  await page.keyboard.press("Escape"); await expect(page.locator("#tools-panel")).not.toBeVisible();
});
test("agent questions have clickable choices, keep draft answers during updates and ignore stale resolution", async ({ page }) => {
  await page.addInitScript(() => { const Native = window.EventSource; window.relaySources = []; window.EventSource = class extends Native { constructor(...args) { super(...args); window.relaySources.push(this); } }; });
  const pendingRequest = { requestId: "question-one", method: "item/tool/requestUserInput", prompt: "Two follow-up questions", questions: [
    { id: "branch", header: "Branch", question: "Which branch should I use?", options: [{ label: "Main", description: "Use the default branch" }, { label: "Develop", description: "Use the integration branch" }] },
    { id: "details", header: "Details", question: "Any other constraints?", options: [] },
  ] };
  const chat = await openFixture(page, [], { status: "running", pendingRequest });
  const emit = event => page.evaluate(({ chatId, event }) => window.relaySources.find(s => s.url.includes(`/chats/${chatId}/events`)).dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })), { chatId: chat.id, event });
  await page.getByLabel("Message", { exact: true }).fill("Keep my prompt draft");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.getByRole("radio", { name: "Main Use the default branch", exact: true })).toBeFocused();
  await page.getByRole("radio", { name: "Develop Use the integration branch", exact: true }).check();
  const details = page.getByRole("textbox", { name: "Details — your answer", exact: true }); await details.fill("Keep\nexisting data");
  await emit({ type: "chat_updated", chat: { ...chat, revision: 1000, status: "running", pendingRequest } });
  await expect(details).toHaveValue("Keep\nexisting data"); await expect(details).toBeFocused();
  await expect(page.getByRole("radio", { name: "Develop Use the integration branch", exact: true })).toBeChecked();
  let received, release;
  const responseGate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/chats/${chat.id}/requests/question-one/respond`, async route => { received = route.request().postDataJSON(); await responseGate; await route.fulfill({ json: { resolved: true } }); });
  await page.getByRole("button", { name: "Send answers", exact: true }).click();
  await expect.poll(() => received).toEqual({ answers: { branch: "Develop", details: "Keep\nexisting data" } });
  await expect(page.getByRole("button", { name: "Send answers", exact: true })).toBeDisabled();
  const next = { ...pendingRequest, requestId: "question-two", questions: [{ id: "next", header: "Next", question: "What comes next?" }] };
  await emit({ type: "request", request: next }); await emit({ type: "request_resolved", requestId: "question-one" });
  release();
  await expect(page.getByRole("textbox", { name: "Next — your answer", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send answers", exact: true })).toBeEnabled();
  let failed = true;
  await page.route(`**/api/chats/${chat.id}/requests/question-two/respond`, route => failed ? route.fulfill({ status: 503, json: { error: "Please retry the answer" } }) : route.fulfill({ json: { resolved: true } }));
  await page.getByRole("textbox", { name: "Next — your answer", exact: true }).fill("Ship this");
  await page.getByRole("button", { name: "Send answers", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Next — your answer", exact: true })).toHaveValue("Ship this");
  await expect(page.getByRole("button", { name: "Send answers", exact: true })).toBeEnabled();
  failed = false; await page.getByRole("button", { name: "Skip questions", exact: true }).click();
  await expect(page.locator("#approval-card")).not.toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep my prompt draft");
});

test("/plan accepts a task, queues while busy and keeps the command on a control error", async ({ page }) => {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Plan UI fixture" } })).json(); created.push(chat.id);
  await page.goto(`/#chat=${chat.id}`);
  const input = page.getByLabel("Message", { exact: true });
  await input.fill("/plan testing\nwith details"); await input.press("Enter");
  await expect.poll(async () => (await (await page.request.get(`/api/chats/${chat.id}`)).json()).chat.mode).toBe("plan");
  await expect(page.locator("#messages")).toContainText("POC worker received: “testing");
  await expect(page.locator("#messages")).toContainText("with details");
  await page.request.post(`/api/chats/${chat.id}/stop`);
  await page.route(`**/api/chats/${chat.id}/mode`, route => route.fulfill({ status: 503, json: { error: "Mode update unavailable" } }));
  await input.fill("/plan "); await input.press("Enter");
  await expect(page.locator("#toasts")).toContainText("Mode update unavailable");
  await expect(input).toHaveValue("/plan ");
  const busy = await openFixture(page, [], { status: "running", agent: "codex" }); let queued;
  await page.route(`**/api/chats/${busy.id}/queue`, route => { queued = route.request().postDataJSON(); return route.fulfill({ status: 202, json: {} }); });
  await input.fill("/plan "); await input.press("Enter");
  await expect.poll(() => queued).toEqual({ text: "/plan", attachments: [] });
  await expect(page.locator("#toasts")).not.toContainText("native terminal command");
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
test("Compact stays available for working and stopped agents, queues /compact, and preserves the composer draft", async ({ page }) => {
  for (const [agent, status, tail] of [["codex", "running", "queue"], ["codex", "stopped", "messages"], ["claude", "running", "queue"]]) {
    const chat = await openFixture(page, [], { agent, status });
    await page.route(`**/api/chats/${chat.id}/session-info`, route => route.fulfill({ json: { agent, canCompact: false, snapshot: status === "stopped" } }));
    let received;
    await page.route(`**/api/chats/${chat.id}/${tail}`, route => { received = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { chat } }); });
    await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
    await page.getByLabel("Context and usage", { exact: true }).click();
    const compact = page.getByRole("button", { name: "Compact session", exact: true });
    await expect(compact).toBeEnabled(); await expect(compact).not.toHaveAttribute("title", /idle|Claude/);
    await compact.click(); await expect.poll(() => received).toEqual({ text: "/compact" });
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this draft");
  }
});
test("Send now targets one queued message, retains the others and preserves drafts on failure and retry", async ({ page }) => {
  const queuedMessages = [{ id: "queued-one", text: "Do this later" }, { id: "queued-two", text: "Do this now" }, { id: "queued-three", text: "Then this" }];
  const chat = await openFixture(page, [], { status: "running", queuedMessages });
  const input = page.getByLabel("Message", { exact: true }); await input.fill("An unfinished draft");
  const patches = []; let fail = true, release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/chats/${chat.id}/queue`, async route => {
    patches.push(route.request().postDataJSON());
    if (fail) return route.fulfill({ status: 503, json: { error: "Retry sending this queued message" } });
    await gate;
    await route.fulfill({ json: { chat: { ...chat, status: "running", revision: 1000, queuedMessages: [queuedMessages[0], queuedMessages[2]] } } });
  });
  const selected = page.locator('[data-queue-id="queued-two"]');
  await expect(selected.getByRole("button", { name: "Send now", exact: true })).toBeVisible();
  await selected.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.locator("#toasts")).toContainText("Retry sending");
  await expect(page.locator(".queue-row")).toHaveCount(3); await expect(input).toHaveValue("An unfinished draft");
  fail = false; await selected.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(selected.getByRole("button", { name: "Sending…", exact: true })).toBeDisabled();
  expect(patches).toEqual([{ sendNowId: "queued-two" }, { sendNowId: "queued-two" }]);
  release(); await expect(selected).toHaveCount(0); await expect(page.locator(".queue-row")).toHaveCount(2);
  await expect(page.locator(".queue-text")).toHaveText(["Do this later", "Then this"]);
  await expect(input).toHaveValue("An unfinished draft");
});

test("busy composer accepts queued messages and its main button stops the agent", async ({ page }) => {
  const chat = await openFixture(page, [], { status: "running" });
  let queued = "", stopped = false;
  await page.route(`**/api/chats/${chat.id}/queue`, route => { queued = route.request().postDataJSON().text; return route.fulfill({ json: { chat } }); });
  await page.route(`**/api/chats/${chat.id}/interrupt`, route => { stopped = true; return route.fulfill({ json: { chat: { ...chat, status: "idle" } } }); });
  const input = page.getByLabel("Message", { exact: true }); await expect(input).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toBeEnabled();
  await input.fill("Do this next"); await input.press("Enter"); await expect.poll(() => queued).toBe("Do this next");
  await page.getByRole("button", { name: "Stop agent", exact: true }).click(); await expect.poll(() => stopped).toBe(true);
});
test("MCP connection can be saved masked then selected in an environment", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "MCP connections", exact: true }).click();
  await page.locator("#mcp-dialog").getByLabel("Connection name", { exact: true }).fill("browser-tools");
  await page.locator("#mcp-companies").getByRole("checkbox", { name: "Unassigned chats (no company)", exact: true }).check();
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
      await page.locator("#mcp-dialog").getByLabel("Connection name", { exact: true }).fill("linear-scoped");
      await page.locator("#mcp-companies").getByLabel("Add companies", { exact: true }).fill(org);
      await page.locator("#mcp-companies").getByRole("button", { name: "Add companies", exact: true }).click();
      await page.getByLabel("MCP endpoint URL").fill("https://mcp.linear.app/mcp");
      await page.getByRole("button", { name: "Save connection" }).click(); await expect(page.locator("#mcp-save-status")).toContainText("Saved");
      await expect(page.locator("#mcp-list")).toContainText(`${org} · linear-scoped · Sign-in required`);
    }
    const { connections } = await (await page.request.get("/api/mcps")).json(); ids.push(...connections.filter(c => c.name === "linear-scoped").map(c => c.id)); expect(ids.length).toBe(2);
    await page.locator("#mcp-list").getByRole("button", { name: /^12-apps · linear-scoped/ }).click(); await expect(page.locator("#mcp-companies").getByRole("checkbox", { name: "12-apps", exact: true })).toBeChecked();
    await page.getByLabel("Close MCP connections").click(); await page.getByRole("button", { name: "Environments", exact: true }).click();
    await page.getByRole("button", { name: "Add environment", exact: false }).click(); await page.getByLabel("Environment name", { exact: true }).fill("Scoped MCP test");
    await page.locator("#environment-companies").getByLabel("Add companies", { exact: true }).fill("12-apps, g2i");
    await page.locator("#environment-companies").getByRole("button", { name: "Add companies", exact: true }).click();
    for (const org of ["12-apps", "g2i"]) await page.locator("#environment-mcp-options").getByRole("checkbox", { name: `linear-scoped · http · ${org}`, exact: true }).check();
    await page.getByRole("button", { name: "Save environment" }).click(); await expect(page.locator("#environment-save-status")).toContainText("Saved securely");
    const { environments } = await (await page.request.get("/api/environments")).json(); env = environments.find(e => e.name === "Scoped MCP test"); expect(env.mcpIds.sort()).toEqual(ids.sort());
  } finally {
    if (env) await page.request.delete(`/api/environments/${env.id}`);
    for (const id of ids) await page.request.delete(`/api/mcps/${id}`);
  }
});

test("all development MCP presets populate their official endpoint without installing or authorizing", async ({ page }) => {
  const before = await (await page.request.get("/api/mcps")).json();
  await page.goto("/"); await page.getByRole("button", { name: "MCP connections", exact: true }).click();
  const presets = [
    ["linear", "Linear", "https://mcp.linear.app/mcp", "oauth"],
    ["atlassian", "Atlassian", "https://mcp.atlassian.com/v2/mcp", "oauth"],
    ["github", "GitHub", "https://api.githubcopilot.com/mcp/", "headers"],
    ["sentry", "Sentry", "https://mcp.sentry.dev/mcp", "oauth"],
    ["figma", "Figma", "https://mcp.figma.com/mcp", "oauth"],
    ["notion", "Notion", "https://mcp.notion.com/mcp", "oauth"],
    ["context7", "Context7", "https://mcp.context7.com/mcp", "none"],
  ];
  for (const [id, name, endpoint, auth] of presets) {
    await page.locator("#mcp-catalog").evaluate(node => { node.open = true; });
    await page.locator("#mcp-presets").getByRole("button", { name: new RegExp(`^${name} `) }).click();
    await expect(page.locator("#mcp-name")).toHaveValue(id);
    await expect(page.locator("#mcp-url")).toHaveValue(endpoint);
    await expect(page.locator("#mcp-type")).toHaveValue("http");
    await expect(page.locator("#mcp-auth")).toHaveValue(auth);
    await expect(page.locator("#mcp-headers")).toHaveValue("");
  }
  expect(await (await page.request.get("/api/mcps")).json()).toEqual(before);
  await page.getByRole("button", { name: "Custom MCP" }).click();
  await expect(page.locator("#mcp-name")).toHaveValue("");
  await expect(page.locator("#mcp-url")).toHaveValue("");
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

test("stopped chat shows its saved context snapshot after reload without waking the worker", async ({ page }) => {
  const usage = { version: 2, contextTokens: 137200, contextWindow: 1000000, recordedAt: "2026-09-15T18:00:00.000Z" };
  const mutations = [];
  page.on("request", request => { if (/\/api\/chats\/chat_.*\/(wake|messages|queue|compact)$/.test(request.url()) && request.method() === "POST") mutations.push(request.url()); });
  await page.route("**/api/chats/chat_*/session-info", route => route.fulfill({ json: { usage, agent: "codex", snapshot: true, rateLimits: [] } }));
  await openFixture(page, [{ id: "saved-user", role: "user", text: "A saved conversation" }], { usage, agent: "codex", status: "stopped" });
  for (let pass = 0; pass < 2; pass++) {
    if (pass) await page.reload();
    await page.getByLabel("Context and usage", { exact: true }).click();
    await expect(page.locator("#session-usage")).toContainText("137.2K / 1M (14%)");
    await expect(page.locator("#session-usage")).toContainText("Saved snapshot");
    await expect(page.locator("#messages")).toContainText("A saved conversation");
  }
  expect(mutations).toEqual([]);
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
