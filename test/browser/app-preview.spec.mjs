import { test as base, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/app-preview.css"></head><body><button id="show">Open app</button><script type="module">
import { AppPreviewDialog } from '/app-preview.js';
window.chat={id:'chat_12345678123412341234123456789abc',ownerId:'owner1'};
window.backend='ec2'; window.requests=[]; window.waiting=[]; window.mode='normal';
window.state={id:'preview1',status:'none',port:3000,retryable:false,canRevoke:false};
window.reply=null; window.popupRecords=[];
window.preview=new AppPreviewDialog({ getChat:()=>window.chat, getBackend:()=>window.backend, pollMs:200, requestTimeoutMs:1000,
  openWindow:()=>{ if(window.blocked)return null; const popup={opener:window,document:{createElement:()=>({click(){popup.url=this.href;}}),head:{append:x=>popup.meta=x},body:{append(){}},title:''},closed:false,close(){this.closed=true}}; window.popupRecords.push(popup); return popup; },
  api:async (url,options)=>{ window.requests.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});
    if(window.mode==='hold')return new Promise(resolve=>window.waiting.push(resolve));
    if(window.mode==='abort')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    if(window.mode==='fail')throw new Error('private arbitrary server error');
    if(url.endsWith('/open'))return window.warmPending ? {warming:{id:'warm_11111111-2222-4333-8444-555555555555',status:'pending',retryAfterMs:250}} : {url:window.launchUrl||location.origin+'/app-preview/open?launch=fixture-intent'};
    if(window.reply)return window.reply;
    const port=options.body?JSON.parse(options.body).port:Number(new URL(url,location.origin).searchParams.get('port'));
    if(options.method==='POST')window.state={...window.state,status:'pending',canRevoke:true};
    if(options.method==='DELETE')window.state={...window.state,status:'revoking',canRevoke:false};
    return {preview:{...window.state,port}};
  }});
