import { test, expect } from "@playwright/test";

test("new environments default CI monitoring on and persist independent choices", async ({ page, request }) => {
  const name = `CI monitoring fixture ${Date.now()}`; let environmentId;
  try {
    await page.goto("/");
    await page.locator("#environment-settings").click();
    await expect(page.locator("#environments-dialog")).toBeVisible();
    await page.locator("#add-environment").click();
    await expect(page.locator("#environment-ci-notify-failures")).toBeChecked();
    await expect(page.locator("#environment-ci-wake-passing")).toBeChecked();
    await page.locator("#environment-name").fill(name);
    await page.locator("#environment-advanced").evaluate(node => { node.open = true; });
    await page.locator("#environment-ci-notify-failures").uncheck();
    await page.getByRole("button", { name: "Save environment", exact: true }).click();
    await expect(page.locator("#environments-dialog")).not.toBeVisible();
    const { environments } = await (await request.get("/api/environments")).json();
    const saved = environments.find(environment => environment.name === name); environmentId = saved?.id;
    expect(saved?.ciMonitoring).toEqual({ notifyFailures: false, wakePassing: true });
  } finally {
    if (environmentId) await request.delete(`/api/environments/${environmentId}`);
  }
});
