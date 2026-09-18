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
  await page.goto(`/#chat=${chat.id}`);
  // Wait for fixture boot under the deliberately CPU-limited browser run;
  // command assertions below retain their normal timeouts.
  await expect(page.locator("#chat-title")).toHaveText(chat.title, { timeout: 15000 });
  await expect.poll(() => page.evaluate(id => window.fixtureSources.some(source => source.url.includes(`/chats/${id}/events`)), chat.id)).toBe(true);
  f.emit = async () => {
    f.snapshot = { ...f.snapshot, revision: f.snapshot.revision + 1, commandCatalogRevision: f.snapshot.commandCatalogRevision + 1 };
    await page.evaluate(chat => window.fixtureSources.find(source => source.url.includes(`/chats/${chat.id}/events`)).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat_updated", chat }) })), f.snapshot);
  };
  return f;
}

const requestEvent = (page, id, event) => page.evaluate(({ id, event }) => window.fixtureSources.find(source => source.url.includes(`/chats/${id}/events`))
  .dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })), { id, event });

for (const width of [1280, 320]) test(`doctor at ${width}px preserves queued files and requires separate cleanup/permission answers`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input"), card = page.locator("#approval-card"), replies = [];
  const name = width === 320 ? "checkup" : "doctor";
  f.catalog = [{ name, description: "Health-check the private setup and propose fixes" }];
  f.snapshot.status = "running"; await f.emit();
  await input.fill(`/${name.slice(0, 3)}`); await page.locator("#slash-options [role=option]").filter({ hasText: `/${name}` }).click();
  await expect(input).toHaveValue(`/${name} `); expect(f.calls).toEqual([]);
  const text = `/${name} Inspect this private profile.\nPreserve ação.`; await input.fill(text); await input.press("Escape");
  await page.locator("#attachment-input").setInputFiles({ name: "diagnostic-context.txt", mimeType: "text/plain", buffer: Buffer.from("Fixture diagnostic reference") });
  await expect(page.locator("#attachment-chips")).toContainText("diagnostic-context.txt");
  f.responseStatus = 400; f.responseError = "Native settings changes require a private Claude profile. Shared host settings writes are locked.";
  await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#toasts")).toContainText("private Claude profile"); await expect(input).toHaveValue(text);
  await expect(page.locator("#attachment-chips")).toContainText("diagnostic-context.txt");
  f.responseStatus = 202; await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(2); expect(f.calls[0]).toEqual(f.calls[1]); expect(f.calls[1].tail).toBe("queue");
  expect(f.calls[1].text).toBe(text); expect(f.calls[1].attachments).toHaveLength(1); await expect(input).toHaveValue("");
  await input.fill("Keep this unrelated draft");
  for (const [id, question, options, answer] of [
    ["cleanup", "Remove only the duplicate local instruction?", ["Clean up everything (recommended)", "Let me pick", "No, keep everything"], "Clean up everything (recommended)"],
    ["permissions", "Separately grant Bash(relay-doctor-read list)?", ["Allow the exact read command", "Keep current permissions"], "Keep current permissions"],
  ]) {
    await page.route(`**/api/chats/${f.snapshot.id}/requests/${id}/respond`, route => { replies.push({ id, ...route.request().postDataJSON() }); return route.fulfill({ json: { resolved: true } }); });
    await requestEvent(page, f.snapshot.id, { type: "request", request: { requestId: id, method: "claude/tool/requestUserInput", prompt: "Claude needs your answer",
      questions: [{ id: "question_1", header: id, question, options: options.map(label => ({ label })) }] } });
    await expect(card).toContainText(question); await expect(card.locator("input:checked")).toHaveCount(0);
    await card.getByRole("radio", { name: answer, exact: true }).check();
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await card.getByRole("button", { name: "Send answers", exact: true }).click(); await expect(card).not.toBeVisible();
    await expect.poll(() => replies.at(-1)).toEqual({ id, answers: { question_1: answer } });
    await expect(input).toHaveValue("Keep this unrelated draft");
  }
  expect(replies).toHaveLength(2); expect(f.calls).toHaveLength(2); expect(f.errors).toEqual([]);
});

