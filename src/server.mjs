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
import { openDatabase } from "./database.mjs";
import { ChatOrganization } from "./chat-organization.mjs";
import { GitHubConnection } from "./github.mjs";
import { Environments, SOFTWARE_CATALOG } from "./environments.mjs";
import { ModelCatalog } from "./models.mjs";

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
  const records = options.records || await openDatabase(config.database);
  const store = options.store || new ChatStore(config.dataDir, records);
  await store.initialize();
  const broker = options.broker || new CapabilityBroker({ ttlMs: config.sessionCapabilityTtlMs });
  const auth = new BrowserAuth({ token: config.authToken, secure: config.cookieSecure });
  const gateway = new ProviderGateway({ config, broker });
  const sseClients = new Set();
  const sidebarClients = new Set();
  const sidebarChanged = () => { for (const response of sidebarClients) response.write('data: {"type":"sidebar_changed"}\n\n'); };
  const organization = new ChatOrganization({ records, store, changed: sidebarChanged });
  const github = options.github || new GitHubConnection({ records, config: config.github });
  const environments = new Environments(records, config.workerBackend);
  const models = options.models || new ModelCatalog(config);
  await environments.initialize();
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
          database: records.kind,
        });
      }
      if (url.pathname === "/api/github" && request.method === "GET") return json(response, 200, await github.status());
      if (url.pathname === "/api/models" && request.method === "GET") return json(response, 200, await models.list(url.searchParams.get("agent")));
      if (url.pathname === "/api/github" && request.method === "POST") return json(response, 200, await github.connect(await bodyJson(request, config.maxBodyBytes)));
      if (url.pathname === "/api/github" && request.method === "DELETE") return json(response, 200, await github.disconnect());
      if (url.pathname === "/api/github/device" && request.method === "POST") return json(response, 200, await github.beginDevice());
      if (url.pathname === "/api/github/device/poll" && request.method === "POST") return json(response, 200, await github.pollDevice((await bodyJson(request, config.maxBodyBytes)).id));
      if (url.pathname === "/api/github/repositories" && request.method === "GET") return json(response, 200, { repositories: await github.repositories(url.searchParams.get("q") || "", url.searchParams.get("refresh") === "1") });
      if (url.pathname === "/api/github/branches" && request.method === "GET") return json(response, 200, { branches: await github.branches(url.searchParams.get("repository")) });
      if (url.pathname === "/api/environments" && request.method === "GET") return json(response, 200, { environments: await environments.list(), software: SOFTWARE_CATALOG });
      if (url.pathname === "/api/environments" && request.method === "POST") return json(response, 201, { environment: await environments.save(await bodyJson(request, config.maxBodyBytes)) });
      const environmentRoute = /^\/api\/environments\/(env_[a-f0-9-]{36})(?:\/(reveal))?$/.exec(url.pathname);
      if (environmentRoute) {
        const id = environmentRoute[1];
        if (environmentRoute[2] && request.method === "POST") {
          const key = (await bodyJson(request, config.maxBodyBytes)).key;
          const variable = (await environments.get(id, { reveal: true })).variables.find(v => v.key === key);
          return variable ? json(response, 200, { value: variable.value }) : json(response, 404, { error: "Variable not found" });
        }
        if (!environmentRoute[2] && request.method === "PATCH") return json(response, 200, { environment: await environments.save(await bodyJson(request, config.maxBodyBytes), id) });
        if (!environmentRoute[2] && request.method === "DELETE") { await environments.remove(id, store.list()); return json(response, 200, { removed: true }); }
      }
      if (url.pathname === "/api/preferences" && request.method === "GET") return json(response, 200, { preferences: await records.get("preferences", "new-chat") || {} });
      if (url.pathname === "/api/preferences" && request.method === "PATCH") {
        const body = await bodyJson(request, config.maxBodyBytes);
        await environments.get(body.environmentId);
        if (!Array.isArray(body.repositories) || body.repositories.length > 100 || body.repositories.some(repo => typeof repo.fullName !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo.fullName) || typeof repo.branch !== "string" || repo.branch.length > 250)) throw new Error("Invalid repository preferences");
        const modelSettings = await models.validate(body.agent, body);
        const preferences = { environmentId: body.environmentId, agent: ["codex", "claude", "mock"].includes(body.agent) ? body.agent : null, ...modelSettings, repositories: body.repositories.map(({ fullName, branch }) => ({ fullName, branch })) };
        await records.put("preferences", "new-chat", preferences);
        return json(response, 200, { preferences });
      }
      if (url.pathname === "/api/chats" && request.method === "GET") {
        return json(response, 200, { chats: store.list().map(summary) });
      }
      if (url.pathname === "/api/chats" && request.method === "POST") {
        const chat = await manager.createChat(await bodyJson(request, config.maxBodyBytes));
        return json(response, 201, { chat });
      }
      if (url.pathname === "/api/sidebar" && request.method === "GET") {
        return json(response, 200, { chats: store.list().map(summary), groups: await organization.listGroups(), preferences: await organization.preferences() });
      }
      if (url.pathname === "/api/sidebar/preferences" && request.method === "PATCH") {
        return json(response, 200, { preferences: await organization.savePreferences(await bodyJson(request, config.maxBodyBytes)) });
      }
      if (url.pathname === "/api/sidebar/events" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
        response.write('data: {"type":"sidebar_changed"}\n\n');
        sidebarClients.add(response);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
        heartbeat.unref?.();
        request.once("close", () => { clearInterval(heartbeat); sidebarClients.delete(response); });
        return;
      }
      if (url.pathname === "/api/groups" && request.method === "POST") {
        return json(response, 201, { group: await organization.saveGroup(await bodyJson(request, config.maxBodyBytes)) });
      }
      const groupRoute = /^\/api\/groups\/(group_[a-f0-9-]{36})$/.exec(url.pathname);
      if (groupRoute && request.method === "PATCH") return json(response, 200, { group: await organization.saveGroup(await bodyJson(request, config.maxBodyBytes), groupRoute[1]) });
      if (groupRoute && request.method === "DELETE") { await organization.removeGroup(groupRoute[1]); return json(response, 200, { removed: true }); }

      const routed = routeChat(url.pathname);
      if (routed) {
        const { chatId, tail } = routed;
        if (tail === "model" && request.method === "PATCH") {
          const chat = store.get(chatId);
          if (!chat) return json(response, 404, { error: "Chat not found" });
          const settings = await models.validate(chat.agent, await bodyJson(request, config.maxBodyBytes));
          const updated = await store.update(chatId, { ...settings, modelSelectionSet: true });
          manager.publishChat(updated);
          return json(response, 200, { chat: updated });
        }
        if (!tail && request.method === "PATCH") {
          return json(response, 200, { chat: await organization.patchChat(chatId, await bodyJson(request, config.maxBodyBytes), manager) });
        }
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
      github,
      environments,
      models,
      adapterFactory: options.adapterFactory || null,
    });
    manager.on("event", event => { if (["chat_updated", "message", "chat_deleted"].includes(event.type)) sidebarChanged(); });
    manager.pullRequests.start();
    return { host: config.host, port, url: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}` };
  }

  async function stop() {
    if (manager) await manager.shutdown();
    for (const client of sseClients) client.close();
    sseClients.clear();
    for (const response of sidebarClients) response.end();
    sidebarClients.clear();
    await new Promise((resolve) => server.close(resolve));
    if (!options.records) await records.close();
  }

  return { server, store, records, organization, broker, config, start, stop, get manager() { return manager; } };
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
