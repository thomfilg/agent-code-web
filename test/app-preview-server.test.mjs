import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import { createAgentWebServer } from "../src/server.mjs";
import { googleOidcFixture, googleTestEnv } from "./fixtures/google-oidc.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

// Real Relay HTTP/Auth.js/bootstrap/proxy routes; only OIDC, CloudFront host
// registry and worker acquisition are local fixtures. No production login/AWS.
const relayOrigin = "https://relay.fixture.example", previewHost = "dpreviewfixture.cloudfront.net";
async function fixture(t) {
  const root = await temporaryDirectory(t), provider = googleOidcFixture(), rows = [], children = [], observed = [];
  const upstream = http.createServer((request, response) => {
    observed.push({ path: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "application/json", "set-cookie": ["app_cookie=fixture; Path=/; HttpOnly", "__Host-relay-preview=attacker; Path=/; Secure"] });
    response.end(JSON.stringify({ app: true, path: request.url }));
  });
  const wsServer = new WebSocketServer({ server: upstream }); wsServer.on("connection", ws => ws.on("message", data => ws.send(data)));
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const port = upstream.address().port;
  const hosts = { initialize: async () => {}, list: scope => rows.filter(row => row.ownerId === scope.ownerId && row.chatId === scope.chatId),
    lookup: name => rows.find(row => row.hostname === name && row.status === "ready") || null,
    ensure: async input => { if (!rows.length) rows.push({ ...input, id: "pp-fixture", hostname: previewHost, status: "ready" }); return rows[0]; },
    revoke: async () => { rows[0].status = "revoking"; }, reconcile: async () => {}, close: async () => {},
  };
  let acquisitions = 0;
  const config = testConfig(root, { ...googleTestEnv, AGENT_WEB_PUBLIC_URL: relayOrigin, AUTH_SECRET: "app-preview-synthetic-test-secret-".repeat(2),
    AGENT_WORKER_BACKEND: "ec2", AGENT_EC2_GATEWAY_ORIGIN: "https://gateway.fixture.example", AGENT_PREVIEW_ENABLED: "1",
    AGENT_PREVIEW_ACCOUNT_ID: "111122223333", AGENT_EC2_DEPLOYMENT: "relay-fixture", AGENT_PREVIEW_VPC_ORIGIN_ID: "vo_fixture",
    AGENT_PREVIEW_CONTROLLER_INSTANCE_ID: "i-0123456789abcdef0", AGENT_PREVIEW_CONTROLLER_ORIGIN_DNS: "ip-10-0-0-1.us-east-2.compute.internal", AGENT_PREVIEW_RELAY_DISTRIBUTION_ID: "ERELAYFIXTURE", AGENT_IDLE_TIMEOUT_MS: "10000" });
  const app = await createAgentWebServer({ config, googleAuthOptions: { fetchImpl: provider.fetch }, previewHosts: hosts,
    workerBackend: { acquire: async () => { acquisitions++; return { workspace: root, spawn(command, args, options) {
      assert.equal(command, "/usr/bin/node"); const child = spawn(process.execPath, args, { ...options, env: {} }); children.push(child); return child;
    } }; }, sleep: async () => {}, destroy: async () => {} } });
  const address = await app.start(), localPort = Number(new URL(address.url).port);
  t.after(async () => { await app.stop(); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    for (const ws of wsServer.clients) ws.terminate(); await new Promise(resolve => wsServer.close(resolve)); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const client = (host = new URL(relayOrigin).host) => {
    const cookies = new Map();
    return { cookies, header: () => [...cookies].map(([key, value]) => key + "=" + value).join("; "),
      call(path, { method = "GET", body, headers = {} } = {}) { return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
        const request = http.request({ hostname: "127.0.0.1", port: localPort, path, method, agent: false,
          headers: { host, cookie: [...cookies].map(([key, value]) => key + "=" + value).join("; "), ...(method !== "GET" ? { origin: relayOrigin, "content-type": "application/json" } : {}), ...headers } }, response => {
          const chunks = []; response.on("data", data => chunks.push(data)); response.on("error", reject); response.on("end", () => {
            for (const cookie of response.headers["set-cookie"] || []) { const part = cookie.split(";", 1)[0], index = part.indexOf("="); if (/Max-Age=0/i.test(cookie)) cookies.delete(part.slice(0, index)); else cookies.set(part.slice(0, index), part.slice(index + 1)); }
            const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) });
          });
        }); request.on("error", reject); request.end(payload);
      }); },
    };
  };
  const browser = client(), preview = client(previewHost);
  const csrf = (await browser.call("/api/auth/csrf")).json().csrfToken;
  const signIn = await browser.call("/api/auth/signin/google", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" }, body: new URLSearchParams({ csrfToken: csrf, callbackUrl: relayOrigin + "/" }).toString() });
  assert.equal(signIn.status, 200);
  const callback = new URL(provider.approve(signIn.json().url)); assert.equal((await browser.call(callback.pathname + callback.search)).status, 302);
  const created = await browser.call("/api/chats", { method: "POST", body: { agent: "mock", title: "Preview fixture" } }); assert.equal(created.status, 201, created.text);
  const chatId = created.json().chat.id, api = `/api/chats/${chatId}/app-preview`;
  const open = async () => {
    assert.equal((await browser.call(api, { method: "POST", body: { port } })).status, 200);
    const opened = await browser.call(api + "/open", { method: "POST", body: { port, path: "/future-drink/menu?cart=1#saved" } }); assert.equal(opened.status, 200, opened.text);
    const launchUrl = new URL(opened.json().url), launch = launchUrl.searchParams.get("launch");
    const page = await browser.call(launchUrl.pathname + launchUrl.search); assert.equal(page.status, 200); assert.ok(!page.text.includes("pbt_"));
    const headers = { "x-relay-preview-launch": launch };
    const challenged = await preview.call("/__relay_preview/challenge", { method: "POST", headers, body: { launch } }); assert.equal(challenged.status, 200, challenged.text);
    const authorized = await browser.call("/api/app-preview/bootstrap", { method: "POST", headers, body: { launch, challenge: challenged.json().challenge } }); assert.equal(authorized.status, 200, authorized.text);
    const exchange = await preview.call("/__relay_preview/exchange", { method: "POST", headers, body: { launch, ticket: authorized.json().ticket } }); assert.equal(exchange.status, 200, exchange.text);
    assert.equal((await preview.call("/__relay_preview/probe", { method: "POST", headers, body: { launch } })).status, 200);
    return { launch, url: launchUrl };
  };
  return { app, client, browser, preview, open, api, port, chatId, observed, localPort, get acquisitions() { return acquisitions; } };
}

