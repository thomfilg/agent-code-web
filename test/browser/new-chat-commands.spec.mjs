import { test, expect } from "@playwright/test";
import { newChatCommands } from "../../public/new-chat-commands.js";

async function fixture(page) {
  const f = { creates: [], messages: [], catalogs: [], effects: [], gate: null, catalogGate: null };
  let preferences = { agent: "codex", agentAccountId: "account-codex", environmentId: "env-command", repositories: [] };
  const chat = { id: "chat_command-fixture", title: "Command fixture", agent: "codex", status: "stopped", workspace: "/fixture", repositories: [], environmentId: "env-command", messages: [], revision: 1, updatedAt: new Date().toISOString() };
  await page.route("**/api/config", async route => { const body = await (await route.fetch()).json(); body.features.agentAccounts = true; await route.fulfill({ json: body }); });
  await page.route("**/api/agent-accounts", route => route.fulfill({ json: { accounts: ["codex", "claude"].map(provider => ({ id: `account-${provider}`, provider, name: "Fixture", status: "connected", email: "fixture@example.test" })) } }));
  await page.route("**/api/models?*", route => route.fulfill({ json: { models: [{ id: "fixture-model", label: "Fixture model", isDefault: true, efforts: ["low"] }], source: "fixture" } }));
  await page.route("**/api/github", route => route.fulfill({ json: { connected: true, connections: [] } }));
  await page.route("**/api/github/repositories*", route => route.fulfill({ json: { repositories: [] } }));
  await page.route("**/api/environments", route => route.fulfill({ json: { environments: [{ id: "env-command", name: "Fixture", companies: [], allowUnassigned: true }], software: [] } }));
  await page.route("**/api/preferences", route => { if (route.request().method() === "PATCH") preferences = route.request().postDataJSON(); return route.fulfill({ json: { preferences } }); });
  await page.route("**/api/new-chat/commands?*", async route => {
    const query = new URL(route.request().url()).searchParams, agent = query.get("agent"), account = query.get("agentAccountId");
    f.catalogs.push({ agent, account }); if (f.catalogGate) await f.catalogGate.promise;
    return route.fulfill({ json: newChatCommands(agent, agent === "claude" ? [{ name: "fixture-native" }] : []) });
  });
  await page.route("**/api/chats", async route => {
    if (route.request().method() !== "POST") return route.continue();
    f.creates.push(route.request().postDataJSON()); if (f.gate) await f.gate.promise;
    Object.assign(chat, route.request().postDataJSON()); return route.fulfill({ status: 201, json: { chat } });
  });
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat } }));
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}/messages`, route => { f.messages.push(route.request().postDataJSON()); return route.fulfill(f.failMessage ? { status: 503, json: { error: "Fixture unavailable" } } : { status: 202, json: { accepted: true } }); });
  page.on("request", request => { if (/\/(wake|goal|stop|queue)$/.test(new URL(request.url()).pathname) && request.method() !== "GET") f.effects.push(request.method()); });
  await page.goto("/"); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  await expect(page.locator("#new-agent-account")).toHaveValue("account-codex");
  return { f, chat };
}

test("draft slash autocomplete handles arrows, Tab, Escape and provider/account changes without creating anything", async ({ page }) => {
  const { f } = await fixture(page), input = page.locator("#initial-prompt");
  await input.fill("/"); await expect(page.locator("#new-slash-options")).toContainText("/goal");
  const first = await input.getAttribute("aria-activedescendant"); await input.press("ArrowDown"); expect(await input.getAttribute("aria-activedescendant")).not.toBe(first);
  await input.fill("/go"); await expect(page.locator("#new-slash-options [role=option]")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("new-chat-goal-desktop.png") });
  await input.press("Tab"); await expect(input).toHaveValue("/goal ");
  expect(f.creates).toEqual([]); expect(f.messages).toEqual([]); expect(f.effects).toEqual([]);
  await input.fill("/compact"); await expect(page.locator("#new-slash-options [role=option]")).toHaveAttribute("aria-disabled", "true");
  await input.press("Enter"); await expect(page.locator("#new-slash-status")).toContainText("existing chat");
  await input.press("Escape"); await expect(page.locator("#new-slash-menu")).toBeHidden();
  await page.locator("#create-chat-button").click(); await expect(page.locator("#create-chat-error")).toContainText("existing chat");
  await page.locator("#new-agent-account").selectOption("account-claude");
  await input.fill("/goal"); await expect(page.locator("#new-slash-status")).toContainText("No matches");
  await input.fill("/fixture"); await expect(page.locator("#new-slash-options")).toContainText("/fixture-native");
  await expect(page.locator("#new-slash-options [role=option]")).toHaveAttribute("aria-disabled", "true");
  expect(f.catalogs).toContainEqual({ agent: "codex", account: "account-codex" }); expect(f.catalogs).toContainEqual({ agent: "claude", account: "account-claude" });
  expect(f.creates).toEqual([]); expect(f.messages).toEqual([]); expect(f.effects).toEqual([]);
});

test("bare first /goal opens the existing goal control once, not a literal message or worker request", async ({ page }) => {
  const { f } = await fixture(page); f.gate = Promise.withResolvers();
  const input = page.locator("#initial-prompt"); await input.fill("/goal"); await expect(page.locator("#new-slash-options")).toContainText("/goal");
  await input.press("Enter"); await expect(input).toHaveValue("/goal "); expect(f.creates).toEqual([]);
  await input.press("Enter"); await expect.poll(() => f.creates.length).toBe(1);
  await page.locator("#new-chat-form").dispatchEvent("submit"); f.gate.resolve();
  await expect(page.locator("#controls-dialog")).toBeVisible(); await expect(page.locator("#controls-dialog")).toContainText("No goal is set");
  await expect(page.locator("#message-input")).toBeEnabled();
  expect(f.creates).toHaveLength(1); expect(f.messages).toEqual([]); expect(f.effects).toEqual([]);
});

test("first goal objective uses the ordinary command send path after explicit submission", async ({ page }) => {
  const { f } = await fixture(page);
  await page.locator("#initial-prompt").fill("/goal Build a local fixture app"); await page.locator("#initial-prompt").press("Enter");
  await expect.poll(() => f.messages.length).toBe(1);
  expect(f.creates).toHaveLength(1); expect(f.creates[0].agentAccountId).toBe("account-codex");
  expect(f.messages[0]).toEqual({ text: "/goal Build a local fixture app", attachments: [] });
});

test("navigation during first-command creation keeps its draft and never sends into another chat", async ({ page }) => {
  const { f } = await fixture(page); f.gate = Promise.withResolvers();
  await page.locator("#initial-prompt").fill("/goal Keep this unsent objective"); await page.locator("#initial-prompt").press("Enter");
  await expect.poll(() => f.creates.length).toBe(1);
  await page.getByRole("button", { name: "Open Existing alpha", exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText("Existing alpha");
  f.gate.resolve(); await expect(page.locator("#toasts")).toContainText("command is kept");
  expect(f.messages).toEqual([]); expect(f.effects).toEqual([]);
  await page.getByRole("button", { name: "Open Command fixture", exact: true }).click();
  await expect(page.locator("#message-input")).toHaveValue("/goal Keep this unsent objective");
  expect(f.creates).toHaveLength(1); expect(f.messages).toEqual([]);
});

test("failed first-command submission preserves the created chat and retry draft", async ({ page }) => {
  const { f } = await fixture(page); f.failMessage = true;
  const objective = "/goal Retry this fixture objective";
  await page.locator("#initial-prompt").fill(objective); await page.locator("#initial-prompt").press("Enter");
  await expect(page.locator("#message-input")).toHaveValue(objective); expect(f.creates).toHaveLength(1);
  f.failMessage = false; await page.locator("#message-input").press("Enter");
  await expect.poll(() => f.messages.length).toBe(2); expect(f.creates).toHaveLength(1);
});

test("late draft command discovery does not reopen dismissed suggestions and menu fits 320px", async ({ page }) => {
  const { f } = await fixture(page); f.catalogGate = Promise.withResolvers();
  const input = page.locator("#initial-prompt"); await input.fill("/go"); await expect(page.locator("#new-slash-status")).toContainText("Loading");
  await input.press("Escape"); f.catalogGate.resolve();
  await expect.poll(() => f.catalogs.length).toBe(1); await expect(page.locator("#new-slash-menu")).toBeHidden();
  await page.setViewportSize({ width: 320, height: 740 }); await input.click();
  await expect(page.locator("#new-slash-options")).toContainText("/goal"); await expect(page.locator("#new-slash-menu")).toBeInViewport({ ratio: 1 });
  expect(await page.locator("#new-slash-menu").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("new-chat-goal-mobile.png") });
  expect(f.creates).toEqual([]); expect(f.effects).toEqual([]);
});
