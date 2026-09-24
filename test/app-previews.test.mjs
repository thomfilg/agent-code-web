import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { AppPreviews } from "../src/app-previews.mjs";
import { PreviewActivity } from "../src/preview-activity.mjs";
import { MemoryRecords } from "../src/database.mjs";

async function fixture(t, { acquire = async id => ({ id }), warmTtlMs } = {}) {
  const rows = [], users = [{ id: "owner-a", sessionId: "session-a", expiresAt: Date.now() + 60000 }, { id: "owner-b", sessionId: "session-b", expiresAt: Date.now() + 60000 }];
  const chats = new Map([["chat-a", { id: "chat-a", ownerId: "owner-a" }], ["chat-b", { id: "chat-b", ownerId: "owner-b" }]]);
  const records = new MemoryRecords();
  for (const user of users) { await records.put("relay-session", user.sessionId, { ...user, ownerId: user.id }); await records.put("relay-user", user.id, { email: user.id + "@example.test" }); }
  const store = { get: id => chats.get(id) }, identity = { records, canRead: (chat, user) => Boolean(chat && chat.ownerId === user.id), allowedEmail: email => email.endsWith("@example.test"), session: async () => users[0] };
  let acquired = 0, reconciles = 0; const generations = new Map();
  const manager = new EventEmitter(); manager.previewGeneration = id => chats.has(id) ? generations.get(id) || 0 : null;
  manager.previewActivity = new PreviewActivity({ generation: manager.previewGeneration, acquire: async id => { acquired++; return acquire(id); } });
  const hosts = {
    lookup: hostname => rows.find(row => row.hostname === hostname && row.status === "ready") || null,
    list: scope => rows.filter(row => row.ownerId === scope.ownerId && row.chatId === scope.chatId),
    ensure: async input => { let row = rows.find(row => row.ownerId === input.ownerId && row.chatId === input.chatId && row.port === input.port && row.status !== "deleted"); if (!row) { row = { ...input, id: "host-" + rows.length, status: "pending", hostname: "app-" + rows.length + ".example.test" }; rows.push(row); } return row; },
    revoke: async (id, scope) => { const row = rows.find(row => row.id === id && row.ownerId === scope.ownerId && row.chatId === scope.chatId); if (!row) throw new Error("wrong owner"); row.status = "revoking"; },
    reconcile: async () => { reconciles++; }, close: async () => {},
  };
  let lastStart, bootstrap;
  const app = new AppPreviews({ hosts, identity, store, manager, relayOrigin: "https://relay.example.test", ...(warmTtlMs ? { warmTtlMs } : {}),
    bootstrapFactory: ({ grants }) => (bootstrap = { start: input => { lastStart = input; return { url: "https://relay.example.test/app-preview/open?launch=fixture" }; },
      authorize: (request, hostname) => grants.authorize(request.headers.cookie, hostname),
      handlePreview: async () => false, handleRelay: async () => false,
      revokeOwner: id => grants.revokeOwner(id), revokeSession: (id, session) => grants.revokeSession(id, session), revokeChat: (id, chat) => grants.revokeChat(id, chat),
      revokeHostname: hostname => { for (const entry of grantsForHost.get(hostname) || []) grants.revokeGrant(entry); }, close: () => grants.close() }),
    proxy: { http: async (_request, response, held) => { assert.equal(held.executor.id, held.lease.binding.chatId); response.end("app"); }, upgrade: async (_request, socket, _head, held) => { assert.equal(held.executor.id, held.lease.binding.chatId); socket.end(); } },
  });
  const grantsForHost = new Map();
  t.after(async () => { await app.close(); manager.previewActivity.close(); });
  const ready = async (index = 0, port = 3000) => { const user = users[index], chatId = "chat-" + (index ? "b" : "a"); await app.ensure(user, chatId, port); const row = rows.find(row => row.ownerId === user.id && row.port === port); row.status = "ready"; return row; };
  const token = row => { const user = users.find(user => user.id === row.ownerId); app.remember(user); const { ticket } = app.grants.issueTicket({ ownerId: user.id, sessionId: user.sessionId, chatId: row.chatId, hostname: row.hostname, port: row.port, runtimeGeneration: manager.previewGeneration(row.chatId) });
    const { grant } = app.grants.exchangeTicket(ticket, row.hostname); grantsForHost.set(row.hostname, [...(grantsForHost.get(row.hostname) || []), grant]); return grant; };
  return { app, users, rows, chats, records, manager, ready, token, generations, get acquired() { return acquired; }, get reconciles() { return reconciles; }, get lastStart() { return lastStart; } };
}

