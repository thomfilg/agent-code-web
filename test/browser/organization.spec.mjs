import { test, expect } from "@playwright/test";

test("chat rows stay single-line with accessible status and inline pin / organize actions", async ({ page }) => {
  await page.goto("/");
  const row = page.locator(".chat-row").filter({ hasText: "Existing beta" });
  await expect(row.locator(".chat-item-meta, .chat-origin, .chat-age")).toHaveCount(0);
  await expect(row.getByRole("img", { name: "Idle", exact: true })).toBeVisible();
  const bounds = await row.evaluate(n => {
    const title = n.querySelector(".chat-item-title").getBoundingClientRect();
    return { height: n.getBoundingClientRect().height, centers: [...n.querySelectorAll(".small-icon")].map(b => { const r = b.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - title.top - title.height / 2); }) };
  });
  expect(bounds.height).toBeLessThan(40); expect(bounds.centers.every(delta => delta < 3)).toBe(true);
  await page.screenshot({ path: "test-results/compact-sidebar.png", fullPage: true });
});

test("Organize deletes only the confirmed chat, keeps other drafts, and updates another tab", async ({ page, context, request }) => {
  const create = async title => (await (await request.post("/api/chats", { data: { title, agent: "mock" } })).json()).chat;
  const active = await create("Delete test active"), other = await create("Delete test other");
  try {
    await page.goto("/"); await page.getByRole("button", { name: `Open ${active.title}`, exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
    await page.getByRole("button", { name: `Organize ${other.title}`, exact: true }).click();
    page.once("dialog", dialog => dialog.dismiss()); await page.locator("#organize-delete-chat").click();
    await expect(page.locator("#organize-dialog")).toBeVisible(); expect((await request.get(`/api/chats/${other.id}`)).ok()).toBe(true);
    page.once("dialog", dialog => { expect(dialog.message()).toContain("cannot be undone"); return dialog.accept(); });
    await page.locator("#organize-delete-chat").click(); await expect(page.locator("#organize-dialog")).not.toBeVisible();
    await expect(page.locator(`[data-chat-id="${other.id}"]`)).toHaveCount(0);
    await expect(page.locator("#chat-title")).toHaveText(active.title); await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this draft");
    expect((await request.get(`/api/chats/${other.id}`)).status()).toBe(404);
    const tab = await context.newPage(); await tab.goto("/"); await tab.getByRole("button", { name: `Open ${active.title}`, exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("button", { name: "Open chats", exact: true }).click();
    await page.getByRole("button", { name: `Organize ${active.title}`, exact: true }).click();
    await expect(page.locator("#organize-delete-chat")).toBeInViewport();
    expect(await page.locator("#organize-dialog").evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true);
    page.once("dialog", dialog => dialog.accept()); await page.locator("#organize-delete-chat").click();
    await expect(page.locator("#organize-dialog")).not.toBeVisible();
    await expect(tab.locator("#chat-title")).not.toHaveText(active.title);
    expect((await request.get(`/api/chats/${active.id}`)).status()).toBe(404);
  } finally { await request.delete(`/api/chats/${active.id}`); await request.delete(`/api/chats/${other.id}`); }
});

test("automatic sidebar status symbols use the requested colors and accessible labels", async ({ page }) => {
  const states = [
    ["working", "Working", "rgb(139, 143, 135)"], ["asking_question", "Asking question", "rgb(234, 191, 85)"],
    ["pr_open", "PR open", "rgb(63, 185, 80)"], ["pr_merged", "PR merged", "rgb(163, 113, 247)"], ["pr_failing", "PR not passing", "rgb(248, 81, 73)"],
  ];
  await page.route("**/api/sidebar", async route => {
    const response = await route.fetch(); const data = await response.json();
    const base = data.chats[0];
    data.chats = states.map(([workflowState, title], index) => ({ ...base, id: index === 0 ? base.id : `chat_${String(index).padStart(32, "0")}`, title, workflowState, pinned: true }));
    await route.fulfill({ response, json: data });
  });
  await page.goto("/");
  for (const [state, label, color] of states) {
    const icon = page.locator(`.chat-status-icon.${state}`);
    await expect(icon).toHaveAttribute("aria-label", label);
    await expect(icon).toHaveCSS("color", color);
    await expect(icon.locator("svg")).toHaveCount(state.startsWith("pr_") ? 1 : 0);
  }
  await page.screenshot({ path: "test-results/automatic-status-icons.png", fullPage: true });
});

test("pin, drag to a custom group, restore grouping, sort, and persist across tabs", async ({ page, context }) => {
  // Keep both drag endpoints visible; the settings footer leaves less room in
  // a short viewport, and dragTo cannot auto-scroll between clipped endpoints.
  await page.setViewportSize({ width: 1280, height: 1000 });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Pin Existing alpha", exact: true }).click();
  await expect(page.locator('[data-section="pinned"]')).toContainText("Existing alpha");
  await page.getByRole("button", { name: "Create custom group" }).click();
  await page.getByLabel("Group name", { exact: true }).fill("Sprint planning");
  await page.getByRole("button", { name: "Save group", exact: true }).click();
  const row = page.locator(".chat-row").filter({ hasText: "Existing beta" });
  const target = page.locator('[data-drop-target="Sprint planning"]');
  await row.dragTo(target.locator("summary"));
  await expect(target).toContainText("Existing beta");
  await page.getByLabel("Sort chats").selectOption("created_asc");
  const other = await context.newPage(); await other.goto("/");
  await expect(other.getByLabel("Sort chats")).toHaveValue("created_asc");
  await expect(other.locator('[data-drop-target="Sprint planning"]')).toContainText("Existing beta");
  await other.getByRole("button", { name: "Organize Existing beta", exact: true }).click();
  await other.getByLabel("Move to group", { exact: true }).selectOption("");
  await expect(other.locator("#organize-state")).toHaveCount(0);
  await expect(other.locator("#organize-status")).toContainText("Idle");
  await other.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator('[data-section="company:personal"]')).toContainText("Existing beta");
  await expect(page.locator(".chat-row").filter({ hasText: "Existing beta" }).getByRole("img", { name: "Idle", exact: true })).toBeVisible();
  await page.reload(); await expect(page.locator('[data-section="pinned"]')).toContainText("Existing alpha");
  expect(errors).toEqual([]);
});

test("GitHub picker preserves repository order, branches, selection and inline errors", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: /New chat/ }).click();
  await expect(page.locator("#new-chat-title")).toHaveCount(0);
  await page.locator("#connect-github-button").click();
  await page.getByRole("button", { name: "Use this server’s gh login" }).click();
  await expect(page.locator("#github-dialog")).not.toBeVisible();
  await page.locator(".repository-picker-dropdown > summary").click();
  await page.getByLabel("Acme/api", { exact: false }).check();
  await page.getByLabel("Other/library", { exact: false }).check();
  await page.getByLabel("Branch for Acme/api").focus();
  await expect(page.getByLabel("Branch for Acme/api").locator("option")).toHaveCount(2);
  await page.getByLabel("Branch for Acme/api").selectOption("develop");
  await page.getByLabel("Make Other/library primary").click();
  await page.getByLabel("New chat model", { exact: true }).selectOption("fixture-gpt");
  await page.getByLabel("New chat effort", { exact: true }).selectOption("high");
  await expect(page.locator("#repository-group-hint")).toContainText("Other → library");
  await page.getByRole("button", { name: "Create chat", exact: true }).click();
  await expect(page.locator("#new-chat-dialog")).not.toBeVisible();
  await expect(page.locator('[data-section="company:other"]')).toContainText("library");
  await expect(page.getByLabel("Chat model", { exact: true })).toHaveValue("fixture-gpt");
  await expect(page.getByLabel("Chat effort", { exact: true })).toHaveValue("high");
  await page.getByLabel("Choose effort", { exact: true }).click();
  await page.getByLabel("Chat effort", { exact: true }).selectOption("low");
  await page.getByLabel("Choose effort", { exact: true }).click();
  await page.reload(); await page.getByRole("button", { name: /New chat/ }).click();
  await expect(page.locator(".repository-chip").first()).toContainText("Other/library");
  await expect(page.getByLabel("Branch for Acme/api")).toHaveValue("develop");
  await expect(page.getByLabel("New chat effort", { exact: true })).toHaveValue("high");
  await expect(page.getByLabel("Chat effort", { exact: true })).toHaveValue("low");
  await page.route("**/api/chats", route => route.request().method() === "POST" ? route.fulfill({ status: 403, json: { error: "GitHub permission revoked. Reconnect your account." } }) : route.continue());
  await page.getByRole("button", { name: "Create chat", exact: true }).click();
  await expect(page.locator("#create-chat-error")).toBeVisible();
  await expect(page.locator("#create-chat-error")).toContainText("permission revoked");
  await expect(page.getByRole("button", { name: "Create chat", exact: true })).toBeEnabled();
});

