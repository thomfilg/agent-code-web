import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OfficialBrowserMcp, officialBrowserVersions, matchingBrowserRuntime } from "../src/official-browser-mcp.mjs";
import { authorizeBrowserTool } from "../src/official-browser-policy.mjs";
import os from 'node:os';
import path from 'node:path';
import {readdir,stat} from 'node:fs/promises';
import {temporaryDirectory} from './helpers.mjs';

const binding = () => ({ ownerId: "synthetic-owner", chatId: "synthetic-chat", companyId: "synthetic-company", environmentId: "synthetic-environment",
  provider: "codex", accountId: "synthetic-account", accountRevision: 1, companyRevision: 1, environmentRevision: 1,
  attemptId: "synthetic-attempt", mode: "guest", generation: 1 });
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) { if (Date.now() > deadline) throw Error("Synthetic MCP gate timed out"); await delay(5); }
}
function fixture(t, { mode = "guest", acquireGate, releaseFailure = false } = {}) {
  const original = { ...binding(), mode, ...(mode === "personal" ? { personalGrantId: "synthetic-grant" } : {}) };
  const f = { current: structuredClone(original), acquired: 0, released: 0, releaseFailure };
  f.proxy = new OfficialBrowserMcp({ binding: original, validateBinding: observed => isDeepStrictEqual(observed, f.current),
    acquireContext: async ({ playwright }) => {
      f.acquired++;
      const browser = await playwright.chromium.launch({ executablePath: "/usr/bin/google-chrome-stable", headless: true, chromiumSandbox: true });
      f.browser = browser; const context = await browser.newContext(); f.page = await context.newPage();
      await acquireGate?.();
      return { context, release: async () => { f.released++; if (f.releaseFailure) { f.releaseFailure = false; throw Error("synthetic private cleanup diagnostic"); } await browser.close(); } };
    } });
  t.after(async () => { await f.proxy.close().catch(() => {}); await f.browser?.close(); });
  return f;
}

