import assert from "node:assert/strict";
import test from "node:test";
import { readinessProbe } from "../src/readiness.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("readiness requires decryptable database and writable data directories", async t => {
  const directory = await temporaryDirectory(t);
  let available = true;
  const records = { get: async () => { if (!available) throw Error("PRIVATE DATABASE ERROR"); return { ok: true }; } };
  const ready = readinessProbe({ records, directories: [directory] });
  assert.equal(await ready(), true);
  available = false;
  assert.equal(await ready(), false);
  assert.equal(await readinessProbe({ records: { get: async () => ({ ok: false }) }, directories: [directory] })(), false);
  assert.equal(await readinessProbe({ records: { get: async () => ({ ok: true }) }, directories: [directory + "/missing"] })(), false);
});

test("readiness bounds a stalled database and fails missing Google configuration", async () => {
  const ready = readinessProbe({ records: { get: () => new Promise(() => {}) }, directories: [], timeoutMs: 10 });
  assert.equal(await ready(), false);
  assert.equal(await readinessProbe({ configured: () => false, records: {}, directories: [] })(), false);
});

test("anonymous readiness is minimal and does not open authenticated APIs", async t => {
  const root = await temporaryDirectory(t);
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "private-fixture-token" }) });
  const { url } = await app.start(); t.after(() => app.stop());
  const response = await fetch(url + "/readyz");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await fetch(url + "/api/chats")).status, 401);
  app.records.get = async () => { throw Error("PRIVATE ENCRYPTION KEY"); };
  const failed = await fetch(url + "/readyz");
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { ok: false });
});

test("deployment drain rejects browser requests, busy work and pauses new admission", async t => {
  const root = await temporaryDirectory(t);
  const app = await createAgentWebServer({ config: testConfig(root) });
  const { url } = await app.start(); t.after(() => app.stop());
  const drain = headers => fetch(url + "/internal/deploy/drain", { method: "POST", headers });
  assert.equal((await drain({ origin: url })).status, 404);
  assert.equal((await drain({ "sec-fetch-site": "same-origin" })).status, 404);
  const chat = await app.manager.createChat({ agent: "mock", title: "Do not interrupt" });
  await app.store.update(chat.id, { status: "running" });
  assert.equal((await drain()).status, 409);
  assert.equal((await fetch(url + "/readyz")).status, 200);
  await app.store.update(chat.id, { status: "stopped" });
  assert.equal((await drain()).status, 200);
  assert.equal((await fetch(url + "/readyz")).status, 503);
  assert.equal((await fetch(url + "/api/chats", { method: "POST" })).status, 503);
  assert.equal((await fetch(url + "/internal/deploy/resume", { method: "POST" })).status, 200);
  assert.equal((await fetch(url + "/readyz")).status, 200);
});
