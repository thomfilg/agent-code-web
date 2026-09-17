import { test, expect } from "@playwright/test";
import { webCommands } from "../../public/web-commands.js";

const created = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function fixture(page) {
  await page.addInitScript(() => { const Native = window.EventSource; window.fixtureSources = []; window.EventSource = class extends Native { constructor(...args) { super(...args); window.fixtureSources.push(this); } }; });
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "claude", title: `Claude commands ${Date.now()}` } })).json(); created.set(page, [chat.id]);
  const f = { snapshot: { ...chat, revision: 10000, commandCatalogRevision: 0 }, catalog: [{ name: "fixture-old", description: "Old native command" }], reads: 0, calls: [], errors: [], responseStatus: 202 };
  page.on("pageerror", error => f.errors.push(error.message));
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: f.snapshot } }));
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}/commands`, async route => { f.reads++; const commands = [...webCommands("claude"), { name: "reload-skills" }, ...f.catalog]; await f.gate; await route.fulfill({ json: { commands } }); });
  for (const tail of ["messages", "queue"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { f.calls.push({ tail, ...route.request().postDataJSON() }); return route.fulfill({ status: f.responseStatus, json: f.responseStatus === 202 ? {} : { error: f.responseError || "/config and /settings do not accept attachments. Remove them or send them in a separate message." } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  f.emit = async () => {
    f.snapshot = { ...f.snapshot, revision: f.snapshot.revision + 1, commandCatalogRevision: f.snapshot.commandCatalogRevision + 1 };
    await page.evaluate(chat => window.fixtureSources.find(source => source.url.includes(`/chats/${chat.id}/events`)).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat_updated", chat }) })), f.snapshot);
  };
  return f;
}

test("native skill reload refreshes an open slash menu immediately without changing the query or sending it", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  await input.fill("/fixture"); await expect(page.locator("#slash-options")).toContainText("/fixture-old");
  await input.fill("/reload-skills"); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(1); expect(f.calls[0]).toEqual({ tail: "messages", text: "/reload-skills", attachments: [] });
  await input.fill("/fresh"); await expect(page.locator("#slash-status")).toContainText("No matches");
  f.catalog = [{ name: "fresh:rules", description: "Newly installed native command" }]; await f.emit();
  await expect(page.locator("#slash-options")).toContainText("/fresh:rules"); await expect(input).toHaveValue("/fresh");
  await page.locator("#slash-options [role=option]").click(); await expect(input).toHaveValue("/fresh:rules ");
  expect(f.reads).toBe(2); expect(f.calls).toHaveLength(1); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`Claude MCP controls at ${width}px preserve manager/status dialogs and queue native actions`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input");
  await page.route(`**/api/chats/${f.snapshot.id}/session-info`, route => route.fulfill({ json: { connectors: [{ name: "relay_one", status: "disabled" }] } }));
  await input.fill("/mc"); await expect(page.locator("#slash-options")).toContainText("reconnect, enable or disable");
  await page.locator("#slash-options [role=option]").click(); await expect(input).toHaveValue("/mcp "); expect(f.calls).toEqual([]);
  await input.fill("/mcp"); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#mcp-dialog")).toBeVisible(); await page.locator("#mcp-close").click();
  await input.fill("/mcp verbose"); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#controls-content")).toContainText("relay_one · disabled");
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close()); expect(f.calls).toEqual([]);
  const commands = ["/mcp reconnect relay_one", "/mcp disable all", "/mcp enable relay_one"];
  for (const [index, text] of commands.entries()) {
    await input.fill(text); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
    await expect.poll(() => f.calls.length).toBe(index + 1);
    expect(f.calls.at(-1)).toEqual({ tail: index ? "queue" : "messages", text, attachments: [] });
    f.snapshot.status = "running"; await f.emit();
  }
  expect(f.errors).toEqual([]);
});

test("rejected MCP attachments keep the command and file available for retry", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  f.responseStatus = 400; f.responseError = "/mcp does not accept attachments. Remove them or send them in a separate message.";
  await page.locator("#attachment-input").setInputFiles({ name: "keep-mcp.txt", mimeType: "text/plain", buffer: Buffer.from("Unsent private file") });
  await expect(page.locator("#attachment-chips")).toContainText("keep-mcp.txt");
  await input.fill("/mcp disable all"); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#toasts")).toContainText("/mcp does not accept attachments"); await expect(input).toHaveValue("/mcp disable all");
  await expect(page.locator("#attachment-chips")).toContainText("keep-mcp.txt");
  await page.locator("#attachment-chips button").filter({ hasText: "×" }).click(); f.responseStatus = 202;
  await page.locator("#composer").evaluate(form => form.requestSubmit()); await expect.poll(() => f.calls.length).toBe(2);
  expect(f.calls.at(-1)).toEqual({ tail: "messages", text: "/mcp disable all", attachments: [] }); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`Claude Fast commands at ${width}px are discoverable, literal and queued while busy`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input");
  f.catalog = [{ name: "fast", description: "Toggle Fast for this chat; may increase usage costs" }]; await f.emit();
  await input.fill("/fas"); await expect(page.locator("#slash-options")).toContainText("/fast");
  await page.locator("#slash-options [role=option]").click(); await expect(input).toHaveValue("/fast "); expect(f.calls).toEqual([]);
  for (const text of ["/fast", "/fast on", "/fast off"]) {
    await input.fill(text); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
    await expect.poll(() => f.calls.length).toBe(["/fast", "/fast on", "/fast off"].indexOf(text) + 1);
    expect(f.calls.at(-1)).toEqual({ tail: text === "/fast" ? "messages" : "queue", text, attachments: [] });
    f.snapshot.status = "running"; await f.emit();
  }
  expect(f.errors).toEqual([]);
});

test("rejected Claude Fast input retains its draft and attachment for an explicit retry", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  f.responseStatus = 400; f.responseError = "/fast does not accept attachments. Remove them or send them in a separate message.";
  await page.locator("#attachment-input").setInputFiles({ name: "keep-fast.txt", mimeType: "text/plain", buffer: Buffer.from("Private unsent content") });
  await expect(page.locator("#attachment-chips")).toContainText("keep-fast.txt");
  await input.fill("/fast on"); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#toasts")).toContainText("does not accept attachments"); await expect(input).toHaveValue("/fast on");
  await expect(page.locator("#attachment-chips")).toContainText("keep-fast.txt");
  await page.locator("#attachment-chips button").filter({ hasText: "×" }).click();
  f.responseStatus = 202;
  await page.locator("#composer").evaluate(form => form.requestSubmit()); await expect.poll(() => f.calls.length).toBe(2);
  expect(f.calls.at(-1)).toEqual({ tail: "messages", text: "/fast on", attachments: [] }); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`native Claude goals at ${width}px insert without sending and preserve literal queued conditions`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input");
  f.catalog = [{ name: "goal", description: "Set a goal — keep working until the condition is met" }]; await f.emit();
  await input.fill("/goa"); await expect(page.locator("#slash-options")).toContainText("/goal");
  await page.locator("#slash-options [role=option]").click(); await expect(input).toHaveValue("/goal "); expect(f.calls).toEqual([]);
  const commands = ["/goal Complete both steps\nand preserve ação.", "/goal", "/goal clear"];
  for (const [index, text] of commands.entries()) {
    await input.fill(text); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
    await expect.poll(() => f.calls.length).toBe(index + 1);
    expect(f.calls.at(-1)).toEqual({ tail: index === 0 ? "messages" : "queue", text, attachments: [] });
    f.snapshot.status = "running"; await f.emit();
  }
  expect(f.errors).toEqual([]);
});

test("native goal responses keep paragraph boundaries and evaluator notices are visible without consuming the draft", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  await input.fill("Keep this unsent message");
  f.snapshot.messages = [
    { id: "msg_goal_reply", role: "assistant", kind: "message", agent: "claude", text: "First step verified.\n\nSecond step still needs verification." },
    { id: "msg_goal_notice", role: "system", kind: "notice", text: "Claude reported a Stop-hook error. The completion check failed; use /goal to inspect any active goal or check the native hook settings." },
  ];
  await f.emit();
  await expect(page.locator(".message-body p").filter({ hasText: "First step verified." })).toHaveText("First step verified.");
  await expect(page.locator(".message-body p").filter({ hasText: "Second step still needs verification." })).toHaveText("Second step still needs verification.");
  await expect(page.getByText(/Claude reported a Stop-hook error/)).toBeVisible();
  await expect(input).toHaveValue("Keep this unsent message"); expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

test("a stale pending discovery cannot replace commands fetched after the native catalog changes", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  let release; f.gate = new Promise(resolve => { release = resolve; });
  await input.fill("/fixture"); await expect.poll(() => f.reads).toBe(1);
  f.gate = null; f.catalog = [{ name: "fixture-new", description: "Refreshed command" }]; await f.emit();
  await expect(page.locator("#slash-options")).toContainText("/fixture-new");
  const response = page.waitForResponse(reply => reply.url().endsWith("/commands")); release(); await (await response).finished();
  await expect(page.locator("#slash-options")).not.toContainText("/fixture-old"); await expect(input).toHaveValue("/fixture");
  expect(f.reads).toBe(2); expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

test("catalog refresh leaves a closed menu, draft and attachments untouched and rejects old replay snapshots", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  await input.fill("/fixture"); await expect(page.locator("#slash-options")).toContainText("/fixture-old");
  await input.fill("Unsent draft with no command");
  await page.locator("#attachment-input").setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("Private fixture attachment") });
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt");
  const stale = f.snapshot; f.catalog = [{ name: "fixture-new", description: "Current command" }]; await f.emit();
  await expect(page.locator("#slash-menu")).not.toBeVisible(); await expect(input).toHaveValue("Unsent draft with no command");
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt"); expect(f.reads).toBe(1);
  await input.fill("/fixture"); await expect(page.locator("#slash-options")).toContainText("/fixture-new");
  await page.evaluate(chat => window.fixtureSources.find(source => source.url.includes(`/chats/${chat.id}/events`)).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat_updated", chat }) })), stale);
  await expect(page.locator("#slash-options")).toContainText("/fixture-new"); expect(f.reads).toBe(2); expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`native configuration at ${width}px stays literal, queues when busy, and updates model, Auto effort and Claude-only modes`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input");
  for (const status of ["idle", "running"]) {
    f.snapshot.status = status; await f.emit();
    const text = "/config model=haiku permissionMode=dontAsk\nlanguage=pt-BR";
    await input.fill(text); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
    await expect.poll(() => f.calls.length).toBe(status === "idle" ? 1 : 2);
    expect(f.calls.at(-1)).toEqual({ tail: status === "idle" ? "messages" : "queue", text, attachments: [] });
  }
  f.snapshot = { ...f.snapshot, status: "idle", model: "haiku", effort: "auto", mode: "dont_ask" }; await f.emit();
  await expect(page.getByRole("combobox", { name: "Chat model", exact: true })).toHaveValue("haiku");
  await expect(page.locator("#composer-model-controls .effort-label")).toHaveText("Auto");
  await expect(page.locator("#mode-label")).toHaveText("Deny prompts");
  await page.locator("#mode-label").click();
  await expect(page.locator('[data-agent-mode="default"]')).toBeVisible();
  await expect(page.locator("#mode-provider-note")).toContainText("cannot yet be answered");
  await page.keyboard.press("Escape");
  f.snapshot = { ...f.snapshot, model: "default", mode: "default" }; await f.emit();
  await expect(page.getByRole("combobox", { name: "Chat model", exact: true })).toHaveValue("default");
  await expect(page.locator("#mode-label")).toHaveText("Manual");
  f.snapshot = { ...f.snapshot, agent: "codex", model: "gpt-5.6-sol", effort: "high", mode: "plan" }; await f.emit();
  await page.locator("#mode-label").click();
  await expect(page.locator('[data-agent-mode="default"]')).toBeHidden(); await expect(page.locator('[data-agent-mode="dont_ask"]')).toBeHidden();
  expect(f.errors).toEqual([]); expect(f.calls).toHaveLength(2);
});

test("rejected configuration preserves its draft and files and can be retried after removing the attachment", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input"); f.responseStatus = 400;
  await page.locator("#attachment-input").setInputFiles({ name: "keep-config.txt", mimeType: "text/plain", buffer: Buffer.from("Unsent private fixture") });
  await expect(page.locator("#attachment-chips")).toContainText("keep-config.txt");
  const text = "/settings model=sonnet"; await input.fill(text); await input.press("Escape");
  await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#toasts")).toContainText("do not accept attachments");
  await expect(input).toHaveValue(text); await expect(page.locator("#attachment-chips")).toContainText("keep-config.txt");
  await page.locator("#attachment-chips button").filter({ hasText: "×" }).click(); f.responseStatus = 202;
  await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(2); expect(f.calls[1]).toEqual({ tail: "messages", text, attachments: [] });
  await expect(input).toHaveValue(""); expect(f.errors).toEqual([]);
});

test("Claude Manual and Deny prompts controls save through the real API without starting a worker", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "claude", title: "Native permission controls" } })).json(); created.set(page, [chat.id]);
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  for (const [mode, label] of [["default", "Manual"], ["dont_ask", "Deny prompts"]]) {
    await page.locator("#mode-label").click(); await page.locator(`[data-agent-mode="${mode}"]`).click();
    await expect(page.locator("#mode-label")).toHaveText(label);
    const saved = (await (await page.request.get(`/api/chats/${chat.id}`)).json()).chat;
    expect(saved.mode).toBe(mode); expect(saved.status).toBe("stopped"); expect(saved.agentSessionId).toBeNull(); expect(saved.messages).toEqual([]);
  }
  await page.getByLabel("Choose effort", { exact: true }).click();
  await page.getByLabel("Chat effort", { exact: true }).selectOption("auto");
  await expect(page.locator(".effort-auto-note")).toBeVisible(); await expect(page.getByRole("slider", { name: "Effort level" })).toBeHidden();
  await page.getByLabel("Chat effort", { exact: true }).selectOption("high");
  await expect(page.getByRole("slider", { name: "Effort level" })).toBeVisible();
});

test("auto-compaction discovery inserts without sending, busy commands queue literally, and rejected files retain the draft", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input");
  f.catalog = [{ name: "autocompact", description: "Set the native auto-compact window" }]; f.snapshot.status = "running"; await f.emit();
  await input.fill("/autocomp"); await page.locator("#slash-options [role=option]").filter({ hasText: "/autocompact" }).click();
  await expect(input).toHaveValue("/autocompact "); expect(f.calls).toEqual([]);
  await input.fill("/autocompact 100k"); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(1); expect(f.calls[0]).toEqual({ tail: "queue", text: "/autocompact 100k", attachments: [] });
  f.snapshot.status = "idle"; await f.emit();
  await input.fill("/autocompact"); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(2); expect(f.calls[1]).toEqual({ tail: "messages", text: "/autocompact", attachments: [] });
  await page.locator("#attachment-input").setInputFiles({ name: "keep-window.txt", mimeType: "text/plain", buffer: Buffer.from("Unsent compaction fixture") });
  await expect(page.locator("#attachment-chips")).toContainText("keep-window.txt");
  f.responseStatus = 400; f.responseError = "/autocompact does not accept attachments. Remove them or send them in a separate message.";
  await input.fill("/autocompact auto"); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#toasts")).toContainText("does not accept attachments");
  await expect(input).toHaveValue("/autocompact auto"); await expect(page.locator("#attachment-chips")).toContainText("keep-window.txt");
  expect(f.errors).toEqual([]); expect(f.calls).toHaveLength(3);
});
