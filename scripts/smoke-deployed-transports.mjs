#!/usr/bin/env node
// Existing production routes only: no synthetic users, auth bypass, prompts,
// account imports, Chrome starts, pairing mutations or infrastructure changes.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

export const transportOrigin = "https://d20atclccf8cku.cloudfront.net";
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const fail = message => { throw new Error(message); };
export function parseTransportOptions(args) {
  const options = { run: false, cookieFile: null };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--run") options.run = true;
    else if (args[index] === "--cookie-file" && path.isAbsolute(args[index + 1] || "")) options.cookieFile = args[++index];
    else fail("Use --run and optional --cookie-file with an absolute private-file path");
  }
  return options;
}

async function privateCookieFile(filename) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 65536) fail("Relay session cookie file must be private, owned, regular and bounded");
    const buffer = Buffer.alloc(65537), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) fail("Relay session cookie file exceeds its limit");
    const content = buffer.subarray(0, bytesRead);
    const cookie = content.toString("utf8").trim();
    if (!cookie || /[\r\n\x00-\x1f\x7f]/.test(cookie)) fail("Relay session cookie must be one header line");
    const names = new Set();
    for (const part of cookie.split(/;\s*/)) {
      const matched = /^(__Host-relay\.auth\.sessionToken(?:\.\d+)?)=([A-Za-z0-9._~-]+)$/.exec(part);
      if (!matched || names.has(matched[1])) fail("Include only Relay's HTTPS session cookie, never provider or browser-profile cookies");
      names.add(matched[1]);
    }
    return { cookie, digest: createHash("sha256").update(content).digest("hex") };
  } finally { await file.close(); }
}

export async function readTransportCookie(filename) {
  const { cookie, digest } = await privateCookieFile(filename);
  return { cookie, assertUnchanged: async () => {
    if ((await privateCookieFile(filename)).digest !== digest) fail("Relay session cookie file changed during the probe; no restoration attempted");
  } };
}

export async function probePairingTransport({ websocket = (url, options) => new WebSocket(url, options), timeoutMs = 15000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now(); let upgraded = false, rejectedPairing = false, settled = false;
    const socket = websocket(transportOrigin.replace("https:", "wss:") + "/browser/connect", {
      headers: { origin: extensionOrigin }, handshakeTimeout: timeoutMs, followRedirects: false, rejectUnauthorized: true, maxPayload: 65536, perMessageDeflate: false,
    });
    const finish = (error, receipt) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      if (socket.readyState !== 3) socket.terminate();
      error ? reject(error) : resolve(receipt);
    };
    const aborted = () => finish(new Error("Deployed WebSocket transport probe cancelled"));
    const timer = setTimeout(() => finish(new Error("Deployed WebSocket transport probe timed out")), timeoutMs);
    signal?.addEventListener("abort", aborted, { once: true });
    socket.on("error", () => finish(new Error("Deployed WebSocket transport failed; private diagnostics suppressed")));
    socket.on("unexpected-response", (_request, response) => { response.resume(); finish(new Error("Deployed WebSocket did not upgrade")); });
    socket.on("upgrade", response => { upgraded = response.statusCode === 101; });
    socket.on("open", () => {
      // Unsupported type fails BEFORE pairing lookup, deletion or persistence.
      // Never generate or send a syntactically valid pair/connect attempt.
      socket.send(JSON.stringify({ type: "transport-probe" }));
    });
    socket.on("message", data => {
      let value; try { value = JSON.parse(data); } catch { finish(new Error("Deployed WebSocket returned an unexpected frame")); return; }
      if (value?.event !== "error" || value.message !== "Invalid or expired pairing. Create a new code in Browser connections.") {
        finish(new Error("Deployed WebSocket returned an unexpected authentication result")); return;
      }
      rejectedPairing = true;
    });
    socket.on("close", (code, reason) => {
      if (!upgraded || !rejectedPairing || code !== 1008 || reason.toString() !== "Authentication failed") {
        finish(new Error("Deployed WebSocket did not preserve the expected authentication rejection")); return;
      }
      finish(null, { upgradeStatus: 101, clientFrameDelivered: true, serverFrameDelivered: true, unauthenticatedPairingRejected: true, closeCode: 1008, elapsedMs: Date.now() - started });
    });
    if (signal?.aborted) aborted();
  });
}

