#!/usr/bin/env node
// Real Relay UI/API/bootstrap/proxy; only OIDC, saved CF host registry and the
// EC2 executor boundary are private local fixtures. Never run against production.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgentWebServer } from "../src/server.mjs";
import { SSH_WORKER_LAUNCHER, sshWorkerRequest } from "../src/ssh-worker-launcher.mjs";
import { WORKER_TCP_BRIDGE } from "../src/worker-tcp-bridge.mjs";
import { googleOidcFixture, googleTestEnv } from "../test/fixtures/google-oidc.mjs";
import { testConfig, waitFor } from "../test/helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length !== 2) throw Error("This local fixture accepts no deployment or credential arguments");
const directory = await mkdtemp(path.join(os.tmpdir(), "relay-preview-ui-"));
const output = path.join(root, "test-results/preview-ui-integrated-mcp");
await mkdir(output, { recursive: true, mode: 0o700 });
const relayHost = "relay.fixture.test", previewHost = "app.preview-fixture.test", origin = `https://${relayHost}`;
const destination = "/future-drink/menu?cart=1#saved";
const provider = googleOidcFixture(), rows = [], children = [], streams = new Set(), tlsSockets = new Set();
const observed = [], apiCalls = []; let acquisitions = 0, app, upstream, wss, front, client, transport, phase = "setup", receipt, failure;
let releaseAcquisition;
const acquisitionGate = new Promise(resolve => { releaseAcquisition = resolve; });
let transportClosed; const observedTransportClose = new Promise(resolve => { transportClosed = resolve; });
const bounded = async (promise, timeout = 10000) => {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("fixture timeout")), timeout); })]); } finally { clearTimeout(timer); }
};
const call = async (name, args) => {
  let result;
  try { result = await client.callTool({ name, arguments: args }, undefined, { timeout: 25000 }); }
  catch { throw Object.assign(Error("Fixture browser transport failed"), { category: "browser-transport" }); }
  if (result.isError) {
    const text = result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "";
    const category = /ENOTFOUND|ERR_NAME_NOT_RESOLVED/.test(text) ? "fixture-dns" : /certificate|CERT_/i.test(text) ? "fixture-tls" : /Timeout|timed out/i.test(text) ? "browser-timeout" : /strict mode violation/i.test(text) ? "ambiguous-locator" : "browser-assertion";
    throw Object.assign(Error("Fixture browser action failed"), { category });
  }
  return result;
};
const run = code => call("browser_run_code_unsafe", { code: `async(page)=>{${code}}` });
try {
  const heartbeat = path.join(directory, "heartbeat"); await writeFile(heartbeat, "", { mode: 0o600 });
  upstream = http.createServer((req, res) => {
    const cookieNames = (req.headers.cookie || "").split(";").filter(Boolean).map(part => part.trim().split("=", 1)[0]);
    observed.push({ path: req.url, host: req.headers.host, cookieNames, authorization: Boolean(req.headers.authorization) });
    if (req.url === "/events") {
      streams.add(res); res.once("close", () => streams.delete(res)); res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: first\n\n");
      const timer = setTimeout(() => res.write("data: incremental\n\n"), 100); res.once("close", () => clearTimeout(timer)); return;
    }
    if (req.url === "/echo") { res.writeHead(426); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": ["app_cookie=fixture; Path=/; HttpOnly; Secure", "__Host-relay-preview=forged; Path=/; Secure"] });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated fixture app</title><h1>Isolated fixture app</h1><p id="ws">WS connecting</p><p id="sse">SSE connecting</p><script>
window.fixtureSocket=new WebSocket('wss://'+location.host+'/echo');fixtureSocket.onopen=()=>fixtureSocket.send('fixture echo');fixtureSocket.onmessage=e=>document.querySelector('#ws').textContent=e.data;fixtureSocket.onclose=()=>document.querySelector('#ws').textContent='WS revoked';
window.fixtureEvents=new EventSource('/events');fixtureEvents.onmessage=e=>document.querySelector('#sse').textContent=e.data;fixtureEvents.onerror=()=>{fixtureEvents.close();document.querySelector('#sse').textContent='SSE revoked';};</script>`);
  });
  wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws, req) => {
    observed.push({ path: req.url, host: req.headers.host, cookieNames: (req.headers.cookie || "").split(";").filter(Boolean).map(part => part.trim().split("=", 1)[0]), authorization: Boolean(req.headers.authorization) });
    ws.on("message", (data, binary) => ws.send(data, { binary }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); const appPort = upstream.address().port;
  const hosts = {
    initialize: async () => {}, list: scope => rows.filter(row => row.ownerId === scope.ownerId && row.chatId === scope.chatId),
    lookup: name => rows.find(row => row.hostname === name && row.status === "ready") || null,
    ensure: async scope => {
      let row = rows.find(row => row.ownerId === scope.ownerId && row.chatId === scope.chatId && row.port === scope.port);
      if (!row) { row = { ...scope, id: "preview-fixture", hostname: previewHost, status: "pending" }; rows.push(row); } return row;
    },
    revoke: async (id, scope) => { const row = rows.find(row => row.id === id && row.ownerId === scope.ownerId && row.chatId === scope.chatId); assert.ok(row); row.status = "revoking"; },
    reconcile: async () => {}, close: async () => {},
  };
  const config = testConfig(path.join(directory, "data"), { ...googleTestEnv, AGENT_WEB_PUBLIC_URL: origin, AUTH_SECRET: "preview-ui-fixture-secret-".repeat(3),
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", AGENT_WORKER_BACKEND: "ec2", AGENT_EC2_GATEWAY_ORIGIN: "https://gateway.fixture.test", AGENT_PREVIEW_ENABLED: "1",
    AGENT_PREVIEW_ACCOUNT_ID: "111122223333", AGENT_EC2_DEPLOYMENT: "relay-fixture", AGENT_PREVIEW_VPC_ORIGIN_ID: "vo_fixture",
    AGENT_PREVIEW_CONTROLLER_INSTANCE_ID: "i-0123456789abcdef0", AGENT_PREVIEW_CONTROLLER_ORIGIN_DNS: "ip-10-0-0-1.us-east-2.compute.internal", AGENT_PREVIEW_RELAY_DISTRIBUTION_ID: "ERELAYFIXTURE", AGENT_IDLE_TIMEOUT_MS: "60000" });
  app = await createAgentWebServer({ config, googleAuthOptions: { fetchImpl: provider.fetch }, previewHosts: hosts,
    workerBackend: { acquire: async () => { acquisitions++; await acquisitionGate; return { workspace: directory, spawn(command, args, options) {
      assert.equal(command, "/usr/bin/node"); assert.deepEqual(args, ["--input-type=module", "-e", WORKER_TCP_BRIDGE]); assert.deepEqual(options.env, {});
      const child = spawn(process.execPath, ["--input-type=module", "-e", SSH_WORKER_LAUNCHER], { ...options, env: {} }); children.push(child);
      child.stdin.write(sshWorkerRequest({ command: process.execPath, args, cwd: directory, env: {}, heartbeat })); return child;
    } }; }, sleep: async () => {}, destroy: async () => {} } });
  const started = await app.start(), controllerPort = Number(new URL(started.url).port);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Relay UI fixture", "-addext", `subjectAltName=DNS:${relayHost},DNS:${previewHost}`, "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem")], { stdio: "ignore" });
  front = https.createServer({ key: await readFile(path.join(directory, "key.pem")), cert: await readFile(path.join(directory, "cert.pem")) }, async (req, res) => {
    if (![relayHost, previewHost].includes(req.headers.host)) { res.writeHead(421); res.end(); return; }
    if (req.headers.host === relayHost && req.url === "/__fixture/google" && req.method === "POST") {
      let bytes = 0, body = "";
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) { res.writeHead(400); res.end(); return; } body += chunk; }
      try { const callback = provider.approve(JSON.parse(body).url); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ callback })); }
      catch { res.writeHead(400); res.end(); } return;
    }
    const apiCall = req.headers.host === relayHost && req.url.includes("/app-preview") ? { method: req.method, path: req.url.split("?", 1)[0] } : null;
    if (apiCall) apiCalls.push(apiCall);
    const request = http.request({ host: "127.0.0.1", port: controllerPort, path: req.url, method: req.method, headers: req.headers }, response => { if (apiCall) apiCall.status = response.statusCode; res.writeHead(response.statusCode, response.headers); response.pipe(res); response.once("error", () => res.destroy()); });
    request.once("error", () => res.destroy()); req.once("aborted", () => request.destroy()); res.once("close", () => request.destroy()); req.pipe(request);
  });
  front.on("connection", socket => { tlsSockets.add(socket); socket.once("close", () => tlsSockets.delete(socket)); socket.on("error", () => {}); });
  front.on("upgrade", (req, socket, head) => {
    if (req.headers.host !== previewHost) { socket.destroy(); return; }
    const request = http.request({ host: "127.0.0.1", port: controllerPort, path: req.url, method: req.method, headers: req.headers });
    request.on("error", () => socket.destroy()); socket.once("close", () => request.destroy());
    request.on("response", response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Denied\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); });
    request.on("upgrade", (response, remote, remoteHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((out, value, index, values) => index % 2 ? out : out + value + ": " + values[index + 1] + "\r\n", "")}\r\n`);
      if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
      remote.on("error", () => socket.destroy()); socket.on("error", () => remote.destroy()); remote.once("close", () => socket.destroy()); socket.once("close", () => remote.destroy()); socket.pipe(remote); remote.pipe(socket);
    }); request.end();
  });
  front.listen(0, "127.0.0.1"); await once(front, "listening");
  const configPath = path.join(directory, "mcp.json"), home = path.join(directory, "home"); await mkdir(home, { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({ browser: { browserName: "chromium", isolated: true, launchOptions: { executablePath: "/usr/bin/google-chrome-stable", headless: true,
    args: ["--ignore-certificate-errors", "--no-proxy-server", `--host-resolver-rules=MAP ${relayHost} 127.0.0.1:${front.address().port},MAP ${previewHost} 127.0.0.1:${front.address().port}`] }, contextOptions: { ignoreHTTPSErrors: true } } }), { mode: 0o600 });
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "node_modules/@playwright/mcp/cli.js"), "--config", configPath, "--snapshot-mode", "none", "--image-responses", "omit", "--output-dir", output], cwd: root, env: { HOME: home, PATH: process.env.PATH, LANG: "C.UTF-8" }, stderr: "pipe" });
  transport.onclose = transportClosed; transport.stderr?.on("data", () => {}); client = new Client({ name: "preview-ui-integrated-fixture", version: "1.0.0" }); await bounded(client.connect(transport), 20000);
  phase = "real-google-fixture-login";
  await run(`await page.context().route('**/*',async route=>{const url=route.request().url();if(url.startsWith('https://accounts.google.com/')){const response=await page.request.post('https://127.0.0.1:${front.address().port}/__fixture/google',{headers:{host:'${relayHost}'},data:{url}});const result=await response.json();await route.fulfill({status:302,headers:{location:result.callback}});return;}if(url.startsWith('${origin}/')||url.startsWith('https://${previewHost}/'))return route.continue();return route.abort();});await page.goto('${origin}/');await page.getByRole('button',{name:'Continue with Google',exact:true}).click();await page.locator('#relay-account-button').filter({hasText:'owner@example.com'}).waitFor();`);
  phase = "create-chat-no-prompt";
  await run(`const chat=await page.evaluate(async()=>{const r=await fetch('/api/chats',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent:'mock',title:'Preview acceptance fixture'})});if(r.status!==201)throw Error('Fixture chat creation failed');return (await r.json()).chat.id;});await page.goto('${origin}/#chat='+chat);await page.reload();await page.getByRole('button',{name:'Open app preview',exact:true}).click();await page.getByLabel('App port').fill('${appPort}');await page.getByLabel('App path').fill('${destination}');await page.getByRole('button',{name:'Set up preview',exact:true}).waitFor();`);
  assert.equal(acquisitions, 0); assert.equal(rows.length, 0);
  phase = "explicit-pending-setup";
  await run(`await page.getByRole('button',{name:'Set up preview',exact:true}).click();await page.getByRole('status').filter({hasText:'several minutes'}).waitFor();`);
  assert.equal(rows.length, 1); assert.equal(rows[0].port, appPort); assert.equal(acquisitions, 0);
  assert.ok(apiCalls.some(row => row.method === "POST" && row.path.endsWith("/app-preview") && row.status === 202));
  assert.equal(apiCalls.filter(row => row.path.endsWith("/app-preview/open")).length, 0);
  rows[0].status = "ready";
  phase = "ready-responsive-ui";
  await run(`await page.getByRole('button',{name:'Refresh status',exact:true}).click();await page.getByRole('button',{name:'Open app ↗',exact:true}).waitFor();`);
  for (const width of [1600, 390, 320]) await run(`await page.setViewportSize({width:${width},height:1000});if(!(await page.locator('#app-preview-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)))throw Error('Preview overflow');await page.screenshot({path:${JSON.stringify(path.join(output, `ready-${width}.png`))}});`);
  phase = "ui-open-popup";
  await run(`const created=page.waitForEvent('popup');await page.getByRole('button',{name:'Open app ↗',exact:true}).click();await created;`);
  phase = "cold-worker-preparation-ui";
  await run(`await page.getByRole('status').filter({hasText:'Preparing this chat'}).waitFor();const popup=page.context().pages().find(p=>p.url()==='about:blank');if(!popup)throw Error('Preparation tab missing');if(!await popup.evaluate(()=>window.opener===null&&document.body.textContent.includes('Preparing this chat')))throw Error('Preparation state missing');await page.screenshot({path:${JSON.stringify(path.join(output, "worker-preparing-320.png"))}});`);
  assert.equal(acquisitions, 1); assert.equal(observed.length, 0);
  assert.ok(apiCalls.some(row => row.method === "POST" && row.path.endsWith("/app-preview/open") && row.status === 202));
  assert.ok(!apiCalls.some(row => row.path === "/api/app-preview/bootstrap"));
  assert.ok(app.store.list().every(chat => chat.messages.length === 0));
  releaseAcquisition();
  phase = "trusted-bootstrap-app-http";
  await run(`const popup=page.context().pages().find(p=>!p.url().startsWith('${origin}/#chat='));if(!popup)throw Error('Fixture popup missing');await popup.getByRole('heading',{name:'Isolated fixture app',exact:true}).waitFor({timeout:15000});if(popup.url()!=='https://${previewHost}${destination}')throw Error('App target changed');if(!await popup.evaluate(()=>window.opener===null&&document.referrer===''&&!document.cookie.includes('relay')))throw Error('Popup isolation failed');`);
  phase = "app-websocket-sse";
  await run(`const popup=page.context().pages().find(p=>p.url().startsWith('https://${previewHost}/'));await popup.locator('#ws').filter({hasText:'fixture echo'}).waitFor({timeout:10000});await popup.locator('#sse').filter({hasText:'incremental'}).waitFor({timeout:10000});await popup.screenshot({path:${JSON.stringify(path.join(output, "app-live.png"))}});`);
  phase = "upstream-isolation-assertions";
  assert.ok(acquisitions > 0); assert.ok(streams.size > 0); assert.ok(wss.clients.size > 0);
  assert.ok(apiCalls.some(row => row.method === "POST" && row.path.endsWith("/app-preview/open") && row.status === 200));
  assert.ok(observed.some(row => row.path === destination.split("#")[0]));
  assert.ok(observed.every(row => row.host === previewHost && !row.authorization && row.cookieNames.every(name => name === "app_cookie")));
  assert.ok(app.store.list().every(chat => chat.messages.length === 0));
  phase = "ui-revoke-closes-live-streams";
  await run(`const relay=page.context().pages().find(p=>p.url().startsWith('${origin}/#chat='));if(!relay)throw Error('Relay fixture tab missing');await relay.getByRole('button',{name:'Revoke preview',exact:true}).click();await relay.getByRole('status').filter({hasText:'Access revoked'}).waitFor();const preview=page.context().pages().find(p=>p.url().startsWith('https://${previewHost}/'));await preview.locator('#ws').filter({hasText:'WS revoked'}).waitFor({timeout:10000});await preview.locator('#sse').filter({hasText:'SSE revoked'}).waitFor({timeout:10000});const denied=await preview.evaluate(async()=>{const r=await fetch('/after-revoke');return r.status;});if(![403,421].includes(denied))throw Error('Revoked access survived');`);
  await waitFor(() => streams.size === 0 && wss.clients.size === 0 && children.every(child => child.exitCode !== null || child.signalCode !== null), { timeoutMs: 10000 });
  assert.equal(rows[0].status, "revoking"); assert.ok(app.store.list().every(chat => chat.messages.length === 0));
  assert.ok(!observed.some(row => row.path === "/after-revoke"));
  receipt = { schema: 1, fixtureOnly: true, actualRelayUiAndApis: true, officialPlaywrightMcp: true, separateHttpsOrigins: true, signedOidcFixture: true,
    explicitAsyncSetup: true, coldWorkerPreparationUi: true, workerReadyBeforeBootstrap: true, originalPathQueryFragment: true, detachedNoReferrerTab: true, workerCookiesIsolated: true, http: true, websocket: true, incrementalSse: true,
    revokeClosesStreams: true, noModelPrompts: true, localLauncherChildrenClosed: true, realAwsOrAccountConsent: false, screenshots: "test-results/preview-ui-integrated-mcp" };
} catch (error) { failure = { ok: false, fixtureOnly: true, phase, category: ["fixture-dns", "fixture-tls", "browser-timeout", "ambiguous-locator", "browser-assertion", "browser-transport"].includes(error?.category) ? error.category : "fixture-assertion",
  diagnostics: { acquisitions, upstreamRequests: observed.length, websocketClients: wss?.clients.size || 0, sseStreams: streams.size,
    intentStatuses: apiCalls.filter(row => row.method === "POST" && row.path.endsWith("/app-preview/open")).map(row => row.status || 0).slice(-5),
    bootstrapStatuses: apiCalls.filter(row => row.path === "/api/app-preview/bootstrap").map(row => row.status || 0).slice(-5) } }; }
