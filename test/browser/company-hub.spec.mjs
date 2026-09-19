import { test, expect } from "@playwright/test";
import { openSettingsSection } from "./settings-navigation.mjs";

test("Settings uses company tabs and scoped cards; adding a company creates a durable tab without losing the draft", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/"); await expect(page.locator("#new-chat-fields")).toBeEnabled();
  await page.locator("#initial-prompt").fill("Keep my task");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const hub = page.locator("#company-settings-dialog");
  await expect(hub.getByRole("tab", { name: "g2i", exact: true })).toBeVisible();
  await expect(hub.locator(".company-settings-section")).toHaveCount(4);
  const firstTab = hub.getByRole("tab").first(); await firstTab.focus(); await firstTab.press("ArrowRight");
  await expect(hub.locator('[role="tab"][aria-selected="true"]')).toBeFocused();
  await hub.getByRole("button", { name: "+ Add company", exact: true }).click();
  const form = hub.locator("#settings-company-form"), save = form.getByRole("button", { name: "Save company", exact: true });
  await expect(save).toBeDisabled();
  await form.getByLabel("Company name", { exact: true }).fill("Hub fixture");
  await form.getByLabel("Company identifier", { exact: true }).fill("hub-fixture");
  await save.click(); await expect(hub.getByRole("tab", { name: "Hub fixture", exact: true })).toHaveAttribute("aria-selected", "true");
  await hub.getByRole("button", { name: "Edit company", exact: true }).click();
  await expect(save).toBeDisabled(); await expect(form.getByLabel("Company identifier", { exact: true })).toHaveAttribute("readonly", "");
  await form.getByLabel("Company name", { exact: true }).fill("Changed draft");
  page.once("dialog", dialog => dialog.dismiss()); await hub.getByRole("tab", { name: "g2i", exact: true }).click();
  await expect(form.getByLabel("Company name", { exact: true })).toHaveValue("Changed draft");
  await form.getByLabel("Company name", { exact: true }).fill("Hub fixture"); await expect(save).toBeDisabled();
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await hub.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.locator("#initial-prompt")).toHaveValue("Keep my task");
  await page.reload(); await openSettingsSection(page, "MCP connections", "hub-fixture");
  await expect(page.locator("#mcp-company-filter")).toHaveValue("hub-fixture");
  await expect(page.locator("#mcp-company-filter")).toBeHidden();
  await expect(page.locator("#mcp-dialog .company-settings-context")).toHaveText("Company: Hub fixture");
  await page.getByLabel("Close MCP connections", { exact: true }).click();
  await openSettingsSection(page, "GitHub", "g2i");
  await expect(page.locator("#github-company-filter")).toHaveValue("g2i");
  await expect(page.locator("#github-dialog .company-settings-context")).toHaveText("Company: g2i");
  expect(errors).toEqual([]);
});

test("GitHub edit drafts never cross company tabs and MCP GitHub shortcut keeps scoped mode", async ({ page }) => {
  await page.route("**/api/github", route => route.fulfill({ json: { connections: [
    { id: "fixture-a", name: "Acme account", login: "fixture-acme", companyId: "acme", connected: true, revision: 1 },
    { id: "fixture-b", name: "G2i account", login: "fixture-g2i", companyId: "g2i", connected: true, revision: 1 },
  ] } }));
  await page.goto("/"); await openSettingsSection(page, "GitHub", "acme");
  await page.locator("#github-account-list").getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#github-connection-name").fill("Unsent rename");
  page.once("dialog", dialog => dialog.dismiss()); await page.getByLabel("Close GitHub dialog", { exact: true }).click();
  await expect(page.locator("#github-dialog")).toBeVisible();
  page.once("dialog", dialog => dialog.accept()); await page.getByLabel("Close GitHub dialog", { exact: true }).click();
  await openSettingsSection(page, "GitHub", "g2i");
  await expect(page.locator("#github-rename-form")).toBeHidden();
  await expect(page.locator("#github-account-list")).toContainText("G2i account");
  await expect(page.locator("#github-account-list")).not.toContainText("Acme account");
  await page.getByLabel("Close GitHub dialog", { exact: true }).click();
  await openSettingsSection(page, "MCP connections", "g2i");
  await page.locator('[data-preset="github"]').click();
  await expect(page.locator("#github-dialog")).toHaveAttribute("data-company-scoped", "true");
  await expect(page.locator("#github-company-filter")).toBeHidden();
  await expect(page.locator("#github-company-filter")).toHaveValue("g2i");
});

