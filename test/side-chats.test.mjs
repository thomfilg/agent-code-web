import assert from "node:assert/strict";
import test from "node:test";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";
import { SideChats } from "../src/side-chats.mjs";

async function fixture(t) {
  const root = await temporaryDirectory(t);
  const calls = { forks: 0, stops: 0, sideStops: 0, sideInputs: [], responses: [] };
  let mainFinish, sideFinish;
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000", AGENT_WEB_AUTH_TOKEN: "side-fixture" }),
    models: { creationSettings: async () => ({}), turnSettings: async () => ({ model: "fixture", effort: "high" }) },
    adapterFactory: ({ hooks }) => ({
      start: async () => {},
      send: async () => new Promise(resolve => { mainFinish = resolve; hooks.onRequest({ requestId: "main-request", method: "item/tool/requestUserInput", params: { questions: [{ id: "main", question: "Main question?" }] } }); }),
      stop: async () => { calls.stops++; mainFinish?.({ text: "Main result" }); },
      forkSide: async sideHooks => {
        calls.forks++; calls.hooks = sideHooks;
        return {
          send: async (text, settings) => { calls.sideInputs.push({ text, settings }); return new Promise(resolve => { sideFinish = resolve; sideHooks.onRequest({ requestId: "side-request", method: "item/tool/requestUserInput", params: { questions: [{ id: "side", question: "Side question?" }] } }); }); },
          respond: async (id, payload) => { calls.responses.push({ id, payload }); sideHooks.onEvent({ type: "assistant_delta", delta: "Side response<relay-waiting>no</relay-waiting>" }); sideFinish?.({ text: "Side response<relay-waiting>no</relay-waiting>" }); },
          stop: async () => { calls.sideStops++; sideFinish?.({ text: "" }); },
          interrupt: async () => { sideFinish?.({ text: "Interrupted side" }); },
        };
      },
    }),
  });
  const { url } = await app.start(); t.after(() => app.stop());
  const headers = { authorization: "Bearer side-fixture", "content-type": "application/json" };
  const chat = await app.manager.createChat({ agent: "codex", title: "Side isolation" });
  const request = async (tail, method = "GET", body) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { app, calls, chat, request, url };
}

