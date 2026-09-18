#!/usr/bin/env node
// Isolated HTTPS fixture: no Google/provider accounts, real workers or AWS.
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PreviewBootstrap } from "../src/preview-bootstrap.mjs";
import { PreviewGrants } from "../src/preview-grants.mjs";
import { boundedFixtureOperation, cleanupPreviewBootstrapFixture, previewBootstrapReceipt, previewFixtureEnvironment } from "./fixtures/preview-bootstrap-cleanup.mjs";

if (process.argv.length !== 2) {
  console.error(JSON.stringify({ ok: false, fixtureOnly: true, phase: "invalid-arguments", cleanupConfirmed: true }));
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(os.tmpdir(), "relay-preview-bootstrap-"));
const relay = "relay.fixture.test", preview = "one.preview-fixture.test", origin = `https://${relay}`;
const binding = { ownerId: "fixture-owner", sessionId: "fixture-login", chatId: "fixture-chat", hostname: preview, port: 3000, runtimeGeneration: 1 };
const user = { id: binding.ownerId, sessionId: binding.sessionId, expiresAt: Date.now() + 300000 };
const counts = { intercepted: 0, challenges: 0, exchanges: 0, probes: 0, app: 0 };
const grants = new PreviewGrants({ isCurrent: () => true });
const bootstrap = new PreviewBootstrap({ relayOrigin: origin, grants, lookupHost: hostname => hostname === preview ? binding : null,
  isCurrent: () => true, authenticate: async request => request.headers.cookie?.split("; ").includes("fixture-relay=owner") ? user : null });