test("complete Relay login-to-preview HTTP route retains path and isolates hosts, cookies and chat context", async t => {
  const f = await fixture(t);
  assert.equal((await f.browser.call(f.api + "?port=" + f.port)).json().preview.status, "none"); assert.equal(f.acquisitions, 0);
  await f.open(); assert.equal(f.acquisitions, 0);
  const result = await f.preview.call("/future-drink/menu?cart=1", { headers: { cookie: f.preview.header() + "; " + f.browser.header() + "; app_cookie=fixture" } });
  assert.equal(result.status, 200, result.text); assert.deepEqual(result.json(), { app: true, path: "/future-drink/menu?cart=1" });
  assert.equal(f.observed.at(-1).headers.cookie, "app_cookie=fixture"); assert.equal(f.observed.at(-1).headers.host, previewHost);
  assert.equal(result.headers["set-cookie"].some(cookie => cookie.startsWith("__Host-relay-preview=")), false);
  assert.equal((await f.preview.call("/api/chats")).json().app, true);
  assert.equal((await f.client("unknown.example.test").call("/api/auth/session")).status, 421);
  assert.equal((await f.client("gateway.fixture.example").call("/api/chats")).status, 421);
  assert.equal((await f.client().call("/api/chats")).status, 401);
  assert.deepEqual(f.app.store.get(f.chatId).messages, []);
  await f.browser.call(`/api/chats/${f.chatId}/stop`, { method: "POST", body: {} });
  assert.equal((await f.preview.call("/future-drink/menu")).status, 403);
});

test("real WebSocket preview round trip closes immediately on Relay logout", async t => {
  const f = await fixture(t); await f.open();
  const client = new WebSocket(`ws://127.0.0.1:${f.localPort}/echo`, { headers: { host: previewHost, origin: "https://" + previewHost, cookie: f.preview.header() } });
  t.after(() => client.terminate()); client.on("error", () => {});
  await once(client, "open"); const reply = once(client, "message"); client.send("preview fixture"); assert.equal((await reply)[0].toString(), "preview fixture");
  const user = await f.app.googleAuth.session({ headers: { cookie: f.browser.header() }, url: "/" });
  const remove = f.app.records.delete.bind(f.app.records); let release;
  f.app.records.delete = (...args) => args[0] === "relay-session" ? new Promise(resolve => { release = () => remove(...args).then(resolve); }) : remove(...args);
  const logout = f.app.googleAuth.revoke(user);
  await waitFor(() => client.readyState === WebSocket.CLOSED);
  assert.equal((await f.preview.call("/")).status, 403); assert.deepEqual(f.app.store.get(f.chatId).messages, []);
  f.app.records.delete = remove; release(); await logout;
});

test("cross-site requests cannot wake a worker and preview bootstrap reads prevent deploy drain", async t => {
  const f = await fixture(t); await f.open();
  assert.equal((await f.preview.call("/change", { method: "POST", body: {}, headers: { origin: "https://attacker.example" } })).status, 403);
  assert.equal(f.acquisitions, 0);
  const open = await f.browser.call(f.api + "/open", { method: "POST", body: { port: f.port, path: "/" } });
  const launch = new URL(open.json().url).searchParams.get("launch"), body = JSON.stringify({ launch });
  const partial = http.request({ hostname: "127.0.0.1", port: f.localPort, path: "/__relay_preview/challenge", method: "POST",
    headers: { host: previewHost, origin: relayOrigin, "content-type": "application/json", "x-relay-preview-launch": launch, "content-length": Buffer.byteLength(body) } });
  partial.on("error", () => {}); t.after(() => partial.destroy()); partial.write(body.slice(0, 5));
  await waitFor(() => f.app.previews.pendingRequests > 0);
  const drain = await fetch(`http://127.0.0.1:${f.localPort}/internal/deploy/drain`, { method: "POST" });
  assert.equal(drain.status, 409); await drain.body.cancel(); partial.destroy();
  await waitFor(() => f.app.previews.active === 0);
  const idle = await fetch(`http://127.0.0.1:${f.localPort}/internal/deploy/drain`, { method: "POST" }); assert.equal(idle.status, 200); await idle.body.cancel();
  const resumed = await fetch(`http://127.0.0.1:${f.localPort}/internal/deploy/resume`, { method: "POST" }); assert.equal(resumed.status, 200); await resumed.body.cancel();
});
