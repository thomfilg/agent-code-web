// Manual, fixture-only acceptance through the installed official Playwright MCP.
// No deployed server, OAuth, provider accounts, AWS or model requests are used.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "test-results/app-preview-mcp"); await mkdir(output, { recursive: true, mode: 0o700 });
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/app-preview.css"><button id="show">Open app</button><script type="module">
import { AppPreviewDialog } from '/app-preview.js';
window.calls=[];window.status='none';
window.preview=new AppPreviewDialog({getChat:()=>({id:'chat_12345678123412341234123456789abc',ownerId:'fixture'}),getBackend:()=>'ec2',
api:async(url,o)=>{window.calls.push({url,method:o.method});if(url.endsWith('/open'))return {url:location.origin+'/app-preview/open?launch=fixture'};
if(o.method==='POST')window.status='pending';if(o.method==='DELETE')window.status='revoking';
return {preview:{id:'fixture',status:window.status,port:3000,retryable:false,canRevoke:['pending','ready'].includes(window.status),hostname:'d123.cloudfront.net'}};}});
document.querySelector('#show').onclick=()=>window.preview.open();</script>`;
const allowed = new Set(["styles.css", "app-preview.css", "app-preview.js", "browser-links.js"]);
const server = createServer(async (req, res) => {
  if (req.url === "/") { res.setHeader("content-type", "text/html"); return res.end(html); }
  if (req.url === "/app-preview/open?launch=fixture") { res.setHeader("content-type", "text/html"); return res.end("<!doctype html><title>Fixture launch destination</title><p>Fixture only</p>"); }
  const name = req.url.slice(1); if (!allowed.has(name)) { res.writeHead(404); return res.end(); }
  res.setHeader("content-type", name.endsWith(".css") ? "text/css" : "text/javascript"); res.end(await readFile(path.join(root, "public", name)));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const client = new Client({ name: "preview-ui-fixture", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "node_modules/@playwright/mcp/cli.js"), "--headless", "--isolated", "--browser", "chrome", "--output-dir", output, "--snapshot-mode", "none", "--image-responses", "omit"], cwd: root, stderr: "pipe" });
transport.stderr?.on("data", () => {});
const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 25000 }); assert.notEqual(result.isError, true, `Fixture ${name} failed`); return result; };
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name), run = names.includes("browser_run_code_unsafe") ? "browser_run_code_unsafe" : "browser_run_code";
  await call(run, { code: `async(page)=>{await page.goto(${JSON.stringify(origin)});await page.getByRole('button',{name:'Open app',exact:true}).click();await page.getByRole('button',{name:'Set up preview',exact:true}).click();await page.getByRole('status').filter({hasText:'several minutes'}).waitFor();await page.evaluate(()=>window.status='ready');await page.getByRole('button',{name:'Refresh status'}).click();await page.getByRole('button',{name:'Open app ↗',exact:true}).waitFor();return {ready:true};}` });
  for (const width of [1600, 390, 320]) {
    await call(run, { code: `async(page)=>{await page.setViewportSize({width:${width},height:900});if(!(await page.locator('#app-preview-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)))throw Error('Fixture dialog overflow');await page.screenshot({path:${JSON.stringify(path.join(output, `ready-${width}.png`))}});return {width:${width},overflow:false};}` });
  }
  await call(run, { code: `async(page)=>{const opened=page.waitForEvent('popup');await page.getByRole('button',{name:'Open app ↗',exact:true}).click();const popup=await opened;await popup.waitForURL(${JSON.stringify(origin + "/app-preview/open?launch=fixture")});const safe=await popup.evaluate(()=>({openerNull:window.opener===null,referrerEmpty:document.referrer===''}));if(!safe.openerNull||!safe.referrerEmpty)throw Error('Fixture popup isolation failed');await popup.close();return safe;}` });
  console.log(JSON.stringify({ fixtureOnly: true, officialMcp: true, widths: [1600, 390, 320], actualPopupIsolated: true, screenshots: "test-results/app-preview-mcp" }));
} finally {
  await client.close().catch(() => {}); await transport.close().catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
