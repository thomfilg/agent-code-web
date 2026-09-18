import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, symlink, chmod } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import WebSocket from "ws";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";
import { googleOidcFixture, googleTestEnv } from "./fixtures/google-oidc.mjs";
import { parseTransportOptions, readTransportCookie, smokeDeployedTransports, probeSidebarStream, probePairingTransport, transportOrigin } from "../scripts/smoke-deployed-transports.mjs";

const cookie = "__Host-relay.auth.sessionToken=synthetic-private-session";

test("default deployed transport plan never reads cookies or starts network/model/browser work", async () => {
  const die = () => { throw Error("must not run"); };
  const plan = await smokeDeployedTransports(parseTransportOptions(["--cookie-file", "/private/session"]), { fetchImpl: die, websocket: die, readCookie: die });
  assert.equal(plan.dryRun, true); assert.equal(plan.chromeStarts, 0); assert.equal(plan.awsMutations, 0);
  for (const args of [["--cookie", cookie], ["--cookie-file", "relative"], ["--origin", "https://foreign.example"], ["--run", "--cookie-file"]]) assert.throws(() => parseTransportOptions(args));
});

test("private session file accepts only Relay HTTPS cookies and detects changes without modifying source", async t => {
  const directory = await temporaryDirectory(t), filename = path.join(directory, "session");
  await writeFile(filename, cookie + "\n", { mode: 0o600 });
  const source = await readTransportCookie(filename); assert.equal(source.cookie, cookie); await source.assertUnchanged();
  const link = path.join(directory, "link"); await symlink(filename, link); await assert.rejects(readTransportCookie(link));
  await chmod(filename, 0o644); await assert.rejects(readTransportCookie(filename)); await chmod(filename, 0o600);
  for (const invalid of [cookie + "; GOOGLE_TOKEN=private", cookie + "\r\nOther: value", cookie + "; " + cookie, "relay.auth.sessionToken=not-secure", "__Host-relay.auth.sessionToken="]) {
    await writeFile(filename, invalid); await assert.rejects(readTransportCookie(filename));
  }
  await writeFile(filename, "__Host-relay.auth.sessionToken.0=chunk1; __Host-relay.auth.sessionToken.1=chunk2");
  assert.match((await readTransportCookie(filename)).cookie, /chunk2/);
  await assert.rejects(source.assertUnchanged(), /changed/);
});

async function deployedFixture(t) {
  const root = await temporaryDirectory(t), provider = googleOidcFixture();
  const app = await createAgentWebServer({ config: testConfig(root, { ...googleTestEnv, AGENT_WEB_PUBLIC_URL: transportOrigin, AGENT_WEB_COOKIE_SECURE: "1" }), googleAuthOptions: { fetchImpl: provider.fetch } });
  const { url } = await app.start(); t.after(() => app.stop());
  const requests = [];
  const fetchImpl = (input, options) => {
    assert.equal(new URL(input).origin, transportOrigin); requests.push({ route: new URL(input).pathname, headers: options.headers });
    // The deployment health gate has its own coverage; this fixture exercises
    // the unchanged production auth/stream/pairing handlers independently.
    if (new URL(input).pathname === "/readyz") return Promise.resolve(Response.json({ ok: true }));
    return fetch(url + new URL(input).pathname, { ...options, headers: { host: new URL(transportOrigin).host, ...options.headers } });
  };
  const websocket = (input, options) => {
    assert.equal(input, transportOrigin.replace("https:", "wss:") + "/browser/connect");
    assert.equal(options.headers.cookie, undefined); assert.equal(options.rejectUnauthorized, true); assert.equal(options.followRedirects, false);
    return new WebSocket(url.replace("http:", "ws:") + "/browser/connect", options);
  };
  return { app, fetchImpl, websocket, requests };
}

test("existing production handlers prove anonymous 401 and real 101/frame/rejection without users or pairing mutation", async t => {
  const f = await deployedFixture(t);
  const pending = { id: "untouched-fixture", expiresAt: Date.now() + 60000 };
  f.app.manager.browsers.personal.pairings.set("existing-fixture", pending);
  const receipt = await smokeDeployedTransports({ run: true }, f);
  assert.equal(receipt.anonymousSseStatus, 401); assert.equal(receipt.websocket.upgradeStatus, 101);
  assert.equal(receipt.websocket.serverFrameDelivered, true); assert.equal(receipt.websocket.closeCode, 1008);
  assert.deepEqual(receipt.sse, { verified: false, reason: "legitimate-user-session-required" });
  assert.equal(receipt.authenticatedLiveBrowserVerified, false); assert.equal(receipt.chatReplayVerified, false);
  assert.equal(f.app.store.list().length, 0); assert.equal(f.app.manager.browsers.entries.size, 0);
  assert.deepEqual([...f.app.manager.browsers.personal.pairings.values()], [pending]);
  assert.equal(f.app.manager.browsers.personal.bridges.size, 0);
  assert.equal((await f.app.records.list("relay-user")).length, 0);
  assert.ok(f.requests.every(request => !request.headers?.cookie));
});

