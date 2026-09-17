import { test, expect } from "@playwright/test";

const chats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of chats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Feedback review ${Date.now()}` } })).json(); chats.set(page, [chat.id]);
  const snapshot = { ...chat, revision: 999999, status: "running", agentSessionId: "native-feedback-fixture", messages: [] };
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.fallback());
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const reports = [], policy = { threadId: snapshot.agentSessionId, enabled: true, logsAllowed: true, logsReason: "", revision: "native-policy" }, calls = { prepare: [], send: [], policy: 0, input: [] };
  await page.route(`**/api/chats/${chat.id}/feedback`, route => route.fulfill({ json: { threadId: snapshot.agentSessionId, reports } }));
  await page.route(`**/api/chats/${chat.id}/feedback/policy`, route => { calls.policy++; return route.fulfill({ json: policy }); });
  await page.route(`**/api/chats/${chat.id}/feedback/prepare`, route => {
    const input = route.request().postDataJSON(); calls.prepare.push(input);
    const item = { id: `report-${calls.prepare.length}`, revision: `revision-${calls.prepare.length}`, threadId: snapshot.agentSessionId, ...input, state: "prepared", createdAt: Date.now(), expiresAt: Date.now() + 300000 };
    reports.unshift(item); return route.fulfill({ json: item });
  });
  await page.route(`**/api/chats/${chat.id}/feedback/send`, route => {
    const input = route.request().postDataJSON(); calls.send.push(input);
    const item = reports.find(item => item.id === input.id); Object.assign(item, { state: "sent", reference: snapshot.agentSessionId });
    return route.fulfill({ json: item });
  });
  for (const tail of ["messages", "queue", "stop"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { calls.input.push(tail); return route.fulfill({ json: { chat: snapshot } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, snapshot, reports, policy, calls };
}
async function open(page) {
  await page.locator("#message-input").fill("/feedback"); await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator("#controls-title")).toHaveText("Send feedback to OpenAI");
  await expect(page.locator("#controls-content [role=status]")).toContainText("Saved status refreshed");
}
async function review(page, reason = "Fixture report") {
  await page.getByRole("button", { name: "Check feedback options", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("Ready to review");
  await page.getByLabel("Your report", { exact: true }).fill(reason); await page.getByRole("button", { name: "Review report", exact: true }).click();
  await expect(page.locator(".native-feedback-confirm")).toBeVisible();
}

test("feedback stays private until confirmation, preserves drafts/files and renders report text literally", async ({ page }) => {
  const f = await setup(page);
  await page.locator("#attachment-input").setInputFiles({ name: "private.txt", mimeType: "text/plain", buffer: Buffer.from("Never include draft files") });
  await expect(page.locator("#attachment-chips")).toContainText("private.txt"); await open(page);
  expect(f.calls.policy).toBe(0); expect(f.calls.send).toEqual([]);
  await expect(page.getByLabel("Include native diagnostic logs and conversation history", { exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Review report", exact: true })).toBeDisabled();
  await review(page, "<img src=x onerror=alert(1)>\nLiteral report");
  await expect(page.locator(".native-feedback-confirm pre")).toContainText("<img src=x onerror=alert(1)>"); await expect(page.locator(".native-feedback-confirm img")).toHaveCount(0); expect(f.calls.send).toEqual([]);
  await page.getByRole("button", { name: "Back to editing", exact: true }).click(); await expect(page.getByLabel("Your report", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Review report", exact: true }).click();
  await page.locator("#message-input").evaluate(input => { input.value = "Keep this unrelated draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.screenshot({ path: "test-results/native-feedback-confirm.png" });
  await page.getByRole("button", { name: "Send feedback to OpenAI", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("Codex confirmed the upload");
  expect(f.calls.send).toEqual([{ id: "report-2", revision: "revision-2", threadId: f.snapshot.agentSessionId, confirm: true }]);
  expect(f.calls.prepare.every(item => item.includeLogs === false)).toBe(true);
  await expect(page.locator("#message-input")).toHaveValue("Keep this unrelated draft"); await expect(page.locator("#attachment-chips")).toContainText("private.txt"); expect(f.calls.input).toEqual([]);
  await expect(page.getByRole("button", { name: "Review report", exact: true })).toBeDisabled();
});

test("logs require opt-in, editing invalidates the review, and disabled/shared policies remain visible", async ({ page }) => {
  const f = await setup(page); await open(page); await review(page);
  await page.getByLabel("Include native diagnostic logs and conversation history", { exact: true }).check();
  await expect(page.locator(".native-feedback-confirm")).toBeHidden(); await page.getByRole("button", { name: "Review report", exact: true }).click();
  await expect(page.locator(".native-feedback-confirm")).toContainText("Native diagnostics and history included"); expect(f.calls.prepare.at(-1).includeLogs).toBe(true); expect(f.calls.send).toEqual([]);
  f.policy.logsAllowed = false; f.policy.logsReason = "Diagnostic logs are unavailable for shared host profiles.";
  await page.getByRole("button", { name: "Check feedback options", exact: true }).click();
  await expect(page.getByLabel("Include native diagnostic logs and conversation history", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Include native diagnostic logs and conversation history", { exact: true })).not.toBeChecked();
  await expect(page.locator("#controls-content")).toContainText("shared host profiles");
  f.policy.enabled = false; await page.getByRole("button", { name: "Check feedback options", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("disabled by native configuration"); await expect(page.getByRole("button", { name: "Review report", exact: true })).toBeDisabled(); expect(f.calls.send).toEqual([]);
});

test("mobile feedback review handles lost responses without retries or horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page); await open(page); await review(page, "long".repeat(500));
  expect(await page.locator("#controls-dialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/native-feedback-mobile.png" });
  let attempts = 0;
  await page.route(`**/api/chats/${f.chat.id}/feedback/send`, route => { attempts++; f.reports[0].state = "uncertain"; return route.fulfill({ status: 502, json: { error: "Connection lost" } }); });
  await page.getByRole("button", { name: "Send feedback to OpenAI", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("outcome may be unknown");
  await page.getByRole("button", { name: "Refresh report status", exact: true }).click();
  await expect(page.locator(".native-feedback-history")).toContainText("Delivery uncertain");
  await expect(page.getByRole("button", { name: "Review report", exact: true })).toBeDisabled(); expect(attempts).toBe(1); expect(f.calls.input).toEqual([]);
  await page.getByRole("button", { name: "Write another report", exact: true }).click(); await expect(page.getByLabel("Your report", { exact: true })).toHaveValue("");
});

test("late feedback discovery cannot overwrite a newer dialog or clear a newer draft", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  await page.route(`**/api/chats/${f.chat.id}/feedback`, async route => { if (first) { first = false; entered.resolve(); await release.promise; } return route.fulfill({ json: { threadId: f.snapshot.agentSessionId, reports: [] } }); });
  await page.locator("#message-input").fill("/feedback"); await page.getByRole("button", { name: "Queue", exact: true }).click(); await entered.promise;
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close()); await open(page); await review(page, "New review");
  await page.locator("#message-input").evaluate(input => { input.value = "New draft"; }); release.resolve();
  await expect(page.locator(".native-feedback-confirm pre")).toHaveText("New review"); await expect(page.locator("#message-input")).toHaveValue("New draft"); expect(f.calls.send).toEqual([]);
});

test("late native acknowledgements notify the original chat without replacing a reopened panel", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route(`**/api/chats/${f.chat.id}/feedback/send`, async route => { entered.resolve(); await release.promise; return route.fulfill({ json: { ...f.reports[0], state: "sent", reference: f.snapshot.agentSessionId } }); });
  await open(page); await review(page); await page.getByRole("button", { name: "Send feedback to OpenAI", exact: true }).click(); await entered.promise;
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close()); await open(page);
  await page.getByLabel("Your report", { exact: true }).fill("New report draft"); await page.locator("#message-input").evaluate(input => { input.value = "New composer draft"; }); release.resolve();
  await expect(page.locator("#toasts")).toContainText(`${f.chat.title}: Codex confirmed the upload`); await expect(page.getByLabel("Your report", { exact: true })).toHaveValue("New report draft");
  await expect(page.locator("#message-input")).toHaveValue("New composer draft"); expect(f.calls.input).toEqual([]);
});