test("actual pinned official catalog is lazy and unsafe default core tools cannot bypass Relay policy", async t => {
  assert.deepEqual(officialBrowserVersions, { mcp: "0.0.81", playwright: "1.64.0-alpha-2026-09-14" });
  const require = createRequire(import.meta.url), official = require("@playwright/mcp");
  let contexts = 0;
  const server = await official.createConnection({ browser: { isolated: false }, capabilities: [] }, async () => { contexts++; throw Error("must not acquire"); });
  const client = new Client({ name: "synthetic-catalog", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const raw = await client.listTools(); assert.equal(contexts, 0);
  assert.ok(raw.tools.some(tool => tool.name === "browser_run_code_unsafe"), "capabilities:[] does not exclude unsafe official core tools");
  const f = fixture(t), catalog = await f.proxy.toolsList();
  assert.equal(f.acquired, 0); assert.equal(f.browser, undefined);
  assert.ok(catalog.tools.some(tool => tool.name === "browser_click"));
  for (const name of ["browser_run_code_unsafe", "browser_cookie_list", "browser_storage_state", "browser_network_requests", "browser_network_request", "browser_console_messages", "browser_file_upload", "browser_close", "browser_install", "browser_route"]) {
    assert.equal(catalog.tools.some(tool => tool.name === name), false);
    assert.throws(() => f.proxy.callTool({ name, arguments: {} }), { code: "TOOL_DENIED" });
  }
  for (const [name, args] of [["browser_snapshot", { filename: "/tmp/not-allowed" }], ["browser_evaluate", { function: "() => 1", filename: "private" }],
    ["browser_navigate", { url: "file:///private" }], ["browser_navigate", { url: "https://user:secret@example.test" }],
    ["browser_navigate", { url: "javascript:alert(1)" }], ["browser_wait_for", { time: 3600 }], ["browser_click", { target: "button", unknown: true }]]) {
    assert.throws(() => f.proxy.callTool({ name, arguments: args }), { code: "ARGUMENTS_DENIED" });
  }
  assert.equal(f.acquired, 0);
  assert.equal(catalog.tools.find(tool => tool.name === "browser_snapshot").inputSchema.properties.filename, undefined);
});

test("stable mode catalog never grants unsupported personal operations or a whole-profile projection", async t => {
  const f = fixture(t, { mode: "personal" }), catalog = await f.proxy.toolsList();
  const guest=fixture(t),guestCatalog=await guest.proxy.toolsList();
  assert.deepEqual(catalog,guestCatalog,'native clients can cache exactly the same names, descriptions and schemas');
  for(const name of ['browser_evaluate','browser_resize','browser_take_screenshot'])assert.throws(()=>authorizeBrowserTool('personal',name,{}),{code:'MODE_UNAVAILABLE'});
  const tabs = catalog.tools.find(tool => tool.name === "browser_tabs"); assert.deepEqual(tabs.inputSchema.properties.action.enum, ["list","new","close","select"]);
  assert.throws(()=>authorizeBrowserTool('guest','browser_take_screenshot',{filename:'/tmp/escape.png'}),{code:'ARGUMENTS_DENIED'});
  assert.throws(()=>authorizeBrowserTool('guest','browser_take_screenshot',{fullPage:true}),{code:'ARGUMENTS_DENIED'});
  assert.deepEqual(authorizeBrowserTool("personal", "browser_click", { target: "button" }), { target: "button" });
  for (const action of ["new", "select", "close"]) assert.throws(() => authorizeBrowserTool("personal", "browser_tabs", { action }), { code: "ARGUMENTS_DENIED" });
  await assert.rejects(f.proxy.callTool({ name: "browser_snapshot" }), { code: "PERSONAL_PROJECTION_UNAVAILABLE" });
  assert.equal(f.acquired, 0);
});

test("official tools actually drive the supplied real disposable Chrome context, not a hidden browser", { timeout: 20000 }, async t => {
  const website = http.createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<title>Official MCP fixture</title><button onclick='window.count=(window.count||0)+1'>Count</button><input aria-label='Name'>"); });
  await new Promise(resolve => website.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => website.close(resolve)));
  const f = fixture(t); await f.proxy.toolsList();
  const result = await f.proxy.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${website.address().port}/` } });
  assert.notEqual(result.isError, true); assert.match(JSON.stringify(result), /Official MCP fixture/);
  assert.notEqual((await f.proxy.callTool({ name: "browser_click", arguments: { target: "button" } })).isError, true);
  assert.equal(await f.page.evaluate(() => window.count), 1);
  assert.notEqual((await f.proxy.callTool({ name: "browser_type", arguments: { target: "input", text: "Synthetic user" } })).isError, true);
  assert.equal(await f.page.locator("input").inputValue(), "Synthetic user");
  const evaluated = await f.proxy.callTool({ name: "browser_evaluate", arguments: { function: "() => ({count:window.count})" } });
  assert.notEqual(evaluated.isError, true); assert.equal(f.acquired, 1); assert.equal(f.browser.contexts().length, 1);
  await f.proxy.revoke(); assert.equal(f.released, 1); assert.equal(f.browser.isConnected(), false);
});

test("owner, company, selected account and generation changes fail before any browser acquisition", async t => {
  for (const field of ["ownerId", "chatId", "companyId", "environmentId", "provider", "accountId", "accountRevision", "companyRevision", "environmentRevision", "attemptId", "generation"]) {
    const f = fixture(t); await f.proxy.toolsList();
    f.current[field] = typeof f.current[field] === "number" ? 2 : "changed";
    await assert.rejects(f.proxy.callTool({ name: "browser_snapshot" }), /REVOKED|SCOPE_CHANGED/);
    assert.equal(f.acquired, 0, field);
  }
});

test("revocation while context acquisition is held cleans up the late context without executing input", { timeout: 20000 }, async t => {
  let release, entered = false;
  const f = fixture(t, { acquireGate: () => new Promise(resolve => { entered = true; release = resolve; }) });
  const call = f.proxy.callTool({ name: "browser_evaluate", arguments: { function: "() => {window.shouldNeverRun=true}" } }); call.catch(() => {});
  try {
    await until(() => entered); const closed = f.proxy.revoke(); release(); await closed;
    await assert.rejects(call, /REVOKED/); assert.equal(f.acquired, 1); assert.equal(f.released, 1); assert.equal(f.browser.isConnected(), false);
  } finally { release?.(); }
});

test("scope changes while a real official action runs discard the result and never replay the mutation", { timeout: 20000 }, async t => {
  const f = fixture(t);
  await f.proxy.callTool({ name: "browser_snapshot" });
  const result = f.proxy.callTool({ name: "browser_evaluate", arguments: { function: "async () => {window.mutations=(window.mutations||0)+1; await new Promise(r=>setTimeout(r,300)); return 'synthetic-private-result'}" } }); result.catch(() => {});
  await f.page.waitForFunction(() => window.mutations === 1);
  f.current.generation = 2;
  await assert.rejects(result, error => error.code === "REVOKED" && !error.message.includes("synthetic-private-result"));
  assert.equal(f.acquired, 1); assert.equal(f.released, 1);
  await assert.rejects(f.proxy.callTool({ name: "browser_snapshot" }), /REVOKED/);
});

test("authority/acquisition failures are sanitized and cannot fall back to a host browser", async t => {
  let acquired = 0;
  const denied = new OfficialBrowserMcp({ binding: binding(), validateBinding: () => { throw Error("private authority value"); }, acquireContext: () => { acquired++; } });
  t.after(() => denied.close());
  await assert.rejects(denied.toolsList(), error => error.code === "SCOPE_CHANGED" && !error.message.includes("private authority"));
  const failed = new OfficialBrowserMcp({ binding: binding(), validateBinding: () => true, acquireContext: () => { acquired++; throw Error("private profile path or credential"); } });
  t.after(() => failed.close());
  await assert.rejects(failed.callTool({ name: "browser_snapshot" }), error => error.code === "REVOKED" && !error.message.includes("private profile"));
  assert.equal(acquired, 1);
});

test("cleanup failure stays fenced and retry resumes release without reacquiring or replaying", { timeout: 20000 }, async t => {
  const f = fixture(t, { releaseFailure: true }); await f.proxy.callTool({ name: "browser_snapshot" });
  await assert.rejects(f.proxy.revoke(), { code: "CLEANUP_UNCONFIRMED" });
  await assert.rejects(f.proxy.callTool({ name: "browser_snapshot" }), /REVOKED/);
  await f.proxy.revoke(); assert.equal(f.released, 2); assert.equal(f.acquired, 1); assert.equal(f.browser.isConnected(), false);
});

test('official viewport screenshots expose no file paths, purge output and close on caller deadline', {timeout:20000}, async t=>{
  const root=await temporaryDirectory(t);t.mock.method(os,'tmpdir',()=>root);
  const f=fixture(t);await f.proxy.callTool({name:'browser_snapshot'});
  const directory=path.join(root,(await readdir(root)).find(name=>name.startsWith('relay-official-browser-mcp-')));
  const screenshot=await f.proxy.callTool({name:'browser_take_screenshot'});
  assert.equal(screenshot.content.filter(item=>item.type==='image').length,1);
  assert.deepEqual(await readdir(directory),[],'no accumulating screenshot output');
  assert.doesNotMatch(JSON.stringify(screenshot.content.filter(item=>item.type!=='image')),/\.png|\/tmp|file:/);
  const sockets=new Set(),site=http.createServer((req,res)=>{if(req.url==='/font')return;res.end('<style>@font-face{font-family:pending;src:url(/font)}body{font-family:pending}</style>Waiting font fixture');});
  site.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>site.close(resolve));});
  await f.page.goto(`http://127.0.0.1:${site.address().port}`,{waitUntil:'domcontentloaded'});
  await until(()=>f.page.evaluate(()=>document.fonts.status==='loading'));
  const controller=new AbortController(),pending=f.proxy.callTool({name:'browser_take_screenshot'},{signal:controller.signal});pending.catch(()=>{});
  await delay(100);controller.abort(Error('Synthetic caller deadline'));
  await assert.rejects(pending,/REVOKED/);
  await assert.rejects(stat(directory),{code:'ENOENT'});
  assert.equal(f.acquired,1);assert.equal(f.browser.isConnected(),false);
});

test("queued requests have an admission bound and revocation fences every waiting action", { timeout: 20000 }, async t => {
  let release, entered = false;
  const f = fixture(t, { acquireGate: () => new Promise(resolve => { entered = true; release = resolve; }) });
  const calls = Array.from({ length: 8 }, () => f.proxy.callTool({ name: "browser_snapshot" })); for (const call of calls) call.catch(() => {});
  try {
    await assert.rejects(f.proxy.callTool({ name: "browser_snapshot" }), { code: "BUSY" });
    await until(() => entered); const closed = f.proxy.revoke(); release(); await closed;
    const results = await Promise.allSettled(calls); assert.ok(results.every(result => result.status === "rejected"));
    assert.equal(f.acquired, 1); assert.equal(f.released, 1);
  } finally { release?.(); }
});
