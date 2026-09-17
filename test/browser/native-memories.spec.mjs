import { test, expect } from "@playwright/test";

const chats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of chats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Memory controls ${Date.now()}` } })).json();
  chats.set(page, [...chats.get(page) || [], chat.id]);
  const snapshot = { ...chat, revision: 999999, status: "idle", agentSessionId: "native-memory-fixture", messages: [] };
  const sent = [], changes = [], stops = [];
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.fallback());
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const catalog = { threadId: snapshot.agentSessionId, revision: "memory-1", mutable: true, busy: false, nextSessionRequired: false, currentThreadGeneration: null, resetAllowed: true, externalContextExcluded: true, warning: "",
    controls: [
      { id: "feature", name: "Local memories", enabled: true, defaultEnabled: false, locked: false, actions: ["disable"], reason: "" },
      { id: "use", name: "Use memories", enabled: true, defaultEnabled: true, locked: false, actions: ["disable"], reason: "" },
      { id: "generate", name: "Generate memories", enabled: true, defaultEnabled: true, locked: false, actions: ["disable"], reason: "" },
    ] };
  await page.route(`**/api/chats/${chat.id}/memories`, route => route.fulfill({ json: catalog }));
  await page.route(`**/api/chats/${chat.id}/memories/change`, route => {
    const input = route.request().postDataJSON(); changes.push(input);
    if (input.id !== "reset") {
      const item = catalog.controls.find(item => item.id === input.id); item.enabled = input.action === "enable"; item.actions = [item.enabled ? "disable" : "enable"];
      if (input.id === "generate") catalog.currentThreadGeneration = item.enabled; else catalog.nextSessionRequired = true;
    }
    catalog.revision = `memory-${changes.length + 1}`; return route.fulfill({ json: { ...catalog, reset: input.id === "reset" } });
  });
  for (const tail of ["queue", "messages"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { sent.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { chat: snapshot } }); });
  await page.route(`**/api/chats/${chat.id}/stop`, route => { stops.push(route.request().method()); return route.fulfill({ json: { chat: snapshot } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, catalog, changes, sent, stops };
}
async function open(page) {
  await page.getByLabel("Message", { exact: true }).fill("/memories"); await page.locator("#send-button").click();
  await expect(page.locator("#controls-title")).toHaveText("Codex memories"); await expect(page.locator("[data-memory-id=use]")).toBeVisible();
}

test("native memory choices and destructive reset require confirmation and retain draft text and files", async ({ page }) => {
  const { changes, sent, stops } = await setup(page);
  await page.locator("#attachment-input").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this file") });
  await expect(page.locator("#attachment-chips")).toContainText("draft.txt"); await open(page);
  await expect(page.locator("#controls-content")).toContainText("does not monitor your browser activity");
  await expect(page.locator("#controls-content")).toContainText("exclude chats that use external context");
  await page.locator("#message-input").evaluate(input => { input.value = "Keep my draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.getByRole("button", { name: "Disable Generate memories", exact: true }).click(); expect(changes).toEqual([]);
  await page.getByRole("button", { name: "Cancel memory change", exact: true }).click(); expect(changes).toEqual([]);
  await expect(page.getByRole("button", { name: "Disable Generate memories", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Disable Generate memories", exact: true }).click(); await page.getByRole("button", { name: "Confirm disable Generate memories", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable Generate memories", exact: true })).toBeEnabled();
  await expect(page.locator("#controls-content")).toContainText("Current chat contribution was disabled");
  expect(changes[0]).toEqual({ id: "generate", action: "disable", confirm: true, threadId: "native-memory-fixture", revision: "memory-1" });
  await page.getByRole("button", { name: "Disable Use memories", exact: true }).click(); await page.getByRole("button", { name: "Confirm disable Use memories", exact: true }).click();
  await expect(page.locator("#controls-content")).toContainText("No restart was performed automatically");
  await page.getByRole("button", { name: "Reset saved memories", exact: true }).click(); await expect(page.locator(".native-memory-confirm")).toContainText("This cannot be undone");
  await expect(page.locator(".native-memory-confirm")).toContainText("Chat messages and settings are kept"); expect(changes).toHaveLength(2);
  await page.getByRole("button", { name: "Cancel memory change", exact: true }).click(); expect(changes).toHaveLength(2);
  await page.getByRole("button", { name: "Reset saved memories", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm reset saved memories", exact: true })).toHaveCSS("color", "rgb(245, 139, 131)");
  await page.screenshot({ path: "test-results/native-memories-reset.png" });
  await page.getByRole("button", { name: "Confirm reset saved memories", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("Chat messages and settings were retained"); expect(changes.at(-1).id).toBe("reset");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep my draft"); await expect(page.locator("#attachment-chips")).toContainText("draft.txt"); expect(sent).toEqual([]); expect(stops).toEqual([]);
});

test("mobile memory controls explain disabled features, protect shared profiles and recover stale failures", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const { chat, catalog, changes, sent, stops } = await setup(page);
  catalog.mutable = false; catalog.resetAllowed = false;
  for (const item of catalog.controls) { item.actions = []; item.reason = "Shared host profile — inspection only"; }
  await open(page); await expect(page.locator("#controls-content")).toContainText("Shared host profile: inspection only"); await expect(page.locator(".native-memory-card button")).toHaveCount(0);
  catalog.mutable = true; catalog.busy = true; catalog.controls[1].actions = ["disable"]; catalog.controls[1].reason = "";
  catalog.controls[0].enabled = false; catalog.controls[0].reason = "Controlled by native policy";
  await page.getByRole("button", { name: "Refresh memory settings", exact: true }).click(); await expect(page.getByRole("button", { name: "Disable Use memories", exact: true })).toBeDisabled();
  await expect(page.locator("[data-memory-id=use]")).toContainText("Inactive while Local memories is off");
  catalog.busy = false; await page.getByRole("button", { name: "Refresh memory settings", exact: true }).click(); await page.getByRole("button", { name: "Disable Use memories", exact: true }).click();
  await page.getByRole("button", { name: "Confirm disable Use memories", exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const card = await page.locator("[data-memory-id=use]").boundingBox(); expect(card.x + card.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: "test-results/native-memories-mobile.png" });
  await page.route(`**/api/chats/${chat.id}/memories/change`, route => route.fulfill({ status: 409, json: { error: "Native memory configuration changed" } }));
  await page.getByRole("button", { name: "Confirm disable Use memories", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("configuration changed");
  await expect(page.getByRole("button", { name: "Disable Use memories", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh memory settings", exact: true }).click(); await expect(page.getByRole("button", { name: "Disable Use memories", exact: true })).toBeEnabled();
  await page.route(`**/api/chats/${chat.id}/memories`, route => route.fulfill({ status: 503, json: { error: "Native memory discovery unavailable" } }));
  await page.getByRole("button", { name: "Refresh memory settings", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("discovery unavailable");
  expect(changes).toEqual([]); expect(sent).toEqual([]); expect(stops).toEqual([]);
});

test("late memory loads preserve a retyped command and late changes cannot replace another chat's draft", async ({ page }) => {
  const { chat, catalog, sent } = await setup(page), loaded = Promise.withResolvers(), loadRelease = Promise.withResolvers();
  await page.route(`**/api/chats/${chat.id}/memories`, async route => { loaded.resolve(); await loadRelease.promise; await route.fulfill({ json: catalog }); });
  await page.getByLabel("Message", { exact: true }).fill("/memories"); await page.locator("#send-button").click(); await loaded.promise;
  await page.locator("#controls-dialog").press("Escape"); await page.getByLabel("Message", { exact: true }).fill("/memories");
  const loadResponse = page.waitForResponse(response => response.url().endsWith(`/api/chats/${chat.id}/memories`)); loadRelease.resolve(); await loadResponse;
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("/memories");
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route(`**/api/chats/${chat.id}/memories/change`, async route => { entered.resolve(); await release.promise; await route.fulfill({ json: catalog }); });
  await open(page); await page.getByRole("button", { name: "Disable Generate memories", exact: true }).click(); await page.getByRole("button", { name: "Confirm disable Generate memories", exact: true }).click(); await entered.promise;
  await expect(page.getByRole("button", { name: "Confirm disable Generate memories", exact: true })).toBeDisabled(); await page.locator("#controls-dialog").press("Escape");
  const { chat: other } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: "Other memory chat" } })).json(); chats.set(page, [...chats.get(page), other.id]);
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText(other.title); await page.getByLabel("Message", { exact: true }).fill("Another chat draft");
  const response = page.waitForResponse(result => result.url().endsWith(`/api/chats/${chat.id}/memories/change`)); release.resolve(); await response;
  await expect(page.locator("#controls-dialog")).not.toBeVisible(); await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Another chat draft"); expect(sent).toEqual([]);
});
