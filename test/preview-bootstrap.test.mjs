import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { PreviewBootstrap, PREVIEW_COOKIE } from "../src/preview-bootstrap.mjs";
import { PreviewGrants } from "../src/preview-grants.mjs";

const origin = "https://relay.example.test", host = "one.preview.example.test";
const binding = { ownerId: "owner-a", sessionId: "session-a", chatId: "chat-a", hostname: host, port: 3000, runtimeGeneration: 1 };
const user = { id: "owner-a", sessionId: "session-a", expiresAt: 1e12 };
const prefix = "/__relay_preview/";
async function fixture(t, options = {}) {
  const state = { now: 1000, current: true, user, gate: null, hosts: new Map([[host, { ...binding }]]) };
  const current = value => state.current && state.hosts.get(value.hostname)?.ownerId === value.ownerId;
  const grants = new PreviewGrants({ isCurrent: current, now: () => state.now });
  const bootstrap = new PreviewBootstrap({ relayOrigin: origin, grants, lookupHost: hostname => state.hosts.get(hostname),
    isCurrent: current, now: () => state.now, authenticate: async req => { if (state.gate) await state.gate; return req.headers["x-fixture-user"] === "denied" ? null : state.user; }, ...options });
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    try {
      const handled = req.headers.host === "relay.example.test" ? await bootstrap.handleRelay(req, res, url) : await bootstrap.handlePreview(req, res, url);
      if (!handled) { res.statusCode = 404; res.end("not a Relay route"); }
    } catch { res.statusCode = 500; res.end("fixture failure"); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { bootstrap.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const send = ({ path, hostname = host, method = "POST", body, headers = {} }) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, method, path, agent: false, headers: { host: hostname, origin, "content-type": "application/json", ...(body?.launch ? { "x-relay-preview-launch": body.launch } : {}), ...headers } }, res => {
      let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => { let value; try { value = JSON.parse(text); } catch { value = null; } resolve({ status: res.statusCode, headers: res.headers, text, value }); });
    }); req.on("error", reject); req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  const start = (changes = {}, path = "/app?x=1#fragment") => {
    const saved = { ...binding, ...changes }; state.hosts.set(saved.hostname, saved);
    const result = bootstrap.start({ binding: saved, user: { ...user, id: saved.ownerId, sessionId: saved.sessionId }, path });
    const launch = new URL(result.url).searchParams.get("launch"); return { ...result, launch, hostname: saved.hostname, binding: saved };
  };
  const challenge = async flow => {
    const response = await send({ path: prefix + "challenge", hostname: flow.hostname, body: { launch: flow.launch } });
    assert.equal(response.status, 200); return { ...flow, challenge: response.value.challenge, nonceCookie: response.headers["set-cookie"][0].split(";")[0], challengeResponse: response };
  };
  const approve = async flow => {
    const response = await send({ path: "/api/app-preview/bootstrap", hostname: "relay.example.test", body: { launch: flow.launch, challenge: flow.challenge } });
    assert.equal(response.status, 200); return { ...flow, ticket: response.value.ticket };
  };
  const exchange = flow => send({ path: prefix + "exchange", hostname: flow.hostname, body: { launch: flow.launch, ticket: flow.ticket }, headers: { cookie: flow.nonceCookie } });
  const opened = async (changes = {}) => {
    const flow = await approve(await challenge(start(changes))), result = await exchange(flow); assert.equal(result.status, 200);
    return { ...flow, grantCookie: result.headers["set-cookie"][0].split(";")[0], exchangeResponse: result };
  };
  const probe = flow => send({ path: prefix + "probe", hostname: flow.hostname, body: { launch: flow.launch }, headers: { cookie: flow.grantCookie } });
  return { state, bootstrap, grants, server, send, start, challenge, approve, exchange, opened, probe };
}
const fakeRequest = (hostname, value) => ({ url: "/app", headers: { host: hostname, cookie: value }, rawHeaders: ["Host", hostname] });

test("trusted launch page contains no grant, has exact CSP and retains app path/query/fragment", async t => {
  const f = await fixture(t), flow = f.start();
  assert.equal(new URL(flow.url).origin, origin); assert.doesNotMatch(flow.url, /pbt_|psg_|preview\.example/);
  const response = await f.send({ path: new URL(flow.url).pathname + new URL(flow.url).search, hostname: "relay.example.test", method: "GET" });
  assert.equal(response.status, 200); assert.match(response.text, /https:\/\/one.preview.example.test\/app\?x=1#fragment/);
  assert.doesNotMatch(response.text, /pbt_|psg_/); assert.match(response.text, /credentials:'include'/);
  assert.match(response.headers["content-security-policy"], /connect-src 'self' https:\/\/one.preview.example.test;/);
  assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(response.headers["referrer-policy"], "no-referrer"); assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.text, /blocking cross-site cookies/); assert.match(response.text, /five minutes/);
});

