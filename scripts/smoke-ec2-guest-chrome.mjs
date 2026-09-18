#!/usr/bin/env node
// Explicit disposable-fixture acceptance. Never points at the live Relay DB.
import assert from "node:assert/strict";
import { readFile, lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgentWebServer } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { terminateWorker } from "../src/worker-process.mjs";
import { nativeTarget, guardNativeTarget } from "./fixtures/ec2-native-guards.mjs";
import { prepareSessionPlugin } from "./fixtures/session-manager-plugin.mjs";
import { awsArgs, runPrivate, openNativeTunnel, nativeProbeOverSsh } from "./fixtures/ec2-native-transport.mjs";
import { validateProbeReceipt } from "./smoke-ec2-native.mjs";
import { spawnGuestWorker, guestExecutor, GuestSiteControl } from "./fixtures/ec2-guest-transport.mjs";
import { validGuestRun } from "./fixtures/ec2-guest-site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const guestPresets = [[320, 640], [390, 844], [640, 960], [834, 1112], [1280, 800], [1920, 1080]];
export function parseGuestOptions(args) {
  const result = { run: false, sshKey: path.join(os.homedir(), ".local/share/agent-relay-aws-mvp/worker-ed25519") };
  const names = { "--worker-id": "workerId", "--image-id": "imageId", "--acceptance-id": "acceptanceId", "--ssh-key": "sshKey" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run") { result.run = true; continue; }
    if (!names[args[i]] || !args[i + 1] || args[i + 1].startsWith("--")) throw Error("Invalid guest acceptance argument");
    result[names[args[i]]] = args[++i];
  }
  if (result.run && (!/^i-[a-f0-9]{8,17}$/.test(result.workerId || "") || !/^ami-[a-f0-9]{8,17}$/.test(result.imageId || "") || !validGuestRun(result.acceptanceId) || !path.isAbsolute(result.sshKey))) throw Error("Guest acceptance requires exact existing worker, image, run UUID and private key");
  return result;
}
export function requireSandbox(value) {
  assert.equal(value.roots, 1); assert.ok(value.renderers >= 1);
  for (const key of ["scanComplete", "nonRoot", "pipeOnly", "noSandboxBypass", "rendererSeccomp", "rendererNamespace"]) assert.equal(value[key], true);
}
export async function pollGuest(check, { timeout = 20000, signal } = {}) {
  const deadline = Date.now() + timeout;
  do { signal?.throwIfAborted(); if (await check()) return; await new Promise(resolve => setTimeout(resolve, 150)); } while (Date.now() < deadline);
  throw Error("Guest fixture acceptance timed out");
}

