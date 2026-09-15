import { test, expect } from "@playwright/test";

test("signed-in Chrome stays off without consent and connection setup fits desktop and phone", async ({ page, request }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Chrome permission UI" } })).json();
  try {
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/#chat=${chat.id}`);
    await expect(page.getByRole("switch", { name: "Use my signed-in Chrome" })).not.toBeChecked();
    await page.locator(".signed-chrome-toggle").click();
    await expect(page.locator("#browser-connections-dialog")).toBeVisible();
    await expect(page.getByLabel("Account password", { exact: true })).toHaveAttribute("type", "password");
    await expect(page.locator("#browser-connections-dialog")).toContainText("not your Google password");
    await expect(page.locator("#signed-chrome-toggle")).not.toBeChecked();
    await page.screenshot({ path: "test-results/chrome-connections-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await page.locator("#browser-connections-dialog").boundingBox();
    expect(dialog.x).toBeGreaterThanOrEqual(0); expect(dialog.x + dialog.width).toBeLessThanOrEqual(390);
    await expect(page.getByLabel("Close browser connections", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/chrome-connections-mobile.png", fullPage: true });
    await page.getByLabel("Close browser connections", { exact: true }).click();
    expect((await (await request.get(`/api/chats/${chat.id}/browser/access`)).json()).enabled).toBe(false);
    expect((await (await request.get(`/api/chats/${chat.id}/browser`)).json()).running).toBe(false);
    expect(errors).toEqual([]);
  } finally { await request.delete(`/api/chats/${chat.id}`); }
});
