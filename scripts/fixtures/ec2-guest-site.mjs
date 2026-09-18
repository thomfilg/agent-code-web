// Standalone guest fixture. Sent through the private SSH launcher, never stored
// in the application database. No external dependencies or account credentials.
import http from "node:http";
import { createInterface } from "node:readline";
import { mkdir, writeFile, readFile, readdir, lstat, realpath, rm, readlink } from "node:fs/promises";
import path from "node:path";

const requireValue = value => { if (!value) throw Error("Guest fixture invariant failed"); };
export const validGuestRun = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value || "");
export async function chromeSandboxReceipt(root, { proc = "/proc", uid = process.getuid() } = {}) {
  const processes = []; let scanComplete = true;
  for (const name of await readdir(proc)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const base = path.join(proc, name);
      const comm = (await readFile(path.join(base, "comm"), "utf8")).trim();
      if (!/^(?:chrome|google-chrome|Chrome_)/.test(comm)) continue;
      const status = await readFile(path.join(base, "status"), "utf8");
      // proc directory ownership changes to root for nondumpable sandboxed
      // renderers. The status effective UID describes the actual process.
      const effectiveUid = status.match(/^Uid:\s+\d+\s+(\d+)/m)?.[1];
      if (effectiveUid === undefined) { scanComplete = false; continue; }
      if (Number(effectiveUid) !== uid) continue;
      // Chrome rewrites child argv into one space-separated proc title. The
      // fixture's executable/profile paths contain no whitespace; tokenize
      // both native argv and those rewritten titles for flag checks.
      const args = (await readFile(path.join(base, "cmdline"))).toString().split(/[\0\s]+/).filter(Boolean);
      let cwd = null;
      try { cwd = await readlink(path.join(base, "cwd")); } catch { /* Nondumpable renderer: keep it in the inventory. */ }
      processes.push({ pid: Number(name), ppid: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]), args, cwd,
        seccomp: status.match(/^Seccomp:\s+(\d+)/m)?.[1], nspid: (status.match(/^NSpid:\s+(.+)/m)?.[1] || "").trim().split(/\s+/).filter(Boolean) });
    } catch {
      // A disappearing PID is normal; unreadable metadata for an extant PID
      // is not proof that a run-owned Chrome process has exited.
      try { await lstat(path.join(proc, name)); scanComplete = false; } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) scanComplete = false; }
    }
  }
  const roots = processes.filter(p => p.args.some(arg => arg.startsWith(`--user-data-dir=${root}/tmp/relay-chrome-`)) && p.args.includes("--remote-debugging-pipe") && !p.args.some(arg => arg.startsWith("--type=")));
  // Include orphaned renderers/crash handlers still in this run's workspace;
  // disappearance of the browser root alone is not proof of cleanup.
  const descendants = new Set(processes.filter(p => p.args.some(arg => arg.startsWith(`--user-data-dir=${root}/tmp/relay-chrome-`)) ||
    /^(?:chrome|google-chrome(?:-stable)?|chrome_crashpad_handler)$/.test(path.basename(p.args[0] || "")) && p.cwd?.startsWith(root + "/")).map(p => p.pid));
  for (let i = 0; i < processes.length; i++) for (const p of processes) if (descendants.has(p.ppid)) descendants.add(p.pid);
  const children = processes.filter(p => descendants.has(p.pid));
  const unrelated = new Set(processes.filter(p => !descendants.has(p.pid) && p.args.some(arg => arg.startsWith("--user-data-dir=") && !arg.startsWith(`--user-data-dir=${root}/`))).map(p => p.pid));
  for (let i = 0; i < processes.length; i++) for (const p of processes) if (!descendants.has(p.pid) && unrelated.has(p.ppid)) unrelated.add(p.pid);
  // A renderer outside the discovered tree without readable cwd or explicit
  // profile cannot safely be classified as unrelated after its parent exits.
  for (const p of processes) if (!descendants.has(p.pid) && !unrelated.has(p.pid) && !p.cwd) scanComplete = false;
  const renderers = children.filter(p => p.args.includes("--type=renderer"));
  return { roots: roots.length, processes: children.length, renderers: renderers.length, scanComplete,
    nonRoot: uid > 0, pipeOnly: roots.length === 1 && children.every(p => !p.args.some(arg => arg.startsWith("--remote-debugging-port"))),
    noSandboxBypass: children.every(p => !p.args.some(arg => ["--no-sandbox", "--disable-setuid-sandbox", "--disable-seccomp-filter-sandbox", "--disable-namespace-sandbox"].includes(arg))),
    rendererSeccomp: renderers.length > 0 && renderers.every(p => p.seccomp === "2"),
    rendererNamespace: roots.length === 1 && roots[0].nspid.length > 0 && renderers.length > 0 && renderers.every(p => p.nspid.length > roots[0].nspid.length) };
}