finally {
  let cleanup = true;
  releaseAcquisition(); // A failed assertion must not strand a pending fixture executor.
  if (client) await bounded(call("browser_close", {})).catch(() => { cleanup = false; });
  await bounded(client?.close() || Promise.resolve(), 6000).catch(() => { cleanup = false; });
  if (transport) await bounded(Promise.all([transport.close(), observedTransportClose]), 6000).catch(() => { cleanup = false; });
  for (const socket of tlsSockets) socket.destroy(); if (front) await bounded(new Promise(resolve => front.close(resolve))).catch(() => { cleanup = false; });
  if (app) await bounded(app.stop()).catch(() => { cleanup = false; });
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGTERM"); } catch { cleanup = false; } }
  await waitFor(() => children.every(child => child.exitCode !== null || child.signalCode !== null), { timeoutMs: 4000 }).catch(async () => {
    // A forced launcher kill cannot prove its nested process-group cleanup.
    cleanup = false;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch {} }
    await waitFor(() => children.every(child => child.exitCode !== null || child.signalCode !== null), { timeoutMs: 2000 }).catch(() => {});
  });
  for (const ws of wss?.clients || []) ws.terminate(); for (const response of streams) response.destroy();
  if (wss) await bounded(new Promise(resolve => wss.close(resolve))).catch(() => { cleanup = false; });
  if (upstream) { upstream.closeAllConnections(); await bounded(new Promise(resolve => upstream.close(resolve))).catch(() => { cleanup = false; }); }
  if (cleanup) await rm(directory, { recursive: true, force: true }).catch(() => { cleanup = false; });
  if (!cleanup) failure ||= { ok: false, fixtureOnly: true, phase: "cleanup-unconfirmed" };
  if (failure) failure.cleanupConfirmed = cleanup;
}
if (failure) { console.error(JSON.stringify(failure)); process.exitCode = 1; }
else console.log(JSON.stringify({ ...receipt, cleanupConfirmed: true }));
