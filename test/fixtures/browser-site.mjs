import http from "node:http";
import { WebSocketServer } from "ws";

export async function startBrowserSite({ port = 0 } = {}) {
  const observed = { text: "", clicks: 0, live: "" };
  const server = http.createServer(async (req, res) => {
    if (req.url === "/observed") {
      if (req.method === "POST") { let body = ""; for await (const chunk of req) body += chunk; Object.assign(observed, JSON.parse(body)); }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(observed)); return;
    }
    if (req.url === "/refresh" && req.method === "POST") {
      for (const socket of sockets.clients) socket.send("Updated live");
      res.end("ok"); return;
    }
    if (req.url === "/login" && req.method === "POST") {
      res.writeHead(303, { location: "/", "set-cookie": "fixture_login=alice; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400" }); res.end(); return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><title>Live development fixture</title><style>
      body{margin:24px;font:16px system-ui;background:#edf4ff;color:#17243e}h1{font-size:28px}button,input{font:inherit;padding:10px;border:1px solid #234;border-radius:6px}button{background:#225ddd;color:#fff;cursor:pointer}#click{position:absolute;left:24px;top:100px}#entry{position:absolute;left:24px;top:160px;width:320px}#echo{position:absolute;left:24px;top:220px}#live{position:absolute;left:24px;top:260px}form{position:absolute;left:24px;top:320px}#session{position:absolute;left:24px;top:380px}
      </style></head><body><h1>Live development fixture</h1><button id="click">Clicks: 0</button><input id="entry" aria-label="Example input" placeholder="Type here"><p id="echo"></p><p id="live">Waiting for refresh</p><form action="/login" method="post"><button>Fixture sign in</button></form><p id="session">${req.headers.cookie?.includes("fixture_login=alice") ? "Signed in as Alice" : "Signed out"}</p><script>
      const report=data=>fetch('/observed',{method:'POST',body:JSON.stringify(data)});
      sessionStorage.fixtureLoads=String(Number(sessionStorage.fixtureLoads || 0)+1); report({loads:Number(sessionStorage.fixtureLoads),hovered:false});
      let count=0; document.querySelector('#click').onclick=()=>{document.querySelector('#click').textContent='Clicks: '+(++count);report({clicks:count})};
      document.querySelector('#click').onmouseenter=()=>report({hovered:true});
      document.querySelector('#entry').oninput=e=>{document.querySelector('#echo').textContent=e.target.value;report({text:e.target.value})};
      new WebSocket('ws://'+location.host).onmessage=e=>{document.querySelector('#live').textContent=e.data;report({live:e.data})};
      </script></body></html>`);
  });
  const sockets = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, async close() {
    // Stop accepting HTTP/upgrades before draining clients, including Chrome's
    // unfinished/preconnected requests which closeIdleConnections leaves open.
    const httpClosed = new Promise(resolve => server.close(resolve));
    const wsClosed = new Promise(resolve => sockets.close(resolve));
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await Promise.all([httpClosed, wsClosed]);
  } };
}
