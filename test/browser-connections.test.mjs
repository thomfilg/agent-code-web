import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { unzipSync } from "fflate";
import { createAgentWebServer } from "../src/server.mjs";
import { BrowserConnections } from "../src/browser-connections.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function fixture(t) {
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root) });
  const { url } = await app.start(); t.after(() => app.stop());
  const request = async (route, cookie, method = "GET", body) => {
    const response = await fetch(url + route, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const alice = await request("/api/browser-account/register", null, "POST", { username: "alice", password: "fixture alice private" });
  const bob = await request("/api/browser-account/register", null, "POST", { username: "bobby", password: "fixture bobby private" });
  for (const id of ["acme", "other"]) assert.equal((await request("/api/companies", alice.cookie, "POST", { id, name: id })).status, 201);
  const chat = (await request("/api/chats", alice.cookie, "POST", { agent: "mock" })).body.chat;
  await app.store.update(chat.id, { repositories: [{ fullName: "unrelated-owner/project", companyId: "acme" }] });
  const pair = (await request("/api/browser-connections", alice.cookie, "POST", { name: "Private Chrome", companyId: "acme" })).body;
  const connect = async (auth, extensionId = "a".repeat(32), acknowledge = true, waitAvailable = true) => {
    const socket = new WebSocket(url.replace("http:", "ws:") + "/browser/connect", { headers: { origin: `chrome-extension://${extensionId}` } }), events = [], commands = [];
    socket.on("error", () => {}); t.after(() => socket.terminate());
    socket.on("message", data => {
      const message = JSON.parse(data); events.push(message);
      if (message.action) { commands.push(message); if (acknowledge) socket.send(JSON.stringify({ id: message.id, grantId: message.grantId, value: { mode: "personal", running: true, tabs: [{ id: "fixture-tab", url: "about:blank" }], tabId: "fixture-tab" } })); }
    });
    await once(socket, "open"); socket.send(JSON.stringify(auth));
    const result = await waitFor(() => events.find(event => ["connected", "error"].includes(event.event)));
    if (result.event === "connected" && socket.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ type: "availability", tabSelected: true })); if (waitAvailable) await waitFor(() => app.manager.browsers.personal.bridges.get(result.id)?.tabSelected); }
    return { socket, events, commands, result };
  };
  return { app, url, request, alice, bob, chat, pair, connect };
}

test("personal Chrome pairing is private, one-use, extension-bound, and never grants access on connect", async t => {
  const { app, request, alice, bob, chat, pair, connect } = await fixture(t);
  assert.equal((await request("/api/browser-connections", bob.cookie)).body.connections.length, 0);
  assert.equal((await request(`/api/browser-connections/${pair.id}`, bob.cookie, "DELETE")).status, 404);
  assert.equal((await request("/api/browser-connections", null, "POST", {})).status, 401);
  const bridge = await connect({ type: "pair", code: pair.code });
  assert.equal(bridge.result.event, "connected");
  assert.equal(bridge.commands.length, 0, "pairing must not send authorize");
  assert.equal((await request(`/api/chats/${chat.id}/browser/access`, alice.cookie)).body.enabled, false);
  const records = JSON.stringify(await app.records.list("browser-connection"));
  assert.equal(records.includes(pair.code), false); assert.equal(records.includes(bridge.result.token), false, "only hashes persist server-side");
  assert.equal((await connect({ type: "pair", code: pair.code })).result.event, "error");
  assert.equal((await connect({ type: "connect", id: pair.id, token: bridge.result.token }, "b".repeat(32))).result.event, "error");
  const ownBob = (await request("/api/chats", bob.cookie, "POST", { agent: "mock" })).body.chat;
  assert.equal((await request(`/api/chats/${ownBob.id}/browser/access`, bob.cookie, "PATCH", { enabled: true, confirm: true, connectionId: pair.id })).status, 404);
  assert.equal((await request(`/api/chats/${chat.id}/browser/access`, alice.cookie, "PATCH", { enabled: true, connectionId: pair.id })).status, 400);
  assert.equal((await request(`/api/chats/${chat.id}/browser/access`, alice.cookie, "PATCH", { enabled: true, confirm: true, connectionId: pair.id })).status, 200);
  assert.equal(bridge.commands.filter(command => command.action === "authorize").length, 1);
  const restored = await connect({ type: "connect", id: pair.id, token: bridge.result.token });
  assert.equal(restored.result.event, "connected"); assert.equal(restored.result.token, undefined);
  assert.equal(restored.commands.length, 0); assert.equal(app.manager.browsers.personal.grants.size, 0);
  assert.equal((await request(`/api/browser-connections/${pair.id}`, alice.cookie, "DELETE")).status, 200);
  assert.equal((await connect({ type: "connect", id: pair.id, token: bridge.result.token })).result.event, "error");
  assert.equal((await request("/api/browser-connections", alice.cookie)).body.connections.length, 0);
});

