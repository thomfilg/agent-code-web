import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserAuth } from "./auth.mjs";
import { CapabilityBroker } from "./capabilities.mjs";
import { loadConfig } from "./config.mjs";
import { ProviderGateway } from "./provider-gateway.mjs";
import { RuntimeManager } from "./runtime-manager.mjs";
import { ChatStore } from "./store.mjs";
import { errorMessage } from "./utils.mjs";
import { createWorkerBackend } from "./worker-backends.mjs";

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function securityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function json(response, status, body, headers = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

function summary(chat) {
  const { messages, pendingRequest, ...rest } = chat;
  return { ...rest, messageCount: messages.length, hasPendingRequest: Boolean(pendingRequest) };
}

async function bodyJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { statusCode: 400 });
  }
}

function validateOrigin(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return true;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

function routeChat(pathname) {
  const match = /^\/api\/chats\/(chat_[a-f0-9]{32})(?:\/(.*))?$/.exec(pathname);
  return match ? { chatId: match[1], tail: match[2] || "" } : null;
}

export async function createAgentWebServer(options = {}) {
  const config = options.config || loadConfig(options.env || process.env);
  const store = options.store || new ChatStore(config.dataDir);
  await store.initialize();
  const broker = options.broker || new CapabilityBroker({ ttlMs: config.sessionCapabilityTtlMs });
  const auth = new BrowserAuth({ token: config.authToken, secure: config.cookieSecure });
  const gateway = new ProviderGateway({ config, broker });
  const sseClients = new Set();
  let manager = null;

  const server = http.createServer(async (request, response) => {
    securityHeaders(response);
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    try {
      if (await gateway.handle(request, response, url)) return;
      if (!validateOrigin(request)) return json(response, 403, { error: "cross-origin request rejected" });

      if (url.pathname === "/api/auth" && request.method === "GET") {
        return json(response, 200, { required: auth.required, authenticated: auth.authenticated(request) });
      }
      if (url.pathname === "/api/session" && request.method === "POST") {
        const body = await bodyJson(request, config.maxBodyBytes);
        if (!auth.acceptsToken(body.token || "")) return json(response, 401, { error: "invalid access token" });
        const headers = auth.required ? { "set-cookie": auth.createCookie() } : {};
        return json(response, 200, { authenticated: true }, headers);
      }
      if (url.pathname === "/api/session" && request.method === "DELETE") {
        return json(response, 200, { authenticated: false }, { "set-cookie": auth.clearCookie() });
      }

      if (url.pathname.startsWith("/api/") && !auth.authenticated(request)) {
        return json(response, 401, { error: "authentication required" });
      }
      if (!manager && url.pathname.startsWith("/api/")) return json(response, 503, { error: "control plane is starting" });

      if (url.pathname === "/api/health" && request.method === "GET") {
        return json(response, 200, { ok: true, chats: store.list().length, activeCapabilities: broker.size });
      }
      if (url.pathname === "/api/config" && request.method === "GET") {
        return json(response, 200, {
          idleTimeoutMs: config.idleTimeoutMs,
          processIsolation: config.processIsolation,
          workerBackend: config.workerBackend,
          agents: manager.availableAgents(),
          workspaceSource: config.workspaceSource,
        });
      }
      if (url.pathname === "/api/chats" && request.method === "GET") {
        return json(response, 200, { chats: store.list().map(summary) });
      }
      if (url.pathname === "/api/chats" && request.method === "POST") {
        const chat = await manager.createChat(await bodyJson(request, config.maxBodyBytes));
        return json(response, 201, { chat });
      }

      const routed = routeChat(url.pathname);
      if (routed) {
        const { chatId, tail } = routed;
        if (!tail && request.method === "GET") {
          const chat = store.get(chatId);
          return chat ? json(response, 200, { chat }) : json(response, 404, { error: "chat not found" });
        }
        if (!tail && request.method === "DELETE") {
          const removed = await manager.remove(chatId);
          return removed ? json(response, 200, { removed: true }) : json(response, 404, { error: "chat not found" });
        }
        if (tail === "messages" && request.method === "POST") {
          const body = await bodyJson(request, config.maxBodyBytes);
          const submitted = await manager.submit(chatId, body.text);
          submitted.completion.catch((error) => console.error(`turn ${chatId}:`, errorMessage(error)));
          return json(response, 202, { accepted: true, message: submitted.message });
        }
        if (tail === "stop" && request.method === "POST") {
          await manager.stop(chatId, "manual");
          return json(response, 200, { stopped: true });
        }
        const requestMatch = /^requests\/([^/]+)\/respond$/.exec(tail);
        if (requestMatch && request.method === "POST") {
          await manager.respond(chatId, requestMatch[1], await bodyJson(request, config.maxBodyBytes));
          return json(response, 200, { resolved: true });
        }
        if (tail === "events" && request.method === "GET") {
          const chat = store.get(chatId);
          if (!chat) return json(response, 404, { error: "chat not found" });
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          response.write(": connected\n\n");
          const lastId = Number(request.headers["last-event-id"] || url.searchParams.get("lastEventId") || 0);
          for (const event of manager.eventsSince(chatId, Number.isFinite(lastId) ? lastId : 0)) {
            response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          const onEvent = (event) => {
            if (event.chatId === chatId) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          };
          manager.on("event", onEvent);
          const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
          heartbeat.unref?.();
          const client = { response, close: () => { clearInterval(heartbeat); manager.off("event", onEvent); response.end(); } };
          sseClients.add(client);
          request.once("close", () => { clearInterval(heartbeat); manager.off("event", onEvent); sseClients.delete(client); });
          return;
        }
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
        const file = path.resolve(config.publicDir, relative);
        if (!file.startsWith(`${path.resolve(config.publicDir)}${path.sep}`) && file !== path.join(path.resolve(config.publicDir), "index.html")) {
          return json(response, 404, { error: "not found" });
        }
        try {
          const info = await stat(file);
          if (!info.isFile()) throw new Error("not a file");
          const content = await readFile(file);
          response.writeHead(200, {
            "content-type": MIME[path.extname(file)] || "application/octet-stream",
            "content-length": content.length,
            "cache-control": path.extname(file) === ".html" ? "no-cache" : "public, max-age=300",
          });
          return response.end(request.method === "HEAD" ? undefined : content);
        } catch {
          return json(response, 404, { error: "not found" });
        }
      }
      return json(response, 404, { error: "not found" });
    } catch (error) {
      if (response.headersSent) return response.end();
      return json(response, error.statusCode || 400, { error: errorMessage(error) });
    }
  });

  async function start() {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    const localGatewayHost = config.host === "::1" ? "[::1]" : "127.0.0.1";
    const gatewayOrigin = `http://${localGatewayHost}:${port}`;
    let workerBackend;
    try {
      workerBackend = options.workerBackend || createWorkerBackend({
        store,
        config,
        gatewayOrigin,
        commandRunner: options.commandRunner,
      });
    } catch (error) {
      await new Promise((resolve) => server.close(resolve));
      throw error;
    }
    manager = new RuntimeManager({
      store,
      config,
      broker,
      gatewayOrigin,
      workerBackend,
      adapterFactory: options.adapterFactory || null,
    });
    return { host: config.host, port, url: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}` };
  }

  async function stop() {
    if (manager) await manager.shutdown();
    for (const client of sseClients) client.close();
    sseClients.clear();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, store, broker, config, start, stop, get manager() { return manager; } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = await createAgentWebServer();
  const address = await app.start();
  console.log(`Agent Web POC listening at ${address.url}`);
  console.log(`Idle worker timeout: ${app.config.idleTimeoutMs} ms; isolation: ${app.config.processIsolation}`);
  const shutdown = async () => {
    console.log("Stopping agent runtimes...");
    await app.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
