import { test, expect } from "@playwright/test";

async function picker(page) {
  await page.route("**/__ultracode-fixture", route => route.fulfill({ contentType: "text/html", body: '<div id="picker"><select class="model-select" aria-label="Model"></select><select class="effort-select" aria-label="Effort"></select><p class="model-note"></p></div>' }));
  await page.goto("/__ultracode-fixture");
  await page.evaluate(async () => {
    const { ModelPicker } = await import("/model-picker.js"); ModelPicker.clearCatalogs();
    const models = [
      { id: "default", label: "Default", isDefault: true, efforts: ["auto", "high", "xhigh"], ultracode: { supported: true, reason: "xhigh effort plus native workflows" } },
      { id: "unverified", label: "Unverified", efforts: ["auto", "xhigh"], ultracode: { supported: false, reason: "Workflow capability not verified for this model" } },
    ];
    window.writes = [];
    window.picker = new ModelPicker({ root: document.querySelector("#picker"), api: async () => ({ source: "claude-account", configuredDefault: "default", models }),
      onChange: async value => { window.writes.push(value); if (window.holdSave) await new Promise(resolve => { window.finishSave = resolve; }); } });
    await window.picker.setAgent("claude", { id: "chat", agentAccountId: "personal", model: "default", effort: "xhigh", ultracode: false });
  });
}

test("Ultracode is distinct from xhigh, saves a chat boolean, preserves pending UI, and model switch disables it", async ({ page }) => {
  await picker(page);
  const effort = page.getByRole("combobox", { name: "Effort", exact: true });
  await expect(effort).toHaveValue("xhigh");
  await expect(effort.locator('option[value="xhigh"]')).toHaveText("Extra high");
  await expect(effort.locator('option[value="ultracode"]')).toHaveText("Ultracode · xhigh + workflows");
  await page.evaluate(() => { window.holdSave = true; });
  await effort.selectOption("ultracode");
  await expect(effort).toBeDisabled();
  expect(await page.evaluate(() => window.writes[0])).toEqual({ model: "default", effort: "xhigh", ultracode: true });
  await page.evaluate(() => { window.holdSave = false; window.finishSave(); });
  await expect(effort).toBeEnabled();
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("unverified");
  await expect(effort.locator('option[value="ultracode"]')).toBeDisabled();
  expect(await page.evaluate(() => window.writes.at(-1).ultracode)).toBe(false);
  await page.evaluate(() => window.picker.setAgent("claude", { id: "other-chat", agentAccountId: "personal", model: "default", effort: "xhigh" }));
  await expect(effort).toHaveValue("xhigh");
});

test("saved unsupported mode remains visibly unavailable and ordinary effort explicitly clears it", async ({ page }) => {
  await picker(page);
  await page.evaluate(() => window.picker.setAgent("claude", { id: "chat", agentAccountId: "personal", model: "unverified", effort: "xhigh", ultracode: true }));
  const effort = page.getByRole("combobox", { name: "Effort", exact: true });
  await expect(effort).toHaveValue("ultracode");
  await expect(effort.locator('option[value="ultracode"]')).toBeDisabled();
  await expect(page.locator(".model-note")).toContainText("not verified");
  await effort.selectOption("xhigh");
  expect(await page.evaluate(() => window.writes.at(-1))).toEqual({ model: "unverified", effort: "xhigh", ultracode: false });
  await expect(page.locator(".model-note")).not.toContainText("workflows");
});
