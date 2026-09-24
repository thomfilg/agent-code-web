import assert from "node:assert/strict";
import test from "node:test";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

async function streamEvent(response, signal) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const next = await reader.read();
    if (next.done || signal.aborted) throw new Error("Worker event stream ended before an event arrived");
    buffer += decoder.decode(next.value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").find(line => line.startsWith("data: "));
      if (data) return JSON.parse(data.slice(6));
    }
  }
}

test("worker events push to the authenticated SSE stream and replay from a durable cursor", { timeout: 12000 }, async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const app = await createAgentWebServer({ config: testConfig(root), records });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.store.create({ title: "Worker event stream", agent: "mock" });
  const endpoint = `${url}/api/chats/${chat.id}/worker-events`;
  const abort = new AbortController(); t.after(() => abort.abort());
  assert.equal((await fetch(`${endpoint}?lastEventId=not-a-cursor`)).status, 400);
  const connected = await fetch(endpoint, { signal: abort.signal }); assert.equal(connected.status, 200);
  const pushed = streamEvent(connected, abort.signal);
  const committed = await records.appendWorkerEvent(chat.id, "fixture:running", { type: "worker-state", state: "running" });
  assert.deepEqual(await pushed, committed, "a database commit wakes SSE without polling the API");
  abort.abort();
  const second = await records.appendWorkerEvent(chat.id, "fixture:stopped", { type: "worker-state", state: "stopped" });
  const replayAbort = new AbortController(); t.after(() => replayAbort.abort());
  const replay = await fetch(endpoint, { headers: { "last-event-id": "1" }, signal: replayAbort.signal });
  assert.equal(replay.status, 200);
  assert.deepEqual(await streamEvent(replay, replayAbort.signal), second);
  replayAbort.abort();
  await app.stop();
});

test("host system events push across the same durable notification channel with cursor replay", { timeout: 12000 }, async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const app = await createAgentWebServer({ config: testConfig(root), records });
  const { url } = await app.start(); t.after(() => app.stop());
  const endpoint = `${url}/api/system/events`;
  assert.equal((await fetch(`${endpoint}?lastEventId=invalid`)).status, 400);
  const abort = new AbortController(); t.after(() => abort.abort());
  const connected = await fetch(endpoint, { signal: abort.signal }); assert.equal(connected.status, 200);
  const pushed = streamEvent(connected, abort.signal);
  const committed = await records.appendSystemEvent("docker:first", { type: "controller-container", action: "die" });
  assert.deepEqual(await pushed, committed);
  abort.abort();
  const second = await records.appendSystemEvent("docker:second", { type: "controller-container", action: "start" });
  const replayAbort = new AbortController(); t.after(() => replayAbort.abort());
  const replay = await fetch(endpoint, { headers: { "last-event-id": "1" }, signal: replayAbort.signal });
  assert.deepEqual(await streamEvent(replay, replayAbort.signal), second);
  replayAbort.abort();
  await app.stop();
});

test("system event stream is unavailable without the Relay browser session", { timeout: 12000 }, async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "fixture-relay-token" }), records });
  const { url } = await app.start();
  assert.equal((await fetch(`${url}/api/system/events`)).status, 401);
  await app.stop();
});