let server, transport, client, phase = "fixture-create", receipt, failure, cleanupConfirmed = false;
let observedTransportClose;
const transportClosed = new Promise(resolve => { observedTransportClose = resolve; });
const sockets = new Set();
const safeCall = async (name, args) => {
  const result = await boundedFixtureOperation(client.callTool({ name, arguments: args }, undefined, { timeout: 25000 }), 26000);
  if (result.isError) throw Error("Browser fixture assertion failed");
  return result;
};
const run = code => safeCall("browser_run_code_unsafe", { code: `async (page) => { ${code} }` });
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Relay preview fixture",
    "-addext", `subjectAltName=DNS:${relay},DNS:${preview}`, "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem")], { stdio: "ignore", timeout: 20000 });
  server = createServer({ key: await readFile(path.join(directory, "key.pem")), cert: await readFile(path.join(directory, "cert.pem")) }, async (req, res) => {
    try {
      const url = new URL(req.url, origin), isRelay = req.headers.host === relay;
      if (isRelay && url.pathname === "/fixture-login") {
        res.setHeader("Set-Cookie", "fixture-relay=owner; Path=/; Secure; HttpOnly; SameSite=Lax"); res.end("Fixture signed in"); return;
      }
      if (isRelay && await bootstrap.handleRelay(req, res, url)) return;
      if (!isRelay && req.headers.host === preview) {
        if (url.pathname === "/sw.js") {
          res.setHeader("Content-Type", "application/javascript"); res.setHeader("Service-Worker-Allowed", "/");
          res.end(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{const p=new URL(e.request.url).pathname;if(p.startsWith('/__relay_preview/')){e.waitUntil(fetch('/__fixture/sw-intercept',{method:'POST'}));e.respondWith(new Response(JSON.stringify({evil:true}),{headers:{'content-type':'application/json'}}));}});`); return;
        }
        if (url.pathname === "/install") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>SW fixture</title><h1>Install fixture</h1>"); return; }
        if (url.pathname === "/__fixture/sw-intercept") { counts.intercepted++; res.end("recorded"); return; }
        if (url.pathname === "/__relay_preview/challenge" && req.method === "POST") counts.challenges++;
        if (url.pathname === "/__relay_preview/exchange" && req.method === "POST") counts.exchanges++;
        if (url.pathname === "/__relay_preview/probe" && req.method === "POST") counts.probes++;
        if (await bootstrap.handlePreview(req, res, url)) return;
        if (url.pathname === "/app") {
          bootstrap.authorize(req, preview); counts.app++; res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Preview app</title><h1>Authenticated preview app</h1>"); return;
        }
      }
      res.statusCode = 404; res.end("Fixture route unavailable");
    } catch { res.statusCode = 403; res.end("Fixture request denied"); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); });
  server.listen(0, "127.0.0.1"); await boundedFixtureOperation(once(server, "listening"));
  const port = server.address().port, configPath = path.join(directory, "mcp.json");
  const fixtureHome = path.join(directory, "home"), fixtureTmp = path.join(directory, "tmp");
  await mkdir(fixtureHome, { mode: 0o700 }); await mkdir(fixtureTmp, { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({ browser: { browserName: "chromium", isolated: true,
    launchOptions: { executablePath: "/usr/bin/google-chrome-stable", headless: true, args: ["--ignore-certificate-errors", "--no-proxy-server",
      `--host-resolver-rules=MAP ${relay} 127.0.0.1:${port},MAP ${preview} 127.0.0.1:${port}`] }, contextOptions: { ignoreHTTPSErrors: true } } }), { mode: 0o600 });
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "node_modules/@playwright/mcp/cli.js"), "--config", configPath,
    "--snapshot-mode", "none", "--image-responses", "omit", "--output-dir", directory], cwd: directory,
    env: previewFixtureEnvironment(directory, process.execPath), stderr: "pipe" });
  transport.onclose = observedTransportClose;
  transport.stderr?.on("data", () => {}); client = new Client({ name: "preview-bootstrap-fixture", version: "1.0.0" });
  await boundedFixtureOperation(client.connect(transport), 20000);
  phase = "service-worker-install";
  await run(`await page.goto('https://${preview}/install');await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js',{scope:'/'});await navigator.serviceWorker.ready;});await page.reload();if(!await page.evaluate(()=>Boolean(navigator.serviceWorker.controller)))throw Error('SW not controlling preview');`);
  phase = "control-interception";
  await run(`const observed=await page.evaluate(async()=>{const r=await fetch('/__relay_preview/control');return (await r.json()).evil===true;});if(!observed)throw Error('SW control fixture did not intercept');`);
  assert.equal(counts.intercepted, 1);
  phase = "relay-login"; await run(`await page.goto('${origin}/fixture-login');`);
  const first = bootstrap.start({ binding, user, path: "/app?original=1#kept" });
  phase = "first-open";
  await run(`await page.goto(${JSON.stringify(first.url)});await page.getByRole('heading',{name:'Authenticated preview app',exact:true}).waitFor({timeout:15000});if(!page.url().endsWith('/app?original=1#kept'))throw Error('Original app URL lost');if(!await page.evaluate(()=>Boolean(navigator.serviceWorker.controller)))throw Error('PWA worker lost');if(await page.evaluate(()=>document.cookie.includes('__Host-relay-preview')))throw Error('Private cookie visible');`);
  assert.equal(counts.intercepted, 1); assert.equal(counts.probes, 1); assert.equal(counts.app, 1);
  phase = "repeat-open"; const repeated = bootstrap.start({ binding, user, path: "/app?repeat=1#kept" });
  await run(`await page.goto(${JSON.stringify(repeated.url)});await page.getByRole('heading',{name:'Authenticated preview app',exact:true}).waitFor({timeout:15000});if(page.url()!=='https://${preview}/app?repeat=1#kept')throw Error('Repeated app URL lost');`);
  assert.equal(counts.intercepted, 1); assert.equal(counts.probes, 2); assert.equal(counts.app, 2);
  phase = "blocked-cookie-negative"; const blocked = bootstrap.start({ binding, user, path: "/app?must-not-open=1" });
  // Browser-protocol cookie controls, not a mocked HTTP response. The existing
  // first-party preview cookie remains, but cross-site bootstrap access is denied.
  await run(`const cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCookieControls',{enableThirdPartyCookieRestriction:true,disableThirdPartyCookieMetadata:true,disableThirdPartyCookieHeuristics:true});await page.goto(${JSON.stringify(blocked.url)});await page.getByRole('heading',{name:'App access could not be opened',exact:true}).waitFor({timeout:15000});if(!await page.getByText(/blocking cross-site cookies/).isVisible())throw Error('Missing privacy explanation');if(!page.url().startsWith('${origin}/app-preview/open'))throw Error('Blocked launch navigated');await cdp.detach();`);
  assert.equal(counts.app, 2); assert.equal(counts.intercepted, 1);
  receipt = { transport: "official Playwright MCP", fixtureOnly: true, syntheticAccountsOnly: true, httpsDistinctSites: true,
    hostileRootServiceWorkerRetained: true, controlInterception: true, bootstrapNotIntercepted: true,
    firstAndRepeatedOpen: true, originalPathQueryFragment: true, grantNotScriptReadable: true,
    browserBlockedCookiesFailClosed: true, realProviderConsents: 0, modelPrompts: 0 };
} catch {
  failure = { ok: false, fixtureOnly: true, phase };
} finally {
  cleanupConfirmed = await cleanupPreviewBootstrapFixture({ client, transport, transportClosed, bootstrap, server, sockets, directory });
}
const result = previewBootstrapReceipt(receipt, failure, cleanupConfirmed);
if (!result.ok) { console.error(JSON.stringify(result)); process.exitCode = 1; }
else console.log(JSON.stringify(result));
