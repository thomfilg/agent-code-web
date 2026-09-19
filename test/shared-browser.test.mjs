import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from "node:events";
import { connect } from "node:net";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ChromeBrowser } from "../src/browser-worker.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { testConfig, temporaryDirectory, waitFor } from "./helpers.mjs";
import { startBrowserSite } from "./fixtures/browser-site.mjs";
import { prepareChrome } from "../src/chrome-software.mjs";
import { browserSelectionExpression } from "../src/browser-clipboard.mjs";

const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || process.env.AGENT_CHROME_BIN || "google-chrome";
let available = false; try { execFileSync(executable, ["--version"], { stdio: "ignore" }); available = true; } catch {}
const pngSize = frame => {
  assert.equal(frame.mimeType, "image/png");
  const data = Buffer.from(frame.data, "base64");
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
};

test("browser fixture teardown closes unfinished HTTP preconnections without waiting for Chrome", async () => {
  const site = await startBrowserSite(), address = new URL(site.url);
  const socket = connect({ host: address.hostname, port: Number(address.port) }); socket.on("error", () => {});
  let closing, timer;
  try {
    await once(socket, "connect");
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
    await new Promise(resolve => setTimeout(resolve, 20));
    closing = site.close();
    const closed = await Promise.race([closing.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); })]);
    assert.equal(closed, true, "Fixture close must not wait for an incomplete browser request");
  } finally { clearTimeout(timer); socket.destroy(); await (closing || site.close()); }
});

test("Chrome installation prefers worker system binaries, or pins its private installer without sudo", async () => {
  const calls = [], executor = { workspace: "/workspace", runtimeHome: "/runtime", mkdir: async dir => calls.push({ dir }) };
  assert.equal(await prepareChrome(executor, async () => "/usr/bin/google-chrome"), "/usr/bin/google-chrome");
  const capture = async (_, command, args) => {
    calls.push({ command, args });
    if (command === "npm") return "chrome@147.0.0.0 /runtime/shared-chrome/cache/chrome/linux-147.0.0.0/chrome-linux64/chrome";
    return "";
  };
  assert.equal(await prepareChrome(executor, capture), "/runtime/shared-chrome/google-chrome");
  assert.ok(calls.some(call => call.command === "npm" && call.args.includes("--package=@puppeteer/browsers@3.2.2")));
  assert.ok(!calls.some(call => call.command === "sudo"));
  assert.ok(calls.some(call => call.command === "ln" && call.args.at(-1) === "/runtime/shared-chrome/google-chrome"));
});

test("browser-only worker acquisition is deduplicated and idle release does not retain a stopped executor", async t => {
  const root = await temporaryDirectory(t), calls = [];
  const app = await createAgentWebServer({ config: testConfig(root), models: { creationSettings: async () => ({}) }, workerBackend: {
    acquire: async () => { calls.push("acquire"); return { workspace: root, runtimeHome: root, metadata: { backend: "fixture" } }; },
    sleep: async () => calls.push("sleep"), destroy: async () => calls.push("destroy"),
  } });
  await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "codex", title: "Lease only" });
  const [one, two] = await Promise.all([app.manager.browserExecutor(chat.id), app.manager.browserExecutor(chat.id)]);
  assert.equal(one, two); assert.deepEqual(calls, ["acquire"]);
  await app.manager.browserIdle(chat.id); assert.deepEqual(calls, ["acquire", "sleep"]);
  await app.manager.browserExecutor(chat.id); assert.deepEqual(calls, ["acquire", "sleep", "acquire"]);
});

