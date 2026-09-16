import { test, expect } from "@playwright/test";

const chats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of chats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const created = [];
  for (const title of ["Import destination", "Imported conversation", "Other chat"]) {
    const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `${title} ${Date.now()}` } })).json(); created.push(chat);
    await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: { ...chat, revision: 999999, status: "idle", agentSessionId: `native-${chat.id}`, messages: [] } } }) : route.fallback());
    await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  }
  chats.set(page, created.map(chat => chat.id)); const [chat, imported, other] = created;
  const state = { threadId: `native-${chat.id}`, mutable: true, busy: false, changing: false, needsRefresh: false, operations: [] };
  const catalog = { source: "claude-code", revision: "review-1", items: [
    { id: "a".repeat(64), itemType: "AGENTS_MD", name: "Instructions", scope: "project", count: 1, entries: [], warning: "Adds project instructions." },
    { id: "b".repeat(64), itemType: "SKILLS", name: "Skills", scope: "profile", count: 2, entries: ["fixture-skill", "<img src=x onerror=alert(1)>"], warning: "Imports the whole detected skill group, including executable scripts." },
    { id: "c".repeat(64), itemType: "SESSIONS", name: "Original conversation", scope: "project", count: 1, entries: [], warning: "Copies only this selected conversation." },
  ], excludedSessions: 1, excludedGroups: 0 };
  const starts = [], opens = [], sent = [], acknowledgements = [], sources = [];
  await page.route(`**/api/chats/${chat.id}/imports/status`, route => route.fulfill({ json: state }));
  await page.route(`**/api/chats/${chat.id}/imports`, route => { sources.push(route.request().postDataJSON().source); return route.fulfill({ json: { ...catalog, source: sources.at(-1), ...state } }); });
  await page.route(`**/api/chats/${chat.id}/imports/start`, route => {
    const input = route.request().postDataJSON(); starts.push(input); state.changing = true; state.needsRefresh = true;
    state.operations = [{ id: input.requestId, source: input.source, phase: "running", reconciled: false, canAcknowledge: false, warning: "", results: [], sessions: [] }];
    return route.fulfill({ json: { ...state, operation: state.operations[0] } });
  });
  await page.route(`**/api/chats/${chat.id}/imports/refresh`, route => {
    if (state.operations[0]?.phase === "running") {
      state.changing = false; state.needsRefresh = false;
      Object.assign(state.operations[0], { phase: "completed", reconciled: true, results: [{ name: "Skills", imported: 1, failed: 1, notReported: 1 }], sessions: [{ id: "d".repeat(64), title: "Original conversation" }] });
    }
    return route.fulfill({ json: state });
  });
  await page.route(`**/api/chats/${chat.id}/imports/acknowledge`, route => { acknowledgements.push(route.request().postDataJSON()); state.needsRefresh = false; Object.assign(state.operations[0], { phase: "acknowledged", reconciled: true, canAcknowledge: false }); return route.fulfill({ json: state }); });
  await page.route(`**/api/chats/${chat.id}/imports/open`, route => { opens.push(route.request().postDataJSON()); return route.fulfill({ json: { threadId: state.threadId, chat: imported } }); });
  for (const tail of ["queue", "messages", "stop"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { sent.push(tail); return route.fulfill({ json: {} }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, imported, other, state, catalog, starts, opens, sent, acknowledgements, sources };
}
async function open(page) {
  await page.locator("#message-input").fill("/import"); await page.locator("#send-button").click();
  await expect(page.locator("#controls-title")).toHaveText("Import into Codex"); await expect(page.locator(".native-import-item")).toHaveCount(3);
}

test("import reviews whole groups, confirms selection, polls results and preserves the draft and its attachments", async ({ page }) => {
  const f = await setup(page);
  await page.locator("#attachment-input").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Keep draft attachment") });
  await expect(page.locator("#attachment-chips")).toContainText("draft.txt"); await open(page);
  await page.getByLabel("Skills", { exact: true }).check(); await page.getByLabel("Original conversation", { exact: true }).check();
  await page.getByText("Review all 2 entries", { exact: true }).click(); await expect(page.locator(".native-import-item img")).toHaveCount(0);
  await page.getByRole("button", { name: "Review 2 selection(s)", exact: true }).click(); await expect(page.locator(".native-import-confirm")).toContainText("every listed entry"); expect(f.starts).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click(); expect(f.starts).toEqual([]);
  await page.getByRole("button", { name: "Review 2 selection(s)", exact: true }).click();
  await page.locator("#message-input").evaluate(input => { input.value = "Do not overwrite this draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.screenshot({ path: "test-results/native-import-confirm.png" });
  await page.getByRole("button", { name: "Confirm import", exact: true }).click();
  await expect(page.locator(".native-import-result")).toContainText("Completed");
  await expect(page.locator(".native-import-result")).toContainText("1 imported · 1 failed · 1 not reported");
  expect(f.starts).toHaveLength(1); expect(f.starts[0].ids).toEqual(["b".repeat(64), "c".repeat(64)]); expect(f.starts[0].confirm).toBe(true); expect(f.starts[0].threadId).toBe(f.state.threadId);
  await page.getByRole("button", { name: "Open chat: Original conversation", exact: true }).click(); expect(f.opens).toEqual([]);
  await expect(page.locator(".native-import-confirm")).toContainText("personal accounts and profile-level settings are not copied");
  await page.getByRole("button", { name: "Open independent chat", exact: true }).click();
  await expect(page.locator("#controls-dialog")).not.toBeVisible(); await expect(page.locator("#chat-title")).toHaveText(f.chat.title);
  await expect(page.locator("#message-input")).toHaveValue("Do not overwrite this draft"); await expect(page.locator("#attachment-chips")).toContainText("draft.txt");
  expect(f.opens[0]).toEqual({ operationId: f.starts[0].requestId, sessionId: "d".repeat(64), threadId: f.state.threadId, confirm: true }); expect(f.sent).toEqual([]);
});

test("mobile import supports source choice, shared-profile locks, recovery errors and explicit incomplete acknowledgement", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page); f.state.mutable = false; await open(page);
  await expect(page.locator("#controls-content")).toContainText("Shared host profile"); await expect(page.getByLabel("Skills", { exact: true })).toBeDisabled();
  await page.getByLabel("Import source").selectOption("cursor"); await expect.poll(() => f.sources.at(-1)).toBe("cursor");
  f.state.mutable = true; f.state.needsRefresh = true; f.state.operations = [{ id: "uncertain-operation", source: "cursor", phase: "uncertain", reconciled: false, canAcknowledge: true, warning: "Files may already have changed.", results: [], sessions: [] }];
  await page.getByRole("button", { name: "Refresh import", exact: true }).click();
  await page.getByRole("button", { name: "Review incomplete outcome", exact: true }).click();
  await expect(page.locator(".native-import-confirm")).toContainText("does not repeat the import"); expect(f.acknowledgements).toEqual([]);
  await page.screenshot({ path: "test-results/native-import-mobile.png" });
  const overflow = await page.locator("#controls-dialog").evaluate(element => element.scrollWidth > element.clientWidth + 1); expect(overflow).toBe(false);
  await page.getByRole("button", { name: "Acknowledge incomplete import", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("No import was repeated"); expect(f.acknowledgements).toHaveLength(1);
  await page.route(`**/api/chats/${f.chat.id}/imports`, route => route.fulfill({ status: 409, json: { error: "Files changed. Refresh the review." } }));
  await page.getByRole("button", { name: "Refresh import", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("Files changed");
  await expect(page.getByRole("button", { name: "Review selection", exact: true })).toBeDisabled(); expect(f.starts).toEqual([]); expect(f.sent).toEqual([]);
});

test("late discovery cannot close a newer import panel or clear its draft", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  await page.route(`**/api/chats/${f.chat.id}/imports/status`, async route => { if (first) { first = false; entered.resolve(); await release.promise; } return route.fulfill({ json: f.state }); });
  await page.locator("#message-input").fill("/import"); await page.locator("#send-button").click(); await entered.promise;
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close()); await open(page);
  await page.locator("#message-input").evaluate(input => { input.value = "New draft"; }); release.resolve();
  await expect(page.locator("#controls-dialog")).toBeVisible(); await page.getByLabel("Instructions", { exact: true }).check();
  await expect(page.getByRole("button", { name: "Review 1 selection(s)", exact: true })).toBeEnabled(); await expect(page.locator("#message-input")).toHaveValue("New draft"); expect(f.sent).toEqual([]);
});

test("a delayed imported-chat opening never switches away from another active chat", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.state.operations = [{ id: "completed-operation", source: "claude-code", phase: "completed", reconciled: true, warning: "", results: [], sessions: [{ id: "d".repeat(64), title: "Original conversation" }] }];
  await page.route(`**/api/chats/${f.chat.id}/imports/open`, async route => { entered.resolve(); await release.promise; return route.fulfill({ json: { threadId: f.state.threadId, chat: f.imported } }); });
  await open(page); await page.getByRole("button", { name: "Open chat: Original conversation", exact: true }).click(); await page.getByRole("button", { name: "Open independent chat", exact: true }).click(); await entered.promise;
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close()); await page.getByRole("button", { name: `Open ${f.other.title}`, exact: true }).click(); await page.locator("#message-input").fill("Other chat draft"); release.resolve();
  await expect(page.locator("#toasts")).toContainText("Imported chat ready"); await expect(page.locator("#chat-title")).toHaveText(f.other.title); await expect(page.locator("#message-input")).toHaveValue("Other chat draft"); expect(f.sent).toEqual([]);
});

test("opening imported history with an empty draft selects its stopped chat without sending a message", async ({ page }) => {
  const f = await setup(page);
  f.state.operations = [{ id: "completed-operation", source: "claude-code", phase: "completed", reconciled: true, warning: "", results: [], sessions: [{ id: "d".repeat(64), title: "Original conversation" }] }];
  Object.assign(f.imported, { status: "stopped", revision: 999999, messages: [{ id: "original-user", role: "user", kind: "message", text: "Original imported question", createdAt: new Date().toISOString() }], importWarnings: ["Native importer retained unsupported image markers."] });
  await page.route(`**/api/chats/${f.imported.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: f.imported } }) : route.fallback());
  for (const tail of ["queue", "messages", "stop"]) await page.route(`**/api/chats/${f.imported.id}/${tail}`, route => { f.sent.push(tail); return route.fulfill({ json: {} }); });
  await open(page); await expect(page.locator("#message-input")).toHaveValue("");
  await page.getByRole("button", { name: "Open chat: Original conversation", exact: true }).click();
  await expect(page.locator(".native-import-confirm")).toContainText("unsupported source content");
  await page.getByRole("button", { name: "Open independent chat", exact: true }).click();
  await expect(page.locator("#controls-dialog")).not.toBeVisible(); await expect(page.locator("#chat-title")).toHaveText(f.imported.title);
  await expect(page.locator("#messages")).toContainText("Original imported question"); await expect(page.locator("#message-input")).toHaveValue("");
  await expect(page.locator("#toasts")).toContainText("unsupported image markers"); expect(f.sent).toEqual([]); expect(f.opens).toHaveLength(1);
});