export async function officialGuestUi({ origin, chat, token, site, browsers, output, signal }) {
  const client = new Client({ name: "relay-ec2-guest-acceptance", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(ROOT, "node_modules/@playwright/mcp/cli.js"), "--headless", "--isolated", "--browser", "chrome", "--output-dir", output],
    cwd: ROOT, env: { PATH: process.env.PATH, HOME: output, LANG: "C.UTF-8" }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  let runCodeTool, phase = "entry";
  const call = async (name, args = {}) => {
    signal?.throwIfAborted();
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000, signal });
    if (result.isError) throw Error(`Official MCP ${name} failed at ${phase}; diagnostics suppressed`);
    return (result.content || []).filter(item => item.type === "text").map(item => item.text).join("\n");
  };
  const code = async body => call(runCodeTool, { code: `async (page) => { ${body} }` });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    runCodeTool = tools.includes("browser_run_code_unsafe") ? "browser_run_code_unsafe" : "browser_run_code";
    assert.ok(tools.includes(runCodeTool), "Official MCP must provide its UI execution tool");
    await call("browser_resize", { width: 1600, height: 1000 });
    await call("browser_navigate", { url: `${origin}/#chat=${chat.id}` });
    phase = "fixture-login-and-browser-start";
    await code(`await page.locator('#login-token').fill(${JSON.stringify(token)}); await page.locator('#login-form button').click(); await page.locator('#open-browser').click(); await page.locator('#browser-status').filter({hasText:'Live ·'}).waitFor();`);
    phase = "guest-navigation";
    await code(`page.__relayGuestErrors=[]; page.on('pageerror',()=>page.__relayGuestErrors.push(true)); await page.locator('#browser-address').fill(${JSON.stringify(site.url)}); await page.locator('#browser-address-form button[type=submit]').click();`);
    await pollGuest(async () => (await site.command("status")).documentId, { signal });
    const original = await site.command("status"), tabId = browsers.info(chat.id).tabId;
    await pollGuest(() => browsers.hasViewers(chat.id), { signal });
    const uiSnapshot = async (width, height) => {
      phase = `viewport-${width}x${height}`;
      // All interaction and canvas inspection goes through official MCP. The
      // guest itself reports CSS metrics through its own HTTP page, not a
      // second hidden automation browser or a parallel CDP session.
      await code(`await page.locator('#browser-viewport').selectOption('${width}x${height}'); await page.waitForFunction(({w,h})=>{const c=document.querySelector('#browser-canvas');return !c.hidden&&c.width===w*2&&c.height===h*2&&c.dataset.viewportWidth===String(w)&&c.dataset.viewportHeight===String(h)},{w:${width},h:${height}});`);
      await pollGuest(async () => { const value = await site.command("status"); return value.width === width && value.height === height && value.dpr === 2; }, { signal });
      await code(`await page.waitForFunction(()=>{const c=document.querySelector('#browser-canvas'),ctx=c.getContext('2d');const p=[...ctx.getImageData(10,10,1,1).data];if(p.join()!=='237,244,255,255')return false;const data=ctx.getImageData(40,620,80,1).data;return Array.from({length:80},(_,i)=>{const expected=Math.floor(i/2)%2?255:0;return data[i*4]===expected&&data[i*4+1]===expected&&data[i*4+2]===expected&&data[i*4+3]===255}).every(Boolean)});`);
      const observed = await site.command("status"); assert.equal(observed.documentId, original.documentId); assert.equal(browsers.info(chat.id).tabId, tabId); assert.equal(browsers.info(chat.id).tabs.length, 1);
      await call("browser_take_screenshot", { filename: path.join(output, `guest-${width}x${height}.png`), fullPage: true, scale: "css" });
    };
    for (const [width, height] of guestPresets) await uiSnapshot(width, height);
    phase = "canvas-input";
    await code(`const c=page.locator('#browser-canvas');const box=await c.boundingBox();await c.click({position:{x:box.width*60/1920,y:box.height*115/1080}});await c.click({position:{x:box.width*70/1920,y:box.height*178/1080}});await page.keyboard.type('EC2 guest input');`);
    await pollGuest(async () => { const value = await site.command("status"); return value.clicks === 1 && value.text === "EC2 guest input"; }, { signal });
    await uiSnapshot(640, 960); // Revisit same tab with input/state preserved.
    assert.equal((await site.command("status")).text, "EC2 guest input");
    await site.command("refresh");
    await pollGuest(async () => (await site.command("status")).live === "Updated live", { signal });
    phase = "live-update-pixels";
    await code(`await page.waitForFunction(()=>[...document.querySelector('#browser-canvas').getContext('2d').getImageData(302,622,1,1).data].join()==='0,192,64,255');`);
    phase = "renderer-sandbox";
    requireSandbox(await site.command("sandbox"));
    assert.ok(browsers.hasViewers(chat.id));
    phase = "stop-chrome";
    await code(`if(page.__relayGuestErrors.length)throw Error('Browser page error');await page.locator('#browser-stop').click();await page.locator('#browser-status').filter({hasText:'Chrome stopped'}).waitFor();`);
    await pollGuest(async () => { const value = await site.command("sandbox"); return value.scanComplete === true && value.processes === 0 && !browsers.hasViewers(chat.id); }, { signal });
    return { presets: guestPresets.map(([width, height]) => ({ width, height, dpr: 2 })), sharpPixels: true, sameTabAndDocument: true, mouseAndKeyboard: true, liveUpdate: true, viewerPresence: true, rendererSandbox: true, browserStopped: true };
  } catch (error) {
    await call("browser_take_screenshot", { filename: path.join(output, "failure.png"), fullPage: true, scale: "css" }).catch(() => {});
    throw error;
  } finally {
    await client.callTool({ name: "browser_close", arguments: {} }).catch(() => {});
    await client.close().catch(() => {}); await transport.close().catch(() => {});
  }
}