document.querySelector('#show').onclick=()=>window.preview.open();
</script></body></html>`;

const test = base.extend({ fixture: async ({}, use) => {
  const files = new Set(["styles.css", "app-preview.css", "app-preview.js", "browser-links.js"]);
  const server = createServer(async (req, res) => {
    if (req.url === "/") { res.setHeader("content-type", "text/html"); return res.end(html); }
    const name = req.url.slice(1); if (!files.has(name)) { res.writeHead(404); return res.end(); }
    res.setHeader("content-type", name.endsWith(".css") ? "text/css" : "text/javascript"); res.end(await readFile(new URL("../../public/" + name, import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await use(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
} });
test.beforeEach(async ({ page, fixture }) => { await page.goto(fixture); await page.getByRole("button", { name: "Open app", exact: true }).click(); await expect(page.getByRole("button", { name: "Set up preview", exact: true })).toBeVisible(); });
const ready = async page => { await page.evaluate(() => { window.state={...window.state,status:'ready',hostname:'d123.cloudfront.net',canRevoke:true}; }); await page.getByRole("button", { name: "Refresh status" }).click(); await expect(page.getByRole("button", { name: "Open app ↗", exact: true })).toBeEnabled(); };

test("async setup shows immediate progress, polls status only, and opens explicit port/path via trusted Relay", async ({ page }) => {
  await page.getByLabel("App port").fill("8081"); await page.getByLabel("App path").fill("/dashboard?view=one#panel");
  await expect(page.getByRole("status")).toContainText("8081");
  await page.evaluate(() => { window.mode='hold'; }); await page.getByRole("button", { name: "Set up preview", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Starting preview setup"); await expect(page.getByLabel("App port")).toBeDisabled();
  await page.evaluate(() => { window.mode='normal'; window.state={...window.state,status:'pending',port:8081,canRevoke:true}; window.waiting.shift()({preview:window.state}); });
  await expect(page.getByRole("status")).toContainText("several minutes");
  await expect.poll(() => page.evaluate(() => window.requests.filter(r=>r.method==='GET').length)).toBeGreaterThan(2);
  expect(await page.evaluate(() => window.requests.filter(r=>r.url.endsWith('/open')))).toEqual([]);
  await ready(page); await page.getByRole("button", { name: "Open app ↗", exact: true }).click();
  expect(await page.evaluate(() => window.requests.find(r=>r.url.endsWith('/open')).body)).toEqual({port:8081,path:"/dashboard?view=one#panel"});
  expect(await page.evaluate(() => ({opener:window.popupRecords[0].opener,referrer:window.popupRecords[0].meta.content,url:window.popupRecords[0].url}))).toEqual({opener:null,referrer:"no-referrer",url:(new URL(page.url())).origin+"/app-preview/open?launch=fixture-intent"});
});

test("blocked popup issues no intent; foreign launch is refused and pending blank tab closes on chat change", async ({ page }) => {
  await ready(page); await page.evaluate(() => { window.blocked=true; }); await page.getByRole("button", { name: "Open app ↗", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No preview access was issued"); expect(await page.evaluate(() => window.requests.some(r=>r.url.endsWith('/open')))).toBe(false);
  await page.evaluate(() => { window.blocked=false; window.launchUrl='https://evil.test/app-preview/open?launch=a'; }); await page.getByRole("button", { name: "Open app ↗", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be opened"); expect(await page.evaluate(() => window.popupRecords[0].closed)).toBe(true);
  await page.evaluate(() => { window.mode='hold'; }); await page.getByRole("button", { name: "Open app ↗", exact: true }).click();
  await page.evaluate(() => { window.chat={...window.chat,id:'other-chat'}; window.preview.setChat(window.chat); window.waiting.shift()({url:location.origin+'/app-preview/open?launch=stale'}); });
  await expect(page.getByRole("dialog")).not.toBeVisible(); expect(await page.evaluate(() => ({closed:window.popupRecords[1].closed,url:window.popupRecords[1].url}))).toEqual({closed:true,url:undefined});
});

test("cold worker shows progress in dialog and detached tab, polls one job, then opens without a prompt", async ({ page }) => {
  await ready(page); await page.evaluate(() => { window.warmPending=true; });
  await page.getByRole("button", { name: "Open app ↗", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Preparing this chat’s worker");
  await expect(page.getByRole("button", { name: "Open app ↗", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.requests.filter(r=>r.url.endsWith('/open')).length)).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.popupRecords[0].url)).toBeUndefined();
  expect(await page.evaluate(() => window.popupRecords[0].document.body.textContent)).toContain("No agent prompt");
  expect(await page.evaluate(() => window.requests.filter(r=>r.url.endsWith('/open')).slice(1).every(r=>r.body.warmingId==='warm_11111111-2222-4333-8444-555555555555'))).toBe(true);
  await page.evaluate(() => { window.warmPending=false; });
  await expect.poll(() => page.evaluate(() => window.popupRecords[0].url)).toContain('/app-preview/open?launch=fixture-intent');
  expect(await page.evaluate(() => window.popupRecords[0].opener)).toBeNull();
});

test("closing warming tab stops polls; bounded warm deadline restores an actionable UI", async ({ page }) => {
  await ready(page); await page.evaluate(() => { window.warmPending=true; });
  await page.getByRole("button", { name: "Open app ↗", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Preparing this chat’s worker");
  await page.evaluate(() => window.popupRecords[0].close());
  await expect(page.getByRole("alert")).toContainText("could not be opened");
  const calls = await page.evaluate(() => window.requests.filter(r=>r.url.endsWith('/open')).length);
  await page.waitForTimeout(300); expect(await page.evaluate(() => window.requests.filter(r=>r.url.endsWith('/open')).length)).toBe(calls);
  await page.evaluate(() => { window.preview.warmTimeoutMs=30; });
  await page.getByRole("button", { name: "Open app ↗", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be opened");
  expect(await page.evaluate(() => window.popupRecords[1].closed)).toBe(true);
});

test("revocation remains available with invalid path and prevents launch while cleanup is pending", async ({ page }) => {
  await ready(page); await page.getByLabel("App path").fill("//evil.test/"); await expect(page.getByRole("button", { name: "Open app ↗", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Revoke preview" }).click(); await expect(page.getByRole("status")).toContainText("Access revoked");
  await expect(page.getByRole("button", { name: "Open app ↗", exact: true })).not.toBeVisible();
  expect(await page.evaluate(() => window.requests.find(r=>r.method==='DELETE').body)).toEqual({port:3000});
});

test("ambiguous setup error requires refresh before retry and never echoes server details", async ({ page }) => {
  await page.evaluate(() => { window.mode='fail'; }); await page.getByRole("button", { name: "Set up preview", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("provisioning may still be running"); await expect(page.getByRole("button", { name: "Set up preview", exact: true })).not.toBeVisible();
  await expect(page.locator("body")).not.toContainText("private arbitrary");
  await page.evaluate(() => { window.mode='normal'; window.state={...window.state,status:'error',retryable:true}; }); await page.getByRole("button", { name: "Refresh status" }).click();
  await page.getByRole("button", { name: "Retry setup" }).click(); await expect(page.getByRole("status")).toContainText("several minutes");
});

test("stale port response is ignored; unavailable state never offers localhost or launch", async ({ page }) => {
  await page.evaluate(() => { window.mode='hold'; }); await page.getByRole("button", { name: "Refresh status" }).click(); await page.getByLabel("App port").fill("9090");
  await page.evaluate(() => { window.mode='normal'; window.state={...window.state,status:'unavailable'}; window.waiting.shift()({preview:{id:'stale',status:'ready',port:3000,hostname:'wrong.cloudfront.net',retryable:false,canRevoke:true}}); });
  await expect(page.getByRole("status")).toContainText("unavailable"); await expect(page.locator(".app-preview-host")).toHaveText(""); await expect(page.getByRole("button", { name: "Open app ↗", exact: true })).not.toBeVisible();
  expect(await page.locator("#app-preview-dialog a[href]").count()).toBe(0);
});

test("bounded status timeout recovers and closing a pending dialog prevents stale reappearance", async ({ page }) => {
  await page.evaluate(() => { window.mode='abort'; window.preview.requestTimeoutMs=30; }); await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("alert")).toContainText("status is unavailable"); await expect(page.getByRole("button", { name: "Refresh status" })).toBeEnabled();
  await page.evaluate(() => { window.mode='hold'; }); await page.getByRole("button", { name: "Refresh status" }).click(); await page.getByRole("button", { name: "Close app preview" }).click();
  await page.evaluate(() => window.waiting.shift()({preview:{...window.state,status:'ready',hostname:'stale.cloudfront.net'}})); await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("local mode preserves existing chat alias and target, without remote requests", async ({ page }) => {
  await page.getByRole("button", { name: "Close app preview" }).click(); await page.evaluate(() => { window.backend='local'; window.requests=[]; window.preview.open({address:'http://localhost:8081/app?q=yes#tab'}); });
  await expect(page.getByRole("link", { name: "Open app ↗", exact: true })).toHaveAttribute("href", "http://chat_12345678123412341234123456789abc.localhost:8081/app?q=yes#tab");
  expect(await page.evaluate(() => window.requests)).toEqual([]); await expect(page.getByRole("button", { name: "Set up preview", exact: true })).not.toBeVisible();
});

test("dialog fits desktop and narrow mobile, with keyboard close", async ({ page }) => {
  await ready(page);
  for (const width of [1600,390,320]) { await page.setViewportSize({width,height:900}); expect(await page.locator("#app-preview-dialog").evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true); await expect(page.getByRole("button", { name: "Open app ↗", exact: true })).toBeVisible(); }
  await page.screenshot({path:test.info().outputPath("remote-preview-320.png")}); await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).not.toBeVisible();
});
