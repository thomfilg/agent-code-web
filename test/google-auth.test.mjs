import assert from "node:assert/strict";
import test from "node:test";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { GoogleAuth, sameOriginRedirect } from "../src/google-auth.mjs";
import { loadConfig } from "../src/config.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";
import { googleOidcFixture, googleTestEnv, cookieClient } from "./fixtures/google-oidc.mjs";

async function setup(t, env = {}) {
  const directory = await temporaryDirectory(t), fixture = googleOidcFixture();
  const config = testConfig(directory, { ...googleTestEnv, ...env });
  const app = await createAgentWebServer({ config, googleAuthOptions: { fetchImpl: fixture.fetch } });
  const { url } = await app.start(); config.google.origin = url;
  // The port is allocated by the OS. Rebuild against that exact public origin.
  await app.googleAuth.initialize();
  t.after(() => app.stop());
  return { app, fixture, url, client: () => cookieClient(url) };
}

test("Google setup fails closed and never exposes secrets or accepts the old access-token login", async t => {
  const { app, client } = await setup(t, { GOOGLE_CLIENT_SECRET: "" });
  const browser = client(), info = await (await browser.request("/api/auth")).json();
  assert.equal(info.method, "google"); assert.equal(info.authenticated, false); assert.equal(info.google.configured, false);
  assert.deepEqual(info.google.missing, ["GOOGLE_CLIENT_SECRET"]);
  assert.equal((await browser.request("/")).status, 200);
  for (const route of ["/api/config", "/api/chats", "/api/sidebar", "/api/github", "/api/mcps", "/api/environments", "/api/browser-account"]) assert.equal((await browser.request(route)).status, 401, route);
  assert.equal((await browser.request("/api/session", { method: "POST", body: '{"token":"anything"}' })).status, 405);
  assert.equal((await browser.request("/api/auth/csrf")).status, 503);
  assert.equal((await app.records.list("relay-user")).length, 0);
});

test("real shared-package OAuth flow persists subject identity, revokes logout, and keeps provider tokens out of records", async t => {
  const { app, fixture, client } = await setup(t);
  const browser = client(), user = await browser.login(fixture);
  assert.ok(user.id); assert.equal(user.email, "owner@example.com");
  assert.equal(app.googleAuth.legacyOwnerId, user.id);
  const oldCookie = browser.header();
  const fresh = new GoogleAuth(app.records, app.config.google, { fetchImpl: fixture.fetch }); await fresh.initialize();
  assert.equal((await fresh.session({ headers: { cookie: oldCookie } })).id, user.id);
  const session = (await app.records.list("relay-session"))[0];
  assert.ok(session.expiresAt > Date.now());
  for (const kind of ["relay-user", "relay-session", "relay-auth"]) assert.ok(!JSON.stringify(await app.records.list(kind)).includes("fixture-google-"));
  assert.equal((await browser.authAction("signout")).status, 200);
  assert.equal((await (await browser.request("/api/auth")).json()).authenticated, false);
  assert.equal(await fresh.session({ headers: { cookie: oldCookie } }), null);
  const relogged = await browser.login(fixture);
  assert.equal(relogged.id, user.id);
  assert.equal((await app.records.list("relay-user")).length, 1);
});

test("an authenticated user can save a revision-checked machine default for one environment", async t => {
  const { fixture, client } = await setup(t);
  const browser = client(); await browser.login(fixture);
  const headers = { "content-type": "application/json" };
  assert.equal((await browser.request("/api/companies", { method: "POST", headers, body: JSON.stringify({ id: "fixture", name: "Fixture" }) })).status, 201);
  const created = await browser.request("/api/environments", { method: "POST", headers, body: JSON.stringify({ name: "Cloud", backend: "ec2", companyId: "fixture", instanceType: "t3.medium" }) });
  assert.equal(created.status, 201);
  const environment = (await created.json()).environment;
  const changed = await browser.request(`/api/environments/${environment.id}/instance-type`, { method: "PATCH", headers, body: JSON.stringify({ instanceType: "m7i.xlarge", revision: environment.revision }) });
  assert.equal(changed.status, 200);
  const updated = (await changed.json()).environment;
  assert.equal(updated.instanceType, "m7i.xlarge"); assert.equal(updated.revision, environment.revision + 1);
  const stale = await browser.request(`/api/environments/${environment.id}/instance-type`, { method: "PATCH", headers, body: JSON.stringify({ instanceType: "t3.large", revision: environment.revision }) });
  assert.equal(stale.status, 409);
});