test("mobile group menu and masked environment editor", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/");
  await page.getByRole("button", { name: "Open chats", exact: true }).click();
  await page.getByRole("button", { name: "Organize Existing alpha", exact: true }).click();
  await page.getByRole("button", { name: "Archive chat", exact: true }).click();
  await expect(page.locator(".chat-row").filter({ hasText: "Existing alpha" }).getByRole("img", { name: "Archived", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Organize Existing alpha", exact: true }).click();
  await page.getByRole("button", { name: "Unarchive chat", exact: true }).click();
  await expect(page.locator(".chat-row").filter({ hasText: "Existing alpha" }).getByRole("img", { name: "Idle", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Environments", exact: true }).click();
  await page.getByRole("button", { name: "Add environment", exact: false }).click();
  await page.getByLabel("Environment name", { exact: true }).fill("Browser sandbox");
  await page.getByRole("button", { name: "Add variable", exact: false }).click();
  await page.getByLabel("Variable 1 name", { exact: true }).fill("SERVICE_TOKEN");
  await page.getByLabel("Variable 1 value", { exact: true }).fill("private-test-only");
  await page.getByRole("button", { name: "Save environment", exact: true }).click();
  await expect(page.locator("#environment-save-status")).toHaveText("Saved securely");
  await expect(page.getByLabel("Variable 1 value", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByLabel("Variable 1 value", { exact: true })).toHaveValue("private-test-only");
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.getByLabel("Variable 1 value", { exact: true })).toHaveAttribute("type", "password");
  await page.screenshot({ path: "test-results/mobile-environments.png", fullPage: true });
});