test("native debug is selectable, queues intact while busy, and keeps the draft after a private-profile refusal", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  f.catalog = [{ name: "debug", description: "Turn on debug logging and investigate problems" }];
  f.snapshot.status = "running"; await f.emit();
  await input.fill("/deb"); await page.locator("#slash-options [role=option]").filter({ hasText: "/debug" }).click();
  await expect(input).toHaveValue("/debug "); expect(f.calls).toEqual([]);
  const text = "/debug Diagnose this session\nPreserve ação and the running app.";
  f.responseStatus = 400; f.responseError = "Debugging requires this chat's private Claude profile. Shared host logs remain locked.";
  await input.fill(text); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#toasts")).toContainText("Shared host logs"); await expect(input).toHaveValue(text);
  f.responseStatus = 202; await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(2);
  expect(f.calls[1]).toEqual({ tail: "queue", text, attachments: [] }); await expect(input).toHaveValue(""); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`native permission review at ${width}px keeps queued input/files and exposes trust without granting it`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input");
  f.catalog = [{ name: "fewer-permission-prompts", description: "Review frequent read-only commands and saved permission rules" }];
  f.snapshot = { ...f.snapshot, status: "running", model: "sonnet", mode: "default" }; await f.emit();
  await input.fill("/fewer-perm"); await page.locator("#slash-options [role=option]").filter({ hasText: "/fewer-permission-prompts" }).click();
  await expect(input).toHaveValue("/fewer-permission-prompts "); expect(f.calls).toEqual([]);
  const text = "/fewer-permission-prompts Review private fixture history\nPreserve ação and existing deny rules.";
  await input.fill(text); await input.press("Escape");
  await page.locator("#attachment-input").setInputFiles({ name: "permission-context.txt", mimeType: "text/plain", buffer: Buffer.from("Read-only context") });
  await expect(page.locator("#attachment-chips")).toContainText("permission-context.txt");
  f.responseStatus = 400; f.responseError = "Native settings changes require a private Claude profile. Shared host settings writes are locked.";
  await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#toasts")).toContainText("private Claude profile");
  await expect(input).toHaveValue(text); await expect(page.locator("#attachment-chips")).toContainText("permission-context.txt");
  f.responseStatus = 202; await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(2); expect(f.calls[1]).toEqual(f.calls[0]);
  expect(f.calls[1].tail).toBe("queue"); expect(f.calls[1].text).toBe(text); expect(f.calls[1].attachments).toHaveLength(1);
  await expect(input).toHaveValue("");
  f.snapshot = { ...f.snapshot, status: "idle", messages: [{ id: "trust-warning", role: "system", kind: "notice",
    text: "Claude is ignoring project permission grants because this workspace has not been trusted. Saving allow rules does not enable them. Review and explicitly trust the workspace in this chat's private Claude profile; existing approval requirements remain in force." }] }; await f.emit();
  await expect(page.locator("#messages")).toContainText("Saving allow rules does not enable them");
  await input.fill("Keep my next draft"); await f.emit(); await expect(input).toHaveValue("Keep my next draft");
  expect(f.calls).toHaveLength(2); expect(f.snapshot.model).toBe("sonnet"); expect(f.snapshot.mode).toBe("default"); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`native batch at ${width}px keeps its queue and draft through all partial reports`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input");
  f.catalog = [{ name: "batch", description: "Parallel native work in isolated worktrees" }]; f.snapshot.status = "idle"; await f.emit();
  await input.fill("/bat"); await page.locator("#slash-options [role=option]").filter({ hasText: "/batch" }).click();
  await expect(input).toHaveValue("/batch "); expect(f.calls).toEqual([]);
  const text = "/batch Apply five independent changes\nPreserve ação and require plan approval.";
  await input.fill(text); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(1); expect(f.calls[0]).toEqual({ tail: "messages", text, attachments: [] });
  f.snapshot = { ...f.snapshot, status: "running", statusDetail: "Native background task is working", idleDeadlineAt: null,
    messages: [{ id: "batch-input", role: "user", kind: "message", text }, { id: "batch-start", role: "assistant", kind: "message", text: "Five native worktree agents are running." }],
    queuedMessages: [{ id: "after-batch", text: "Continue after all reports" }] }; await f.emit();
  await input.fill("Keep this unsent draft");
  for (let count = 1; count <= 5; count++) {
    f.snapshot = { ...f.snapshot, messages: [...f.snapshot.messages, { id: `batch-report-${count}`, role: "assistant", kind: "message", text: `${count}/5 native units reported.` }] }; await f.emit();
    await expect(page.getByText(`${count}/5 native units reported.`, { exact: true })).toBeVisible();
    await expect(page.locator("#runtime-status")).toHaveText("running");
    await expect(page.locator('[data-queue-id="after-batch"]')).toContainText("Continue after all reports");
    await expect(page.locator("#countdown")).not.toContainText("SLEEPS IN"); await expect(input).toHaveValue("Keep this unsent draft");
  }
  f.snapshot = { ...f.snapshot, status: "idle", queuedMessages: [], messages: [...f.snapshot.messages,
    { id: "batch-follow-up", role: "user", kind: "message", text: "Continue after all reports" },
    { id: "batch-follow-up-reply", role: "assistant", kind: "message", text: "Follow-up finished after the batch." }] }; await f.emit();
  await expect(page.locator(".queue-row")).toHaveCount(0); await expect(page.getByText("Follow-up finished after the batch.", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("Keep this unsent draft"); expect(f.calls).toHaveLength(1); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`native research at ${width}px stays running after launch and keeps draft/files on a failed Send now`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input"), actions = [];
  f.catalog = [{ name: "deep-research", description: "Native multi-source research workflow" }];
  f.snapshot.status = "idle"; await f.emit();
  await input.fill("/deep-res"); await expect(page.locator("#slash-options")).toContainText("/deep-research");
  await page.locator("#slash-options [role=option]").click(); await expect(input).toHaveValue("/deep-research ");
  const text = "/deep-research Compare the fixture records\nPreserve ação and this second line.";
  await input.fill(text); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(1); expect(f.calls[0]).toEqual({ tail: "messages", text, attachments: [] });
  f.snapshot = { ...f.snapshot, status: "running", statusDetail: "Native background task is working", idleDeadlineAt: null,
    messages: [{ id: "research-start", role: "assistant", kind: "message", text: "Research is running in the native workflow." }],
    queuedMessages: [{ id: "later", text: "Retain this queued input" }, { id: "now", text: "Send this selected input now" }] }; await f.emit();
  await expect(page.locator("#runtime-status")).toHaveText("running"); await expect(page.locator("#queue-message")).toBeVisible();
  await expect(page.locator("#countdown")).not.toContainText("SLEEPS IN");
  await input.fill("Keep this unsent draft");
  await page.locator("#attachment-input").setInputFiles({ name: "research-context.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this attachment") });
  let failed = true;
  await page.route(`**/api/chats/${f.snapshot.id}/queue`, async route => {
    actions.push(route.request().postDataJSON());
    if (failed) return route.fulfill({ status: 503, json: { error: "Native workflow cancellation failed; the queued message was not sent. Retry or explicitly Stop the worker." } });
    f.snapshot = { ...f.snapshot, revision: f.snapshot.revision + 1, queuedMessages: f.snapshot.queuedMessages.filter(item => item.id !== "now") };
    await route.fulfill({ json: { chat: f.snapshot } });
  });
  const sendNow = page.locator('[data-queue-id="now"]').getByRole("button", { name: "Send now", exact: true });
  await sendNow.click(); await expect(page.locator("#toasts")).toContainText("the queued message was not sent");
  await expect(page.locator(".queue-row")).toHaveCount(2); await expect(sendNow).toBeEnabled();
  failed = false; await sendNow.click(); await expect(page.locator(".queue-row")).toHaveCount(1);
  expect(actions).toEqual([{ sendNowId: "now" }, { sendNowId: "now" }]);
  f.snapshot = { ...f.snapshot, status: "idle", messages: [...f.snapshot.messages, { id: "research-report", role: "assistant", kind: "message", text: "Native report: [Fixture source](https://alpha.example.test/record)." }] }; await f.emit();
  await expect(page.locator("#messages").getByRole("link", { name: "Fixture source" })).toHaveAttribute("href", "https://alpha.example.test/record");
  await expect(input).toHaveValue("Keep this unsent draft"); await expect(page.locator("#attachment-chips")).toContainText("research-context.txt");
  expect(f.calls).toHaveLength(1); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`native loops at ${width}px expose awake/running state and Send now without consuming the draft`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input"), actions = [];
  f.catalog = [{ name: "loop", description: "Schedule a native recurring prompt" }, { name: "simplify", description: "Simplify changed code" }]; await f.emit();
  await input.fill("/loo"); await expect(page.locator("#slash-options")).toContainText("/loop");
  await page.locator("#slash-options [role=option]").click(); await expect(input).toHaveValue("/loop "); expect(f.calls).toEqual([]);
  await input.fill("Keep this draft unsent");
  await page.locator("#attachment-input").setInputFiles({ name: "loop-context.txt", mimeType: "text/plain", buffer: Buffer.from("Unsent context") });
  f.snapshot = { ...f.snapshot, status: "idle", idleKeepAwakeReason: "schedule", idleDeadlineAt: null, statusDetail: "Sleep paused while native scheduled tasks are active" }; await f.emit();
  await expect(page.locator("#runtime-status")).toHaveText("Ready"); await expect(page.locator("#countdown")).toHaveText("KEPT AWAKE");
  await expect(page.locator("#runtime-detail")).toContainText("scheduled tasks");
  f.snapshot = { ...f.snapshot, status: "running", idleKeepAwakeReason: null, statusDetail: "Native background task is working", queuedMessages: [{ id: "later", text: "Keep queued" }, { id: "now", text: "Cancel this loop" }] }; await f.emit();
  await expect(page.locator("#runtime-status")).toHaveText("running"); await expect(page.locator("#queue-message")).toBeVisible();
  await page.route(`**/api/chats/${f.snapshot.id}/queue`, async route => {
    actions.push(route.request().postDataJSON());
    f.snapshot = { ...f.snapshot, revision: f.snapshot.revision + 1, queuedMessages: f.snapshot.queuedMessages.filter(item => item.id !== "now") };
    await route.fulfill({ json: { chat: f.snapshot } });
  });
  await page.locator('[data-queue-id="now"]').getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.locator(".queue-row")).toHaveCount(1); await expect(page.locator(".queue-text")).toHaveText("Keep queued");
  expect(actions).toEqual([{ sendNowId: "now" }]); expect(f.calls).toEqual([]);
  await expect(input).toHaveValue("Keep this draft unsent"); await expect(page.locator("#attachment-chips")).toContainText("loop-context.txt");
  expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`expired Claude access at ${width}px offers explicit Stop without sending the draft or dropping files`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input"), stops = [];
  await input.fill("Keep my unsent follow-up");
  await page.locator("#attachment-input").setInputFiles({ name: "gateway-context.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this draft attachment") });
  await page.route(`**/api/chats/${f.snapshot.id}/stop`, async route => {
    stops.push(route.request().method()); await route.fulfill({ json: {} });
  });
  f.snapshot = { ...f.snapshot, status: "idle", queuePaused: true, messages: [{ id: "capability-expired", role: "system", kind: "error",
    text: "Claude's temporary gateway access expired or its account/profile changed. Stop the worker and retry to establish a new session capability; the running application has not been restarted." }] }; await f.emit();
  await expect(page.locator("#messages")).toContainText("Stop the worker and retry");
  await expect(page.locator("#messages")).toContainText("the running application has not been restarted");
  expect(stops).toEqual([]); expect(f.calls).toEqual([]);
  await page.locator('summary[aria-label="Chat actions"]').click();
  await page.getByRole("button", { name: "Stop worker", exact: true }).click();
  await expect.poll(() => stops).toEqual(["POST"]);
  f.snapshot = { ...f.snapshot, status: "stopped" }; await f.emit();
  await expect(input).toHaveValue("Keep my unsent follow-up"); await expect(page.locator("#attachment-chips")).toContainText("gateway-context.txt");
  expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`Claude effort changes at ${width}px preserve the running chat, draft and files and display native override errors`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input"), changes = [], stops = [];
  f.snapshot = { ...f.snapshot, status: "running", model: "sonnet", effort: "auto" }; await f.emit();
  await page.route(`**/api/chats/${f.snapshot.id}/model`, async route => {
    const selected = route.request().postDataJSON(); changes.push(selected);
    f.snapshot = { ...f.snapshot, ...selected, revision: f.snapshot.revision + 1 };
    await route.fulfill({ json: { chat: f.snapshot } });
  });
  await page.route(`**/api/chats/${f.snapshot.id}/stop`, route => { stops.push(true); return route.fulfill({ json: {} }); });
  await input.fill("Keep my next task unsent");
  await page.locator("#attachment-input").setInputFiles({ name: "effort-context.txt", mimeType: "text/plain", buffer: Buffer.from("Unsent context") });
  const controls = page.locator("#composer-model-controls");
  for (const effort of ["high", "low", "auto"]) {
    if (!await controls.locator(".effort-menu").evaluate(element => element.open)) await controls.locator(".effort-label").click();
    await page.getByRole("combobox", { name: "Chat effort", exact: true }).selectOption(effort);
    await expect(controls).toHaveAttribute("data-status", "ready");
    await expect(controls.locator(".effort-label")).toHaveText(effort[0].toUpperCase() + effort.slice(1));
  }
  await page.keyboard.press("Escape");
  f.snapshot = { ...f.snapshot, status: "error", messages: [
    { id: "effort-notice", role: "system", kind: "notice", text: "Claude's worker environment sets CLAUDE_CODE_EFFORT_LEVEL. It may override the web effort selection; use /effort status to check the effective native level." },
    { id: "effort-error", role: "system", kind: "error", text: "The worker's Claude effort environment changed. Stop the application session before retrying to apply it; its running applications have not been stopped." },
  ] }; await f.emit();
  await expect(page.locator("#messages")).toContainText("/effort status");
  await expect(page.locator("#messages")).toContainText("its running applications have not been stopped");
  await expect(input).toHaveValue("Keep my next task unsent"); await expect(page.locator("#attachment-chips")).toContainText("effort-context.txt");
  expect(changes).toEqual(["high", "low", "auto"].map(effort => ({ model: "sonnet", effort })));
  expect(stops).toEqual([]); expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`native Plan transitions at ${width}px update the selector without guessing approval results or losing drafts`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input"), card = page.locator("#approval-card");
  await page.locator("#attachment-input").setInputFiles({ name: "plan-context.txt", mimeType: "text/plain", buffer: Buffer.from("Unsent plan context") });
  await expect(page.locator("#attachment-chips")).toContainText("plan-context.txt");
  await input.fill("Keep this next task");
  const request = { requestId: "native-plan-approval", method: "claude/tool/requestApproval", prompt: "Claude requests permission to use ExitPlanMode",
    command: JSON.stringify({ plan: "Change only the fixture file" }), availableDecisions: ["accept", "decline"] };
  f.snapshot = { ...f.snapshot, status: "running", mode: "plan", pendingRequest: request }; await f.emit();
  await expect(page.locator("#mode-label")).toHaveText("Plan"); await expect(card.locator("code")).toContainText("Change only the fixture file");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/chats/${f.snapshot.id}/requests/${request.requestId}/respond`, async route => {
    expect(route.request().postDataJSON()).toEqual({ decision: "accept" }); await gate; await route.fulfill({ json: { resolved: true } });
  });
  await card.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(card.getByRole("button", { name: "Approve once", exact: true })).toBeDisabled();
  await expect(page.locator("#mode-label")).toHaveText("Plan");
  f.snapshot = { ...f.snapshot, mode: "accept_edits", pendingRequest: null }; await f.emit();
  release(); await expect(page.locator("#mode-label")).toHaveText("Edits"); await expect(card).not.toBeVisible();
  await expect(input).toHaveValue("Keep this next task"); await expect(page.locator("#attachment-chips")).toContainText("plan-context.txt");
  f.snapshot = { ...f.snapshot, mode: "plan", messages: [{ id: "mode-conflict", role: "system", kind: "notice", text: "Claude changed its current permission mode, but your newer web selection was kept for the next turn." }] }; await f.emit();
  await expect(page.locator("#mode-label")).toHaveText("Plan"); await expect(page.locator("#messages")).toContainText("your newer web selection was kept");
  await page.reload(); await expect(page.locator("#mode-label")).toHaveText("Plan");
  expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`Claude approvals at ${width}px stay literal, offer only native decisions and preserve the next request and draft`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input"), card = page.locator("#approval-card");
  await page.locator("#attachment-input").setInputFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.from("Keep my unsent file") });
  await expect(page.locator("#attachment-chips")).toContainText("context.txt");
  await input.fill("Keep my unsent prompt");
  const first = { requestId: "claude-approval-one", method: "claude/tool/requestApproval", prompt: "Claude requests permission to use Write",
    command: JSON.stringify({ file_path: `/fixture/${"nested_".repeat(65)}/SKILL.md`, content: '<img src=x onerror="window.fixtureUnsafe=true">' }, null, 2), availableDecisions: ["accept", "decline"] };
  f.snapshot = { ...f.snapshot, status: "running", pendingRequest: first }; await f.emit();
  await expect(card.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "For this session", exact: true })).toHaveCount(0);
  await expect(card.locator("code")).toHaveText(first.command); await expect(card.locator("img")).toHaveCount(0);
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  let fail = true, release, payload;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/chats/${f.snapshot.id}/requests/${first.requestId}/respond`, async route => {
    payload = route.request().postDataJSON();
    if (fail) return route.fulfill({ status: 503, json: { error: "Approval transport unavailable" } });
    await gate; await route.fulfill({ json: { resolved: true } });
  });
  await card.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.locator("#toasts")).toContainText("Approval transport unavailable");
  expect(payload).toEqual({ decision: "accept" });
  await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
  fail = false; await card.getByRole("button", { name: "Deny", exact: true }).click();
  await expect.poll(() => payload).toEqual({ decision: "decline" });
  await expect(card.getByRole("button", { name: "Approve once", exact: true })).toBeDisabled();
  const next = { ...first, requestId: "claude-approval-two", command: "A different native request" };
  await requestEvent(page, f.snapshot.id, { type: "request", request: next });
  await requestEvent(page, f.snapshot.id, { type: "request_resolved", requestId: first.requestId });
  release(); await expect(card.locator("code")).toHaveText(next.command);
  await expect(card.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
  await requestEvent(page, f.snapshot.id, { type: "request_resolved", requestId: next.requestId });
  await expect(card).not.toBeVisible(); await expect(input).toHaveValue("Keep my unsent prompt");
  await expect(page.locator("#attachment-chips")).toContainText("context.txt");
  expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`Claude questions at ${width}px support multiple choices, literal text and skipping without losing focus or drafts`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input"), card = page.locator("#approval-card");
  const request = { requestId: "claude-question-one", method: "claude/tool/requestUserInput", prompt: "Claude needs your answers", questions: [
    { id: "question_1", header: "Sections", question: "Which sections?", multiSelect: true, options: [{ label: "Intro" }, { label: "Conclusion" }] },
    { id: "question_2", header: "Name", question: "Which name?", options: [{ label: "Fixture" }, { label: "Sample" }] },
  ] };
  f.snapshot = { ...f.snapshot, status: "running", pendingRequest: request }; await f.emit();
  await input.fill("Keep this prompt"); await page.keyboard.press("Alt+ArrowUp");
  await expect(card.getByRole("checkbox", { name: "Intro", exact: true })).toBeFocused();
  await page.keyboard.press("Space"); await card.getByRole("checkbox", { name: "Conclusion", exact: true }).check();
  await card.getByRole("radio", { name: "Fixture", exact: true }).check();
  const answer = card.getByRole("textbox", { name: "Name — your answer", exact: true });
  await answer.fill("ação\nKeep it literal"); await f.emit();
  await expect(answer).toBeFocused(); await expect(answer).toHaveValue("ação\nKeep it literal");
  await expect(card.getByRole("radio", { name: "Fixture", exact: true })).not.toBeChecked();
  await expect(card.getByRole("checkbox", { name: "Intro", exact: true })).toBeChecked();
  await expect(card.getByRole("checkbox", { name: "Conclusion", exact: true })).toBeChecked();
  let received;
  await page.route(`**/api/chats/${f.snapshot.id}/requests/${request.requestId}/respond`, route => {
    received = route.request().postDataJSON(); return route.fulfill({ json: { resolved: true } });
  });
  await card.getByRole("button", { name: "Send answers", exact: true }).click();
  await expect.poll(() => received).toEqual({ answers: { question_1: ["Intro", "Conclusion"], question_2: "ação\nKeep it literal" } });
  await expect(card).not.toBeVisible();
  await requestEvent(page, f.snapshot.id, { type: "request", request: { ...request, requestId: "claude-question-two" } });
  await card.getByRole("checkbox", { name: "Intro", exact: true }).check();
  await card.getByRole("textbox", { name: "Sections — your answer", exact: true }).fill("A custom section");
  await expect(card.getByRole("checkbox", { name: "Intro", exact: true })).not.toBeChecked();
  await page.route(`**/api/chats/${f.snapshot.id}/requests/claude-question-two/respond`, route => {
    received = route.request().postDataJSON(); return route.fulfill({ json: { resolved: true } });
  });
  await card.getByRole("button", { name: "Skip questions", exact: true }).click();
  await expect.poll(() => received).toEqual({ answers: {} }); await expect(card).not.toBeVisible();
  await expect(input).toHaveValue("Keep this prompt"); expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
});

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

