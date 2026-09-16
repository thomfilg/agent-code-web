import { test, expect } from "@playwright/test";

const chats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of chats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Feature picker ${Date.now()}` } })).json();
  chats.set(page, [...chats.get(page) || [], chat.id]);
  const snapshot = { ...chat, revision: 999999, status: "idle", agentSessionId: "native-feature-fixture", messages: [] };
  const sent = [], changes = [], stops = [];
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.fallback());
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const catalog = { threadId: snapshot.agentSessionId, revision: "catalog-1", mutable: true, busy: false, restartRequired: false, truncated: false, warning: "", features: [
    { id: "network_proxy", name: "Network proxy", description: "Apply restrictions to sandbox network access.", announcement: "Restart Codex after enabling it.", enabled: false, defaultEnabled: false, source: "default", locked: false, actions: ["enable"], reason: "" },
    { id: "prevent_idle_sleep", name: "Prevent sleep while running", description: "Keep the worker computer awake.", announcement: "", enabled: false, defaultEnabled: false, source: "mdm", locked: true, actions: [], reason: "Controlled by native policy, a project override or session configuration" },
  ] };
  await page.route(`**/api/chats/${chat.id}/experimental`, route => route.fulfill({ json: catalog }));
  await page.route(`**/api/chats/${chat.id}/experimental/change`, route => {
    const input = route.request().postDataJSON(); changes.push(input);
    const feature = catalog.features.find(item => item.id === input.id); feature.enabled = input.action === "enable"; feature.actions = [feature.enabled ? "disable" : "enable"];
    catalog.revision = `catalog-${changes.length + 1}`; catalog.restartRequired = true; return route.fulfill({ json: catalog });
  });
  for (const tail of ["queue", "messages"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { sent.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { chat: snapshot } }); });
  await page.route(`**/api/chats/${chat.id}/stop`, route => { stops.push(route.request().method()); return route.fulfill({ json: { chat: snapshot } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, catalog, changes, sent, stops };
}
async function open(page) {
  await page.getByLabel("Message", { exact: true }).fill("/experimental"); await page.locator("#send-button").click();
  await expect(page.locator("#controls-title")).toHaveText("Codex experimental features");
  await expect(page.locator(".native-feature-card")).toHaveCount(2);
}

test("native experimental picker confirms changes, explains restart and preserves draft text and files", async ({ page }) => {
  const { changes, sent, stops } = await setup(page);
  await page.locator("#attachment-input").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this attachment") });
  await expect(page.locator("#attachment-chips")).toContainText("draft.txt"); await open(page);
  const managed = page.locator(".native-feature-card").filter({ has: page.getByRole("heading", { name: "Prevent sleep while running", exact: true }) });
  await expect(managed).toContainText("Controlled by native policy"); await expect(managed.locator("button")).toHaveCount(0);
  await expect(page.locator("#controls-content")).toContainText("not Relay’s idle-container timer");
  await page.getByLabel("Find an experimental feature", { exact: true }).fill("network"); await expect(page.locator(".native-feature-card")).toHaveCount(1);
  await expect(page.locator("#controls-content")).toContainText("does not grant sandbox network access");
  await page.locator("#message-input").evaluate(input => { input.value = "Keep the draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.getByRole("button", { name: "Enable Network proxy", exact: true }).click(); expect(changes).toEqual([]);
  await page.getByRole("button", { name: "Cancel feature change", exact: true }).click(); expect(changes).toEqual([]);
  await expect(page.getByRole("button", { name: "Enable Network proxy", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Enable Network proxy", exact: true }).click();
  await page.screenshot({ path: "test-results/native-features-picker.png" });
  await page.getByRole("button", { name: "Confirm enable Network proxy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable Network proxy", exact: true })).toBeEnabled();
  await expect(page.locator("#controls-content")).toContainText("No restart was performed automatically");
  expect(changes[0]).toEqual({ id: "network_proxy", action: "enable", confirm: true, threadId: "native-feature-fixture", revision: "catalog-1" });
  await page.getByRole("button", { name: "Disable Network proxy", exact: true }).click(); await page.getByRole("button", { name: "Confirm disable Network proxy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable Network proxy", exact: true })).toBeEnabled(); expect(changes.map(input => input.action)).toEqual(["enable", "disable"]);
  expect(sent).toEqual([]); expect(stops).toEqual([]); await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep the draft"); await expect(page.locator("#attachment-chips")).toContainText("draft.txt");
});

test("native features fit mobile, protect shared profiles and require refresh after stale writes", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { chat, catalog, changes, sent, stops } = await setup(page);
  catalog.mutable = false; catalog.features[0].actions = []; catalog.features[0].reason = "Shared host profile — inspection only";
  await open(page); await expect(page.locator("#controls-content")).toContainText("Shared host profile: inspection only");
  await expect(page.locator(".native-feature-card button")).toHaveCount(0);
  catalog.mutable = true; catalog.busy = true; catalog.features[0].actions = ["enable"]; catalog.features[0].reason = "";
  await page.getByRole("button", { name: "Refresh features", exact: true }).click(); await expect(page.getByRole("button", { name: "Enable Network proxy", exact: true })).toBeDisabled();
  catalog.busy = false; await page.getByRole("button", { name: "Refresh features", exact: true }).click(); await expect(page.getByRole("button", { name: "Enable Network proxy", exact: true })).toBeEnabled();
  await page.getByLabel("Find an experimental feature", { exact: true }).fill("network");
  await page.getByRole("button", { name: "Enable Network proxy", exact: true }).click();
  await page.getByRole("button", { name: "Confirm enable Network proxy", exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const card = await page.locator(".native-feature-card").boundingBox(); expect(card.x + card.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: "test-results/native-features-mobile.png" });
  await page.route(`**/api/chats/${chat.id}/experimental/change`, route => route.fulfill({ status: 409, json: { error: "Native feature configuration changed" } }));
  await page.getByRole("button", { name: "Confirm enable Network proxy", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("configuration changed"); await expect(page.getByRole("button", { name: "Enable Network proxy", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh features", exact: true }).click(); await expect(page.getByRole("button", { name: "Enable Network proxy", exact: true })).toBeEnabled();
  catalog.features = []; await page.getByLabel("Find an experimental feature", { exact: true }).fill(""); await page.getByRole("button", { name: "Refresh features", exact: true }).click();
  await expect(page.locator(".native-feature-list")).toHaveText("This native Codex version reports no beta features.");
  await page.route(`**/api/chats/${chat.id}/experimental`, route => route.fulfill({ status: 503, json: { error: "Native feature discovery unavailable" } }));
  await page.getByRole("button", { name: "Refresh features", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("discovery unavailable");
  expect(changes).toEqual([]); expect(sent).toEqual([]); expect(stops).toEqual([]);
});

test("a delayed native feature response cannot overwrite another chat draft or dialog", async ({ page }) => {
  const { chat, catalog, sent } = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route(`**/api/chats/${chat.id}/experimental/change`, async route => { entered.resolve(); await release.promise; await route.fulfill({ json: catalog }); });
  await open(page); await page.getByRole("button", { name: "Enable Network proxy", exact: true }).click(); await page.getByRole("button", { name: "Confirm enable Network proxy", exact: true }).click(); await entered.promise;
  await expect(page.getByRole("button", { name: "Confirm enable Network proxy", exact: true })).toBeDisabled(); await page.locator("#controls-dialog").press("Escape");
  const { chat: other } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: "Other feature chat" } })).json(); chats.set(page, [...chats.get(page), other.id]);
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText(other.title);
  await page.getByLabel("Message", { exact: true }).fill("Another chat draft");
  const response = page.waitForResponse(result => result.url().endsWith(`/api/chats/${chat.id}/experimental/change`)); release.resolve(); await response;
  await expect(page.locator("#controls-dialog")).not.toBeVisible(); await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Another chat draft"); expect(sent).toEqual([]);
});
