import { test, expect } from "@playwright/test";

const chats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of chats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Plugin picker ${Date.now()}` } })).json();
  chats.set(page, [...chats.get(page) || [], chat.id]);
  const snapshot = { ...chat, revision: 999999, status: "idle", agentSessionId: "native-plugin-fixture", messages: [] };
  const sent = [], changes = [], calls = [];
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.fallback());
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const catalog = { threadId: snapshot.agentSessionId, revision: "catalog-1", mutable: true, busy: false, truncated: false, warning: "", plugins: [
    { id: "fixture@market", name: "Fixture", marketplace: "market", description: "Plugin fixture details", version: "1.0.0", source: "local", capabilities: ["skills"], installed: false, enabled: false, actions: ["install"], reason: "" },
    { id: "managed@company", name: "Managed", marketplace: "company", description: "Managed native plugin", version: "1.0.0", source: "git", capabilities: ["tools"], installed: true, enabled: true, actions: [], reason: "Managed by native workspace policy" },
  ] };
  await page.route(`**/api/chats/${chat.id}/plugins`, route => { calls.push("list"); return route.fulfill({ json: catalog }); });
  await page.route(`**/api/chats/${chat.id}/plugins/change`, route => {
    const input = route.request().postDataJSON(); changes.push(input);
    const plugin = catalog.plugins[0];
    plugin.installed = input.action !== "remove"; plugin.enabled = ["install", "enable"].includes(input.action);
    plugin.actions = plugin.installed ? [plugin.enabled ? "disable" : "enable", "remove"] : ["install"];
    catalog.revision = `catalog-${changes.length + 1}`;
    return route.fulfill({ json: catalog });
  });
  for (const tail of ["queue", "messages"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { sent.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { chat: snapshot } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, catalog, changes, sent, calls };
}
async function open(page) {
  await page.getByLabel("Message", { exact: true }).fill("/plugins");
  await page.locator("#send-button").click();
  await expect(page.locator("#controls-title")).toHaveText("Codex plugins");
  await expect(page.getByRole("button", { name: "Details for Fixture", exact: true })).toBeVisible();
}

test("plugin picker uses marketplace tabs, confirms native actions and preserves draft without sending", async ({ page }) => {
  const { catalog, changes, sent } = await setup(page); await open(page);
  await expect(page.locator("#controls-content")).toContainText("private native profile");
  await page.getByRole("tab", { name: "All marketplaces", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "market", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".native-plugin-card")).toHaveCount(1);
  await page.getByRole("tab", { name: "company", exact: true }).click();
  await page.getByRole("button", { name: "Details for Managed", exact: true }).click();
  await expect(page.locator(".native-plugin-detail")).toContainText("Managed by native workspace policy");
  await expect(page.locator(".native-plugin-actions button")).toHaveCount(0);
  await page.getByRole("tab", { name: "All marketplaces", exact: true }).click();
  await page.getByLabel("Find a native plugin").fill("fixture"); await expect(page.locator(".native-plugin-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Details for Fixture", exact: true }).click();
  await page.locator("#message-input").evaluate(input => { input.value = "Keep my draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.getByRole("button", { name: "Install Fixture", exact: true }).click();
  expect(changes).toEqual([]); await page.getByRole("button", { name: "Cancel plugin change", exact: true }).click(); expect(changes).toEqual([]);
  await page.getByRole("button", { name: "Install Fixture", exact: true }).click();
  await page.screenshot({ path: "test-results/native-plugins-picker.png" });
  await page.getByRole("button", { name: "Confirm install Fixture", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable Fixture", exact: true })).toBeEnabled();
  expect(changes[0]).toEqual({ id: "fixture@market", action: "install", confirm: true, threadId: "native-plugin-fixture", revision: "catalog-1" });
  for (const action of ["disable", "enable", "remove"]) {
    await page.getByRole("button", { name: `${action[0].toUpperCase() + action.slice(1)} Fixture`, exact: true }).click();
    await page.getByRole("button", { name: `Confirm ${action} Fixture`, exact: true }).click();
    await expect(page.locator("#controls-content [role=status]")).toHaveText("Plugin state and installed skills refreshed.");
  }
  expect(changes.map(item => item.action)).toEqual(["install", "disable", "enable", "remove"]);
  expect(catalog.plugins[0].installed).toBe(false); expect(sent).toEqual([]);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep my draft");
});

test("plugin picker fits mobile, keeps shared host profiles read-only and requires refresh after a stale action", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { chat, catalog, sent, changes } = await setup(page);
  catalog.mutable = false; catalog.plugins[0].actions = []; catalog.plugins[0].reason = "Shared host profile — inspection only";
  await open(page); await page.getByRole("button", { name: "Details for Fixture", exact: true }).click();
  await expect(page.locator("#controls-content")).toContainText("Shared host profile: inspection only");
  await expect(page.locator(".native-plugin-actions button")).toHaveCount(0);
  const geometry = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth,
    overflow: [...document.querySelectorAll("body *")].filter(node => { const rect = node.getBoundingClientRect(); return rect.width && rect.right > innerWidth; }).slice(0, 20).map(node => ({ tag: node.tagName, id: node.id, class: node.className, width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right })) }));
  expect(geometry.width, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewport);
  const header = await page.locator(".topbar").boundingBox(), actions = await page.locator("#chat-actions").boundingBox();
  expect(actions.y + actions.height).toBeLessThanOrEqual(header.y + header.height);
  await page.screenshot({ path: "test-results/native-plugins-mobile.png" });
  catalog.mutable = true; catalog.plugins[0].actions = ["install"]; catalog.plugins[0].reason = ""; catalog.busy = true;
  await page.getByRole("button", { name: "Refresh plugins", exact: true }).click();
  await expect(page.getByRole("button", { name: "Install Fixture", exact: true })).toBeDisabled();
  catalog.busy = false; await page.getByRole("button", { name: "Refresh plugins", exact: true }).click();
  await expect(page.getByRole("button", { name: "Install Fixture", exact: true })).toBeEnabled();
  await page.route(`**/api/chats/${chat.id}/plugins/change`, route => route.fulfill({ status: 409, json: { error: "The plugin catalog changed; refresh and confirm again" } }));
  await page.getByRole("button", { name: "Install Fixture", exact: true }).click();
  await page.getByRole("button", { name: "Confirm install Fixture", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("catalog changed");
  await expect(page.getByRole("button", { name: "Install Fixture", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh plugins", exact: true }).click();
  await expect(page.getByRole("button", { name: "Install Fixture", exact: true })).toBeEnabled(); expect(sent).toEqual([]); expect(changes).toEqual([]);
});

test("a delayed plugin mutation cannot replace a new dialog or another chat draft", async ({ page }) => {
  const { chat, catalog, sent } = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route(`**/api/chats/${chat.id}/plugins/change`, async route => { entered.resolve(); await release.promise; await route.fulfill({ json: catalog }); });
  await open(page); await page.getByRole("button", { name: "Details for Fixture", exact: true }).click();
  await page.getByRole("button", { name: "Install Fixture", exact: true }).click();
  await page.getByRole("button", { name: "Confirm install Fixture", exact: true }).click(); await entered.promise;
  await expect(page.getByRole("button", { name: "Confirm install Fixture", exact: true })).toBeDisabled();
  await page.locator("#controls-dialog").press("Escape");
  const { chat: other } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: "Other plugin chat" } })).json();
  chats.set(page, [...chats.get(page), other.id]);
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText(other.title);
  await page.getByLabel("Message", { exact: true }).fill("Other chat draft");
  const response = page.waitForResponse(result => result.url().endsWith(`/api/chats/${chat.id}/plugins/change`)); release.resolve(); await response;
  await expect(page.locator("#controls-dialog")).not.toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Other chat draft"); expect(sent).toEqual([]);
});