export async function probeSidebarStream(cookie, { fetchImpl = fetch, timeoutMs = 40000, firstEventLimitMs = 10000, heartbeatMinGapMs = 1000, signal } = {}) {
  const abort = new AbortController();
  const combined = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const started = Date.now(); let reader;
  try {
    const response = await fetchImpl(transportOrigin + "/api/sidebar/events", { redirect: "error", headers: { cookie, origin: transportOrigin }, signal: combined });
    if (response.status !== 200) fail("A legitimate active Google Relay session is required for the SSE gate");
    if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") || "") || !/\bno-transform\b/i.test(response.headers.get("cache-control") || "")) fail("Deployed SSE headers did not preserve event streaming");
    reader = response.body.getReader();
    let text = "", bytes = 0, firstEventMs = null;
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) fail("Deployed SSE closed before its heartbeat");
      bytes += chunk.value.length;
      if (bytes > 65536) fail("Deployed SSE probe exceeded its bounded response");
      text += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = text.indexOf("\n\n")) >= 0) {
        const frame = text.slice(0, boundary); text = text.slice(boundary + 2);
        if (frame.startsWith("data: ")) {
          let value; try { value = JSON.parse(frame.slice(6)); } catch { fail("Deployed SSE contained an unexpected frame"); }
          if (value?.type !== "sidebar_changed") fail("Deployed SSE contained an unexpected event");
          firstEventMs ??= Date.now() - started;
          if (firstEventMs > firstEventLimitMs) fail("Deployed SSE initial event was delayed or buffered");
        } else if (frame === ": heartbeat") {
          if (firstEventMs === null) fail("Deployed SSE heartbeat preceded the initial event");
          const heartbeatMs = Date.now() - started;
          if (heartbeatMs - firstEventMs < heartbeatMinGapMs) fail("Deployed SSE did not deliver separate live frames");
          return { status: 200, initialEventReceived: true, heartbeatReceived: true, noTransform: true, firstEventMs, heartbeatMs };
        } else fail("Deployed SSE contained an unexpected frame");
      }
    }
  } finally { abort.abort(); await reader?.cancel().catch(() => {}); }
}

export async function smokeDeployedTransports(options, dependencies = {}) {
  if (!options.run) return { dryRun: true, origin: transportOrigin, actions: ["anonymous-readiness", "anonymous-SSE-denial", "WSS-upgrade-and-unsupported-pairing-rejection", ...(options.cookieFile ? ["legitimate-session-sidebar-SSE-and-heartbeat"] : [])],
    sse200Requires: "User-supplied private file containing only an active Google Relay HTTPS session cookie", productionUsersCreated: 0, modelPrompts: 0, chromeStarts: 0, awsMutations: 0 };
  const { fetchImpl = fetch, websocket, readCookie = readTransportCookie, signal, timeoutMs = 40000, firstEventLimitMs = 10000, heartbeatMinGapMs = 1000 } = dependencies;
  const requestSignal = () => AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
  const ready = await fetchImpl(transportOrigin + "/readyz", { redirect: "error", signal: requestSignal() });
  if (ready.status !== 200 || ready.headers.get("content-length") && Number(ready.headers.get("content-length")) > 1024) fail("Deployed Relay readiness failed");
  let body = "";
  for await (const chunk of ready.body) { body += Buffer.from(chunk).toString(); if (body.length > 1024) fail("Deployed Relay readiness receipt was too large"); }
  if (body.length > 1024 || JSON.stringify(JSON.parse(body)) !== '{"ok":true}') fail("Deployed Relay readiness receipt was unexpected");
  const denied = await fetchImpl(transportOrigin + "/api/sidebar/events", { redirect: "error", headers: { origin: transportOrigin }, signal: requestSignal() });
  await denied.body?.cancel();
  if (denied.status !== 401) fail("Anonymous SSE access was not denied");
  const ws = await probePairingTransport({ websocket, signal });
  let source, sse = { verified: false, reason: "legitimate-user-session-required" };
  try {
    if (options.cookieFile) {
      signal?.throwIfAborted();
      source = await readCookie(options.cookieFile);
      sse = { verified: true, ...await probeSidebarStream(source.cookie, { fetchImpl, signal, timeoutMs, firstEventLimitMs, heartbeatMinGapMs }) };
    }
  } finally { await source?.assertUnchanged(); }
  return { schema: 1, origin: transportOrigin, readiness: true, anonymousSseStatus: 401, websocket: ws, sse,
    authenticatedLiveBrowserVerified: false, chatReplayVerified: false, productionUsersCreated: 0, modelPrompts: 0, chromeStarts: 0, awsMutations: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => controller.abort());
  try { console.log(JSON.stringify(await smokeDeployedTransports(parseTransportOptions(process.argv.slice(2)), { signal: controller.signal }), null, 2)); }
  catch { console.error("Deployed transport check failed; no session cookies or private response bodies are printed. Google sign-in is required for optional protected SSE."); process.exitCode = 1; }
}