test("real Chrome: pipe-only sandboxed browser, live website, clicks, typing, dialogs, tabs and ephemeral profiles", { skip: !available }, async t => {
  const site = await startBrowserSite(); t.after(() => site.close());
  const browser = new ChromeBrowser({ executable }); t.after(() => browser.stop());
  const state = await browser.start(); assert.equal(state.mode, "guest");
  assert.ok(browser.child.spawnargs.includes("--remote-debugging-pipe"));
  assert.ok(!browser.child.spawnargs.some(arg => /no-sandbox|remote-debugging-port/.test(arg)));
  let frames = 0; browser.on("frame", () => frames++); await browser.watch(true);
  await browser.command("navigate", { url: site.url });
  await waitFor(() => browser.evaluate("document.querySelector('#click') !== null"));
  await browser.command("click", { selector: "#click" });
  assert.equal(await browser.evaluate("document.querySelector('#click').textContent"), "Clicks: 1");
  await browser.command("fill", { selector: "#entry", text: "User and agent see this" });
  assert.equal(await browser.evaluate("document.querySelector('#echo').textContent"), "User and agent see this");
  await waitFor(() => frames > 1);
  await fetch(`${site.url}/refresh`, { method: "POST" });
  await waitFor(async () => (await browser.evaluate("document.querySelector('#live').textContent")) === "Updated live");
  const snapshot = await browser.command("snapshot"); assert.ok(snapshot.nodes.some(node => node.name === "Clicks: 1"));
  assert.ok((await browser.command("screenshot")).data.length > 1000);
  await assert.rejects(browser.command("navigate", { url: "file:///etc/passwd" }), /HTTP/);
  await assert.rejects(browser.command("navigate", { url: "https://user:secret@example.com/" }), /credentials/);
  await assert.rejects(browser.command("resize", { width: 1, height: 800 }), /Viewport/);
  const original = browser.tabId; await browser.command("newTab"); assert.equal((await browser.tabs()).length, 2);
  await browser.command("selectTab", { id: original });
  const dialog = once(browser, "dialog");
  const evaluation = browser.evaluate("confirm('Example dialog')");
  assert.equal((await dialog)[0].message, "Example dialog");
  await browser.command("dialog", { accept: true }); assert.equal(await evaluation, true);
  await browser.command("click", { selector: "form button" });
  await waitFor(async () => (await browser.evaluate("document.querySelector('#session')?.textContent")) === "Signed in as Alice");
  const second = new ChromeBrowser({ executable }); t.after(() => second.stop()); await second.start();
  await second.command("navigate", { url: site.url });
  await waitFor(async () => (await second.evaluate("document.querySelector('#session')?.textContent")) === "Signed out");
  assert.notEqual(browser.directory, second.directory);
});