for (const width of [1280, 320]) test(`bundled review discovery at ${width}px retains flags and multiline targets for immediate and queued input`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input");
  f.catalog = [{ name: "code-review", description: "Review code for bugs", argumentHint: "[low|medium|high|xhigh|max] [--fix] [<target>]" }]; await f.emit();
  await input.fill("/code-r"); await expect(page.locator("#slash-options")).toContainText("/code-review");
  await page.locator("#slash-options [role=option]").click(); await expect(input).toHaveValue("/code-review "); expect(f.calls).toEqual([]);
  for (const [index, text] of ["/code-review high total.mjs", "/code-review max --fix src/ação.mjs\nKeep the public API"].entries()) {
    await input.fill(text); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
    await expect.poll(() => f.calls.length).toBe(index + 1);
    expect(f.calls.at(-1)).toEqual({ tail: index ? "queue" : "messages", text, attachments: [] });
    f.snapshot.status = "running"; await f.emit();
  }
  expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`plugin namespaces at ${width}px remain distinct, insert without sending and preserve queued arguments/files`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input"), options = page.locator("#slash-options [role=option]");
  f.catalog = [{ name: "fixture-alpha:stamp", description: "Alpha stamp" }, { name: "fixture-beta:stamp", description: "Beta stamp" }, { name: "reload-plugins", kind: "SDK control" }]; await f.emit();
  await input.fill("/fixture-"); await expect(options).toHaveCount(2);
  await options.filter({ hasText: "/fixture-beta:stamp" }).click(); await expect(input).toHaveValue("/fixture-beta:stamp "); expect(f.calls).toEqual([]);
  const uploaded = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/api/chats/${f.snapshot.id}/attachments`));
  await page.locator("#attachment-input").setInputFiles({ name: "plugin-context.txt", mimeType: "text/plain", buffer: Buffer.from("Literal plugin context") });
  const { attachment } = await (await uploaded).json(); expect(attachment.name).toBe("plugin-context.txt");
  await expect(page.locator("#attachment-chips")).toContainText("plugin-context.txt");
  const command = "/fixture-beta:stamp Preserve ação\nand this exact line";
  f.snapshot.status = "running"; await f.emit(); await input.fill(command); await input.press("Escape");
  await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(1); expect(f.calls[0].tail).toBe("queue"); expect(f.calls[0].text).toBe(command);
  expect(f.calls[0].attachments).toEqual([attachment.id]);
  await input.fill("/fixture-"); await expect(options).toHaveCount(2);
  f.catalog = f.catalog.filter(command => command.name !== "fixture-beta:stamp"); await f.emit(); await expect(options).toHaveCount(1); await expect(options).toContainText("/fixture-alpha:stamp");
  await expect(input).toHaveValue("/fixture-"); expect(f.calls).toHaveLength(1);
  await input.fill("/reload-p"); await expect(options).toContainText("/reload-plugins"); await options.click();
  await expect(input).toHaveValue("/reload-plugins "); expect(f.calls).toHaveLength(1);
  await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(2); expect(f.calls[1]).toEqual({ tail: "queue", text: "/reload-plugins", attachments: [] });
  expect(f.errors).toEqual([]);
});

test("review findings stay readable after stop, and a rejected send keeps the command and file for retry", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  await page.locator("#attachment-input").setInputFiles({ name: "review-context.txt", mimeType: "text/plain", buffer: Buffer.from("Unsent review context") });
  await expect(page.locator("#attachment-chips")).toContainText("review-context.txt");
  const command = "/code-review high --fix total.mjs";
  await input.fill(command); await input.press("Escape");
  f.responseStatus = 503; f.responseError = "Native review worker unavailable";
  await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#toasts")).toContainText(f.responseError);
  await expect(input).toHaveValue(command); await expect(page.locator("#attachment-chips")).toContainText("review-context.txt");
  f.snapshot.status = "stopped";
  f.snapshot.messages = [{ id: "msg_review_findings", role: "assistant", kind: "message", agent: "claude", text: "total.mjs:2 — The CLI subtracts instead of adding.\n\nRunning node total.mjs 2 3 prints -1 instead of 5." }];
  await f.emit();
  await expect(page.locator(".message-body")).toContainText("total.mjs:2 — The CLI subtracts instead of adding.");
  await expect(page.locator(".message-body")).toContainText("prints -1 instead of 5");
  await expect(input).toHaveValue(command); await expect(page.locator("#attachment-chips")).toContainText("review-context.txt");
  expect(f.calls).toHaveLength(1); expect(f.errors).toEqual([]);
});

for (const width of [1280, 320]) test(`run and verify at ${width}px retain multiline arguments and queue without altering the draft`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input");
  f.catalog = [{ name: "run", description: "Run the actual application" }, { name: "verify", description: "Verify the changed behavior" }]; await f.emit();
  await input.fill("/ver"); await expect(page.locator("#slash-options")).toContainText("/verify");
  await page.locator("#slash-options [role=option]").click(); await expect(input).toHaveValue("/verify "); expect(f.calls).toEqual([]);
  for (const [index, text] of ["/run Start the HTTP app\nKeep it available", "/verify Reject invalid input and preserve ação"].entries()) {
    await input.fill(text); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
    await expect.poll(() => f.calls.length).toBe(index + 1);
    expect(f.calls.at(-1)).toEqual({ tail: index ? "queue" : "messages", text, attachments: [] });
    f.snapshot.status = "running"; await f.emit();
  }
  expect(f.errors).toEqual([]);
});

test("a background answer does not replace a live foreground stream or consume the unsent draft", async ({ page }) => {
  const f = await fixture(page), input = page.locator("#message-input");
  f.snapshot.status = "running"; await f.emit(); await input.fill("Keep my unsent message");
  const emit = event => page.evaluate(({ id, event }) => window.fixtureSources.find(source => source.url.includes(`/chats/${id}/events`))
    .dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })), { id: f.snapshot.id, event });
  await emit({ type: "turn_started", messageId: "foreground_application_reply" });
  await emit({ type: "assistant_delta", delta: "Checking the actual HTTP route." });
  await emit({ type: "message", message: { id: "background_application_reply", role: "assistant", agent: "claude", kind: "message", text: "The background HTTP server stopped." } });
  await expect(page.getByText("Checking the actual HTTP route.", { exact: true })).toBeVisible();
  await expect(page.getByText("The background HTTP server stopped.", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("Keep my unsent message"); expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
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
  await expect(page.locator("#mode-provider-note")).toContainText("Private Claude profiles support Approve once and Deny here");
  await expect(page.locator("#mode-provider-note")).toContainText("Shared host profiles do not support approval replies");
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

for (const width of [1280, 320]) test(`bundled native prompts at ${width}px retain files, queue literally and display confirmed settings`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page), input = page.locator("#message-input");
  f.catalog = ["dataviz", "design-sync", "update-config"].map(name => ({ name, description: "Installed native bundled command" }));
  f.snapshot.status = "idle"; await f.emit();
  await input.fill("/datav"); await page.locator("#slash-options [role=option]").filter({ hasText: "/dataviz" }).click();
  await expect(input).toHaveValue("/dataviz "); expect(f.calls).toEqual([]);
  await page.locator("#attachment-input").setInputFiles({ name: "values.csv", mimeType: "text/csv", buffer: Buffer.from("Label,Value\nAção,7\nBeta,12") });
  await expect(page.locator("#attachment-chips")).toContainText("values.csv");
  const chart = "/dataviz Chart the attached fixture values.\nPreserve ação.";
  await input.fill(chart); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(1);
  expect(f.calls[0]).toMatchObject({ tail: "messages", text: chart }); expect(f.calls[0].attachments).toHaveLength(1);
  await expect(input).toHaveValue("");
  f.snapshot.status = "running"; await f.emit();
  await page.locator("#attachment-input").setInputFiles({ name: "settings-example.json", mimeType: "application/json", buffer: Buffer.from('{"model":"sonnet"}') });
  await expect(page.locator("#attachment-chips")).toContainText("settings-example.json");
  const update = "/update-config Use the attached example in this private profile.\nKeep Plan mode.";
  f.responseStatus = 400; f.responseError = "Native settings changes require a private Claude profile. This worker uses a shared host profile.";
  await input.fill(update); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#toasts")).toContainText("shared host profile");
  await expect(input).toHaveValue(update); await expect(page.locator("#attachment-chips")).toContainText("settings-example.json");
  f.responseStatus = 202; await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(3);
  expect(f.calls[1]).toEqual(f.calls[2]); expect(f.calls[2]).toMatchObject({ tail: "queue", text: update }); expect(f.calls[2].attachments).toHaveLength(1);
  f.snapshot = { ...f.snapshot, status: "idle", model: "sonnet", mode: "plan" }; await f.emit();
  await expect(page.getByRole("combobox", { name: "Chat model", exact: true })).toHaveValue("sonnet");
  await expect(page.locator("#mode-label")).toHaveText("Plan");
  await input.fill("/design-sync Inspect the fixture components without uploading."); await input.press("Escape"); await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect.poll(() => f.calls.length).toBe(4);
  expect(f.calls[3]).toEqual({ tail: "messages", text: "/design-sync Inspect the fixture components without uploading.", attachments: [] });
  f.snapshot.messages = [{ id: "native-design-authorization", role: "assistant", kind: "message", text: "DesignSync requires a separately authorized account. No projects were read and no files were uploaded." }]; await f.emit();
  await expect(page.locator("#messages")).toContainText("separately authorized account");
  expect(f.errors).toEqual([]);
});

test("Claude Manual and Deny prompts controls save through the real API without starting a worker", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "claude", title: "Native permission controls" } })).json(); created.set(page, [chat.id]);
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  await page.locator("#mode-label").click();
  await expect(page.locator("#mode-provider-note")).toContainText("Private Claude profiles support Approve once and Deny here");
  await expect(page.locator("#mode-provider-note")).toContainText("Shared host profiles do not support approval replies");
  await page.locator("#mode-label").click();
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
