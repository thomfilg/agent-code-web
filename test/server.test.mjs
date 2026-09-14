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
