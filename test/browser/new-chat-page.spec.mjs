import { test, expect } from "@playwright/test";

async function fixture(page) {
  const repositories = ["Acme/api", "Acme/web", "Other/library"].map(fullName => ({ fullName, branch: "main", defaultBranch: "main", companyId: "acme", githubConnectionId: "github-fixture" }));
  let preferences = { agent: "mock", environmentId: "env-fixture", repositories: [] };
  const calls = { create: [], messages: [], repositories: [] };
  const chat = { id: "chat_new-page-fixture", title: "First message", agent: "mock", status: "stopped", workspace: "/fixture", repositories: [], environmentId: "env-fixture", messages: [], revision: 1, updatedAt: new Date().toISOString() };
  const f = { calls, chat, failCreate: false, failMessage: false, failRepository: false, gate: null, messageGate: null };
  await page.route("**/api/github", route => route.fulfill({ json: { connected: true, login: "fixture", connections: [{ id: "github-fixture", companyId: "acme", connected: true }] } }));
  await page.route("**/api/github/repositories*", route => route.fulfill({ json: { repositories } }));
  await page.route("**/api/github/branches?*", route => route.fulfill({ json: { branches: ["main", "dev"] } }));
  await page.route("**/api/environments", route => route.fulfill({ json: { environments: [{ id: "env-fixture", name: "Development", companyId: "acme", companies: ["acme"], allowUnassigned: false }], software: [] } }));
  await page.route("**/api/preferences", route => { if (route.request().method() === "PATCH") preferences = route.request().postDataJSON(); return route.fulfill({ json: { preferences } }); });
  await page.route("**/api/chats", async route => {
    if (route.request().method() !== "POST") return route.continue();
    calls.create.push(route.request().postDataJSON()); if (f.gate) await f.gate.promise;
    if (f.failCreate) return route.fulfill({ status: 403, json: { error: "Reconnect GitHub" } });
    Object.assign(chat, route.request().postDataJSON()); return route.fulfill({ status: 201, json: { chat } });
  });
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat } }));
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}/messages`, async route => {
    calls.messages.push(route.request().postDataJSON()); if (f.messageGate) await f.messageGate.promise;
    return route.fulfill(f.failMessage ? { status: 503, json: { error: "Fixture worker unavailable" } } : { json: { accepted: true } });
  });
  await page.route(`**/api/chats/${chat.id}/repositories`, async route => {
    calls.repositories.push(route.request().postDataJSON());
    if (f.failRepository) return route.fulfill({ status: 409, json: { error: "Wait for active work" } });
    chat.repositories.push(route.request().postDataJSON()); chat.revision++; return route.fulfill({ json: { chat } });
  });
  await page.goto("/"); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  return f;
}
async function choose(page) {
  await page.getByRole("button", { name: "Add repositories", exact: true }).click();
  await page.locator("#repository-results").getByRole("checkbox", { name: /Acme\/api/ }).check();
  await page.getByRole("button", { name: "Add repositories", exact: true }).click();
}

test("new chat is inline, workspace chips are compact, and first send shows progress before the server responds", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const f = await fixture(page); f.gate = Promise.withResolvers(); f.messageGate = Promise.withResolvers();
  try {
    await expect(page.locator("#new-chat-page")).toBeVisible(); await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.locator("#repo-search")).toBeHidden(); await choose(page);
    await expect(page.locator("#selected-repositories")).toContainText("api");
    const strip = await page.locator("#new-chat-page .workspace-strip").boundingBox(), input = await page.locator("#initial-prompt").boundingBox();
    expect(strip.height).toBeLessThan(40); expect(strip.y + strip.height).toBeLessThanOrEqual(input.y);
    await page.locator("#initial-prompt").fill("Build the dashboard");
    await page.screenshot({ path: test.info().outputPath("new-chat-desktop.png"), fullPage: true });
    await page.locator("#initial-prompt").press("Enter");
    await expect(page.locator("#new-chat-progress")).toContainText("Build the dashboard");
    await expect(page.locator("#new-chat-status")).toHaveText("Preparing your chat…");
    await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", true);
    await page.locator("#new-chat-form").dispatchEvent("submit"); await expect.poll(() => f.calls.create.length).toBe(1);
    f.gate.resolve(); await expect(page.locator("#conversation")).toBeVisible();
    await expect(page.locator("#new-chat-page")).toBeHidden(); await expect(page.locator("#messages")).toContainText("Build the dashboard");
    await expect(page.locator("#chat-workspace-strip")).toContainText("api");
    await expect.poll(() => f.calls.messages.length).toBe(1); expect(f.calls.messages[0].text).toBe("Build the dashboard");
    f.messageGate.resolve(); expect(errors).toEqual([]);
  } finally { f.gate.resolve(); f.messageGate.resolve(); }
});

test("failed creation preserves draft; failed first send stays in the created chat without creating another", async ({ page }) => {
  const f = await fixture(page); await choose(page); f.failCreate = true;
  await page.locator("#initial-prompt").fill("Keep my unsent task"); await page.locator("#initial-prompt").press("Enter");
  await expect(page.locator("#create-chat-error")).toHaveText("Reconnect GitHub"); await expect(page.locator("#initial-prompt")).toHaveValue("Keep my unsent task");
  await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false); expect(f.calls.messages).toHaveLength(0);
  f.failCreate = false; f.failMessage = true; await page.locator("#initial-prompt").press("Enter");
  await expect(page.locator("#message-input")).toHaveValue("Keep my unsent task");
  expect(f.calls.create).toHaveLength(2); expect(f.calls.messages).toHaveLength(1);
});

test("existing chat adds a repository and branch from the compact plus without opening another chat", async ({ page }) => {
  const f = await fixture(page); await choose(page); await page.locator("#initial-prompt").fill("First task"); await page.locator("#initial-prompt").press("Enter");
  await expect(page.locator("#conversation")).toBeVisible();
  await page.getByRole("button", { name: "Add repository to chat", exact: true }).click();
  const strip = page.locator("#chat-workspace-strip"); await strip.getByRole("button", { name: "Other/library", exact: true }).click();
  await expect(strip.getByLabel("Branch for Other/library").locator("option")).toHaveCount(2);
  await strip.getByLabel("Branch for Other/library").selectOption("dev"); f.failRepository = true;
  await strip.getByRole("button", { name: "Add repository", exact: true }).click(); await expect(strip.getByRole("alert")).toContainText("Wait for active work");
  f.failRepository = false; await strip.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(strip.locator(".selected-repositories")).toContainText("library"); await expect(strip.locator(".selected-repositories")).toContainText("dev");
  expect(f.calls.create).toHaveLength(1); expect(f.chat.repositories[0].fullName).toBe("Acme/api"); expect(f.calls.repositories.at(-1).branch).toBe("dev");
});

test("mobile draft and picker fit 320px without a modal or horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await fixture(page); await choose(page);
  await page.locator("#initial-prompt").fill("An unsent draft");
  await page.getByRole("button", { name: "Add repositories", exact: true }).click();
  await page.locator("#repository-results").getByRole("checkbox", { name: /Other\/library/ }).check();
  expect(await page.locator("#new-chat-page").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const popover = await page.locator("#repository-picker .repository-popover").boundingBox(); expect(popover.x).toBeGreaterThanOrEqual(0); expect(popover.x + popover.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: test.info().outputPath("new-chat-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Add repositories", exact: true }).click();
  await page.getByRole("button", { name: "Open chats", exact: true }).click(); await page.locator("#new-chat-button").click();
  await expect(page.locator("#initial-prompt")).toHaveValue("An unsent draft");
});

test("company-scoped draft requires a repository and Enter respects IME and Shift+Enter", async ({ page }) => {
  const f = await fixture(page);
  await page.locator("#initial-prompt").fill("Scratch task");
  await page.locator("#initial-prompt").press("Enter");
  expect(f.calls.create).toHaveLength(0); await expect(page.locator("#create-chat-button")).toBeDisabled();
  await expect(page.locator("#environment-selection-hint")).toContainText("Choose a repository");
  await choose(page); await expect(page.locator("#create-chat-button")).toBeEnabled();
  await page.locator("#initial-prompt").dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await page.locator("#initial-prompt").dispatchEvent("keydown", { key: "Enter", repeat: true, bubbles: true });
  await page.locator("#initial-prompt").dispatchEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true });
  expect(f.calls.create).toHaveLength(0);
  await page.locator("#initial-prompt").press("Shift+Enter"); await expect(page.locator("#initial-prompt")).toHaveValue("Scratch task\n");
  await page.locator("#initial-prompt").press("Enter"); await expect(page.locator("#conversation")).toBeVisible();
  expect(f.calls.create).toHaveLength(1); expect(f.calls.create[0].repositories.map(repo => repo.fullName)).toEqual(["Acme/api"]);
});
