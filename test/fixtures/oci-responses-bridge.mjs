// Runs INSIDE the disposable OCI worker. Loopback HTTP is bridged through its
// owned stdio, never a controller TCP port or an external model service.
import http from "node:http";
import readline from "node:readline";
let nextId = 0;
const pending = new Map(), maxBytes = 2 * 1024 * 1024;
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || !["/v1/responses", "/tool-counter"].includes(request.url) || pending.size >= 4) {
    request.resume(); response.writeHead(400); response.end(); return;
  }
  let raw = "", length = 0;
  try {
    for await (const chunk of request) { length += chunk.length; if (length > maxBytes) throw Error("Fixture request too large"); raw += chunk; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); response.writeHead(504); response.end(); }, 15000);
    pending.set(id, { response, timer });
    process.stdout.write(JSON.stringify({ id, kind: request.url === "/tool-counter" ? "tool" : "responses", body: raw ? JSON.parse(raw) : {} }) + "\n");
  } catch { response.writeHead(400); response.end(); }
});
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  if (line.length > maxBytes) { process.exitCode = 1; server.closeAllConnections(); server.close(); return; }
  const message = JSON.parse(line), slot = pending.get(message.id);
  if (!slot) return;
  pending.delete(message.id); clearTimeout(slot.timer);
  const { response } = slot;
  if (message.error) { response.writeHead(500); response.end("Fixture assertion failed"); return; }
  if (message.text !== undefined) { response.writeHead(200, { "content-type": "text/plain" }); response.end(message.text); return; }
  const item = message.item;
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `oci_response_${message.id}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `oci_response_${message.id}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
lines.on("close", () => { for (const slot of pending.values()) clearTimeout(slot.timer); server.closeAllConnections(); server.close(); });
const port = Number(process.argv[2] || 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("Invalid fixture bridge port");
server.listen(port, "127.0.0.1", () => process.stdout.write(JSON.stringify({ ready: true, port: server.address().port }) + "\n"));