test("preview polling is owner-scoped and never provisions or acquires a worker", async t => {
  const f = await fixture(t);
  assert.equal((await f.app.status(f.users[0], "chat-a", 3000)).preview.status, "none");
  assert.equal(f.rows.length, 0); assert.equal(f.acquired, 0); assert.equal(f.reconciles, 0);
  await assert.rejects(f.app.status(f.users[1], "chat-a", 3000), { statusCode: 404 });
  await assert.rejects(f.app.status(null, "chat-a", 3000), { statusCode: 401 });
  for (const port of [80, 65536, "3000", 3000.1, null]) await assert.rejects(f.app.ensure(f.users[0], "chat-a", port), { statusCode: 400 });
});

test("distinct ports keep stable host bindings and opening prepares a worker before minting bootstrap", async t => {
  const f = await fixture(t), first = await f.ready(0, 3000), second = await f.ready(0, 4000);
  assert.notEqual(first.hostname, second.hostname);
  const firstPoll = await f.app.open(f.users[0], "chat-a", 3000, "/future-drink/menu?cart=1#saved");
  await new Promise(resolve => setImmediate(resolve));
  const opened = await f.app.open(f.users[0], "chat-a", 3000, "/future-drink/menu?cart=1#saved", firstPoll.warming.id);
  assert.equal(new URL(opened.url).origin, "https://relay.example.test"); assert.equal(f.lastStart.binding.hostname, first.hostname); assert.equal(f.lastStart.path, "/future-drink/menu?cart=1#saved");
  assert.equal(f.acquired, 1); assert.equal(f.lastStart.binding.runtimeGeneration, 0);
  assert.equal(f.manager.previewActivity.has("chat-a"), false); assert.equal(f.app.warming.size, 0);
});

test("cold Open returns pending immediately, deduplicates and never mints until worker ready", async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { acquire: async id => { await gate; return { id }; } }); await f.ready();
  const first = await f.app.open(f.users[0], "chat-a", 3000, "/app?x=1#y");
  assert.equal(first.warming.status, "pending"); assert.equal(f.acquired, 1); assert.equal(f.lastStart, undefined); assert.ok(f.app.active > 0);
  const polls = await Promise.all(Array.from({ length: 6 }, () => f.app.open(f.users[0], "chat-a", 3000, "/app?x=1#y", first.warming.id)));
  assert.ok(polls.every(result => result.warming.id === first.warming.id)); assert.equal(f.acquired, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.ok((await f.app.open(f.users[0], "chat-a", 3000, "/app?x=1#y", first.warming.id)).url);
  assert.equal(f.lastStart.path, "/app?x=1#y"); assert.equal(f.app.warming.size, 0);
  await assert.rejects(f.app.open(f.users[0], "chat-a", 3000, "/app?x=1#y", first.warming.id), { statusCode: 409 }); assert.equal(f.acquired, 1);
});