function streamFixture({ buffered = false, wrongEvent = false, closeEarly = false, noTransform = false } = {}) {
  const state = { cancelled: false };
  state.fetchImpl = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      const event = `data: ${JSON.stringify({ type: wrongEvent ? "private-event" : "sidebar_changed" })}\n\n`;
      controller.enqueue(Buffer.from(event + (buffered ? ": heartbeat\n\n" : "")));
      if (closeEarly) controller.close();
      else if (!buffered) state.timer = setTimeout(() => controller.enqueue(Buffer.from(": heartbeat\n\n")), 20);
      options.signal.addEventListener("abort", () => { clearTimeout(state.timer); state.cancelled = true; }, { once: true });
    },
    cancel() { clearTimeout(state.timer); state.cancelled = true; },
  }), { headers: { "content-type": "text/event-stream", "cache-control": noTransform ? "no-cache" : "no-cache, no-transform" } });
  return state;
}

test("protected SSE requires separate initial/heartbeat frames, forwards cookie only there and closes stream", async t => {
  const f = await deployedFixture(t), stream = streamFixture(), events = [];
  const receipt = await smokeDeployedTransports({ run: true, cookieFile: "/fixture/session" }, { ...f,
    readCookie: async () => ({ cookie, assertUnchanged: async () => events.push("source-unchanged") }), heartbeatMinGapMs: 5,
    fetchImpl: (url, options) => {
      if (!options.headers?.cookie) return f.fetchImpl(url, options);
      assert.equal(url, transportOrigin + "/api/sidebar/events"); assert.equal(options.headers.cookie, cookie);
      return stream.fetchImpl(url, options);
    },
  });
  assert.equal(receipt.sse.verified, true); assert.equal(receipt.sse.status, 200); assert.equal(receipt.sse.heartbeatReceived, true);
  assert.equal(stream.cancelled, true); assert.deepEqual(events, ["source-unchanged"]);
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic-private|cookie|user_|email/i);
});

test("SSE cannot claim success from buffering, wrong event, missing headers, closed stream or expired auth", async () => {
  for (const change of [{ buffered: true }, { wrongEvent: true }, { closeEarly: true }, { noTransform: true }]) {
    const stream = streamFixture(change);
    await assert.rejects(probeSidebarStream(cookie, { fetchImpl: stream.fetchImpl, heartbeatMinGapMs: 5 }));
    assert.equal(stream.cancelled, true);
  }
  await assert.rejects(probeSidebarStream(cookie, { fetchImpl: async () => new Response("PRIVATE BODY", { status: 401 }) }), error => !error.message.includes("PRIVATE BODY"));
});

test("WebSocket cancellation never claims a completed transport probe or hangs", async () => {
  const signal = AbortSignal.abort(), socket = new EventEmitter();
  socket.readyState = 0; socket.terminate = () => { socket.readyState = 3; socket.emit("close", 1006, Buffer.alloc(0)); };
  await assert.rejects(probePairingTransport({ signal, websocket: () => socket }), /cancelled/);
  assert.equal(socket.readyState, 3);
});

test("WebSocket receipts require the upgrade, exact rejection frame and expected close", async () => {
  for (const missing of ["upgrade", "frame", "close", "unexpected"]) {
    const socket = new EventEmitter();
    socket.readyState = 0; socket.terminate = () => { socket.readyState = 3; };
    socket.send = () => {
      if (missing !== "frame") socket.emit("message", Buffer.from(JSON.stringify(missing === "unexpected" ? { event: "connected", token: "PRIVATE-FIXTURE" } : { event: "error", message: "Invalid or expired pairing. Create a new code in Browser connections." })));
      socket.readyState = 3; socket.emit("close", missing === "close" ? 1000 : 1008, Buffer.from("Authentication failed"));
    };
    await assert.rejects(probePairingTransport({ websocket: () => {
      queueMicrotask(() => { if (missing !== "upgrade") socket.emit("upgrade", { statusCode: 101 }); socket.readyState = 1; socket.emit("open"); });
      return socket;
    } }), error => !error.message.includes("PRIVATE-FIXTURE"));
  }
});
