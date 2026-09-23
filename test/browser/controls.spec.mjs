import { test, expect } from "@playwright/test";

test("compact mobile composer switches agents with Sol/Opus high defaults and preserves chat", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/");
  await page.getByRole("button", { name: "Open chats", exact: true }).click();
  await page.getByRole("button", { name: "Open Existing alpha", exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText("Existing alpha");
  const url = page.url();
  await page.getByLabel("Chat agent", { exact: true }).selectOption("codex");
  await expect(page.getByLabel("Chat model", { exact: true })).toHaveValue("gpt-5.6-sol");
  await expect(page.getByLabel("Chat model", { exact: true }).locator('option[value="gpt-5.6-sol"]')).toHaveText("GPT-5.6-Sol");
  await expect(page.getByLabel("Chat effort", { exact: true })).toHaveValue("high");
  await expect(page.locator("#composer-model-controls .model-note")).not.toBeVisible();
  await page.getByLabel("Chat agent", { exact: true }).selectOption("claude");
  await expect(page.getByLabel("Chat model", { exact: true })).toHaveValue("opus");
  await expect(page.getByLabel("Chat model", { exact: true }).locator('option[value="opus"]')).toHaveText("Opus 5.5 with 1M context");
  await expect(page.getByLabel("Chat effort", { exact: true })).toHaveValue("high");
  expect(page.url()).toBe(url); await expect(page.locator("#chat-title")).toHaveText("Existing alpha");
  await page.getByLabel("Agent mode", { exact: true }).click();
  await page.locator('[data-agent-mode="plan"]').click(); await expect(page.locator("#mode-label")).toHaveText("Plan");
  await page.getByLabel("Choose effort", { exact: true }).click();
  await page.getByRole("slider", { name: "Effort level" }).fill("0");
  await expect(page.getByLabel("Chat effort", { exact: true })).toHaveValue("low");
  await page.getByLabel("Chat effort", { exact: true }).selectOption("high");
  await page.getByLabel("Choose effort", { exact: true }).click();
  const dimensions = await page.locator("#composer").evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, height: node.clientHeight }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1); expect(dimensions.height).toBeLessThan(140);
  await page.screenshot({ path: "test-results/compact-mobile-composer.png", fullPage: true });
  await page.getByLabel("Chat agent", { exact: true }).selectOption("mock");
});

test("PR bar opens colored diffs, shows CI counts/conflicts, and requires explicit GitHub auto-merge", async ({ page }) => {
  await page.request.post("/api/github", { data: { method: "local", companies: ["acme", "other"] } });
  await page.goto("/");
  await page.getByRole("button", { name: "Open PR controls fixture", exact: true }).click();
  const bar = page.locator(".pull-request-bar");
  await expect(bar.getByRole("link", { name: "⑂ #42" })).toHaveAttribute("href", "https://github.com/Acme/api/pull/42");
  await bar.locator(".ci-menu > summary").click();
  await expect(bar.locator(".ci-count.inProgress strong")).toHaveText("1");
  await expect(bar.locator(".ci-count.passed strong")).toHaveText("2");
  await expect(bar.locator(".ci-count.skipped strong")).toHaveText("1");
  await expect(bar).toContainText("Merge conflicts detected");
  await expect(bar.getByRole("link", { name: "CI monitoring ↗" })).toHaveAttribute("href", "https://github.com/Acme/api/pull/42/checks");
  page.once("dialog", dialog => dialog.dismiss());
  await bar.getByLabel("Auto-merge PR 42").click(); await expect(bar.getByLabel("Auto-merge PR 42")).not.toBeChecked();
  page.once("dialog", dialog => dialog.accept());
  await bar.getByLabel("Auto-merge PR 42").check();
  await expect(bar.getByLabel("Auto-merge PR 42")).toBeChecked();
  await page.getByRole("button", { name: "View changes for PR 42" }).click();
  await expect(page.locator("#diff-files")).toContainText("src/example.ts");
  await expect(page.locator(".diff-line.added")).toContainText("+new value");
  await expect(page.locator(".diff-line.removed")).toContainText("-old value");
  await page.screenshot({ path: "test-results/desktop-pr-diff.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Close changes", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Close changes", exact: true }).click();
  await page.request.delete("/api/github");
});

test("PR CI menu uses the selected environment monitoring defaults", async ({ page }) => {
  const payload = await (await page.request.get("/api/chats")).json();
  const fixture = payload.chats.find(chat => chat.title === "PR controls fixture");
  const detail = await (await page.request.get(`/api/chats/${fixture.id}`)).json();
  await page.route(`**/api/chats/${fixture.id}`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { chat: { ...detail.chat, ownerId: `user_${"a".repeat(32)}`, agentAccountId: "account_fixture", githubEvents: { revision: 0, defaults: { notifyFailures: true, wakePassing: true }, subscriptions: [], deliveries: [] } } } })
    : route.fallback());
  await page.goto(`/#chat=${fixture.id}`);
  const bar = page.locator(".pull-request-bar"); await bar.locator(".ci-menu > summary").click();
  await expect(bar.getByLabel("Notify agent when checks fail for PR 42")).toBeChecked();
  await expect(bar.getByLabel("Wake this chat when checks pass for PR 42")).toBeChecked();
});