test("side chat runs concurrently, keeps questions/messages separate, and never pauses the main queue", async t => {
  const { app, calls, chat, request } = await fixture(t);
  await app.manager.submit(chat.id, "Main prompt");
  await waitFor(() => app.store.get(chat.id).pendingRequest);
  const initialMessages = structuredClone(app.store.get(chat.id).messages);
  const [a, b] = await Promise.all([request("side", "POST"), request("side", "POST")]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(calls.forks, 1);
  const { side } = await a.json();
  assert.equal((await request("side/messages", "POST", { sideId: side.id, text: "My side question" })).status, 202);
  await waitFor(() => app.manager.sideChats.get(chat.id).side.pendingRequest);
  assert.equal(app.store.get(chat.id).pendingRequest.requestId, "main-request");
  assert.equal(app.manager.isBusy(chat.id), true);
  assert.deepEqual(app.store.get(chat.id).messages, initialMessages);
  assert.equal((await request("side/messages", "POST", { sideId: side.id, text: "double submit" })).status, 409);
  assert.equal((await request("side/respond", "POST", { sideId: side.id, requestId: "main-request", answers: { main: "no" } })).status, 409);
  assert.equal((await request("side/respond", "POST", { sideId: side.id, requestId: "side-request", answers: { wrong: "no" } })).status, 400);
  assert.equal((await request("side/respond", "POST", { sideId: side.id, requestId: "side-request", answers: { side: "yes" } })).status, 200);
  await waitFor(() => app.manager.sideChats.get(chat.id).side.status === "idle");
  assert.deepEqual(calls.responses, [{ id: "side-request", payload: { answers: { side: { answers: ["yes"] } } } }]);
  assert.equal(app.manager.sideChats.get(chat.id).side.messages.at(-1).text, "Side response");
  assert.deepEqual(app.store.get(chat.id).messages, initialMessages);
  assert.ok(!app.manager.eventsSince(chat.id).some(event => event.type === "side_chat_updated"), "Do not retain duplicate side snapshots in main SSE history");
  const queueBefore = app.store.get(chat.id).queuePaused;
  assert.equal((await request("side", "DELETE", { sideId: side.id })).status, 200);
  assert.equal(calls.stops, 0); assert.equal(calls.sideStops, 1);
  assert.equal(app.store.get(chat.id).queuePaused, queueBefore);
  assert.equal(app.store.get(chat.id).status, "running");
  assert.equal(app.store.get(chat.id).pendingRequest.requestId, "main-request");
});

test("side endpoints enforce authentication, origin, session identity, and attachment chat ownership", async t => {
  const { app, calls, chat, request, url } = await fixture(t);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/side`)).status, 401);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/side`, { method: "POST", headers: { authorization: "Bearer side-fixture", origin: "https://evil.example" } })).status, 403);
  assert.equal(calls.forks, 0);
  const { side } = await (await request("side", "POST")).json();
  assert.deepEqual(app.store.get(chat.id).messages, []);
  assert.equal(app.manager.isBusy(chat.id), false, "An idle side does not block main input");
  const other = await app.manager.createChat({ agent: "codex" });
  const privateFile = await app.manager.attachments.upload(other.id, { name: "private.txt", data: Buffer.from("private").toString("base64") });
  const wrong = await request("side/messages", "POST", { sideId: side.id, text: "read this", attachments: [privateFile.id] });
  assert.notEqual(wrong.status, 202); assert.equal(calls.sideInputs.length, 0);
  assert.equal((await request("side/messages", "POST", { sideId: side.id, text: "/side nested" })).status, 400);
  const file = await app.manager.attachments.upload(chat.id, { name: "own.txt", mime: "text/plain", data: Buffer.from("own fixture").toString("base64") });
  assert.equal((await request("side/messages", "POST", { sideId: side.id, text: "Read own attachment", attachments: [file.id] })).status, 202);
  assert.equal(app.store.get(chat.id).idleDeadlineAt, null, "A side turn must hold the worker awake");
  assert.equal(app.store.get(chat.id).idleKeepAwakeReason, "side");
  assert.match(calls.sideInputs[0].text, /own\.txt/); assert.equal(calls.sideInputs[0].settings.model, "fixture");
  await request("side", "DELETE", { sideId: side.id });
  const reopened = await (await request("side", "POST")).json(); assert.notEqual(reopened.side.id, side.id);
  assert.equal((await request("side", "DELETE", { sideId: side.id })).status, 409);
  assert.equal(app.manager.sideChats.get(chat.id).side.id, reopened.side.id);
  await app.manager.stop(chat.id);
  assert.equal(app.manager.sideChats.get(chat.id).side, null); assert.equal(calls.sideStops, 2);
  await app.store.update(chat.id, { ownerId: "another-private-user" });
  assert.equal((await request("side")).status, 404);
  assert.equal((await request("side", "POST")).status, 404);
});

test("closing a side chat during native fork creation cannot resurrect it or leak its adapter", async () => {
  const ready = Promise.withResolvers(); let stopped = 0;
  const sessions = new SideChats({ fork: () => ready.promise, prepare: async () => ({}), activity: async () => {}, publish: () => {} });
  const opening = sessions.open("chat-fixture"), rejected = assert.rejects(opening, /closed/);
  const closing = sessions.close("chat-fixture");
  assert.equal(sessions.get("chat-fixture").side, null);
  ready.resolve({ stop: async () => { stopped++; } });
  await closing; await rejected;
  assert.equal(stopped, 1); assert.equal(sessions.get("chat-fixture").side, null);
});

test("side questions retain a new pending question arriving while the previous answer resolves", async t => {
  const { app, calls, chat, request } = await fixture(t);
  const { side } = await (await request("side", "POST")).json();
  calls.hooks.onRequest({ requestId: "old", method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true } } } });
  calls.hooks.onRequest({ requestId: "new", method: "item/tool/requestUserInput", params: { questions: [{ id: "q", question: "New?" }] } });
  const result = await request("side/respond", "POST", { sideId: side.id, requestId: "old", decision: "decline" });
  assert.equal(result.status, 200);
  assert.equal(app.manager.sideChats.get(chat.id).side.pendingRequest.requestId, "new");
  assert.deepEqual(calls.responses[0].payload, { permissions: {} });
});
