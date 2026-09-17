import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  return { response, body: await response.json() };
}

test("transcript copies persist rich content without sharing workspaces or starting agents", async t => {
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "copy-secret" }) });
  const { url } = await app.start(); t.after(() => app.stop());
  const headers = { Authorization: "Bearer copy-secret" };
  const original = (await jsonRequest(`${url}/api/chats`, { method: "POST", headers, body: JSON.stringify({ agent: "mock", title: "Long original" }) })).body.chat;
  const messages = Array.from({ length: 60 }, (_, i) => ({ id: `original-${i}`, role: i % 2 ? "assistant" : "user", text: i % 2 ? "# Result\n\n| A | B |\n| - | - |\n| One | Two |\n\n```html\n<h1>Document</h1>\n```" : `Request ${i}` }));
  messages.push({ id: "original-tool", role: "tool", kind: "tool", meta: { itemId: "call", tool: "Read", input: "file.md", output: "Actual contents", state: "completed" } });
  messages[0].attachments = [{ id: "private-file", name: "notes.txt", path: "/private/path" }];
  await app.store.update(original.id, { messages, agentSessionId: "never-share", queuedMessages: [{ id: "queued", text: "Never run this" }], usage: { contextTokens: 12345 }, environmentId: "never-share" });
  const endpoint = `${url}/api/chats/${original.id}/copy`, before = app.store.get(original.id);
  assert.equal((await jsonRequest(endpoint, { method: "POST", body: "{}" })).response.status, 401);
  assert.equal((await jsonRequest(endpoint, { method: "POST", headers: { ...headers, Origin: "https://attacker.example" }, body: "{}" })).response.status, 403);
  const response = await jsonRequest(endpoint, { method: "POST", headers, body: JSON.stringify({ title: "Rendering copy" }) });
  assert.equal(response.response.status, 201); const copy = response.body.chat;
  assert.equal(copy.messages.length, messages.length); assert.notEqual(copy.workspace, original.workspace);
  assert.equal(copy.agentSessionId, null); assert.equal(copy.environmentId, null); assert.equal(copy.usage, undefined); assert.equal(copy.status, "stopped");
  assert.equal(copy.needsAgentHandoff, true); assert.equal(copy.queuedMessages, undefined); assert.deepEqual(copy.repositories, []);
  assert.notEqual(copy.messages[0].id, messages[0].id); assert.equal(copy.messages[1].text, messages[1].text);
  assert.equal(copy.messages[0].attachments[0].id, undefined); assert.equal(copy.messages[0].attachments[0].path, undefined);
  assert.deepEqual(copy.messages.at(-1).meta, messages.at(-1).meta);
  assert.deepEqual(app.store.get(original.id), before);
  assert.equal((await jsonRequest(`${url}/api/chats/${copy.id}`, { headers })).body.chat.messages.length, 61);
});

test("a rendering sample extends the requested chat in place and is explicit, idempotent and excluded from handoff", async t => {
  const { handoffPrompt } = await import("../src/agent-handoff.mjs");
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "sample-secret" }) });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "mock", title: "Keep this chat" });
  await app.store.appendMessage(chat.id, { role: "user", text: "Original request" });
  const before = app.store.get(chat.id), endpoint = `${url}/api/chats/${chat.id}/rendering-sample`, headers = { Authorization: "Bearer sample-secret" };
  assert.equal((await jsonRequest(endpoint, { method: "POST", body: '{"confirm":true}' })).response.status, 401);
  assert.equal((await jsonRequest(endpoint, { method: "POST", headers, body: "{}" })).response.status, 403);
  const result = await jsonRequest(endpoint, { method: "POST", headers, body: '{"confirm":true}' });
  assert.equal(result.response.status, 200); const after = result.body.chat;
  assert.equal(after.id, before.id); assert.equal(after.workspace, before.workspace); assert.equal(after.customGroupId, before.customGroupId); assert.equal(after.ownerId, before.ownerId);
  assert.equal(after.messages.length, before.messages.length + 241); assert.deepEqual(after.messages[0], before.messages[0]);
  assert.ok(after.messages.reduce((n, m) => n + m.text.length, 0) > 200000); assert.equal(app.store.list().length, 1);
  assert.equal(after.status, "stopped"); assert.equal(after.agentSessionId, null);
  const repeat = await jsonRequest(endpoint, { method: "POST", headers, body: '{"confirm":true}' }); assert.equal(repeat.body.chat.messages.length, after.messages.length);
  assert.doesNotMatch(handoffPrompt({ ...after, needsAgentHandoff: true, messages: [...after.messages, { role: "user", text: "Continue" }] }, "Continue"), /Rendering sample/);
  const real = await app.store.appendMessage(chat.id, { role: "user", text: "A real request after the samples" });
  const removed = await jsonRequest(endpoint, { method: "DELETE", headers });
  assert.equal(removed.response.status, 200); assert.deepEqual(removed.body.chat.messages.map(message => message.id), [before.messages[0].id, real.id]);
  assert.equal(removed.body.chat.workspace, before.workspace);
});

test("HTTP UI creates a chat, streams an event, and exposes persisted result", async (t) => {
  const root = await temporaryDirectory(t);
  const app = await createAgentWebServer({ config: testConfig(path.join(root, "data")) });
  const address = await app.start();
  t.after(() => app.stop());
  const base = address.url;

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Agent Relay/);

  const created = await jsonRequest(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ agent: "mock", title: "HTTP POC" }),
  });
  assert.equal(created.response.status, 201);
  const chatId = created.body.chat.id;

  const streamResponse = await fetch(`${base}/api/chats/${chatId}/events`);
  const reader = streamResponse.body.getReader();
  const sent = await jsonRequest(`${base}/api/chats/${chatId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "from HTTP" }),
  });
  assert.equal(sent.response.status, 202);

  let streamText = "";
  await waitFor(async () => {
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: false, value: new Uint8Array() }), 30)),
    ]);
    streamText += new TextDecoder().decode(result.value || new Uint8Array());
    return streamText.includes('"type":"tool"') && streamText.includes("assistant_delta");
  });
  await reader.cancel();

  const finished = await waitFor(async () => {
    const result = await jsonRequest(`${base}/api/chats/${chatId}`);
    return result.body.chat.messages.some((message) => message.role === "assistant") ? result.body.chat : null;
  });
  assert.match(finished.messages.at(-1).text, /from HTTP/);
  await waitFor(() => app.store.get(chatId).status === "stopped");
});

test("HTTP API requires the configured access token and exchanges it for a cookie", async (t) => {
  const root = await temporaryDirectory(t);
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "browser-secret" }) });
  const address = await app.start();
  t.after(() => app.stop());

  assert.equal((await fetch(`${address.url}/api/chats`)).status, 401);
  const login = await fetch(`${address.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "browser-secret" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${address.url}/api/chats`, { headers: { cookie } })).status, 200);
});
