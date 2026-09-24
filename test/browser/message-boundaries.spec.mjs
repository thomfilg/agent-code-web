import { test, expect } from "@playwright/test";

test("agent updates stay separate paragraphs while streaming and after reload", async ({ page, request }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Message boundary fixture" } })).json();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const text = "Checking the server.\n\nShared Chrome is ready.\n\nThe app works.";
  const assistant = { id: "assistant-boundary-fixture", role: "assistant", agent: "codex", kind: "message", text };
  let saved = false;
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor(url) { this.url = url; window.fixtureEventSource = this; }
      close() {}
    };
  });
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() !== "GET" ? route.continue() : route.fulfill({ json: { chat: { ...chat, status: saved ? "idle" : "running", messages: [{ id: "user-boundary-fixture", role: "user", text: "Check the server" }, ...(saved ? [assistant] : [])] } } }));
  try {
    await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
    await page.evaluate(({ id, text }) => {
      const emit = event => window.fixtureEventSource.onmessage({ data: JSON.stringify(event) });
      emit({ type: "turn_started", messageId: id });
      for (const delta of text.match(/.{1,8}|\n/gs)) emit({ type: "assistant_delta", delta });
    }, assistant);
    const paragraphs = page.locator(".message.assistant .message-text p");
    await expect(paragraphs).toHaveText(["Checking the server.", "Shared Chrome is ready.", "The app works."]);
    const gap = await paragraphs.evaluateAll(nodes => nodes[1].getBoundingClientRect().top - nodes[0].getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThan(0);
    await page.evaluate(message => window.fixtureEventSource.onmessage({ data: JSON.stringify({ type: "turn_completed", message }) }), assistant);
    saved = true;
    await expect(paragraphs).toHaveCount(3);
    await page.reload(); await expect(paragraphs).toHaveText(["Checking the server.", "Shared Chrome is ready.", "The app works."]);
    expect(errors).toEqual([]);
  } finally { await request.delete(`/api/chats/${chat.id}`); }
});
