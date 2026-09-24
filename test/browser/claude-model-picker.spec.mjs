import { test, expect } from "@playwright/test";

test("Claude has one native Default, preserves its saved ID and disables native unavailable choices", async ({ page }) => {
  // Isolated component on the local fixture origin: no account/provider call,
  // CLI process, conversation or model turn is created by this test.
  await page.route("**/__claude-model-picker-fixture", route => route.fulfill({ contentType: "text/html", body: '<div id="picker"><select class="model-select" aria-label="Model"></select><select class="effort-select" aria-label="Effort"></select><p class="model-note"></p></div>' }));
  await page.goto("/__claude-model-picker-fixture");
  await page.evaluate(async () => {
    const { ModelPicker } = await import("/model-picker.js");
    window.modelWrites = [];
    const catalog = { source: "claude-account", configuredDefault: "default", configuredDefaultEffort: "auto", note: "Native fixture models", models: [
      { id: "default", label: "Default (recommended)", isDefault: true, efforts: ["auto", "high"] },
      { id: "fixture-native", label: "Native fixture model", efforts: ["auto", "high"] },
      { id: "fixture-new", label: "Upcoming fixture model", disabled: true, disabledReason: "Update the CLI to use this native option", efforts: ["auto", "high"] },
    ] };
    window.modelPicker = new ModelPicker({ root: document.querySelector("#picker"), api: async () => catalog, onChange: value => { window.modelWrites.push(value); } });
    await window.modelPicker.setAgent("claude", { agentAccountId: "fixture", model: "default", effort: "auto" });
  });
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveValue("default");
  await expect(model.locator("option")).toHaveCount(3);
  await expect(model.locator('option[value="default"]')).toHaveText("Default (recommended)");
  await expect(model.locator('option[value="fixture-new"]')).toBeDisabled();
  await expect(model.locator('option[value="fixture-new"]')).toContainText("Update the CLI");
  await model.selectOption("fixture-native"); await model.selectOption("default");
  expect(await page.evaluate(() => window.modelWrites.map(value => value.model))).toEqual(["fixture-native", "default"]);
  await page.evaluate(() => window.modelPicker.setAgent("claude", { agentAccountId: "fixture", model: "fixture-new" }));
  await expect(model).toHaveValue("fixture-new"); await expect(page.getByRole("combobox", { name: "Effort", exact: true })).toBeDisabled();
  await expect(page.locator(".model-note")).toContainText("Update the CLI");
  await page.evaluate(() => window.modelPicker.setAgent("claude", { agentAccountId: "fixture", model: "removed-model" }));
  await expect(model.locator('option[value="removed-model"]')).toBeDisabled();
  expect(await page.evaluate(() => window.modelWrites.length)).toBe(2);
});
