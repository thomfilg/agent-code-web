import { test, expect } from "@playwright/test";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
let chatId;
test.afterEach(async ({ request }) => { if (chatId) await request.delete(`/api/chats/${chatId}`); chatId = null; });

test("pasted images can be previewed before and after sending, without losing the draft", async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Attachment preview fixture" } })).json(); chatId = chat.id;
  await page.goto(`/#chat=${chat.id}`); const input = page.getByLabel("Message", { exact: true }); await input.fill("Review this cropped image");
  await input.evaluate((node, base64) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0)), transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "cropped.png", { type: "image/png" }));
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, png.toString("base64"));
  const chip = page.locator("#attachment-chips").getByRole("button", { name: "Preview cropped.png", exact: true });
  await expect(chip).toBeVisible(); await chip.click();
  const image = page.locator("#preview-content img"); await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBe(1);
  await expect(input).toHaveValue("Review this cropped image");
  await page.getByRole("button", { name: "Actual size", exact: true }).click(); await expect(page.locator("#preview-content")).toHaveClass(/image-actual-size/);
  await page.getByLabel("Close preview", { exact: true }).click(); await expect(chip).toBeFocused();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("#attachment-chips")).toBeEmpty();
  await page.locator("#messages").getByRole("button", { name: "Preview cropped.png", exact: true }).click();
  await expect(image).toBeVisible(); await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByLabel("Close preview", { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel("Close preview", { exact: true }).click();
  await expect(page.locator("#runtime-status")).toHaveText("Ready"); await expect(page.locator("#countdown")).toHaveText("KEPT AWAKE");
});

test("image removal is separate from previewing, and normal pasted text is left alone", async ({ page, request }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Attachment removal fixture" } })).json(); chatId = chat.id;
  await page.goto(`/#chat=${chat.id}`);
  await page.locator("#attachment-input").setInputFiles({ name: "picture.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Remove picture.png", exact: true }).click();
  await expect(page.locator("#attachment-chips")).toBeEmpty(); await expect(page.locator("#preview-panel")).not.toBeVisible();
  expect(await page.getByLabel("Message", { exact: true }).evaluate(node => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", "ordinary text");
    return node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  })).toBe(true);
});