test("many pull requests collapse to one card row and expand on demand", async ({ page }) => {
  const payload = await (await page.request.get("/api/chats")).json();
  const fixture = payload.chats.find(chat => chat.title === "PR controls fixture");
  const detail = await (await page.request.get(`/api/chats/${fixture.id}`)).json();
  const pullRequests = Array.from({ length: 6 }, (_, index) => ({ ...detail.chat.pullRequests[0], number: 42 + index, headRef: `feature/card-${index}` }));
  await page.route(`**/api/chats/${fixture.id}`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { chat: { ...detail.chat, revision: 999999, pullRequests, goal: { status: "active", objective: "Keep this goal compact beside the PR and workspace context" } } } }) : route.fallback());
  await page.goto(`/#chat=${fixture.id}`);
  await expect(page.locator(".pull-request-bar")).toHaveCount(1);
  await expect(page.locator("#pull-request-bars")).toContainText("6 PRs");
  const context = page.locator("#chat-context-strip");
  await expect(context.locator("#goal-status")).toBeVisible();
  await expect(context.locator("#pull-request-bars")).toBeVisible();
  await expect(context.locator("#chat-workspace-strip")).toBeVisible();
  const compact = await context.evaluate(node => ({
    height: node.getBoundingClientRect().height,
    childParents: ["goal-status", "pull-request-bars", "chat-workspace-strip"].map(id => document.getElementById(id)?.parentElement?.id),
    centers: ["goal-status", "pull-request-bars", "chat-workspace-strip"].map(id => { const box = document.getElementById(id).getBoundingClientRect(); return box.top + box.height / 2; }),
  }));
  expect(compact.childParents).toEqual(["chat-context-strip", "chat-context-strip", "chat-context-strip"]);
  expect(compact.height).toBeLessThanOrEqual(34);
  expect(Math.max(...compact.centers) - Math.min(...compact.centers)).toBeLessThanOrEqual(1);
  const composerTop = (await page.locator("#composer").boundingBox()).y;
  await page.getByRole("button", { name: "View more", exact: true }).click();
  await expect(page.locator("#pull-request-bars")).toHaveClass(/expanded/);
  await expect(page.locator(".pull-request-bar")).toHaveCount(6);
  expect((await page.locator("#composer").boundingBox()).y).toBe(composerTop);
});

test("repository strip keeps its primary repository and moves overflow into a compact panel", async ({ page }) => {
  const payload = await (await page.request.get("/api/chats")).json();
  const fixture = payload.chats.find(chat => chat.title === "PR controls fixture");
  const detail = await (await page.request.get(`/api/chats/${fixture.id}`)).json();
  const repositories = Array.from({ length: 5 }, (_, index) => ({ fullName: `Acme/a-very-long-repository-${index}`, branch: `feature/long-branch-${index}` }));
  await page.route(`**/api/chats/${fixture.id}`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { chat: { ...detail.chat, revision: 999999, repositories } } }) : route.fallback());
  await page.setViewportSize({ width: 600, height: 800 }); await page.goto(`/#chat=${fixture.id}`);
  await expect(page.locator(".repository-chip").first()).toBeVisible();
  const more = page.locator(".repository-overflow-menu > summary"); await expect(more).toBeVisible();
  await expect(more).toContainText(/and \d+ more/); await more.click();
  await expect(page.locator(".repository-overflow-row")).toHaveCount(5);
});

test("internal goal continuations use the one-line system queue and never appear as user queue text", async ({ page }) => {
  const payload = await (await page.request.get("/api/chats")).json();
  const fixture = payload.chats.find(chat => chat.title === "PR controls fixture");
  const detail = await (await page.request.get(`/api/chats/${fixture.id}`)).json();
  const queuedMessages = [
    { id: "system-goal", text: "/goal resume", relayGoalWake: true, systemWork: true, attachmentIds: [] },
    { id: "user-message", text: "Real user follow-up", attachmentIds: [] },
  ];
  await page.route(`**/api/chats/${fixture.id}`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { chat: { ...detail.chat, revision: 999999, queuedMessages } } }) : route.fallback());
  await page.goto(`/#chat=${fixture.id}`);
  await expect(page.locator("#system-queue")).toContainText("Continue active goal");
  await expect(page.locator("#system-queue")).not.toContainText("/goal resume");
  await expect(page.locator("#message-queue")).toContainText("Real user follow-up");
  await expect(page.locator("#message-queue")).not.toContainText("/goal resume");
});

test("upload chips, usage availability, transcript and repository menus are functional", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "Open Existing beta", exact: true }).click();
  await page.locator("#attachment-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Fixture notes") });
  await expect(page.locator("#attachment-chips")).toContainText("notes.txt");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("#messages")).toContainText("notes.txt");
  await expect(page.locator("#attachment-chips")).toBeEmpty();
  await page.getByLabel("Context and usage", { exact: true }).click();
  await expect(page.locator("#session-usage")).toContainText("Subscription limits not reported");
  await expect(page.locator("#session-usage").getByRole("button", { name: "Compact session" })).toBeEnabled();
  await page.getByLabel("Chat actions", { exact: true }).click();
  await page.getByRole("button", { name: "Transcript view", exact: true }).click();
  await expect(page.locator("#preview-content")).toContainText("Please inspect the attached files");
  await page.getByLabel("Close preview", { exact: true }).click();
  await page.getByLabel("Repositories", { exact: true }).click();
  await expect(page.locator("#chat-repositories")).toContainText("Add repository");
});