test("complete cookie-bound flow exposes grant only in HttpOnly Set-Cookie, then single-use probe", async t => {
  const f = await fixture(t), flow = await f.opened();
  assert.equal(flow.exchangeResponse.text, '{"ok":true}');
  for (const value of [flow.challengeResponse.headers["set-cookie"][0], flow.exchangeResponse.headers["set-cookie"][0]]) {
    assert.match(value, /Path=\/; Secure; HttpOnly; SameSite=None; Max-Age=/); assert.doesNotMatch(value, /Domain=/);
  }
  assert.match(flow.exchangeResponse.headers["set-cookie"][1], /Max-Age=0$/);
  const lease = f.bootstrap.authorize(fakeRequest(host, flow.grantCookie), host);
  assert.deepEqual(lease.binding, binding); assert.equal(lease.signal.aborted, false);
  assert.equal((await f.probe(flow)).status, 200); assert.equal((await f.probe(flow)).status, 403);
  assert.equal((await f.exchange(flow)).status, 403); assert.equal(lease.signal.aborted, false);
});

test("captured launch/challenge cannot authorize with another owner/session or missing login", async t => {
  const f = await fixture(t), flow = await f.challenge(f.start());
  for (const wrong of [null, { ...user, id: "owner-b" }, { ...user, sessionId: "session-b" }, { ...user, expiresAt: 999 }]) {
    f.state.user = wrong;
    assert.equal((await f.send({ path: new URL(flow.url).pathname + new URL(flow.url).search, hostname: "relay.example.test", method: "GET" })).status, 403);
    assert.equal((await f.send({ path: "/api/app-preview/bootstrap", hostname: "relay.example.test", body: { launch: flow.launch, challenge: flow.challenge } })).status, 403);
  }
  f.state.user = user; assert.match((await f.approve(flow)).ticket, /^pbt_/);
});

test("stolen authorized ticket alone or substituted browser nonce cannot mint a grant", async t => {
  const f = await fixture(t), flow = await f.approve(await f.challenge(f.start()));
  for (const value of [undefined, flow.nonceCookie.replace(/=.*/, "=" + "A".repeat(43)), flow.nonceCookie + "; " + flow.nonceCookie]) {
    const result = await f.send({ path: prefix + "exchange", body: { launch: flow.launch, ticket: flow.ticket }, headers: value ? { cookie: value } : {} });
    assert.equal(result.status, 403); assert.equal(result.headers["set-cookie"], undefined); assert.doesNotMatch(result.text, /pbt_|psg_/);
  }
  assert.equal((await f.exchange(flow)).status, 200);
});

test("parallel tabs have distinct nonce cookies; cross-tab challenge/ticket/grant substitution is denied", async t => {
  const f = await fixture(t), a = await f.approve(await f.challenge(f.start())), b = await f.approve(await f.challenge(f.start()));
  assert.notEqual(a.nonceCookie.split("=")[0], b.nonceCookie.split("=")[0]);
  assert.equal((await f.exchange({ ...a, nonceCookie: b.nonceCookie })).status, 403);
  assert.equal((await f.exchange({ ...a, ticket: b.ticket })).status, 403);
  const ar = await f.exchange(a), br = await f.exchange(b); assert.equal(ar.status, 200); assert.equal(br.status, 200);
  assert.equal((await f.probe({ ...a, grantCookie: br.headers["set-cookie"][0].split(";")[0] })).status, 403);
});