test("another Google user cannot inherit legacy conversations, credentials, environments, groups, preferences or server agents", async t => {
  const { app, fixture, client } = await setup(t);
  const legacy = await app.store.create({ agent: "mock", title: "Old private transcript" });
  await app.records.put("connection", "github", { login: "old-owner", token: "owner-private-credential" });
  const original = JSON.stringify(app.store.get(legacy.id));
  const owner = client(), member = client();
  // Member signs in FIRST: it must not claim existing data.
  const memberUser = await member.login(fixture, { sub: "google-member", email: "member@example.com", email_verified: true });
  assert.equal(app.googleAuth.legacyOwnerId, null);
  const empty = await (await member.request("/api/sidebar")).json(); assert.deepEqual(empty.chats, []);
  assert.equal((await (await member.request("/api/github")).json()).connected, false);
  assert.equal((await (await member.request("/api/github")).json()).localAvailable, false);
  assert.deepEqual((await (await member.request("/api/mcps")).json()).connections, []);
  assert.deepEqual((await (await member.request("/api/preferences")).json()).preferences, {});
  assert.equal((await member.request(`/api/chats/${legacy.id}`)).status, 404);
  const ownerUser = await owner.login(fixture);
  assert.notEqual(ownerUser.id, memberUser.id);
  assert.equal((await owner.request(`/api/chats/${legacy.id}`)).status, 200);
  assert.equal(JSON.stringify(app.store.get(legacy.id)), original, "login does not rewrite stored messages / workspaces");
  const create = await member.request("/api/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "mock", title: "Member conversation", ownerId: ownerUser.id }) });
  assert.equal(create.status, 201);
  const chat = (await create.json()).chat; assert.equal(chat.ownerId, memberUser.id);
  assert.equal((await owner.request(`/api/chats/${chat.id}`)).status, 404);
  const config = await (await member.request("/api/config")).json();
  assert.ok(config.agents.filter(agent => agent.id !== "mock").every(agent => !agent.enabled));
  assert.equal((await member.request("/api/browser-account/register", { method: "POST" })).status, 405);
  const ownerEnvs = (await (await owner.request("/api/environments")).json()).environments;
  const memberEnvs = (await (await member.request("/api/environments")).json()).environments;
  assert.notEqual(ownerEnvs[0].id, memberEnvs[0].id);
  const reveal = await member.request(`/api/environments/${ownerEnvs[0].id}/reveal`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"key":"SECRET"}' });
  assert.equal(reveal.status, 404);
  const crossEnv = await member.request("/api/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "mock", environmentId: ownerEnvs[0].id }) });
  assert.equal(crossEnv.status, 404);
});

test("OAuth rejects missing CSRF, wrong origin/state/nonce, unverified or uninvited accounts and unsafe callback destinations", async t => {
  const { fixture, client, app, url } = await setup(t);
  const browser = client();
  assert.equal((await browser.request("/api/auth/signin/google", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" } })).status, 403);
  const noCsrf = await browser.request("/api/auth/signin/google", { method: "POST", headers: { origin: url, "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" }, body: "csrfToken=wrong" });
  assert.ok(!(await noCsrf.text()).includes("accounts.google.com"));
  for (const profile of [
    { sub: "unverified", email: "owner@example.com", email_verified: false },
    { sub: "uninvited", email: "outsider@example.com", email_verified: true },
    { sub: "wrong-nonce", email: "owner@example.com", email_verified: true, nonce: "wrong" },
  ]) {
    const start = await (await browser.authAction("signin/google")).json();
    const result = await browser.request(fixture.approve(start.url, profile));
    assert.ok(new URL(result.headers.get("location")).searchParams.has("error"));
    assert.equal((await (await browser.request("/api/auth")).json()).authenticated, false);
  }
  const start = await (await browser.authAction("signin/google", { callbackUrl: url + ".evil.example/" })).json();
  const callback = new URL(fixture.approve(start.url)); callback.searchParams.set("state", "wrong");
  await browser.request(callback.href);
  assert.equal((await app.records.list("relay-user")).length, 0);
  for (const redirect of ["//evil.example", "/\\evil.example", url + ".evil.example", "javascript:alert(1)"]) assert.equal(sameOriginRedirect(redirect, url), url + "/");
  assert.equal(sameOriginRedirect("/#chat=saved", url), url + "/#chat=saved");
});

test("Google configuration requires HTTPS outside loopback and a strong explicit session secret", () => {
  assert.throws(() => loadConfig({ ...googleTestEnv, AGENT_WEB_PUBLIC_URL: "http://public.example" }), /HTTPS/);
  assert.throws(() => loadConfig({ ...googleTestEnv, AUTH_SECRET: "weak" }), /32 characters/);
  assert.throws(() => loadConfig({ ...googleTestEnv, AGENT_WEB_PUBLIC_URL: "https://relay.example/path" }), /origin/);
  assert.equal(loadConfig({ ...googleTestEnv, AGENT_WEB_HOST: "0.0.0.0", AGENT_WEB_PUBLIC_URL: "https://relay.example" }).google.enabled, true);
});

test("expired and replaced sessions fail closed; another Google subject with the same email cannot inherit the old owner", async t => {
  const { app, fixture, client } = await setup(t);
  const browser = client(), owner = await browser.login(fixture);
  const originalCookie = browser.header(), originalSession = await app.googleAuth.session({ headers: { cookie: originalCookie } });
  const replacement = await browser.login(fixture, { sub: "different-subject", email: "owner@example.com", email_verified: true });
  assert.notEqual(replacement.id, owner.id); assert.equal(app.googleAuth.legacyOwnerId, owner.id);
  assert.equal(await app.googleAuth.session({ headers: { cookie: originalCookie } }), null);
  assert.equal(app.googleAuth.canRead({ ownerId: owner.id }, originalSession), false);
  const current = await app.googleAuth.session({ headers: { cookie: browser.header() } });
  assert.equal(app.googleAuth.canRead({ ownerId: null }, current), false);
  const saved = await app.records.get("relay-session", current.sessionId);
  await app.records.put("relay-session", saved.id, { ...saved, expiresAt: Date.now() - 1 });
  assert.equal((await browser.request("/api/chats")).status, 401);
});

test("Relay cookies are HttpOnly, secure on HTTPS, and do not collide with other localhost Auth.js apps", async () => {
  const records = new MemoryRecords();
  const config = loadConfig({ ...googleTestEnv, AGENT_WEB_PUBLIC_URL: "https://relay.example" }).google;
  const auth = new GoogleAuth(records, config); await auth.initialize();
  const response = await auth.api.handler(new Request("https://relay.example/api/auth/csrf"));
  assert.equal(response.status, 200);
  for (const cookie of response.headers.getSetCookie()) {
    assert.match(cookie, /^__Host-relay\.auth\./); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/i); assert.doesNotMatch(cookie, /; Domain=/i);
  }
});

test("user-specific resources stay separate at runtime and MCP capabilities route only to their owner", async t => {
  const { app, fixture, client, url } = await setup(t);
  const ownerClient = client(), memberClient = client();
  const owner = await ownerClient.login(fixture);
  const member = await memberClient.login(fixture, { sub: "member", email: "member@example.com", email_verified: true });
  const a = await app.resources.forOwner(owner.id), b = await app.resources.forOwner(member.id);
  for (const services of [a, b]) await services.companies.save({ id: "acme", name: "Acme" });
  assert.equal(a.records, app.records); assert.notEqual(a.mcps, b.mcps);
  await a.records.put("github_connection", "github_12345678-1234-1234-1234-123456789012", { token: "owner-secret" });
  await assert.rejects(b.github.get("github_12345678-1234-1234-1234-123456789012"), /not found/);
  const amcp = await a.mcps.save({ name: "linear", type: "http", url: "https://mcp.example/a", authMode: "headers", headers: { Authorization: "Bearer owner-secret" }, companies: ["acme"] });
  const bmcp = await b.mcps.save({ name: "linear", type: "http", url: "https://mcp.example/b", authMode: "headers", headers: { Authorization: "Bearer member-secret" }, companies: ["acme"] });
  await assert.rejects(b.mcps.get(amcp.id), /not found/);
  const env = await b.environments.save({ name: "Member tools", backend: "local", variables: [], companies: ["acme"], mcpIds: [bmcp.id] });
  await assert.rejects(a.environments.runtime(env.id, { repositories: [{ fullName: "acme/app" }] }), /not found/);
  const chat = { id: "member-chat", ownerId: member.id, environmentId: env.id, repositories: [{ fullName: "acme/app" }] };
  assert.equal((await app.manager.servicesFor(chat)).mcps, b.mcps);
  const grants = await b.mcps.runtime(chat.id, [bmcp.id], url, chat);
  const credential = Object.values(grants)[0].headers.Authorization;
  const wrongEndpoint = await fetch(`${url}/gateway/mcp/${amcp.id}`, { method: "POST", headers: { Authorization: credential }, body: "{}" });
  assert.equal(wrongEndpoint.status, 401);
  app.manager.revokeChatMcps(chat.id);
  assert.equal(b.mcps.broker.size, 0);
});
