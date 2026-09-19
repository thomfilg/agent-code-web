import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createAgentWebServer } from "../src/server.mjs";
import { eventFixture, eventOwner, eventSecret } from "./fixtures/github-events.mjs";
import { testConfig, waitFor } from "./helpers.mjs";

test("actual HTTP webhook route accepts signed unauthenticated hints, rejects forged bodies, and protects private subscriptions", { timeout: 15000 }, async t => {
  const f = await eventFixture(t); await f.monitor.stop(); await f.events.stop();
  const app = await createAgentWebServer({ config: testConfig(f.root, { AGENT_GITHUB_WEBHOOK_SECRET: eventSecret, AGENT_IDLE_TIMEOUT_MS: "60000" }), records: f.records, store: f.store, github: f.github });
  const { url } = await app.start(); t.after(() => app.stop());
  // Session identity is synthetic and never carries a provider credential.
  const session = await app.browserUsers.startSession({ id: eventOwner, username: "fixture-owner" });
  const cookie = session.cookie.split(";")[0];
  const endpoint = `${url}/api/chats/${f.chat.id}/pull-requests/subscription`;
  const patch = (headers, revision = 0) => fetch(endpoint, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ repository: "acme/project", number: 7, notifyFailures: true, wakePassing: false, revision }) });
  assert.equal((await patch({})).status, 404);
  assert.equal((await patch({ cookie, origin: "https://evil.invalid" })).status, 403);
  const accepted = await patch({ cookie }); assert.equal(accepted.status, 200, await accepted.text());
  assert.equal((await patch({ cookie })).status, 409, "stale revision cannot overwrite consent");
  f.canonical.checks = "failing"; f.canonical.run++;
  const raw = Buffer.from(JSON.stringify({ repository: { id: 101, full_name: "acme/project" }, check_run: { head_sha: f.canonical.headSha, pull_requests: [] }, privateText: "never-persist-this-payload" }));
  const headers = { "x-github-delivery": "http-fixture", "x-github-event": "check_run", "x-hub-signature-256": `sha256=${createHmac("sha256", eventSecret).update(raw).digest("hex")}` };
  const send = (body = raw, extra = headers) => fetch(`${url}/webhooks/github`, { method: "POST", headers: extra, body });
  assert.equal((await send(Buffer.concat([raw, Buffer.from(" ")]))).status, 401);
  assert.equal((await send()).status, 202); await app.manager.githubEvents.process();
  assert.equal((await app.manager.githubEvents.state(f.chat.id)).events.length, 1);
  assert.equal((await send()).status, 202); await app.manager.githubEvents.process();
  assert.equal((await app.manager.githubEvents.state(f.chat.id)).events.length, 1);
  assert.equal((await f.records.list("github-webhook")).some(row => JSON.stringify(row).includes("never-persist")), false);
  assert.equal(app.manager.isBusy(f.chat.id), false, "failed checks do not wake stopped workers");
  assert.equal(f.requests.every(request => !request.options.method || request.options.method === "GET"), true);
});

test("held subscription HTTP request cannot grant after owner change or logout", { timeout: 15000 }, async t => {
  for (const mutation of ["owner", "logout"]) {
    const gate = Promise.withResolvers(); let hold = false, entered = false;
    t.after(() => gate.resolve());
    const f = await eventFixture(t, { beforeRequest: async route => { if (hold && route.endsWith("/pulls/7")) { entered = true; await gate.promise; } } });
    await f.monitor.stop(); await f.events.stop();
    const app = await createAgentWebServer({ config: testConfig(f.root, { AGENT_GITHUB_WEBHOOK_SECRET: eventSecret }), records: f.records, store: f.store, github: f.github });
    const { url } = await app.start(); t.after(() => app.stop()); await app.manager.pullRequests.stop();
    const session = await app.browserUsers.startSession({ id: eventOwner, username: "fixture-owner" });
    hold = true;
    const response = fetch(`${url}/api/chats/${f.chat.id}/pull-requests/subscription`, { method: "PATCH", headers: { cookie: session.cookie.split(";")[0], "content-type": "application/json" },
      body: JSON.stringify({ repository: "acme/project", number: 7, notifyFailures: true, wakePassing: true, revision: 0 }) });
    await waitFor(() => entered);
    if (mutation === "owner") await f.store.update(f.chat.id, { ownerId: `user_${"b".repeat(32)}` });
    else for (const row of await f.records.list("browser-user-session")) await f.records.delete("browser-user-session", row.id);
    gate.resolve(); const result = await response;
    assert.equal(result.status, mutation === "owner" ? 404 : 401, await result.text());
    assert.equal(await app.manager.githubEvents.state(f.chat.id), null);
    assert.equal(app.manager.isBusy(f.chat.id), false);
    await app.stop();
  }
});