test("CORS is exact Relay origin with no wildcard, unrelated origins and methods never receive authority", async t => {
  const f = await fixture(t), flow = f.start();
  for (const value of ["https://evil.test", "null", "https://relay.example.test.evil", "https://relay.example.test:443", "https://one.preview.example.test"]) {
    const result = await f.send({ path: prefix + "challenge", body: { launch: flow.launch }, headers: { origin: value } });
    assert.equal(result.status, 403); assert.equal(result.headers["access-control-allow-origin"], undefined);
  }
  const preflight = await f.send({ path: prefix + "challenge", method: "OPTIONS", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-relay-preview-launch" } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers["access-control-allow-origin"], origin); assert.equal(preflight.headers["access-control-allow-credentials"], "true");
  assert.equal((await f.send({ path: prefix + "challenge", method: "GET" })).status, 403);
  assert.equal((await f.send({ path: "/api/app-preview/bootstrap", hostname: "relay.example.test", body: { launch: flow.launch, challenge: "A".repeat(43) }, headers: { origin: "https://evil.test" } })).status, 403);
});

test("unknown/rebound hosts, extra query/body fields and Relay routes on preview fail closed", async t => {
  const f = await fixture(t), flow = f.start();
  assert.equal((await f.send({ path: prefix + "challenge", hostname: "evil.test", body: { launch: flow.launch } })).status, 403);
  assert.equal((await f.send({ path: prefix + "challenge?x=1", body: { launch: flow.launch } })).status, 403);
  assert.equal((await f.send({ path: prefix + "challenge", body: { launch: flow.launch, hostname: "evil.test" } })).status, 403);
  assert.equal((await f.send({ path: "/api/chats", method: "GET" })).status, 404);
  f.state.hosts.set(host, { ...binding, port: 9000 });
  assert.equal((await f.send({ path: prefix + "challenge", body: { launch: flow.launch } })).status, 403);
});

test("cookie-blocked probe never succeeds using an unrelated old grant and does not clear existing cookie", async t => {
  const f = await fixture(t), old = await f.opened(); assert.equal((await f.probe(old)).status, 200);
  const fresh = await f.opened();
  for (const value of [undefined, old.grantCookie]) {
    const result = await f.send({ path: prefix + "probe", body: { launch: fresh.launch }, headers: value ? { cookie: value } : {} });
    assert.equal(result.status, 403); assert.equal(result.headers["set-cookie"], undefined);
  }
  assert.equal(f.bootstrap.authorize(fakeRequest(host, old.grantCookie), host).signal.aborted, false);
});

test("owner/session/chat/host revocation aborts live leases and pending flows with exact scope", async t => {
  for (const method of ["revokeOwner", "revokeSession", "revokeChat", "revokeHostname"]) {
    const f = await fixture(t), flow = await f.opened(); await f.probe(flow);
    const other = await f.opened({ hostname: "two.preview.example.test", port: 3001 }); await f.probe(other);
    const lease = f.bootstrap.authorize(fakeRequest(host, flow.grantCookie), host), otherLease = f.bootstrap.authorize(fakeRequest(other.hostname, other.grantCookie), other.hostname);
    const args = method === "revokeHostname" ? [host] : method === "revokeChat" ? [user.id, binding.chatId] : method === "revokeSession" ? [user.id, user.sessionId] : [user.id];
    f.bootstrap[method](...args); assert.equal(lease.signal.aborted, true); assert.equal(otherLease.signal.aborted, method !== "revokeHostname");
    assert.throws(() => f.bootstrap.authorize(fakeRequest(host, flow.grantCookie), host), /Preview access is unavailable/);
  }
});

test("scope changes after async authentication cannot issue or serve the launch", async t => {
  const f = await fixture(t), flow = await f.challenge(f.start()); let release;
  f.state.gate = new Promise(resolve => release = resolve);
  const pending = f.send({ path: "/api/app-preview/bootstrap", hostname: "relay.example.test", body: { launch: flow.launch, challenge: flow.challenge } });
  await new Promise(resolve => setTimeout(resolve, 20)); f.bootstrap.revokeChat(user.id, binding.chatId); release();
  assert.equal((await pending).status, 403);
});

test("expiration, capacity, invalid paths and restart never renew or restore access", async t => {
  const f = await fixture(t, { maxFlows: 1, maxPerOwner: 1 }); f.start(); assert.throws(() => f.start(), /Preview access/);
  f.state.now += 60000; const fresh = f.start(); assert.ok(fresh.url);
  const g = await fixture(t);
  for (const path of ["//evil.test", "https://evil.test/", "/\\evil", "/\rno", "/%5cevil", prefix + "challenge", "x".repeat(4097)]) assert.throws(() => g.start({}, path), /Preview access/);
  const flow = await g.opened(), lease = g.bootstrap.authorize(fakeRequest(host, flow.grantCookie), host);
  g.bootstrap.close(); assert.equal(lease.signal.aborted, true); assert.throws(() => g.bootstrap.start({ binding, user }), /Preview access/);
});

test("malformed/oversized JSON and private thrown diagnostics produce only the fixed public error", async t => {
  const f = await fixture(t), flow = f.start();
  for (const body of ['{"PRIVATE-SECRET":', '"PRIVATE-SECRET"', "[1]", JSON.stringify({ launch: flow.launch, secret: "X".repeat(5000) })]) {
    const response = await f.send({ path: prefix + "challenge", body }); assert.equal(response.status, 403);
    assert.equal(response.text, '{"error":"Preview access is unavailable. Open it again from Relay."}');
  }
});

test("Stop/revoke interrupts an exact pending bootstrap body before its read timeout", async t => {
  const f = await fixture(t), flow = f.start();
  const response = new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: f.server.address().port, method: "POST", path: prefix + "challenge", agent: false,
      headers: { host, origin, "content-type": "application/json", "content-length": "1000", "x-relay-preview-launch": flow.launch } }, res => {
      let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode, text }));
    }); req.on("error", reject); req.write("{"); t.after(() => req.destroy());
  });
  await new Promise(resolve => setTimeout(resolve, 20)); f.bootstrap.revokeHostname(host);
  const timer = setTimeout(() => assert.fail("revoked body was not released"), 1000);
  try { const result = await response; assert.equal(result.status, 403); assert.match(result.text, /Preview access is unavailable/); }
  finally { clearTimeout(timer); }
});
