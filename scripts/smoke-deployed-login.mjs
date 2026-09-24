#!/usr/bin/env node
// Public entry/Google initiation only. Never completes login or enters consent.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, mkdtemp, lstat, chmod, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { transportOrigin } from "./smoke-deployed-transports.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = new URL(transportOrigin).hostname;
export const loginViewports = Object.freeze([[1600, 1000], [390, 844], [320, 740]].map(Object.freeze));
const boundary = { origin: transportOrigin, verificationScope: "anonymous-entry-and-optional-google-initiation-only", deploymentIdentityVerified: false,
  authenticatedAccessVerified: false, credentialsEntered: false, consentSubmitted: false, modelTurns: 0,
  deploymentBindingRequired: "Pair this behavior receipt with a separately verified immutable deployment image/revision. It does not identify running code." };
export function parseLoginOptions(args) {
  const result = { run: false, checkGoogleRedirect: false }, seen = new Set();
  for (const arg of args) {
    if (seen.has(arg) || !["--run", "--check-google-redirect"].includes(arg)) throw new Error("Invalid login probe options");
    seen.add(arg); result[arg === "--run" ? "run" : "checkGoogleRedirect"] = true;
  }
  if (result.checkGoogleRedirect && !result.run) throw new Error("Google initiation requires --run");
  return result;
}
const phases = new Set(["prepare", "connect", "discovery", "entry-1600", "entry-390", "entry-320", "google-initiation", "cleanup"]);
const categories = new Set(["failed", "invalid-tool-result", "entry-check-failed", "missing-tools", "cancelled-or-deadline", "cleanup-unconfirmed"]);
export class LoginProbeError extends Error {
  constructor(phase, category = "failed", cleanup) {
    super("Deployed login probe failed"); this.phase = phases.has(phase) ? phase : "prepare";
    this.category = categories.has(category) ? category : "failed";
    if (cleanup) this.cleanup = cleanup;
  }
}
export function parseLoginToolResult(result) {
  try {
    if (result?.isError || !Array.isArray(result?.content)) throw 0;
    const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    if (text.length > 131072) throw 0;
    const sections = text.split(/^### /m).filter(part => part.startsWith("Result\n"));
    if (sections.length !== 1) throw 0;
    const value = JSON.parse(sections[0].slice(7).trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value;
  } catch { throw new LoginProbeError("discovery", "invalid-tool-result"); }
}
function shape(value, keys) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function entryReceipt(value, width, height) {
  if (!shape(value, ["width", "height", "hostname", "visible", "enabled", "noHorizontalOverflow", "chatsStatus"]) || value.width !== width || value.height !== height || value.hostname !== HOST ||
    value.visible !== true || value.enabled !== true || value.noHorizontalOverflow !== true || value.chatsStatus !== 401) throw new LoginProbeError(`entry-${width}`, "entry-check-failed");
  return { width, height, googleButtonVisible: true, googleButtonEnabled: true, noHorizontalOverflow: true, anonymousChatsStatus: 401 };
}
function googleReceipt(value) {
  if (!shape(value, ["hostname", "redirectUriMismatch", "googleError400", "visibleEmailField"]) || ![HOST, "accounts.google.com", "unexpected-host"].includes(value.hostname) ||
    ["redirectUriMismatch", "googleError400", "visibleEmailField"].some(key => typeof value[key] !== "boolean")) throw new LoginProbeError("google-initiation", "invalid-tool-result");
  return { ...value, providerReached: value.hostname === "accounts.google.com", loginVerified: false };
}
async function bounded(operation, ms, signal) {
  let timer, abort;
  try {
    return await Promise.race([Promise.resolve().then(() => { if (signal?.aborted) throw 0; return operation(); }), new Promise((_, reject) => {
      abort = () => reject(new LoginProbeError("prepare", "cancelled-or-deadline"));
      timer = setTimeout(abort, ms); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
export async function smokeDeployedLogin(options, { signal, clientFactory = info => new Client(info), transportFactory = config => new StdioClientTransport(config),
  outputRoot = path.join(ROOT, "test-results"), callTimeoutMs = 45000, cleanupTimeoutMs = 6000 } = {}) {
  // Programmatic callers cannot bypass the CLI's explicit initiation gate.
  if (options?.checkGoogleRedirect && !options?.run) throw new LoginProbeError("prepare");
  if (!options?.run) return { schema: 1, dryRun: true, ...boundary, viewports: loginViewports, browserTransport: "installed official Playwright MCP", googleRedirectRequested: false };
  let phase = "prepare", client, transport, directory, failure, receipt;
  const transportClosure = Promise.withResolvers();
  const cleanup = { browserClosed: false, clientClosed: false, transportClosed: false, privateTransientFilesRemoved: false };
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 180000);
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  try {
    if (combined.aborted) throw new LoginProbeError(phase, "cancelled-or-deadline");
    await mkdir(outputRoot, { recursive: true }); const parent = await lstat(outputRoot);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()) throw 0;
    directory = await mkdtemp(path.join(outputRoot, "deployed-login-")); await chmod(directory, 0o700);
    for (const name of ["screenshots", "home", "mcp"]) await mkdir(path.join(directory, name), { mode: 0o700 });
    client = clientFactory({ name: "relay-deployed-login-probe", version: "1.0.0" });
    transport = transportFactory({ command: process.execPath, args: [path.join(ROOT, "node_modules/@playwright/mcp/cli.js"), "--headless", "--isolated", "--browser", "chrome", "--snapshot-mode", "none", "--image-responses", "omit", "--output-dir", path.join(directory, "mcp")],
      cwd: ROOT, env: { HOME: path.join(directory, "home"), PATH: process.env.PATH, LANG: "C.UTF-8" }, stderr: "pipe", maxBufferSize: 1024 * 1024 });
    // SDK close() may resolve immediately after SIGKILL without observing close.
    // Protocol.connect preserves this previous handler when installing its own.
    transport.onclose = () => transportClosure.resolve();
    transport.stderr?.on("data", () => {});
    const call = async (name, args = {}) => {
      const result = await bounded(() => client.callTool({ name, arguments: args }, undefined, { timeout: callTimeoutMs, signal: combined }), callTimeoutMs, combined);
      if (result?.isError) throw new LoginProbeError(phase); return result;
    };
    phase = "connect"; await bounded(() => client.connect(transport), 20000, combined);
    phase = "discovery"; const tools = (await bounded(() => client.listTools({}, { timeout: callTimeoutMs, signal: combined }), callTimeoutMs, combined)).tools;
    const names = Array.isArray(tools) ? tools.map(tool => tool.name) : [];
    const runTool = names.includes("browser_run_code_unsafe") ? "browser_run_code_unsafe" : "browser_run_code";
    if (![runTool, "browser_resize", "browser_navigate", "browser_close"].every(name => names.includes(name))) throw new LoginProbeError(phase, "missing-tools");
    const runCode = async code => parseLoginToolResult(await call(runTool, { code: `async (page) => { ${code} }` }));
    const entries = [];
    for (const [width, height] of loginViewports) {
      phase = `entry-${width}`;
      await call("browser_resize", { width, height });
      if (!entries.length) await call("browser_navigate", { url: transportOrigin + "/" });
      const screenshot = path.join(directory, "screenshots", `entry-${width}.png`);
      const value = await runCode(`if(!page.url().startsWith(${JSON.stringify(transportOrigin + "/")}))throw Error('Unexpected entry origin');
        await page.locator('#google-sign-in').waitFor({state:'visible',timeout:20000});
        await page.waitForFunction(()=>!document.querySelector('#google-sign-in')?.disabled,undefined,{timeout:20000});
        const visible=await page.locator('#google-sign-in').isVisible(),enabled=await page.locator('#google-sign-in').isEnabled();
        const measured=await page.evaluate(async()=>{if(location.origin!==${JSON.stringify(transportOrigin)})throw Error('Unexpected entry origin');const response=await fetch(${JSON.stringify(transportOrigin + "/api/chats")},{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});const chatsStatus=response.status;await response.body?.cancel();return {width:innerWidth,height:innerHeight,noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth&&document.body.scrollWidth<=innerWidth,chatsStatus};});
        if(!page.url().startsWith(${JSON.stringify(transportOrigin + "/")}))throw Error('Unexpected entry origin');
        await page.screenshot({path:${JSON.stringify(screenshot)},fullPage:true,timeout:10000});
        return {...measured,hostname:page.url().split('/')[2],visible,enabled};`);
      entries.push(entryReceipt(value, width, height));
      const file = await lstat(screenshot); if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid() || file.size > 10 * 1024 * 1024) throw 0;
      await chmod(screenshot, 0o600);
    }
    let google = null;
    if (options.checkGoogleRedirect) {
      phase = "google-initiation";
      google = googleReceipt(await runCode(`if(!page.url().startsWith(${JSON.stringify(transportOrigin + "/")}))throw Error('Unexpected entry origin');
        await page.locator('#google-sign-in').click({timeout:10000});
        await page.waitForURL(url=>url.hostname==='accounts.google.com',{timeout:30000,waitUntil:'domcontentloaded'}).catch(()=>{});
        const host=page.url().split('/')[2];
        const flags=await page.evaluate(()=>{const text=(document.body?.innerText||'').slice(0,65536);const email=document.querySelector('input[type=email]');const box=email?.getBoundingClientRect();return {redirectUriMismatch:/redirect_uri_mismatch/i.test(text),googleError400:/Error\\s*400|400[.:]\\s*(?:That|Bad Request)/i.test(text),visibleEmailField:!!email&&!!box&&box.width>0&&box.height>0&&getComputedStyle(email).visibility!=='hidden'};});
        return {hostname:host==='accounts.google.com'?host:host===${JSON.stringify(HOST)}?host:'unexpected-host',...flags};`));
    }
    receipt = { schema: 1, dryRun: false, ...boundary, checkedAt: new Date().toISOString(), browserTransport: "installed official Playwright MCP", entries,
      googleRedirectRequested: !!options.checkGoogleRedirect, google, screenshotsDirectory: path.join(directory, "screenshots") };
  } catch (error) {
    failure = new LoginProbeError(phase, error instanceof LoginProbeError ? error.category : combined.aborted ? "cancelled-or-deadline" : "failed");
  } finally {
    clearTimeout(timer);
    for (const [key, action] of [["browserClosed", () => client?.callTool({ name: "browser_close", arguments: {} }, undefined, { timeout: cleanupTimeoutMs })],
      ["clientClosed", () => client?.close()], ["transportClosed", async () => { if (transport) { await transport.close(); await transportClosure.promise; } }]]) {
      if (!client && !transport) { cleanup[key] = true; continue; }
      try { const result = await bounded(action, cleanupTimeoutMs); if (result?.isError) throw 0; cleanup[key] = true; } catch { /* Fixed flags, never raw cleanup errors. */ }
    }
    // Never persist OAuth snapshots/logs/profile state. Pre-provider entry PNGs alone remain private.
    if (directory && cleanup.transportClosed) {
      try { for (const name of ["home", "mcp"]) await rm(path.join(directory, name), { recursive: true, force: true }); cleanup.privateTransientFilesRemoved = true; } catch { /* Preserve primary failure. */ }
    } else cleanup.privateTransientFilesRemoved = !directory;
  }
  if (failure) { failure.cleanup = cleanup; throw failure; }
  if (!Object.values(cleanup).every(Boolean)) throw new LoginProbeError("cleanup", "cleanup-unconfirmed", cleanup);
  return { ...receipt, cleanup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController(); for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => controller.abort());
  try { console.log(JSON.stringify(await smokeDeployedLogin(parseLoginOptions(process.argv.slice(2)), { signal: controller.signal }), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, phase: error instanceof LoginProbeError ? error.phase : "prepare", category: error instanceof LoginProbeError ? error.category : "failed", ...(error instanceof LoginProbeError && error.cleanup ? { cleanup: error.cleanup } : {}) })); process.exitCode = 1; }
}
