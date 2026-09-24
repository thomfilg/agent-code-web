import { expect } from "@playwright/test";

export async function openSettingsSection(page, section, companyId) {
  const hub = page.locator("#company-settings-dialog");
  if (!await hub.isVisible()) {
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    if (page.viewportSize().width < 700 && !await page.locator("#sidebar").evaluate(el => el.classList.contains("open"))) await page.getByRole("button", { name: "Open chats", exact: true }).click();
    await settings.click();
  }
  if (companyId) await hub.locator(`[id="settings-tab-${companyId}"]`).click();
  await hub.getByRole("button", { name: section, exact: true }).click();
}

export async function switchSettingsCompany(page, section, companyId) {
  const filter = page.locator(section === "GitHub" ? "#github-company-filter" : "#mcp-company-filter");
  if (await filter.isVisible()) { await filter.selectOption(companyId); return; }
  const child = page.locator("dialog[open]").filter({ hasNot: page.locator("#company-settings-title") }).last();
  await child.getByRole("button", { name: /^Close/ }).first().click();
  await expect(child).toBeHidden();
  await openSettingsSection(page, section, companyId);
}
