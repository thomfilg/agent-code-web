import { test, expect } from "@playwright/test";
import { openSettingsSection } from "./settings-navigation.mjs";

const inspected = {
  source: "thomfilg/ai-plugin-work", revision: "abc123", marketplace: { name: "work-workflow", description: "Work plugins" },
  plugins: [
    { name: "work-workflow", version: "1.0.0", description: "Workflow commands", commands: [{ name: "work-workflow:work", aliases: ["work"], description: "Run work" }] },
    { name: "synapsys", version: "1.0.0", description: "Memory commands", commands: [] },
  ],
};

test("company Plugins installs Claude and Codex selections from a public marketplace", async ({ page }) => {
  let records = [], revision = 0;
  await page.route("**/api/company-plugins**", route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.pathname === "/api/company-plugins/inspect") return route.fulfill({ json: { marketplace: inspected } });
    if (url.pathname === "/api/company-plugins" && method === "GET") {
      const companyId = url.searchParams.get("companyId");
      return route.fulfill({ json: { marketplaces: companyId ? records.filter(record => record.companyId === companyId) : records } });
    }
    if (url.pathname === "/api/company-plugins" && method === "POST") {
      const input = request.postDataJSON(), record = { id: "plugin_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: input.companyId, source: inspected.source,
        marketplace: inspected.marketplace, plugins: inspected.plugins, targets: input.targets, sourceRevision: inspected.revision, revision: ++revision };
      records = [record]; return route.fulfill({ status: 201, json: { marketplace: record } });
    }
    return route.fulfill({ status: 404, json: { error: "Fixture route not found" } });
  });

  await page.goto("/"); await expect(page.locator("#new-chat-fields")).toBeEnabled();
  await openSettingsSection(page, "Plugins", "g2i");
  const dialog = page.locator("#company-plugins-dialog"); await expect(dialog).toBeVisible();
  await expect(dialog.locator("#company-plugin-list")).toContainText("No company plugins installed yet");
  await dialog.getByRole("button", { name: "+ Add marketplace", exact: true }).click();
  await dialog.getByLabel("Public GitHub marketplace").fill("https://github.com/thomfilg/ai-plugin-work.git");
  await dialog.getByRole("button", { name: "Load plugins", exact: true }).click();
  await expect(dialog.getByLabel("Install work-workflow for Claude")).toBeChecked();
  await expect(dialog.getByLabel("Install work-workflow for Codex")).toBeChecked();
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled(); await expect(save).toBeInViewport();
  await page.evaluate(() => { window.pluginSettingsChanged = 0; window.addEventListener("relay-company-plugins-changed", () => window.pluginSettingsChanged++); });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await dialog.locator(".company-plugins-card").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("company-plugins.png") });
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(save).toBeInViewport(); expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await save.click(); await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.pluginSettingsChanged)).toBe(1);

  const hub = page.locator("#company-settings-dialog");
  await expect(hub.getByRole("button", { name: "Plugins", exact: true })).toContainText("2 for Claude · 2 for Codex");
  expect(records[0].source).toBe("thomfilg/ai-plugin-work");
  expect(records[0].targets).toEqual({ claude: ["synapsys", "work-workflow"], codex: ["synapsys", "work-workflow"] });
});