test("closing Settings invalidates delayed MCP navigation", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "Settings", exact: true }).click();
  const hub = page.locator("#company-settings-dialog");
  await expect(hub.getByRole("button", { name: "MCP connections", exact: true })).toBeEnabled();
  let release, entered; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  await page.route("**/api/mcps/presets", async route => { entered(); await held; await route.continue(); });
  await hub.getByRole("button", { name: "MCP connections", exact: true }).click(); await started;
  await hub.getByLabel("Close settings", { exact: true }).click();
  const response = page.waitForResponse("**/api/mcps/presets"); release(); await response;
  await page.waitForTimeout(100);
  await expect(page.locator("#mcp-dialog")).toBeHidden(); await expect(hub).toBeHidden();
});

test("another settings destination cancels a pending MCP open", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "Settings", exact: true }).click();
  const hub = page.locator("#company-settings-dialog");
  await expect(hub.getByRole("button", { name: "MCP connections", exact: true })).toBeEnabled();
  let release, entered; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  await page.route("**/api/mcps/presets", async route => { entered(); await held; await route.continue(); });
  await hub.getByRole("button", { name: "MCP connections", exact: true }).click(); await started;
  await hub.getByRole("button", { name: "GitHub", exact: true }).click();
  await expect(page.locator("#github-dialog")).toBeVisible();
  const response = page.waitForResponse("**/api/mcps/presets"); release(); await response; await page.waitForTimeout(100);
  await expect(page.locator("#mcp-dialog")).toBeHidden(); await expect(page.locator("#github-dialog")).toBeVisible();
});

test("closing Settings invalidates delayed environment navigation and scoped editors keep the company", async ({ page }) => {
  await page.goto("/"); await openSettingsSection(page, "Environments", "g2i");
  await expect(page.locator("#environment-company-filter")).toBeHidden();
  await expect(page.locator("#environments-dialog .company-settings-context")).toHaveText("Company: g2i");
  await page.getByLabel("Close environments", { exact: true }).click();
  const hub = page.locator("#company-settings-dialog");
  await expect(hub.getByRole("button", { name: "Environments", exact: true })).toBeEnabled();
  let release, entered; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  await page.route("**/api/environments", async route => { entered(); await held; await route.continue(); });
  await hub.getByRole("button", { name: "Environments", exact: true }).click(); await started;
  await hub.getByLabel("Close settings", { exact: true }).click();
  const response = page.waitForResponse("**/api/environments"); release(); await response; await page.waitForTimeout(100);
  await expect(page.locator("#environments-dialog")).toBeHidden(); await expect(hub).toBeHidden();
});

test("Settings fits desktop/mobile and load failures keep stale company actions disabled until retry", async ({ page }, testInfo) => {
  let fail = false;
  await page.route("**/api/companies", route => fail ? route.fulfill({ status: 503, json: { error: "Fixture unavailable" } }) : route.continue());
  await page.goto("/"); await expect(page.locator("#new-chat-fields")).toBeEnabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const hub = page.locator("#company-settings-dialog");
  await expect(hub.locator(".company-settings-section").first()).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("settings-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await hub.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(hub.getByLabel("Close settings", { exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("settings-mobile.png") });
  await hub.getByLabel("Close settings", { exact: true }).click(); fail = true;
  await page.getByRole("button", { name: "Open chats", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(hub.getByRole("alert")).toContainText("Fixture unavailable");
  await expect(hub.locator(".company-settings-section").first()).toBeDisabled();
  fail = false; await hub.getByRole("button", { name: "Retry loading settings" }).click();
  await expect(hub.locator(".company-settings-section").first()).toBeEnabled();
});
