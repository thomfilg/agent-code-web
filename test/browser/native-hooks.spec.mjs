import { test, expect } from "@playwright/test";

const chats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of chats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Hook browser ${Date.now()}` } })).json();
  chats.set(page, [...chats.get(page) || [], chat.id]);
  const snapshot = { ...chat, revision: 999999, status: "idle", agentSessionId: "native-hook-fixture", messages: [] };
  const sent = [], changes = [];
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.fallback());
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const hook = { id: "a".repeat(64), event: "userPromptSubmit", type: "command", source: "project", managed: false, enabled: false, trust: "untrusted", actions: ["trust"], currentHash: `sha256:${"b".repeat(64)}`, sourcePath: "/fixture/project/.codex/hooks.json", pluginId: "", command: 'node check.mjs --text "<script>never_execute()</script>"', matcher: "", statusMessage: "Check project", async: false, timeoutSec: 60, additionalContextLimit: null, complete: true, reason: "" };
  const catalog = { threadId: snapshot.agentSessionId, revision: "catalog-1", mutable: true, busy: false, truncated: false, warning: "", hooks: [hook,
    { ...hook, id: "c".repeat(64), event: "preToolUse", type: "mcpTool", source: "user", statusMessage: "Audit tools", command: "", server: "fixture-audit", tool: "record", enabled: true, trust: "trusted", actions: ["disable"] },
    { ...hook, id: "d".repeat(64), event: "sessionStart", source: "system", statusMessage: "Managed hook", command: "node managed.mjs", managed: true, enabled: true, trust: "managed", actions: [], reason: "Managed by native policy; user controls cannot change it" },
  ] };
  await page.route(`**/api/chats/${chat.id}/hooks`, route => route.fulfill({ json: catalog }));
  await page.route(`**/api/chats/${chat.id}/hooks/change`, route => {
    const input = route.request().postDataJSON(); changes.push(input);
    const selected = catalog.hooks.find(item => item.id === input.id);
    if (input.action === "trust") selected.trust = "trusted"; else selected.enabled = input.action === "enable";
    selected.actions = [selected.enabled ? "disable" : "enable"]; catalog.revision = `catalog-${changes.length + 1}`;
    return route.fulfill({ json: catalog });
  });
  for (const tail of ["queue", "messages"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { sent.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { chat: snapshot } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, catalog, changes, sent };
}
async function open(page) {
  await page.getByLabel("Message", { exact: true }).fill("/hooks"); await page.locator("#send-button").click();
  await expect(page.locator("#controls-title")).toHaveText("Codex hooks");
  await expect(page.getByRole("button", { name: "Details for Check project", exact: true })).toBeVisible();
}

test("native hooks filter by event, show literal definitions, require source review and preserve draft attachments", async ({ page }) => {
  const { catalog, changes, sent } = await setup(page);
  await page.locator("#attachment-input").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Preserve me") });
  await expect(page.locator("#attachment-chips")).toContainText("draft.txt"); await open(page);
  await page.getByLabel("Hook event", { exact: true }).selectOption("sessionStart"); await expect(page.locator(".native-hook-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Details for Managed hook", exact: true }).click();
  await expect(page.locator(".native-hook-detail")).toContainText("Managed by native policy"); await expect(page.locator(".native-hook-actions button")).toHaveCount(0);
  await page.getByLabel("Hook event", { exact: true }).selectOption("preToolUse");
  await page.getByRole("button", { name: "Details for Audit tools", exact: true }).click();
  await expect(page.locator(".native-hook-command")).toHaveText("fixture-audit / record");
  await expect(page.locator(".native-hook-detail")).toContainText("MCP input templates are not included");
  await page.getByLabel("Hook event", { exact: true }).selectOption("");
  await page.getByLabel("Find a native hook", { exact: true }).fill("check.mjs"); await expect(page.locator(".native-hook-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Details for Check project", exact: true }).click();
  await expect(page.locator(".native-hook-command")).toHaveText(catalog.hooks[0].command); await expect(page.locator(".native-hook-detail script")).toHaveCount(0);
  await page.locator("#message-input").evaluate(input => { input.value = "Keep this draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.getByRole("button", { name: "Trust hook", exact: true }).click();
  const confirm = page.getByRole("button", { name: "Confirm trust hook", exact: true }); await expect(confirm).toBeDisabled(); expect(changes).toEqual([]);
  await page.getByRole("button", { name: "Cancel hook change", exact: true }).click(); expect(changes).toEqual([]);
  await page.getByRole("button", { name: "Trust hook", exact: true }).click();
  await page.getByRole("checkbox", { name: /I reviewed this hook/ }).check(); await expect(confirm).toBeEnabled();
  await page.screenshot({ path: "test-results/native-hooks-browser.png" }); await confirm.click();
  await expect(page.getByRole("button", { name: "Enable hook", exact: true })).toBeEnabled(); expect(catalog.hooks[0].enabled).toBe(false);
  expect(changes[0]).toEqual({ id: "a".repeat(64), action: "trust", confirm: true, threadId: "native-hook-fixture", revision: "catalog-1" });
  for (const action of ["enable", "disable"]) {
    await page.getByRole("button", { name: `${action[0].toUpperCase() + action.slice(1)} hook`, exact: true }).click();
    await page.getByRole("button", { name: `Confirm ${action} hook`, exact: true }).click();
    await expect(page.locator("#controls-content [role=status]")).toHaveText("Native hook state verified and refreshed.");
  }
  expect(changes.map(item => item.action)).toEqual(["trust", "enable", "disable"]); expect(sent).toEqual([]);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this draft"); await expect(page.locator("#attachment-chips")).toContainText("draft.txt");
});

test("hook browser is responsive, keeps shared definitions hidden and requires refresh after stale changes", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { chat, catalog, sent, changes } = await setup(page);
  catalog.mutable = false; for (const hook of catalog.hooks) hook.actions = [];
  await open(page); await page.getByRole("button", { name: "Details for Check project", exact: true }).click();
  await expect(page.locator("#controls-content")).toContainText("Shared host profile: inspection only");
  await expect(page.locator(".native-hook-command")).toHaveCount(0); await expect(page.locator(".native-hook-actions button")).toHaveCount(0);
  await expect(page.locator("#controls-content")).not.toContainText("/fixture/project");
  catalog.mutable = true; catalog.busy = true; catalog.hooks[0].actions = ["trust"];
  await page.getByRole("button", { name: "Refresh hooks", exact: true }).click(); await expect(page.getByRole("button", { name: "Trust hook", exact: true })).toBeDisabled();
  catalog.busy = false; await page.getByRole("button", { name: "Refresh hooks", exact: true }).click(); await expect(page.getByRole("button", { name: "Trust hook", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Trust hook", exact: true }).click();
  await page.getByRole("checkbox", { name: /I reviewed this hook/ }).check();
  await page.getByRole("button", { name: "Confirm trust hook", exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const command = await page.locator(".native-hook-command").boundingBox(); expect(command.x + command.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: "test-results/native-hooks-mobile.png" });
  await page.route(`**/api/chats/${chat.id}/hooks/change`, route => route.fulfill({ status: 409, json: { error: "The hook definition changed; review it again" } }));
  await page.getByRole("button", { name: "Confirm trust hook", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("definition changed"); await expect(page.getByRole("button", { name: "Trust hook", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh hooks", exact: true }).click(); await expect(page.getByRole("button", { name: "Trust hook", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Trust hook", exact: true }).click(); await expect(page.getByRole("button", { name: "Confirm trust hook", exact: true })).toBeDisabled();
  catalog.hooks = []; await page.getByRole("button", { name: "Refresh hooks", exact: true }).click();
  await expect(page.locator(".native-hook-list")).toHaveText("No lifecycle hooks configured for this workspace.");
  await page.route(`**/api/chats/${chat.id}/hooks`, route => route.fulfill({ status: 503, json: { error: "Native hook connection is unavailable" } }));
  await page.getByRole("button", { name: "Refresh hooks", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("connection is unavailable");
  expect(sent).toEqual([]); expect(changes).toEqual([]);
});

test("a delayed hook change cannot overwrite another chat or its draft", async ({ page }) => {
  const { chat, catalog, sent } = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers();
  catalog.hooks[0].trust = "trusted"; catalog.hooks[0].actions = ["enable"];
  await page.route(`**/api/chats/${chat.id}/hooks/change`, async route => { entered.resolve(); await release.promise; await route.fulfill({ json: catalog }); });
  await open(page); await page.getByRole("button", { name: "Details for Check project", exact: true }).click();
  await page.getByRole("button", { name: "Enable hook", exact: true }).click(); await page.getByRole("button", { name: "Confirm enable hook", exact: true }).click(); await entered.promise;
  await expect(page.getByRole("button", { name: "Confirm enable hook", exact: true })).toBeDisabled(); await page.locator("#controls-dialog").press("Escape");
  const { chat: other } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: "Other hook chat" } })).json(); chats.set(page, [...chats.get(page), other.id]);
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText(other.title);
  await page.getByLabel("Message", { exact: true }).fill("Other draft");
  const response = page.waitForResponse(result => result.url().endsWith(`/api/chats/${chat.id}/hooks/change`)); release.resolve(); await response;
  await expect(page.locator("#controls-dialog")).not.toBeVisible(); await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Other draft"); expect(sent).toEqual([]);
});