test("invalid targets and stale/cross-session preparation IDs never acquire a worker", async t => {
  const f = await fixture(t); await f.ready();
  for (const path of ["//evil.test/", "/__relay_preview/probe", "/%00", "/\\bad"]) await assert.rejects(f.app.open(f.users[0], "chat-a", 3000, path));
  await assert.rejects(f.app.open(f.users[0], "chat-a", 3000, "/", "warm_unknown"), { statusCode: 409 }); assert.equal(f.acquired, 0);
  const result = await f.app.open(f.users[0], "chat-a", 3000, "/");
  const second = { ...f.users[0], sessionId: "another-session" }; await f.records.put("relay-session", second.sessionId, { ...second, ownerId: second.id });
  await assert.rejects(f.app.open(second, "chat-a", 3000, "/", result.warming.id), { statusCode: 409 }); assert.equal(f.acquired, 1);
});

test("Stop/logout/revoke/close/expiry cancel exact warming holds and late acquire cannot revive them", async t => {
  for (const cause of ["stop", "logout", "port", "close", "expiry"]) {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { acquire: async id => { await gate; return { id }; }, warmTtlMs: cause === "expiry" ? 15 : 60000 }); await f.ready();
    const first = await f.app.open(f.users[0], "chat-a", 3000, "/");
    if (cause === "stop") { f.generations.set("chat-a", 1); f.manager.emit("preview-revoke", { chatId: "chat-a", reason: "manual" }); }
    if (cause === "logout") { f.app.revokeOwner(f.users[0].id); await f.records.delete("relay-session", f.users[0].sessionId); }
    if (cause === "port") await f.app.remove(f.users[0], "chat-a", 3000);
    if (cause === "close") await f.app.close();
    if (cause === "expiry") await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.app.warming.size, 0, cause); assert.equal(f.manager.previewActivity.has("chat-a"), false, cause);
    release(); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.app.open(f.users[0], "chat-a", 3000, "/", first.warming.id));
    assert.equal(f.acquired, 1, cause); assert.equal(f.lastStart, undefined, cause); assert.equal(f.manager.previewActivity.has("chat-a"), false, cause);
  }
});

test("ready warming rechecks durable session and owner cap is bounded without cancelling siblings", async t => {
  const f = await fixture(t); await f.ready(); await f.ready(1);
  const first = await f.app.open(f.users[0], "chat-a", 3000, "/");
  const sibling = await f.app.open(f.users[1], "chat-b", 3000, "/");
  await new Promise(resolve => setImmediate(resolve));
  await f.records.delete("relay-session", f.users[0].sessionId);
  await assert.rejects(f.app.open(f.users[0], "chat-a", 3000, "/", first.warming.id), { statusCode: 401 });
  f.app.revokeOwner(f.users[0].id); assert.ok(f.app.warming.has(sibling.warming.id));
  assert.ok((await f.app.open(f.users[1], "chat-b", 3000, "/", sibling.warming.id)).url);
  for (let i = 0; i < 4; i++) await f.app.open(f.users[1], "chat-b", 3000, "/" + i);
  await assert.rejects(f.app.open(f.users[1], "chat-b", 3000, "/overflow"), { statusCode: 429 });
});

test("expired pending acquisitions retain drain and quota reservations until actual settlement", async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { warmTtlMs: 15, acquire: async id => { await gate; return { id }; } }); await f.ready();
  for (let i = 0; i < 4; i++) await f.app.open(f.users[0], "chat-a", 3000, "/" + i);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.app.warming.size, 0); assert.equal(f.manager.previewActivity.has("chat-a"), false);
  assert.equal(f.app.warmAcquisitions.size, 4); assert.ok(f.app.active >= 4);
  await assert.rejects(f.app.open(f.users[0], "chat-a", 3000, "/overflow"), { statusCode: 429 }); assert.equal(f.acquired, 4);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.warmAcquisitions.size, 0); assert.equal(f.app.active, 0); assert.equal(f.lastStart, undefined);
});