export function guestHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>EC2 guest acceptance</title><style>
  html,body{margin:0;background:#edf4ff;font:16px sans-serif;color:#17243e}h1{margin:20px;font-size:22px}
  #click,#entry,#echo,#live,#metrics,#stripes{position:absolute;left:24px}#click{top:100px}#entry{top:160px;width:240px}
  #echo{top:210px}#live{top:240px}#metrics{top:270px;font-size:12px}#stripes{left:20px;top:310px;width:100px;height:8px;background:repeating-linear-gradient(90deg,#000 0,#000 1px,#fff 1px,#fff 2px)}#live-tile{position:absolute;left:150px;top:310px;width:10px;height:8px;background:#e00000}
  button,input{font:inherit;padding:8px}button{background:#225ddd;color:white;border:0}</style></head><body>
  <h1>EC2 guest acceptance</h1><button id="click">Clicks: 0</button><input id="entry" aria-label="Example input"><p id="echo"></p><p id="live">Waiting</p><p id="metrics"></p><div id="stripes"></div><div id="live-tile"></div>
  <script>const documentId=crypto.randomUUID();let clicks=0;const entry=document.querySelector('#entry');
  function report(){const value={documentId,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,clicks,text:entry.value,live:document.querySelector('#live').textContent};document.querySelector('#metrics').textContent=innerWidth+'x'+innerHeight+' @'+devicePixelRatio;fetch('/observed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}).catch(()=>{});}
  document.querySelector('#click').onclick=()=>{document.querySelector('#click').textContent='Clicks: '+(++clicks);report()};entry.oninput=()=>{document.querySelector('#echo').textContent=entry.value;report()};addEventListener('resize',report);requestAnimationFrame(report);
  new EventSource('/events').onmessage=e=>{document.querySelector('#live').textContent=e.data;document.querySelector('#live-tile').style.background='#00c040';report()};</script></body></html>`;
}

export async function startGuestSite(runId, { rootBase = "/opt/agent-web", sandbox = chromeSandboxReceipt } = {}) {
  requireValue(validGuestRun(runId) && process.getuid() > 0);
  const root = path.join(rootBase, `guest-acceptance-${runId}`);
  await mkdir(root, { mode: 0o700 }); // Never reuse another or a stale run.
  await writeFile(path.join(root, "owner.json"), JSON.stringify({ runId, pid: process.pid }), { flag: "wx", mode: 0o600 });
  for (const name of ["workspace", "runtime-home", "tmp"]) await mkdir(path.join(root, name), { mode: 0o700 });
  let observed = {}, closing;
  const events = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === "/" && request.method === "GET") { response.setHeader("content-type", "text/html"); response.end(guestHtml()); return; }
      if (request.url === "/events" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }); response.write(": ready\n\n");
        events.add(response); response.once("close", () => events.delete(response)); return;
      }
      if (request.url === "/observed" && request.method === "POST") {
        let length = 0; const chunks = [];
        for await (const chunk of request) { length += chunk.length; requireValue(length <= 4096); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks));
        requireValue(validGuestRun(input.documentId) && Number.isInteger(input.width) && Number.isInteger(input.height) && Number.isFinite(input.dpr) && Number.isInteger(input.clicks) && typeof input.text === "string" && input.text.length <= 128 && typeof input.live === "string" && input.live.length <= 128);
        observed = Object.fromEntries(["documentId", "width", "height", "dpr", "clicks", "text", "live"].map(key => [key, input[key]]));
        response.end("ok"); return;
      }
      response.writeHead(404); response.end();
    } catch { response.writeHead(400); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const close = () => closing ||= (async () => {
    for (const event of events) event.end();
    const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped;
    const info = await lstat(root), marker = JSON.parse(await readFile(path.join(root, "owner.json"), "utf8"));
    requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077) && await realpath(root) === root && marker.runId === runId && marker.pid === process.pid);
    const inventory = await sandbox(root); requireValue(inventory.scanComplete === true && inventory.processes === 0);
    await rm(root, { recursive: true, force: false });
  })();
  return { root, url: `http://127.0.0.1:${server.address().port}/`, close,
    async command(action) {
      if (action === "status") return { ...observed };
      if (action === "sandbox") return sandbox(root);
      if (action === "refresh") { for (const event of events) event.write("data: Updated live\n\n"); return { refreshed: true }; }
      throw Error("Unsupported guest fixture action");
    } };
}

if (process.argv[1] === "--relay-guest-site") {
  let site;
  const send = value => new Promise(resolve => process.stdout.write(JSON.stringify(value) + "\n", resolve));
  const stop = async () => { try { await site?.close(); process.exitCode = 0; } catch { process.exitCode = 1; } process.stdin.destroy(); };
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(name, stop);
  try {
    site = await startGuestSite(process.argv[2]);
    await send({ event: "ready", value: { root: site.root, url: site.url } });
    const input = createInterface({ input: process.stdin });
    input.on("line", async line => {
      let value; try {
        requireValue(line.length <= 1024); value = JSON.parse(line); requireValue(Number.isSafeInteger(value.id));
        if (value.action === "stop") { await site.close(); await send({ id: value.id, value: { cleanedUp: true } }); input.close(); process.stdin.destroy(); return; }
        await send({ id: value.id, value: await site.command(value.action) });
      } catch { await send({ id: value?.id, error: "Guest fixture action failed" }); }
    });
    input.once("close", stop);
  } catch { process.stderr.write("Guest fixture failed; private diagnostics suppressed\n"); await stop(); }
}
