import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ChromeBrowser } from "../src/browser-worker.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { testConfig, temporaryDirectory, waitFor } from "./helpers.mjs";
import { startBrowserSite } from "./fixtures/browser-site.mjs";
import { prepareChrome } from "../src/chrome-software.mjs";

const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || process.env.AGENT_CHROME_BIN || "google-chrome";
let available = false; try { execFileSync(executable, ["--version"], { stdio: "ignore" }); available = true; } catch {}

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
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "browser-fixture", AGENT_IDLE_TIMEOUT_MS: "60000", AGENT_CHROME_BIN: executable }) });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "mock", title: "Shared Chrome test" });
  const other = await app.manager.createChat({ agent: "mock", title: "Other Chrome" });
  const endpoint = `${url}/api/chats/${chat.id}/browser`, headers = { Authorization: "Bearer browser-fixture" };
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
  const tokenConfig = app.manager.browsers.runtime(chat.id, url).relay_browser;
  const client = new Client({ name: "browser-test", version: "1" }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(tokenConfig.url), { requestInit: { headers: tokenConfig.headers } }));
  const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === "browser_snapshot"));
  assert.equal((await client.callTool({ name: "browser_navigate", arguments: { url: site.url } })).isError, undefined);
  await waitFor(async () => (await app.manager.browsers.command(chat.id, "evaluate", { expression: "document.querySelector('#click') !== null" })));
  socket.send(JSON.stringify({ id: 1, action: "mouse", params: { type: "mousePressed", x: 60, y: 120, button: "left", buttons: 1, clickCount: 1 } }));
  socket.send(JSON.stringify({ id: 2, action: "mouse", params: { type: "mouseReleased", x: 60, y: 120, button: "left", buttons: 0, clickCount: 1 } }));
  await waitFor(() => events.some(e => e.id === 2));
  const result = await client.callTool({ name: "browser_evaluate", arguments: { expression: "document.querySelector('#click').textContent" } });
  assert.equal(JSON.parse(result.content[0].text), "Clicks: 1", "agent sees the user's click");
  await client.callTool({ name: "browser_fill", arguments: { selector: "#entry", text: "From the agent" } });
  await waitFor(() => events.some(e => e.event === "frame" && e.value.data.length > 5000));
  const screenshot = await client.callTool({ name: "browser_screenshot", arguments: {} }); assert.equal(screenshot.content[0].type, "image");
  const second = app.manager.browsers.runtime(other.id, url).relay_browser;
  assert.notEqual(second.headers.Authorization, tokenConfig.headers.Authorization);
  assert.equal(app.manager.browsers.info(other.id).running, false);
  assert.ok(app.manager.browsers.hasViewers(chat.id));
  await app.manager.stop(chat.id);
  assert.equal((await fetch(tokenConfig.url, { method: "POST", headers: { ...tokenConfig.headers, "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal(app.manager.browsers.info(chat.id).running, false);
  assert.equal(app.store.get(chat.id).messages.length, 0, "opening Chrome never starts an LLM or logs browser input into the transcript");
});