test("polling never extends warming expiry and a delayed timer cannot admit an expired ready job", async t => {
  const f = await fixture(t); await f.ready();
  const first = await f.app.open(f.users[0], "chat-a", 3000, "/");
  const job = f.app.warming.get(first.warming.id), deadline = job.expiresAt;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(job.expiresAt, deadline); clearTimeout(job.timer); job.expiresAt = Date.now() - 1;
  await assert.rejects(f.app.open(f.users[0], "chat-a", 3000, "/", job.id), { statusCode: 409 });
  assert.equal(f.lastStart, undefined); assert.equal(f.app.warming.size, 0); assert.equal(f.manager.previewActivity.has("chat-a"), false);
});

test("saved Google session is checked again before opening and before a worker is acquired", async t => {
  const f = await fixture(t), host = await f.ready(), token = f.token(host);
  await f.records.delete("relay-session", f.users[0].sessionId);
  await assert.rejects(f.app.open(f.users[0], "chat-a", 3000, "/"), { statusCode: 401 });
  await assert.rejects(f.app.lease({ headers: { host: host.hostname, cookie: token } }, new AbortController().signal), { statusCode: 401 });
  assert.equal(f.acquired, 0);
});

test("revoking one port aborts its grant but does not revoke another port or owner", async t => {
  const f = await fixture(t), a = await f.ready(), otherPort = await f.ready(0, 4000), b = await f.ready(1);
  const la = f.app.grants.authorize(f.token(a), a.hostname), lp = f.app.grants.authorize(f.token(otherPort), otherPort.hostname), lb = f.app.grants.authorize(f.token(b), b.hostname);
  await f.app.remove(f.users[0], "chat-a", 3000);
  assert.equal(la.signal.aborted, true); assert.equal(lp.signal.aborted, false); assert.equal(lb.signal.aborted, false);
  f.app.revokeOwner("owner-a"); assert.equal(lp.signal.aborted, true); assert.equal(lb.signal.aborted, false);
});

test("runtime Stop invalidates browser access synchronously and never revives a stale generation", async t => {
  const f = await fixture(t), host = await f.ready(), token = f.token(host), grant = f.app.grants.authorize(token, host.hostname);
  f.generations.set("chat-a", 1); f.manager.emit("preview-revoke", { chatId: "chat-a", reason: "manual" });
  assert.equal(grant.signal.aborted, true);
  await assert.rejects(f.app.lease({ headers: { host: host.hostname, cookie: token } }, new AbortController().signal)); assert.equal(f.acquired, 0);
});

test("HTTP proxy uses a checked executor lease, releases on finish, and rejects foreign host without acquisition", async t => {
  const f = await fixture(t), host = await f.ready(), token = f.token(host);
  const request = new EventEmitter(); request.headers = { host: host.hostname, cookie: token };
  const response = new EventEmitter(); response.end = value => { response.body = value; response.emit("close"); }; response.writeHead = code => { response.statusCode = code; };
  await f.app.handleHttp(request, response, new URL("https://" + host.hostname));
  assert.equal(response.body, "app"); assert.equal(f.acquired, 1); assert.equal(f.manager.previewActivity.has("chat-a"), false);
  request.headers.host = "foreign.example.test";
  await f.app.handleHttp(request, response, new URL("https://foreign.example.test")); assert.equal(response.statusCode, 403); assert.equal(f.acquired, 1);
});

test("host ownership change and archive invalidate existing grants", async t => {
  const f = await fixture(t), host = await f.ready(), token = f.token(host);
  f.chats.get("chat-a").archived = true;
  assert.throws(() => f.app.grants.authorize(token, host.hostname));
  await assert.rejects(f.app.open(f.users[0], "chat-a", 3000, "/")); assert.equal(f.acquired, 0);
});

test("non-retryable provider errors stay non-retryable in the public UI", async t => {
  const f = await fixture(t), host = await f.ready(); host.status = "error"; host.retryable = false;
  const result = await f.app.status(f.users[0], "chat-a", 3000); assert.equal(result.preview.retryable, false); assert.equal(result.preview.hostname, null);
});
