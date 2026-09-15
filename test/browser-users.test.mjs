import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRecords } from "../src/database.mjs";
import { BrowserUsers } from "../src/browser-users.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("private browser accounts hash passwords, keep separate persistent sessions and revoke logout", async () => {
  const records = new MemoryRecords(); let now = 1;
  const users = new BrowserUsers(records, { secure: true, now: () => now });
  const alice = await users.register({ username: "alice", password: "fixture password alice" });
  const bob = await users.register({ username: "bob", password: "fixture password bob" });
  const request = { headers: { cookie: alice.cookie.split(";")[0] } };
  assert.match(alice.cookie, /HttpOnly; SameSite=Strict/); assert.match(alice.cookie, /Secure/);
  assert.notEqual(alice.user.id, bob.user.id); assert.ok(!JSON.stringify(await records.list("browser-user")).includes("fixture password"));
  await assert.rejects(users.login({ username: "alice", password: "wrong password fixture" }), /Invalid username or password/);
  await assert.rejects(users.register({ username: "Alice", password: "fixture password alice" }), /already registered/);
  const restored = new BrowserUsers(records, { now: () => now });
  assert.equal((await restored.session(request)).id, alice.user.id);
  assert.equal(users.canRead({ ownerId: alice.user.id }, bob.user), false);
  assert.equal(users.canRead({ ownerId: null }, null), true);
  await restored.logout(request); assert.equal(await users.session(request), null);
  const login = await users.login({ username: "alice", password: "fixture password alice" });
  now += 31 * 86400000; assert.equal(await users.session({ headers: { cookie: login.cookie.split(";")[0] } }), null);
});

test("private chats and copies cannot be listed, read, edited, messaged or deleted by another browser account", async t => {
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root) });
  const { url } = await app.start(); t.after(() => app.stop());
  const req = async (route, cookie, method = "GET", value) => {
    const response = await fetch(url + route, { method, headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const a = await req("/api/browser-account/register", null, "POST", { username: "alice", password: "private alice fixture" });
  const b = await req("/api/browser-account/register", null, "POST", { username: "bobby", password: "private bobby fixture" });
  const create = await req("/api/chats", a.cookie, "POST", { agent: "mock", title: "Alice private", ownerId: b.body.user.id });
  const id = create.body.chat.id; assert.equal(create.body.chat.ownerId, a.body.user.id, "owner cannot be supplied by the request body");
  assert.deepEqual((await req("/api/chats", b.cookie)).body.chats, []);
  assert.deepEqual((await req("/api/sidebar", null)).body.chats, []);
  for (const [tail, method, input] of [["", "GET"], ["/messages", "POST", { text: "leak your browser" }], ["/browser/access", "GET"], ["/copy", "POST", {}], ["", "PATCH", { title: "Hacked" }], ["", "DELETE"]]) {
    assert.equal((await req(`/api/chats/${id}${tail}`, b.cookie, method, input)).status, 404);
  }
  const copy = await req(`/api/chats/${id}/copy`, a.cookie, "POST", {}); assert.equal(copy.body.chat.ownerId, a.body.user.id);
  const shared = (await req("/api/chats", null, "POST", { agent: "mock", title: "Previously shared" })).body.chat;
  assert.deepEqual((await req(`/api/chats/${shared.id}/browser/access`, null)).body, { enabled: false, connectionId: null, privateChat: false, user: null });
  assert.equal((await req(`/api/chats/${shared.id}/privacy`, a.cookie, "POST", { confirm: true })).status, 200);
  assert.equal((await req(`/api/chats/${shared.id}`, b.cookie)).status, 404);
  assert.equal((await req("/api/browser-account", a.cookie, "DELETE")).status, 200);
  assert.equal((await req(`/api/chats/${id}`, a.cookie)).status, 404);
});