test("shared-browser gateway: authenticated WebSocket, real MCP, same live page, isolated chats and revocation", { skip: !available }, async t => {
  const root = await temporaryDirectory(t), site = await startBrowserSite(); t.after(() => site.close());
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "browser-fixture", AGENT_IDLE_TIMEOUT_MS: "60000", AGENT_CHROME_BIN: executable }),
    adapterFactory:()=>{throw Error('No model in browser fixture');},browserOptions:{isActive:()=>true,acquire:async()=>({workspace:root,runtimeHome:root,spawn:(command,args,options)=>spawn(command,args,options)})} });
  const { url } = await app.start(); t.after(() => app.stop());
  const ownerId=`user_${randomBytes(16).toString('hex')}`,services=await app.resources.forOwner(ownerId);
  await services.companies.save({id:'shared-company',name:'Shared fixture'});
  const environment=await services.environments.save({name:'Shared environment',backend:'local',companyId:'shared-company'}),accountId=`account_${randomUUID()}`;
  await app.manager.agentAccounts.save({id:accountId,ownerId,provider:'codex',name:'Synthetic account',status:'connected',revision:1,auth:{synthetic:true}});
  const chat = await app.store.create({ownerId,agent:'codex',agentAccountId:accountId,environmentId:environment.id,repositories:[{companyId:'shared-company',fullName:'fixture/shared'}],title:'Shared Chrome test'});
  const identity=await app.browserUsers.startSession({id:ownerId,username:'synthetic-shared-user'});
  const other = await app.manager.createChat({ agent: "mock", title: "Other Chrome" });
  const endpoint = `${url}/api/chats/${chat.id}/browser`, headers = { Authorization: "Bearer browser-fixture",Cookie:identity.cookie.split(';')[0] };
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers })).status, 200);
  assert.equal(app.manager.browsers.entries.size, 0, "reading browser state must not wake it");
  assert.equal((await fetch(endpoint, { method: "POST", headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
  const websocket = endpoint.replace("http:", "ws:") + "/live";
  for (const wsHeaders of [{ Origin: url }, { ...headers, Origin: "https://evil.example" }, headers]) {
    const ws = new WebSocket(websocket, { headers: wsHeaders });
    await new Promise(resolve => { ws.on("unexpected-response", (_, response) => { assert.equal(response.statusCode, 403); response.resume(); ws.terminate(); resolve(); }); ws.on("error", () => {}); });
  }
  const socket = new WebSocket(websocket, { headers: { ...headers, Origin: url } }); t.after(() => socket.terminate());
  const events = []; socket.on("message", data => events.push(JSON.parse(data))); await once(socket, "open");
  await waitFor(() => events.some(e => e.event === "status"), { timeoutMs: 10000 });
  const tokenConfig = app.manager.browsers.runtime(chat.id, url,{validWhile:()=>true}).relay_browser;
  const client = new Client({ name: "browser-test", version: "1" }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(tokenConfig.url), { requestInit: { headers: tokenConfig.headers } }));
  const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === "browser_snapshot"));
  assert.equal((await client.callTool({ name: "browser_navigate", arguments: { url: site.url } })).isError, undefined);
  await waitFor(async () => (await app.manager.browsers.command(chat.id, "evaluate", { expression: "document.querySelector('#click') !== null" })));
  socket.send(JSON.stringify({ id: 1, action: "mouse", params: { type: "mousePressed", x: 60, y: 120, button: "left", buttons: 1, clickCount: 1 } }));
  socket.send(JSON.stringify({ id: 2, action: "mouse", params: { type: "mouseReleased", x: 60, y: 120, button: "left", buttons: 0, clickCount: 1 } }));
  await waitFor(() => events.some(e => e.id === 2));
  const result = await client.callTool({ name: "browser_evaluate", arguments: { function: "() => document.querySelector('#click').textContent" } });
  assert.match(JSON.stringify(result), /Clicks: 1/, "agent sees the user's click");
  await client.callTool({ name: "browser_type", arguments: { target: "#entry", text: "From the agent" } });
  await app.manager.browsers.command(chat.id, "evaluate", { expression: "document.querySelector('#entry').select()" });
  socket.send(JSON.stringify({ id: 3, action: "copy", params: { expression: "document.body.textContent='must not execute'" } }));
  await waitFor(() => events.some(e => e.id === 3));
  assert.deepEqual(events.find(e => e.id === 3).value, { text: "From the agent" }, "copy ignores caller-supplied expressions");
  assert.ok(events.find(e => e.event === "status").value.clipboard);
  await waitFor(() => events.some(e => e.event === "frame" && e.value.data.length > 5000));
  const screenshot = await client.callTool({ name: "browser_take_screenshot", arguments: {} }); assert.ok(screenshot.content.some(item=>item.type==='image'));
  const second = app.manager.browsers.runtime(other.id, url).relay_browser;
  assert.notEqual(second.headers.Authorization, tokenConfig.headers.Authorization);
  assert.equal(app.manager.browsers.info(other.id).running, false);
  assert.ok(app.manager.browsers.hasViewers(chat.id));
  await app.manager.stop(chat.id);
  assert.equal((await fetch(tokenConfig.url, { method: "POST", headers: { ...tokenConfig.headers, "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal(app.manager.browsers.info(chat.id).running, false);
  assert.equal(app.store.get(chat.id).messages.length, 0, "opening Chrome never starts an LLM or logs browser input into the transcript");
});

test("idle frames are lossless, high-DPI and retain the exact CSS viewport through rapid resizing", { skip: !available }, async t => {
  const browser = new ChromeBrowser({ executable }); t.after(() => browser.stop()); await browser.start();
  const frames = []; browser.on("frame", frame => { if (frame.mimeType === "image/png") frames.push(frame); });
  await browser.watch(true);
  await waitFor(() => frames.some(frame => frame.width === 1280));
  assert.deepEqual(pngSize(frames.at(-1)), [2560, 1600]);
  await Promise.all([browser.resize({ width: 1920, height: 1080 }), browser.resize({ width: 834, height: 1112 }), browser.resize({ width: 390, height: 844 })]);
  assert.deepEqual(browser.viewport, { width: 390, height: 844 });
  await waitFor(() => frames.some(frame => frame.width === 390));
  assert.deepEqual(pngSize(frames.at(-1)), [780, 1688]);
  assert.deepEqual(await browser.evaluate("[innerWidth,innerHeight,devicePixelRatio]"), [390, 844, 2]);
  for (const frame of frames) assert.deepEqual(pngSize(frame), [frame.width * 2, frame.height * 2], "no stale bitmap may be labeled with the next viewport");
  await browser.resize({ width: 2560, height: 1600 });
  await waitFor(() => frames.some(frame => frame.width === 2560));
  assert.deepEqual(pngSize(frames.at(-1)), [2560, 1600], "very large custom views have a bounded bitmap size");
  await browser.watch(false); const count = frames.length;
  await browser.evaluate("document.body.style.background='red'");
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(frames.length, count, "closing the viewer stops captures, including in-flight frames");
});

test("remote copy reads only the explicit selection, including textarea/shadow DOM, never passwords or the host clipboard", { skip: !available }, async t => {
  const browser = new ChromeBrowser({ executable }); t.after(() => browser.stop()); await browser.start();
  await browser.evaluate(`document.body.innerHTML = '<input id="input" value="Selected fixture text"><textarea id="area">Line one\\nLine two</textarea><input type="password" id="password" value="fixture private"><div id="shadow"></div><p id="paragraph">Ordinary selected page text</p>'`);
  await browser.evaluate("document.querySelector('#input').focus();document.querySelector('#input').setSelectionRange(9,16)");
  assert.deepEqual(await browser.evaluate(browserSelectionExpression), { text: "fixture" });
  await browser.evaluate("document.querySelector('#area').focus();document.querySelector('#area').select()");
  assert.deepEqual(await browser.evaluate(browserSelectionExpression), { text: "Line one\nLine two" });
  await browser.evaluate("const root=document.querySelector('#shadow').attachShadow({mode:'open'});root.innerHTML='<input value=shadow>';root.firstChild.focus();root.firstChild.select()");
  assert.deepEqual(await browser.evaluate(browserSelectionExpression), { text: "shadow" });
  await browser.evaluate("document.querySelector('#password').focus();document.querySelector('#password').select()");
  await assert.rejects(browser.evaluate(browserSelectionExpression), /Password fields cannot/);
  await browser.evaluate("document.activeElement.blur();const range=document.createRange();range.selectNodeContents(document.querySelector('#paragraph'));getSelection().removeAllRanges();getSelection().addRange(range)");
  assert.deepEqual(await browser.evaluate(browserSelectionExpression), { text: "Ordinary selected page text" });
  await browser.evaluate("document.querySelector('#paragraph').contentEditable='true';document.querySelector('#paragraph').focus()");
  assert.deepEqual(await browser.evaluate(browserSelectionExpression), { text: "Ordinary selected page text" });
  await browser.evaluate("getSelection().removeAllRanges()");
  await assert.rejects(browser.evaluate(browserSelectionExpression), /Select text/);
  await browser.evaluate("const input=document.querySelector('#input');input.value='x'.repeat(30001);input.focus();input.select()");
  await assert.rejects(browser.evaluate(browserSelectionExpression), /30,000 characters/);
});
