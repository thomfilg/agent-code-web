import { test, expect } from "@playwright/test";
import { BUILTIN_PETS, builtinPet } from "../../public/pets.js";
import { petSheet } from "../fixtures/pet-sheet.mjs";

test("switching account clears private pet names, labels, files and decoded previews, and hides a cached foreign chat's state", async ({ page }) => {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Pet privacy fixture" } })).json();
  try {
    const privatePet = { ...builtinPet("codex"), id: "custom-private", name: "Private old pet", description: "Private old description", builtin: false };
    let saved = { scope: "old-owner", revision: 1, selected: privatePet.id, pets: [...BUILTIN_PETS.map(pet => builtinPet(pet.id)), privatePet], account: { id: "old-owner", username: "Private old username" } };
    const errors = [], assets = []; page.on("pageerror", error => errors.push(error.message));
    await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: { ...chat, revision: 9999, ownerId: "old-owner", status: "running" } } }));
    await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
    await page.route("**/api/pets", route => route.fulfill({ json: saved }));
    await page.route("**/api/pets/assets/**", route => { assets.push(route.request().url()); return route.fulfill({ contentType: "image/png", body: petSheet() }); });
    await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title); await expect(page.locator("#chat-pet .pet-art")).toHaveAttribute("data-art", "ready");
    await page.getByLabel("Chat settings", { exact: true }).click(); await page.locator("#pets-button").click(); await expect(page.locator(".pet-preview")).toHaveAttribute("data-art", "ready");
    await page.getByLabel("Custom pet name", { exact: true }).fill("Private unsaved name"); await page.getByLabel("Pet sprite sheet", { exact: true }).setInputFiles({ name: "private-sheet.png", mimeType: "image/png", buffer: petSheet() });
    saved = { scope: "new-owner", revision: 0, selected: "fireball", pets: BUILTIN_PETS.map(pet => builtinPet(pet.id)), account: { id: "new-owner", username: "New owner" } };
    await page.evaluate(() => dispatchEvent(new Event("focus"))); await expect(page.locator("#controls-content [role=status]")).toContainText("account changed");
    await expect(page.locator("#chat-pet")).toBeHidden(); await expect(page.locator("#controls-content")).not.toContainText("Private old");
    await expect(page.getByLabel("Custom pet name", { exact: true })).toHaveValue(""); expect(await page.getByLabel("Pet sprite sheet", { exact: true }).evaluate(input => input.files.length)).toBe(0);
    expect(await page.locator(".pet-preview").getAttribute("aria-label")).toBeNull(); await expect(page.locator(".pet-preview")).toHaveAttribute("data-art", "off");
    await expect(page.getByRole("button", { name: "Save pet", exact: true })).toBeDisabled();
    expect(assets.some(url => url.includes("fireball"))).toBe(false); expect(errors).toEqual([]);
  } finally { await page.request.delete(`/api/chats/${chat.id}`); }
});