export async function smokeEc2Guest(options, { run = runPrivate, guard = guardNativeTarget, plugin = prepareSessionPlugin, tunnel = openNativeTunnel, probe = nativeProbeOverSsh, driveUi = officialGuestUi, signal, log = () => {} } = {}) {
  if (!options.run) return { dryRun: true, ...nativeTarget, fixtureController: "isolated loopback + memory database", guest: "fresh dedicated existing EC2 worker", presets: guestPresets, browserTransport: "official Playwright MCP", providerCredentialReads: 0, modelTurns: 0, createsAwsResources: false, instanceLifecycle: "supervisor must retire this separate worker after every run" };
  const json = async (...args) => JSON.parse(await run("aws", awsArgs([...args, "--output", "json"]), { signal }));
  assert.match(await run("aws", ["--version"], { signal }), /^aws-cli\/2\.35\.20\s/);
  const target = await guard(options, json), key = await lstat(options.sshKey);
  assert.ok(key.isFile() && !key.isSymbolicLink() && key.nlink === 1 && key.uid === process.getuid() && !(key.mode & 0o077));
  assert.equal((await run("ssh-keygen", ["-y", "-f", options.sshKey], { signal })).trim().split(/\s+/).slice(0, 2).join(" "), target.publicKey);
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-ec2-guest-"));
  const output = path.join(ROOT, "test-results", `ec2-guest-${options.acceptanceId}`);
  let connection, site, app, receipt, cleanupError;
  const children = new Set();
  try {
    const installed = await plugin(directory, { run: (command, args) => run(command, args, { signal }) });
    connection = await tunnel(target, directory, installed, { run, signal });
    validateProbeReceipt(await probe({ options, directory, tunnel: connection, request: { action: "preflight", runId: options.acceptanceId }, first: true, run, signal }), options.acceptanceId, "preflight");
    const checked = await guard(options, json); assert.deepEqual(checked, target);
    const spawnRemote = input => {
      signal?.throwIfAborted();
      const child = spawnGuestWorker({ options, directory, tunnel: connection, ...input }); children.add(child); child.once("close", () => children.delete(child)); return child;
    };
    const source = await readFile(new URL("./fixtures/ec2-guest-site.mjs", import.meta.url), "utf8");
    site = new GuestSiteControl(spawnRemote({ command: "/usr/bin/node", args: ["--input-type=module", "-e", source, "--", "--relay-guest-site", options.acceptanceId], cwd: "/opt/agent-web", env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" } }));
    const info = await site.ready;
    assert.equal(info.root, `/opt/agent-web/guest-acceptance-${options.acceptanceId}`); assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    site.url = info.url;
    const executor = guestExecutor(info.root, spawnRemote, await readFile(new URL("../src/browser-worker.mjs", import.meta.url), "utf8"));
    const token = randomBytes(32).toString("hex");
    const config = loadConfig({ AGENT_WEB_HOST: "127.0.0.1", AGENT_WEB_PORT: "0", AGENT_DATA_DIR: path.join(directory, "data"), AGENT_DATABASE_MODE: "memory", AGENT_ENABLE_MOCK: "1", AGENT_PROCESS_ISOLATION: "none", AGENT_WEB_AUTH_TOKEN: token, AGENT_IDLE_TIMEOUT_MS: "60000", AGENT_CHROME_BIN: "/usr/bin/google-chrome", AGENT_WORKER_BACKEND: "ec2", AGENT_EC2_GATEWAY_ORIGIN: "https://fixture.invalid", PATH: process.env.PATH });
    app = await createAgentWebServer({ config, workerBackend: { acquire: async () => executor, sleep: async () => {}, destroy: async () => { throw Error("Fixture must not destroy EC2"); } } });
    const { url } = await app.start();
    const chat = await app.manager.createChat({ agent: "mock", title: "Isolated EC2 guest Chrome acceptance" });
    await mkdir(output, { recursive: true, mode: 0o700 });
    log("Driving disposable Relay UI through official Playwright MCP. No provider account or model is used.");
    receipt = await driveUi({ origin: url, chat, token, site, browsers: app.manager.browsers, output, signal });
    assert.equal(app.store.get(chat.id).messages.length, 0);
  } finally {
    try { await app?.stop(); } catch { cleanupError = true; }
    try { if (site) assert.equal((await site.command("stop")).cleanedUp, true); } catch { cleanupError = true; }
    for (const child of children) await terminateWorker(child, 2500).catch(() => { cleanupError = true; });
    try { await connection?.close(); } catch { cleanupError = true; }
    await rm(directory, { recursive: true, force: false });
    if (cleanupError) throw Error("Guest fixture cleanup unconfirmed; retire only the dedicated tagged worker");
  }
  return { schema: 1, accepted: true, ...receipt, workerId: options.workerId, imageId: options.imageId, acceptanceId: options.acceptanceId,
    browserTransport: "official Playwright MCP", fixtureNotDeployedAuthAcceptance: true, providerCredentialReads: 0, modelTurns: 0, transcriptMessages: 0,
    fixtureRemoved: true, sessionClosed: true, workerRetirementRequired: true, screenshots: output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const abort = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => abort.abort());
  try { console.log(JSON.stringify(await smokeEc2Guest(parseGuestOptions(process.argv.slice(2)), { signal: abort.signal, log: message => console.error(message) }), null, 2)); }
  catch { console.error("EC2 guest Chrome acceptance failed; private diagnostics suppressed. Inspect exact worker/session retirement. This did not test deployed Google authentication."); process.exitCode = 1; }
}
