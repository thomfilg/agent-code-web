import assert from "node:assert/strict";
import test from "node:test";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";
import { googleOidcFixture, googleTestEnv, cookieClient } from "./fixtures/google-oidc.mjs";

test("GitHub native login HTTP routes are private to each Google user and reject all token/host imports", async t => {
  const directory = await temporaryDirectory(t), fixture = googleOidcFixture();
  const config = testConfig(directory, googleTestEnv);
  const app = await createAgentWebServer({ config, googleAuthOptions: { fetchImpl: fixture.fetch } });
  const { url } = await app.start(); config.google.origin = url; await app.googleAuth.initialize();
  t.after(() => app.stop());
  const anonymous = cookieClient(url), owner = cookieClient(url), member = cookieClient(url);
  const post = (client, route, data) => client.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  assert.equal((await post(anonymous, "/api/github/device", {})).status, 401);
  const ownerUser = await owner.login(fixture);
  await member.login(fixture, { sub: "google-member", email: "member@example.com", email_verified: true });
  const service = (await app.resources.forOwner(ownerUser.id)).github;
  let cancelled = false;
  service.loginFactory = () => { let reject; return { start: onCode => new Promise((resolve, fail) => { reject = fail; onCode({ userCode: "TEST-CODE", verificationUrl: "https://github.com/login/device" }); }), close: async () => { cancelled = true; reject?.(new Error("cancelled")); } }; };
  for (const client of [owner, member]) for (const input of [{ token: "fixture_token_secret" }, { method: "local" }]) {
    assert.equal((await post(client, "/api/github", input)).status, 400);
    assert.equal((await post(client, "/api/github/device", input)).status, 400);
  }
  await post(owner, "/api/companies", { id: "acme", name: "Acme" });
  const login = await (await post(owner, "/api/github/device", { companyId: "acme" })).json();
  assert.equal(login.connection.signIn.userCode, "TEST-CODE");
  assert.deepEqual((await (await member.request("/api/github")).json()).connections, []);
  assert.equal((await post(member, "/api/github/device/poll", { id: login.id })).status, 404);
  assert.equal((await post(member, "/api/github/device/cancel", { id: login.id })).status, 404);
  assert.equal((await member.request(`/api/github/connections/${login.connection.id}`, { method: "DELETE" })).status, 404);
  assert.equal(cancelled, false);
  assert.equal((await post(owner, "/api/github/device/cancel", { id: login.id })).status, 200);
  assert.equal(cancelled, true);
});
