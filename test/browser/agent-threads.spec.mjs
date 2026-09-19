import { test, expect } from "@playwright/test";

const fixtureChats = new WeakMap();
test.afterEach(async ({ page }) => { const id = fixtureChats.get(page); if (id) await page.request.delete(`/api/chats/${id}`); });

async function setup(page, offline = false, { agent = "codex", empty = false } = {}) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Agent threads ${Date.now()}` } })).json();
  fixtureChats.set(page, chat.id);
  const question = requestId => ({ requestId, method: "item/tool/requestUserInput", prompt: "Agent needs input", questions: [{ id: "answer", question: "Child choice?", options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }] }] });
  // This synthetic native session is newer than the underlying, unstarted
  // fixture chat. A delayed sidebar refresh must not overwrite its identity.
  const main = { ...chat, agent, revision: 999999, agentSessionId: "native-main", status: "running", messages: [{ id: "main-user", role: "user", text: "Real main conversation" }], pendingRequest: { ...question("main-question"), questions: [{ id: "answer", question: "Main choice?", options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }] }] } };
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: main } }));
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  let snapshot = { rootThreadId: "native-main", epoch: "native-fixture", revision: 1, awake: !offline, threads: [
    { id: "child-a", parentThreadId: "native-main", name: "Ada", role: "worker", status: offline ? "stopped" : "active", canAcceptDirectInput: true, historyLoaded: true, nextCursor: "older", messages: [{ id: "child-answer", role: "assistant", text: "Native child answer" }], pendingRequest: offline ? null : question("child-question") },
    { id: "child-b", parentThreadId: "child-a", name: "Lin", role: "reviewer", status: "idle", canAcceptDirectInput: true, historyLoaded: true, messages: [{ id: "nested-answer", role: "assistant", text: "Nested agent result" }] },
  ] };
  if (agent === "claude") snapshot = { ...snapshot, provider: "claude", coverage: "Observed native children from this process only.", threads: snapshot.threads.map(thread => ({ ...thread, canAcceptDirectInput: false, canStop: !offline && thread.status === "active", nextCursor: null, pendingRequest: null })) };
  if (empty) snapshot.threads = [];
  const calls = [], mainWrites = [];
  page.on("request", request => { if (request.method() === "POST" && new RegExp(`/chats/${chat.id}/(messages|queue|stop|requests|wake|start)(/|$)`).test(request.url())) mainWrites.push(request.url()); });
  await page.route(`**/api/chats/${chat.id}/subagents**`, async route => {
    const method = route.request().method(), tail = new URL(route.request().url()).pathname.split("/subagents")[1], input = route.request().postDataJSON();
    calls.push({ method, tail, input });
    if (method === "GET") return route.fulfill({ json: snapshot });
    snapshot = structuredClone(snapshot); snapshot.revision++;
    if (!tail) snapshot.awake = true;
    const thread = snapshot.threads.find(thread => thread.id === input?.threadId);
    if (tail === "/messages") { thread.messages.push({ id: `input-${snapshot.revision}`, role: "user", text: input.text }); thread.status = "active"; }
    if (tail === "/respond") { thread.pendingRequest = null; }
    if (tail === "/stop") { thread.status = "idle"; thread.canStop = false; }
    const page = tail === "/select" && input.cursor ? { threadId: thread.id, messages: [{ id: "older", role: "assistant", text: "Older child response" }], nextCursor: null } : undefined;
    return route.fulfill({ json: { ...snapshot, ...(page ? { page } : {}) } });
  });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(main.title);
  return { chat, calls, mainWrites };
}

test("agent picker routes replies and approvals only to selected descendants and preserves main drafts", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  const { calls, mainWrites } = await setup(page);
  await page.locator("#message-input").fill("Unsent main draft");
  await page.locator("#approval-card").getByRole("radio", { name: /One/ }).check();
  await page.getByRole("button", { name: "Open agent threads", exact: true }).click();
  await page.screenshot({ path: "test-results/agent-threads-list-desktop.png" });
  await page.getByRole("button", { name: "Open agent Ada", exact: true }).click();
  await expect(page.locator("#agents-messages")).toContainText("Native child answer");
  const chat = await page.locator("#conversation").boundingBox(), panel = await page.locator("#agents-panel").boundingBox();
  expect(panel.x).toBeGreaterThan(chat.x + chat.width - 2);
  await page.locator("#agents-approval").getByRole("radio", { name: /Two/ }).check();
  await page.locator("#agents-approval").getByRole("button", { name: "Send answers", exact: true }).click();
  await expect(page.locator("#agents-approval")).toBeHidden();
  await expect(page.locator("#approval-card").getByRole("radio", { name: /One/ })).toBeChecked();
  await page.getByLabel("Message selected agent").fill("Child draft");
  await page.getByLabel("Choose agent thread").selectOption("child-b");
  await expect(page.getByLabel("Message selected agent")).toHaveValue("");
  await expect(page.locator("#agents-messages")).toContainText("Nested agent result");
  await page.getByLabel("Choose agent thread").selectOption("child-a");
  await expect(page.getByLabel("Message selected agent")).toHaveValue("Child draft");
  await page.getByRole("button", { name: "Send to running agent", exact: true }).click();
  await expect(page.getByLabel("Message selected agent")).toHaveValue("");
  await expect(page.locator("#agents-messages")).toContainText("Child draft");
  await page.getByRole("button", { name: "Earlier agent messages", exact: true }).click();
  await expect(page.locator("#agents-messages")).toContainText("Older child response");
  await page.getByRole("button", { name: "Latest agent messages", exact: true }).click();
  await page.getByRole("button", { name: "Stop agent reply", exact: true }).click();
  await expect(page.locator("#message-input")).toHaveValue("Unsent main draft");
  await expect(page.locator("#messages")).not.toContainText("Child draft");
  const mutations = calls.filter(call => ["/messages", "/respond", "/stop"].includes(call.tail));
  expect(mutations).toHaveLength(3);
  expect(mutations.every(call => call.input.threadId === "child-a" && call.input.rootThreadId === "native-main")).toBeTruthy();
  expect(mutations.find(call => call.tail === "/respond").input.requestId).toBe("child-question");
  expect(mainWrites).toEqual([]);
  await page.screenshot({ path: "test-results/agent-threads-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Back to agent list", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Send to agent", exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/agent-threads-popup-mobile.png" });
  await page.getByRole("button", { name: "Back to agent list", exact: true }).click();
  await expect(page.getByRole("button", { name: "Return to main chat", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Return to main chat", exact: true }).click();
  await expect(page.locator("#agents-panel")).toBeHidden();
});

test("subagents alias opens saved context without waking the worker or sending a slash prompt", async ({ page }) => {
  const { calls, mainWrites } = await setup(page, true);
  await page.locator("#message-input").fill("/subagents");
  await page.locator("#composer").evaluate(form => form.requestSubmit());
  await expect(page.locator("#agents-panel")).toBeVisible();
  await expect(page.locator("#message-input")).toHaveValue("");
  await page.getByRole("button", { name: "Open agent Ada", exact: true }).click();
  await expect(page.locator("#agents-status")).toContainText("Saved snapshot");
  await expect(page.locator("#agents-messages")).toContainText("Native child answer");
  await expect(page.locator("#agents-send")).toBeDisabled();
  expect(calls.filter(call => call.method !== "GET")).toHaveLength(0); expect(mainWrites).toEqual([]);
});

test("late child selection or reply cannot switch the view or erase another agent's draft", async ({ page }) => {
  const { chat, mainWrites } = await setup(page);
  await page.getByRole("button", { name: "Open agent threads", exact: true }).click();
  await page.getByRole("button", { name: "Open agent Ada", exact: true }).click();
  await expect(page.locator("#agents-messages")).toContainText("Native child answer");
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/chats/${chat.id}/subagents/messages`, async route => { await gate; return route.fallback(); });
  await page.getByLabel("Message selected agent").fill("Delayed reply to Ada");
  const request = page.waitForRequest(request => request.url().endsWith("/subagents/messages"));
  await page.locator("#agents-form").evaluate(form => form.requestSubmit()); await request;
  await page.getByLabel("Choose agent thread").selectOption("child-b");
  await page.getByLabel("Message selected agent").fill("Unsent Lin draft");
  release();
  await expect(page.locator("#agents-send")).toBeEnabled();
  await expect(page.getByLabel("Choose agent thread")).toHaveValue("child-b");
  await expect(page.getByLabel("Message selected agent")).toHaveValue("Unsent Lin draft");
  await page.getByLabel("Choose agent thread").selectOption("child-a");
  await expect(page.getByLabel("Message selected agent")).toHaveValue("");
  expect(mainWrites).toEqual([]);
});

