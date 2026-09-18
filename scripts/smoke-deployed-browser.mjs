#!/usr/bin/env node
// Explicit, anonymous deployed-browser acceptance through the official
// Playwright MCP. Does not sign in, create chats or send model prompts.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.argv[2] || "https://d20atclccf8cku.cloudfront.net";
if (!["https://d20atclccf8cku.cloudfront.net", "http://localhost:8787"].includes(origin)) throw new Error("Select the authorized AWS or local Relay origin");
const destination = path.join(root, "test-results", origin.startsWith("https:") ? "aws-mcp" : "local-mcp");
await mkdir(destination, { recursive: true });
const ready = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(15000), redirect: "error" });
assert.equal(ready.status, 200, "Real database/directory readiness is required");
assert.deepEqual(await ready.json(), { ok: true });
const chats = await fetch(`${origin}/api/chats`, { signal: AbortSignal.timeout(15000), redirect: "error" });
assert.equal(chats.status, 401, "Anonymous browser cannot read saved chats");
const client = new Client({ name: "relay-deployed-browser-acceptance", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "node_modules/@playwright/mcp/cli.js"), "--headless", "--isolated", "--browser", "chrome", "--output-dir", destination], cwd: root, stderr: "pipe" });
transport.stderr?.on("data", () => {});
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} must succeed`);
  return (result.content || []).filter(item => item.type === "text").map(item => item.text).join("\n");
}
try {
  await client.connect(transport);
  await call("browser_navigate", { url: origin });
  await call("browser_wait_for", { text: "Continue with Google" });
  for (const width of [1600, 390, 320]) {
    await call("browser_resize", { width, height: width === 1600 ? 1000 : 844 });
    const snapshot = await call("browser_snapshot");
    assert.match(snapshot, /Sign in to Agent Relay/);
    assert.match(snapshot, /Continue with Google/);
    const layout = await call("browser_evaluate", { function: "() => ({ noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth, signInEnabled: !document.querySelector('#google-sign-in')?.disabled, configured: document.querySelector('#google-setup')?.hidden === true })" });
    for (const field of ["noHorizontalOverflow", "signInEnabled", "configured"]) assert.match(layout, new RegExp(`"${field}":\\s*true`));
    await call("browser_take_screenshot", { filename: path.join(destination, `google-entry-${width}.png`), fullPage: true, scale: "css" });
  }
  console.log(JSON.stringify({ origin, readiness: true, anonymousChats: 401, responsiveWidths: [1600, 390, 320], screenshots: destination, browserTransport: "official Playwright MCP", signedIn: false, modelPrompts: 0 }));
} finally {
  await client.callTool({ name: "browser_close", arguments: {} }).catch(() => {});
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
