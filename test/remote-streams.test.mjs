import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import WebSocket from "ws";
import { createAgentWebServer } from "../src/server.mjs";
import { googleOidcFixture, googleTestEnv } from "./fixtures/google-oidc.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const origin = "https://relay.example.test";

// The HTTP hop received by a TLS-terminating reverse proxy: the canonical Host,
// Origin and Secure cookies are forwarded without trusting X-Forwarded-Host.
function proxyClient(target) {
  const cookies = new Map();
  return {
    cookies, header() { return [...cookies].map(([key, value]) => `${key}=${value}`).join("; "); },
    async request(route, options = {}) {
      const path = new URL(route, origin), response = await fetch(`${target}${path.pathname}${path.search}`, { ...options, redirect: "manual", headers: { host: new URL(origin).host, cookie: this.header(), origin, ...options.headers } });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0], i = pair.indexOf("=");
        if (/Max-Age=0/i.test(cookie)) cookies.delete(pair.slice(0, i)); else cookies.set(pair.slice(0, i), pair.slice(i + 1));
        assert.ok(/; Secure/i.test(cookie), "public HTTPS cookies must remain Secure behind HTTP origin hop");
      }
      return response;
    },
    async action(name) {
      const { csrfToken } = await (await this.request("/api/auth/csrf")).json();
      return this.request(`/api/auth/${name}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" }, body: new URLSearchParams({ csrfToken, callbackUrl: origin + "/" }) });
    },
    async login(provider, profile) {
      const start = await this.action("signin/google"); assert.equal(start.status, 200);
      const callback = provider.approve((await start.json()).url, profile);
      assert.equal(new URL(callback).origin, origin);
      const response = await this.request(callback); assert.equal(response.status, 302);
      const auth = await (await this.request("/api/auth")).json(); assert.equal(auth.authenticated, true); return auth.user;
    },
  };
}

test("public HTTPS origin hop preserves Google ownership, SSE replay and authenticated live-browser WS", async t => {
  const root = await temporaryDirectory(t), provider = googleOidcFixture();
  const app = await createAgentWebServer({ config: testConfig(root, { ...googleTestEnv, AGENT_WEB_PUBLIC_URL: origin, AGENT_WEB_COOKIE_SECURE: "1", AGENT_IDLE_TIMEOUT_MS: "60000" }), googleAuthOptions: { fetchImpl: provider.fetch } });
  const { url } = await app.start(); t.after(() => app.stop());
  const owner = proxyClient(url), other = proxyClient(url), ownerUser = await owner.login(provider);
  await other.login(provider, { sub: "google-member", email: "member@example.com", email_verified: true });
  const chat = await app.store.create({ agent: "mock", ownerId: ownerUser.id, title: "TLS origin stream fixture" });
  const endpoint = `/api/chats/${chat.id}`, live = `${url.replace("http:", "ws:")}${endpoint}/browser/live`;

  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await owner.request(`${endpoint}/events`, { signal: abort.signal });
  assert.equal(stream.status, 200); assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.match(stream.headers.get("cache-control"), /no-transform/);
  let transcript = "", ended = false;
  const read = (async () => { try { for await (const chunk of stream.body) transcript += Buffer.from(chunk).toString(); } catch {} finally { ended = true; } })();
  await waitFor(() => transcript.includes(": connected"));
  app.manager.publishChat(chat);
  await waitFor(() => transcript.includes("chat_updated"));
  const firstId = Number(/id: (\d+)/.exec(transcript)[1]);
  app.manager.publishChat({ ...chat, title: "replayed fixture update" });
  const replayAbort = new AbortController(); t.after(() => replayAbort.abort());
  const replay = await owner.request(`${endpoint}/events`, { headers: { "last-event-id": String(firstId) }, signal: replayAbort.signal });
  let replayText = "";
  const replayRead = (async () => { try { for await (const chunk of replay.body) replayText += Buffer.from(chunk).toString(); } catch {} })();
  await waitFor(() => replayText.includes("replayed fixture update"));
  assert.equal(replayText.includes(`id: ${firstId}\n`), false, "reconnection replays only events after Last-Event-ID");
  replayAbort.abort(); await replayRead;
  assert.equal((await other.request(`${endpoint}/events`)).status, 404);

  const actions = [], browser = new EventEmitter();
  browser.state = { running: true, mode: "guest", tabs: [], tabId: null };
  let connectionChecks = 0;
  browser.ensureConnected = async () => { connectionChecks++; };
  browser.command = async (action, params) => { actions.push({ action, params }); return {}; };
  browser.stop = async () => {};
  const entry = { browser, viewers: new Set() }; entry.ready = Promise.resolve(entry);
  app.manager.browsers.entries.set(chat.id, entry);

  async function rejected(headers, status) {
    const socket = new WebSocket(live, { headers }); socket.on("error", () => {});
    await new Promise(resolve => socket.on("unexpected-response", (_, response) => { assert.equal(response.statusCode, status); response.resume(); socket.terminate(); resolve(); }));
  }
  await rejected({ host: new URL(origin).host, origin, cookie: other.header() }, 404);
  await rejected({ host: new URL(origin).host, origin: "https://foreign.example", cookie: owner.header() }, 403);
  await rejected({ host: "internal-origin.invalid", origin, cookie: owner.header(), "x-forwarded-host": new URL(origin).host }, 403);
  const socket = new WebSocket(live, { headers: { host: new URL(origin).host, origin, cookie: owner.header() } });
  t.after(() => socket.terminate());
  const messages = []; socket.on("message", value => messages.push(JSON.parse(value))); await once(socket, "open");
  await waitFor(() => messages.some(message => message.event === "status"));
  assert.equal(connectionChecks, 1, "only the authorized browser connection reaches the process readiness check");
  socket.send(JSON.stringify({ id: 1, action: "text", params: { text: "remote input" } }));
  await waitFor(() => messages.some(message => message.id === 1));
  assert.ok(actions.some(action => action.action === "text" && action.params.text === "remote input"));
  const closed = once(socket, "close");
  assert.equal((await owner.action("signout")).status, 200);
  assert.equal((await closed)[0], 1000); await waitFor(() => ended); await read;
  assert.equal((await owner.request(`${endpoint}/events`)).status, 401);
  assert.equal(app.store.get(chat.id).messages.length, 0, "stream/browser transport must never send model prompts");
});