for (const agent of ["codex", "claude"]) test(`${agent} empty panel never wakes or connects implicitly`, async ({ page }) => {
  const { calls, mainWrites } = await setup(page, true, { agent, empty: true });
  await page.getByRole("button", { name: "Open agent threads", exact: true }).click();
  await expect(page.locator("#agents-list")).toContainText("No observed child agents");
  expect(calls.filter(call => call.method !== "GET")).toEqual([]); expect(mainWrites).toEqual([]);
  await page.getByRole("button", { name: "Connect to agents", exact: true }).click();
  await expect.poll(() => calls.filter(call => call.method === "POST" && !call.tail).length).toBe(1);
  expect(mainWrites).toEqual([]);
});

test("Claude child popup exposes public context and child-only Stop, never a misleading send composer", async ({ page }) => {
  const { calls, mainWrites } = await setup(page, false, { agent: "claude" });
  await page.locator("#message-input").fill("Unsent main Claude draft");
  await page.getByRole("button", { name: "Open agent threads", exact: true }).click();
  const button = page.getByRole("button", { name: "Open agent Ada", exact: true }); await button.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#agent-conversation-dialog")).toBeVisible(); await expect(page.locator("#agents-messages")).toContainText("Native child answer");
  await expect(page.locator("#agent-conversation-capability")).toContainText("Direct messaging to this child is not supported");
  await expect(page.locator("#agents-input")).toBeHidden(); await expect(page.locator("#agents-send")).toBeHidden();
  await page.getByRole("button", { name: "Stop agent reply", exact: true }).click();
  await expect(page.locator("#agent-conversation-status")).toContainText("idle");
  expect(calls.filter(call => call.tail === "/stop").map(call => call.input.threadId)).toEqual(["child-a"]);
  expect(calls.some(call => call.tail === "/messages")).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: "test-results/claude-agent-popup-mobile.png" });
  await page.keyboard.press("Escape"); await expect(button).toBeFocused(); await expect(page.locator("#message-input")).toHaveValue("Unsent main Claude draft");
  expect(mainWrites).toEqual([]);
});