test("private live streams deny other users, logout revokes viewers, and the extension archive contains only fixed source files", async t => {
  const { app, url, request, alice, bob, chat, pair, connect } = await fixture(t);
  await connect({ type: "pair", code: pair.code });
  await request(`/api/chats/${chat.id}/browser/access`, alice.cookie, "PATCH", { enabled: true, confirm: true, connectionId: pair.id });
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/events`, { headers: { cookie: bob.cookie } })).status, 404);
  for (const cookie of [bob.cookie, ""]) {
    const socket = new WebSocket(`${url.replace("http:", "ws:")}/api/chats/${chat.id}/browser/live`, { headers: { origin: url, cookie } });
    socket.on("error", () => {});
    await new Promise(resolve => socket.on("unexpected-response", (_, response) => { assert.equal(response.statusCode, 404); response.resume(); socket.terminate(); resolve(); }));
  }
  const viewer = new WebSocket(`${url.replace("http:", "ws:")}/api/chats/${chat.id}/browser/live`, { headers: { origin: url, cookie: alice.cookie } });
  viewer.on("error", () => {}); t.after(() => viewer.terminate()); await once(viewer, "open");
  const controller = new AbortController(); t.after(() => controller.abort());
  const stream = await fetch(`${url}/api/chats/${chat.id}/events`, { headers: { cookie: alice.cookie }, signal: controller.signal });
  assert.equal(stream.status, 200); const reader = stream.body.getReader(); await reader.read();
  const closed = once(viewer, "close");
  await request("/api/browser-account", alice.cookie, "DELETE"); await closed;
  assert.equal(app.manager.browsers.personal.grants.size, 0);
  let done = false; while (!done) ({ done } = await reader.read());
  assert.equal((await request(`/api/chats/${chat.id}`, alice.cookie)).status, 404);
  const archive = await fetch(`${url}/api/browser-extension/download`);
  assert.equal(archive.headers.get("content-type"), "application/zip");
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ["manifest.json", "popup.css", "popup.html", "popup.js", "worker.js"].map(name => `agent-relay-chrome/${name}`).sort());
  const manifest = JSON.parse(new TextDecoder().decode(files["agent-relay-chrome/manifest.json"]));
  assert.deepEqual(manifest.permissions, ["debugger", "storage"]); assert.equal(manifest.content_scripts, undefined);
});

test("expired pairing and cancellation during authorization cannot leave a live grant or resurrect a removed connection", async t => {
  const { app, request, alice, chat, pair, connect } = await fixture(t), personal = app.manager.browsers.personal;
  const originalNow = personal.now; personal.now = () => originalNow() + 6 * 60000;
  assert.equal((await connect({ type: "pair", code: pair.code })).result.event, "error"); personal.now = originalNow;
  const fresh = (await request("/api/browser-connections", alice.cookie, "POST", { companyId: "acme" })).body;
  const bridge = await connect({ type: "pair", code: fresh.code }, "a".repeat(32), false);
  const enabling = personal.enable(chat.id, alice.body.user, fresh.id), rejected = assert.rejects(enabling, /revoked|cancelled/);
  await waitFor(() => bridge.commands.find(command => command.action === "authorize"));
  const revoking = personal.revokeChat(chat.id);
  const revoke = await waitFor(() => bridge.commands.find(command => command.action === "revoke"));
  bridge.socket.send(JSON.stringify({ id: revoke.id, grantId: revoke.grantId, value: {} }));
  await revoking; await rejected;
  assert.equal(personal.info(chat.id, alice.body.user).enabled, false);
  const authorize = bridge.commands.find(command => command.action === "authorize");
  bridge.socket.send(JSON.stringify({ id: authorize.id, grantId: authorize.grantId, value: { running: true } }));
  const pendingPair = (await request("/api/browser-connections", alice.cookie, "POST", { companyId: "acme" })).body;
  const put = app.records.put.bind(app.records); let release, storing;
  app.records.put = async (kind, id, value) => { if (kind === "browser-connection" && id === pendingPair.id && value.tokenHash) { storing = true; await new Promise(resolve => { release = resolve; }); } return put(kind, id, value); };
  const pairing = connect({ type: "pair", code: pendingPair.code }, "a".repeat(32), true, false); await waitFor(() => storing);
  const removing = personal.remove(pendingPair.id, alice.body.user); release(); await pairing; await removing;
  assert.equal(await app.records.get("browser-connection", pendingPair.id), null);
  assert.equal(personal.bridges.has(pendingPair.id), false); assert.equal(personal.grants.size, 0);
});

test("company-scoped browser listing and consent reject wrong-company, missing-company and owner bypasses", async t => {
  const { app, request, alice, bob, chat, pair, connect } = await fixture(t);
  const bridge = await connect({ type: "pair", code: pair.code });
  for (const input of [{}, { companyId: "missing" }, { companyId: "*" }, { companyId: "acme", companies: ["acme", "other"] }, { companyId: "acme", allowUnassigned: true }]) {
    assert.equal((await request("/api/browser-connections", alice.cookie, "POST", input)).status, 400);
  }
  const other = (await request("/api/browser-connections", alice.cookie, "POST", { name: "Other profile", companyId: "other" })).body;
  assert.deepEqual((await request("/api/browser-connections?companyId=acme", alice.cookie)).body.connections.map(c => c.id), [pair.id]);
  assert.deepEqual((await request("/api/browser-connections?companyId=other", alice.cookie)).body.connections.map(c => c.id), [other.id]);
  assert.equal((await request("/api/browser-connections?companyId=missing", alice.cookie)).status, 400);
  assert.deepEqual((await request("/api/browser-connections?companyId=acme&includeLegacy=1", bob.cookie)).body.connections, []);
  assert.equal((await request(`/api/browser-connections/${pair.id}`, bob.cookie, "PATCH", { companyId: "other" })).status, 404);
  assert.equal((await request(`/api/browser-connections/${pair.id}`, alice.cookie, "PATCH", { companyId: "other" })).status, 409);
  const enable = connectionId => request(`/api/chats/${chat.id}/browser/access`, alice.cookie, "PATCH", { enabled: true, confirm: true, connectionId });
  assert.equal((await enable(other.id)).status, 403);
  await app.store.update(chat.id, { repositories: [] }); assert.equal((await enable(pair.id)).status, 403);
  await app.store.update(chat.id, { repositories: [{ fullName: "acme/project", companyId: "other" }] }); assert.equal((await enable(pair.id)).status, 403, "GitHub owner cannot override explicit Relay company");
  assert.equal(bridge.commands.length, 0); assert.equal(app.manager.browsers.personal.grants.size, 0);
});

test("legacy profiles remain intact and unusable until explicit immutable company assignment", async t => {
  const { app, request, alice, chat, pair, connect } = await fixture(t);
  const initial = await connect({ type: "pair", code: pair.code });
  const before = await app.records.get("browser-connection", pair.id);
  const legacy = { ...before }; delete legacy.companyId;
  await app.records.put("browser-connection", pair.id, legacy);
  const bridge = await connect({ type: "connect", id: pair.id, token: initial.result.token });
  assert.equal(bridge.result.event, "connected"); assert.equal(bridge.commands.length, 0);
  const list = (await request("/api/browser-connections", alice.cookie)).body.connections;
  assert.equal(list[0].companyId, null); assert.equal(list[0].paired, true);
  assert.deepEqual((await request("/api/browser-connections?companyId=acme", alice.cookie)).body.connections, []);
  assert.equal((await request("/api/browser-connections?companyId=acme&includeLegacy=1", alice.cookie)).body.connections.length, 1);
  const enable = () => request(`/api/chats/${chat.id}/browser/access`, alice.cookie, "PATCH", { enabled: true, confirm: true, connectionId: pair.id });
  assert.equal((await enable()).status, 403);
  assert.deepEqual(await app.records.get("browser-connection", pair.id), legacy, "Listing, reconnect and failed consent never migrate or delete profiles");
  assert.equal((await request(`/api/browser-connections/${pair.id}`, alice.cookie, "PATCH", { companyId: "acme" })).status, 200);
  assert.deepEqual(await app.records.get("browser-connection", pair.id), { ...legacy, companyId: "acme" });
  assert.equal(bridge.commands.length, 0, "Assignment never grants access or disconnects the saved profile");
  assert.equal((await enable()).status, 200);
  assert.equal((await request(`/api/browser-connections/${pair.id}`, alice.cookie, "PATCH", { companyId: "other" })).status, 409);
});

for (const mutation of ["company", "owner", "archive"]) test(`${mutation} change during authorization cannot activate a stale Chrome grant`, async t => {
  const { app, alice, bob, chat, pair, connect } = await fixture(t), personal = app.manager.browsers.personal;
  const bridge = await connect({ type: "pair", code: pair.code }, "a".repeat(32), false);
  const enabling = personal.enable(chat.id, alice.body.user, pair.id), rejected = assert.rejects(enabling, /cancelled|revoked/);
  const authorize = await waitFor(() => bridge.commands.find(command => command.action === "authorize"));
  await app.store.update(chat.id, mutation === "owner" ? { ownerId: bob.body.user.id } : mutation === "archive" ? { archived: true } : { repositories: [{ fullName: "other/project", companyId: "other" }] });
  bridge.socket.send(JSON.stringify({ id: authorize.id, grantId: authorize.grantId, value: { running: true } }));
  await rejected; assert.equal(personal.grants.size, 0);
  const revoke = await waitFor(() => bridge.commands.find(command => command.action === "revoke"));
  bridge.socket.send(JSON.stringify({ id: revoke.id, grantId: revoke.grantId, value: {} }));
});

for (const trigger of ["command-result", "frame", "cached-state"]) test(`company changes revoke active Chrome access on ${trigger}`, async t => {
  const { app, alice, chat, pair, connect } = await fixture(t), personal = app.manager.browsers.personal;
  const bridge = await connect({ type: "pair", code: pair.code });
  await personal.enable(chat.id, alice.body.user, pair.id);
  let closed = false, sent = false;
  const grant = personal.grants.get(chat.id);
  grant.viewers.add({ readyState: 1, close: () => { closed = true; }, send: () => { sent = true; } });
  const request = personal.request.bind(personal), gate = Promise.withResolvers();
  personal.request = (...args) => args[1] === "snapshot" ? gate.promise : request(...args);
  const rejected = trigger === "command-result" ? assert.rejects(personal.command(chat.id, "snapshot"), /revoked/) : null;
  await app.store.update(chat.id, { repositories: [{ fullName: "other/project", companyId: "other" }] });
  if (trigger === "command-result") { gate.resolve({ privateFixtureData: true }); await rejected; }
  if (trigger === "frame") {
    bridge.socket.send(JSON.stringify({ event: "frame", grantId: grant.id, value: { data: "fixture-frame" } }));
    await waitFor(() => bridge.commands.some(command => command.action === "revoke"));
  }
  if (trigger === "cached-state") assert.notEqual(app.manager.browsers.info(chat.id).mode, "personal");
  assert.equal(closed, true); assert.equal(personal.grants.size, 0);
  assert.equal(personal.info(chat.id, alice.body.user).enabled, false);
  assert.notEqual(app.manager.browsers.info(chat.id).mode, "personal");
  await personal.command(chat.id, "snapshot").catch(() => {}); assert.equal(sent, false);
});

test("pairing never falls back to a global registry or another owner's registered company", async () => {
  const records = new MemoryRecords(), store = { get: () => null }, alice = { id: "alice" }, bob = { id: "bob" };
  const disconnectedRegistry = new BrowserConnections({ records, store });
  await assert.rejects(disconnectedRegistry.pair(alice, { companyId: "acme" }), /registry is unavailable/);
  const checked = [], personal = new BrowserConnections({ records, store, validateCompany: async (owner, company) => {
    checked.push([owner.id, company]);
    if (owner.id !== "alice" || company !== "acme") throw Object.assign(Error("Company unavailable for this owner"), { statusCode: 400 });
  } });
  await assert.rejects(personal.pair(bob, { companyId: "acme" }), /unavailable for this owner/);
  assert.deepEqual(await records.list("browser-connection"), []);
  const pair = await personal.pair(alice, { companyId: "acme" });
  assert.equal((await records.get("browser-connection", pair.id)).companyId, "acme");
  await assert.rejects(personal.list(bob, { companyId: "acme", includeLegacy: true }), /unavailable for this owner/);
  assert.deepEqual(await personal.list(bob), []);
  assert.deepEqual(checked, [["bob", "acme"], ["alice", "acme"], ["bob", "acme"]]);
  await personal.shutdown();
});
