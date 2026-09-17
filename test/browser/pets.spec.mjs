import { test, expect } from "@playwright/test";
import { BUILTIN_PETS, builtinPet } from "../../public/pets.js";
import { petSheet } from "../fixtures/pet-sheet.mjs";
const sheet = petSheet(), created = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page, { selected = null, busy = false } = {}) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: `Pet fixture ${Date.now()}` } })).json(); created.set(page, [chat.id]);
  const snapshot = { ...chat, revision: 99999, agent: "codex", status: busy ? "running" : "stopped", messages: [] }, calls = { saves: [], actions: [], errors: [], assets: [] };
  let saved = { scope: "shared", revision: 0, selected, pets: BUILTIN_PETS.map(pet => builtinPet(pet.id)), account: null };
  page.on("pageerror", error => calls.errors.push(error.message));
  await page.route(`**/api/chats/${chat.id}`, route => route.fulfill({ json: { chat: snapshot } }));
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  for (const tail of ["messages", "queue", "wake", "stop", "compact"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { calls.actions.push(tail); return route.fulfill({ json: {} }); });
  await page.route("**/api/pets", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: saved });
    const input = route.request().postDataJSON(); calls.saves.push(input);
    if (input.scope !== saved.scope || input.revision !== saved.revision) return route.fulfill({ status: 409, json: { error: "Pets changed in another tab. Reload /pets before saving." } });
    saved = { ...saved, selected: input.selected, revision: saved.revision + 1 }; return route.fulfill({ json: saved });
  });
  await page.route("**/api/pets/assets/**", route => { calls.assets.push(route.request().url()); return route.fulfill({ contentType: "image/png", body: sheet }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, snapshot, calls, get saved() { return saved; }, set saved(value) { saved = value; } };
}
const close = page => page.locator("#controls-dialog").evaluate(dialog => dialog.close());
async function open(page) { await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#pets-button").click(); await expect(page.locator("#controls-title")).toHaveText("Pets"); await expect(page.locator("#controls-content [role=status]")).toContainText("Saved pets loaded"); }
async function save(page) { await page.getByRole("button", { name: "Save pet", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("saved and active"); }
async function command(page, text, busy = false) { await page.locator("#message-input").fill(text); await page.getByRole("button", { name: busy ? "Queue" : "Send message", exact: true }).click(); }

test("pet picker previews all built-ins without applying; save, cancel and Off retain drafts and files", async ({ page }) => {
  const f = await setup(page); expect(f.calls.assets).toEqual([]);
  await page.locator("#message-input").fill("Keep my draft"); await page.locator("#attachment-input").setInputFiles({ name: "pet.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
  await open(page); await expect(page.getByRole("radio")).toHaveCount(9); await expect(page.getByRole("button", { name: "Upload pet", exact: true })).toBeDisabled();
  for (const pet of BUILTIN_PETS) { await page.getByRole("radio", { name: pet.name, exact: true }).check(); await expect(page.locator(".pet-preview")).toHaveAttribute("data-art", "ready"); await expect(page.locator("#chat-pet")).toBeHidden(); }
  await close(page); expect(f.calls.saves).toEqual([]);
  await open(page); await page.getByRole("radio", { name: "Codex", exact: true }).check(); await save(page); await close(page);
  await expect(page.locator("#chat-pet .pet-art")).toHaveAttribute("data-art", "ready"); await expect(page.locator("#chat-pet")).toContainText("Codex");
  await expect(page.locator("#message-input")).toHaveValue("Keep my draft"); await expect(page.locator("#attachment-chips")).toContainText("pet.txt");
  await page.getByRole("button", { name: "Hide pet", exact: true }).click(); await expect(page.locator("#chat-pet")).toBeHidden();
  await page.reload(); await expect(page.locator("#chat-pet")).toBeHidden(); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("busy /pet and /pets aliases, named choices, and off are web controls, never queued agent messages", async ({ page }) => {
  const f = await setup(page, { busy: true });
  await command(page, "/pet", true); await expect(page.locator("#controls-title")).toHaveText("Pets"); await expect(page.locator("#message-input")).toHaveValue(""); await close(page);
  await command(page, "/pets Dewey", true); await expect(page.locator("#chat-pet")).toContainText("Dewey"); await expect(page.locator("#message-input")).toHaveValue("");
  await expect(page.locator("#chat-pet .pet-art")).toHaveAttribute("data-art", "ready"); await expect(page.locator("#chat-pet")).toContainText("Running");
  await command(page, "/pet null-signal", true); await expect(page.locator("#chat-pet")).toContainText("Null Signal");
  await command(page, "/pets imaginary", true); await expect(page.locator("#toasts")).toContainText("Unknown pet"); await expect(page.locator("#message-input")).toHaveValue("/pets imaginary");
  await command(page, "/pets off", true); await expect(page.locator("#chat-pet")).toBeHidden(); await expect(page.locator("#message-input")).toHaveValue("");
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("current-chat states draw the correct actual sprite pixels, reduced motion is still, and hidden tabs stop animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); const f = await setup(page, { selected: "codex", busy: true });
  const art = page.locator("#chat-pet .pet-art");
  for (const [status, pendingRequest, label, frame] of [["running", null, "running", 56], ["idle", { requestId: "pet-request", method: "item/commandExecution/requestApproval", params: { command: "fixture" } }, "input", 48], ["idle", null, "ready", 64], ["error", null, "blocked", 40], ["stopped", null, "idle", 0]]) {
    Object.assign(f.snapshot, { status, pendingRequest }); await page.reload(); await expect(art).toHaveAttribute("data-art", "ready"); await expect(page.locator("#chat-pet")).toHaveAttribute("data-activity", label); await expect(art).toHaveAttribute("data-frame", String(frame)); await expect(art).toHaveAttribute("data-animating", "false");
    const pixels = await art.locator("canvas").evaluate(canvas => ({ center: [...canvas.getContext("2d").getImageData(96, 104, 1, 1).data], corner: canvas.getContext("2d").getImageData(0, 0, 1, 1).data[3] }));
    expect(pixels.center).toEqual([(frame * 13 + 100) % 255, (frame * 37 + 110) % 255, (frame * 61 + 120) % 255, 255]); expect(pixels.corner).toBe(0);
  }
  f.snapshot.status = "running"; await page.reload(); await page.emulateMedia({ reducedMotion: "no-preference" }); await expect(art).toHaveAttribute("data-animating", "true");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); }); await expect(art).toHaveAttribute("data-animating", "false");
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); }); await expect(art).toHaveAttribute("data-animating", "true");
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("custom PNG upload, actual decoding, selection persistence, private library and confirmed deletion use real HTTP storage", async ({ page }) => {
  const username = `pets-owner-${Date.now()}`; expect((await page.request.post("/api/browser-account/register", { data: { username, password: "isolated-pet-owner-password" } })).ok()).toBe(true);
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Private custom pet" } })).json(); created.set(page, [chat.id]);
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title); await open(page); await expect(page.locator("#controls-content")).toContainText(username);
  await page.getByLabel("Custom pet name", { exact: true }).fill("My local pet"); await page.getByLabel("Pet sprite sheet", { exact: true }).setInputFiles({ name: "sheet.png", mimeType: "image/png", buffer: sheet });
  await page.getByRole("button", { name: "Upload pet", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("Custom pet added"); await expect(page.getByRole("radio", { name: "My local pet", exact: true })).toBeChecked();
  await expect(page.locator(".pet-preview")).toHaveAttribute("data-art", "ready"); await expect(page.locator("#chat-pet")).toBeHidden(); await save(page); await close(page);
  await expect(page.locator("#chat-pet .pet-art")).toHaveAttribute("data-art", "ready"); await page.reload(); await expect(page.locator("#chat-pet")).toContainText("My local pet");
  let library = await (await page.request.get("/api/pets")).json(); const id = library.selected; expect(id).toMatch(/^custom-/); expect(library.account.username).toBe(username);
  await open(page); page.once("dialog", dialog => dialog.dismiss()); await page.getByRole("button", { name: "Delete custom pet", exact: true }).click(); await expect(page.getByRole("radio", { name: "My local pet", exact: true })).toBeVisible();
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "Delete custom pet", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("artwork deleted"); await expect(page.getByRole("radio", { name: "My local pet", exact: true })).toHaveCount(0); await expect(page.locator("#chat-pet")).toBeHidden();
  library = await (await page.request.get("/api/pets")).json(); expect(library.selected).toBeNull(); expect((await page.request.get(`/api/pets/assets/${id}?scope=${library.scope}`)).status()).toBe(404);
  const stored = (await (await page.request.get(`/api/chats/${chat.id}`)).json()).chat; expect(stored.status).toBe("stopped"); expect(stored.messages).toEqual([]); expect(stored.agentSessionId).toBeFalsy();
});

test("asset failure is visible and retriable; failed preferences and unknown names retain the slash draft", async ({ page }) => {
  const f = await setup(page); let fail = true;
  await page.route("**/api/pets/assets/**", route => fail ? route.fulfill({ status: 502, json: { error: "Fixture artwork unavailable" } }) : route.fallback());
  await open(page); await page.getByRole("radio", { name: "Rocky", exact: true }).check(); await expect(page.locator(".pet-preview")).toHaveAttribute("data-art", "error"); await expect(page.locator(".pet-preview")).toContainText("unavailable");
  fail = false; await page.getByRole("button", { name: "Retry artwork", exact: true }).click(); await expect(page.locator(".pet-preview")).toHaveAttribute("data-art", "ready"); await close(page);
  await page.route("**/api/pets", route => route.fulfill({ status: 503, json: { error: "Fixture pets unavailable" } }));
  await command(page, "/pets"); await expect(page.locator("#controls-content [role=status]")).toContainText("unavailable"); await expect(page.locator("#message-input")).toHaveValue("/pets"); await expect(page.getByRole("button", { name: "Save pet", exact: true })).toBeDisabled();
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("slow discovery cannot erase a newer draft or replace a newer dialog", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let delay = true;
  await page.route("**/api/pets", async route => { if (delay) { delay = false; entered.resolve(); await release.promise; } return route.fallback(); });
  await command(page, "/pets"); await entered.promise; await close(page); await page.locator("#message-input").fill("Newer draft"); await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#keymap-button").click(); release.resolve();
  await expect(page.locator("#controls-title")).toHaveText("Keyboard shortcuts"); await expect(page.locator("#message-input")).toHaveValue("Newer draft"); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("account changes invalidate an open picker and discard the old account's late save and artwork", async ({ page }) => {
  const f = await setup(page, { selected: "codex", busy: true }), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await open(page); await page.getByRole("radio", { name: "Dewey", exact: true }).check();
  await page.route("**/api/pets", async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const result = { ...f.saved, selected: "dewey", revision: 1 }; entered.resolve(); await release.promise; return route.fulfill({ json: result });
  });
  await page.getByRole("button", { name: "Save pet", exact: true }).click(); await entered.promise;
  f.saved = { ...f.saved, scope: "second-owner", account: { id: "second-owner", username: "Second owner" }, selected: null };
  await page.evaluate(() => dispatchEvent(new Event("focus"))); await expect(page.locator("#chat-pet")).toBeHidden(); await expect(page.locator("#controls-content [role=status]")).toContainText("account changed"); await expect(page.getByRole("button", { name: "Save pet", exact: true })).toBeDisabled();
  release.resolve(); await expect(page.locator("#toasts")).toContainText("original panel"); await expect(page.locator("#chat-pet")).toBeHidden(); await close(page); await open(page); await expect(page.locator("#controls-content")).toContainText("Second owner"); await expect(page.getByRole("radio", { name: "Off", exact: true })).toBeChecked();
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("mobile picker fits, stays keyboard accessible and does not overlap the composer", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page, { selected: "codex" }); await open(page);
  await page.getByRole("radio", { name: "Dewey", exact: true }).check(); await expect(page.locator(".pet-preview")).toHaveAttribute("data-art", "ready");
  await page.screenshot({ path: "test-results/pets-mobile.png" });
  expect(await page.locator("#controls-dialog").evaluate(dialog => dialog.getBoundingClientRect().width <= innerWidth && dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  expect(await page.getByRole("radio", { name: "Dewey", exact: true }).locator("..").locator("span").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Save pet", exact: true }).focus(); await page.keyboard.press("Enter"); await expect(page.locator("#controls-content [role=status]")).toContainText("saved and active"); await page.keyboard.press("Escape"); await expect(page.locator("#controls-dialog")).not.toBeVisible();
  const bounds = await page.evaluate(() => ({ pet: document.querySelector("#chat-pet").getBoundingClientRect().bottom, composer: document.querySelector("#composer").getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth }));
  expect(bounds.pet).toBeLessThan(bounds.composer); expect(bounds.overflow).toBe(false); expect(f.calls.errors).toEqual([]); expect(f.calls.actions).toEqual([]);
});

test("a late acknowledgement cannot roll back a newer selection loaded on focus in the same panel", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await open(page); await page.getByRole("radio", { name: "Dewey", exact: true }).check();
  await page.route("**/api/pets", async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const result = { ...f.saved, selected: "dewey", revision: 1 }; entered.resolve(); await release.promise; return route.fulfill({ json: result });
  });
  await page.getByRole("button", { name: "Save pet", exact: true }).click(); await entered.promise;
  f.saved = { ...f.saved, selected: "fireball", revision: 2 }; await page.evaluate(() => dispatchEvent(new Event("focus"))); await expect(page.locator("#chat-pet")).toContainText("Fireball");
  release.resolve(); await expect(page.locator("#controls-content [role=status]")).toContainText("latest saved selection"); await expect(page.getByRole("radio", { name: "Fireball", exact: true })).toBeChecked(); await expect(page.locator("#chat-pet")).toContainText("Fireball"); expect(f.calls.errors).toEqual([]);
});

test("slow pet preferences do not hold chat startup, typing or file attachments", async ({ page }) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route("**/api/pets", async route => { entered.resolve(); await release.promise; return route.fulfill({ json: { scope: "shared", revision: 0, selected: null, pets: BUILTIN_PETS.map(pet => builtinPet(pet.id)), account: null } }); });
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Slow pet fixture" } })).json(); created.set(page, [chat.id]);
  try {
    await page.goto(`/#chat=${chat.id}`); await entered.promise; await expect(page.locator("#chat-title")).toHaveText(chat.title); await page.locator("#message-input").fill("Keep working");
    await page.locator("#attachment-input").setInputFiles({ name: "slow-pet.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") }); await expect(page.locator("#attachment-chips")).toContainText("slow-pet.txt");
  } finally { release.resolve(); }
  await expect(page.locator("#message-input")).toHaveValue("Keep working"); await expect(page.locator("#chat-pet")).toBeHidden();
});

test("closing a picker disposes its animation and a late decoded bitmap without showing a stale image", async ({ page }) => {
  const f = await setup(page);
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    window.petDecodeEntered = false; window.petBitmapClosed = 0;
    window.createImageBitmap = async (...args) => { const bitmap = await decode(...args), close = bitmap.close.bind(bitmap); bitmap.close = () => { window.petBitmapClosed++; close(); }; window.petDecodeEntered = true; await new Promise(resolve => { window.releasePetDecode = resolve; }); return bitmap; };
  });
  await open(page); await page.getByRole("radio", { name: "Codex", exact: true }).check(); await expect.poll(() => page.evaluate(() => window.petDecodeEntered)).toBe(true);
  await close(page); await page.evaluate(() => window.releasePetDecode()); await expect.poll(() => page.evaluate(() => window.petBitmapClosed)).toBe(1);
  await expect(page.locator("#chat-pet")).toBeHidden(); await expect(page.locator(".pet-preview")).toHaveAttribute("data-art", "off"); await expect(page.locator(".pet-preview")).toHaveAttribute("data-animating", "false");
  expect(f.calls.errors).toEqual([]); expect(f.calls.actions).toEqual([]);
});
