import http from "node:http";
import { personalBrowserScope } from './personal-browser-authority.mjs';
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserAuth } from "./auth.mjs";
import { KeymapPreferences } from "./keymap.mjs";
import { StatusLinePreferences } from "./status-line.mjs";
import { TabTitlePreferences } from "./tab-title.mjs";
import { SyntaxThemePreferences } from "./syntax-theme.mjs";
import { PetPreferences } from "./pets.mjs";
import { PET_IMAGE_LIMIT } from "../public/pets.js";
import { SYNTAX_MODES } from "../public/syntax-theme.js";
import { CapabilityBroker } from "./capabilities.mjs";
import { loadConfig } from "./config.mjs";
import { ProviderGateway } from "./provider-gateway.mjs";
import { NpmRegistryGateway } from "./npm-registry-gateway.mjs";
import { RuntimeManager } from "./runtime-manager.mjs";
import { ChatStore } from "./store.mjs";
import { errorMessage } from "./utils.mjs";
import { createWorkerBackend } from "./worker-backends.mjs";
import { openDatabase } from "./database.mjs";
import { ChatOrganization } from "./chat-organization.mjs";
import { rememberChatSelection, restoreChatSelection } from "./chat-preferences.mjs";
import { SavedPrompts, knownPromptProjects } from "./saved-prompts.mjs";
import { searchMessages } from "./message-search.mjs";
import { GitHubConnection } from "./github.mjs";
import { Companies } from "./companies.mjs";
import { GitHubWorkerGateway } from "./github-worker-gateway.mjs";
import { handleGitHubWorkerMcp } from "./github-worker-mcp.mjs";
import { Environments, SOFTWARE_CATALOG } from "./environments.mjs";
import { WORKER_INSTANCE_CATALOG, WORKER_INSTANCE_PRICING_REGION } from "./worker-instances.mjs";
import { ModelCatalog } from "./models.mjs";
import { HarnessUpdater } from "./harness-updater.mjs";
import { Attachments } from "./attachments.mjs";
import { CommandCatalog } from "./command-catalog.mjs";
import { McpConnections } from "./mcp-connections.mjs";
import { MCP_PRESETS } from "./mcp-presets.mjs";
import { safeMcpUrl, oauthCookieName } from "./mcp-oauth.mjs";
import { SharedBrowsers } from "./shared-browser.mjs";
import { WebSocketServer } from "ws";
import { BrowserUsers } from "./browser-users.mjs";
import { GoogleAuth } from "./google-auth.mjs";
import { UserServices } from "./user-services.mjs";
import { AgentAccounts } from "./agent-accounts.mjs";
import { BrowserConnections } from "./browser-connections.mjs";
import { zipSync } from "fflate";
import { readinessProbe } from "./readiness.mjs";
import { closeIncompleteRequestAfterResponse } from "./http-request-lifecycle.mjs";
import { AppPreviews } from "./app-previews.mjs";
import { CompanyPlugins } from "./company-plugins.mjs";
import { companyForChat } from "../public/company-scope.js";

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
  const { messages, pendingRequest, workspaceDiff, workspaceChanges, ...rest } = chat;
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
  request.guardChat?.();
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
  const auth = new BrowserAuth({ token: config.google?.enabled ? "" : config.authToken, secure: config.cookieSecure });
  const googleAuth = new GoogleAuth(records, config.google || { enabled: false }, { ...options.googleAuthOptions, onSignOut: user => releaseIdentity(user) });
  const browserUsers = googleAuth.enabled ? googleAuth : new BrowserUsers(records, { secure: config.cookieSecure });
  const keymaps = new KeymapPreferences(records);
  const statuslines = new StatusLinePreferences(records);
  const tabTitles = new TabTitlePreferences(records);
  const syntaxThemes = new SyntaxThemePreferences(records);
  const pets = new PetPreferences(records, { fetchImpl: options.petFetch });
  const savedPrompts = new SavedPrompts(records);
  const gateway = new ProviderGateway({ config, broker });
  const npmGateway = options.npmGateway || new NpmRegistryGateway({ ttlMs: config.sessionCapabilityTtlMs, upstreamBaseUrl: config.npm.upstreamBaseUrl, ...(options.npmGatewayOptions || {}) });
  const sseClients = new Set();
  const sidebarClients = new Set();
  let stopping;
  let initializing = true;
  let draining = false;
  let activeMutations = 0;
  let browserAttachments = 0;
  const sidebarChanged = () => { for (const response of sidebarClients) response.write('data: {"type":"sidebar_changed"}\n\n'); };
  const agentAccounts = new AgentAccounts({ records, config, ...options.agentAccountsOptions,
    onChange: ownerId => { for (const response of sidebarClients) if (response.ownerId === ownerId) response.write('data: {"type":"agent_accounts_changed"}\n\n'); },
    onRevoke: async (ownerId, id) => {
      const chats = store.list().filter(chat => chat.ownerId === ownerId && chat.agentAccountId === id);
      // One failed worker shutdown must not leave the remaining account-bound
      // workers running. Await every attempt, but never expose private errors.
      const results = await Promise.allSettled(chats.map(async chat => manager?.stop(chat.id, "account-disconnected")));
      const failed = results.filter(result => result.status === "rejected").length;
      if (failed) throw Object.assign(new Error(`Account access is blocked, but ${failed} of ${chats.length} chat workers could not be stopped. Retry this account action.`), { statusCode: 503 });
    } });
  await agentAccounts.initialize();
  const organization = new ChatOrganization({ records, store, changed: sidebarChanged });
  const companies = new Companies(records);
  const github = options.github || new GitHubConnection({ records, config: config.github, companies });
  github.companies = companies;
  const mcps = new McpConnections(records, { ttlMs: config.sessionCapabilityTtlMs, companies });
  const publicOrigin = config.publicOrigin ? safeMcpUrl(config.publicOrigin).origin : null;
  const environments = new Environments(records, config.workerBackend, mcps, { defaultInstanceType: config.ec2.instanceType });
  const companyPlugins = options.companyPlugins || new CompanyPlugins(records, { companies, config, inspect: options.inspectPluginSource });
  const models = options.models || new ModelCatalog(config, agentAccounts);
  const harnessUpdates = options.harnessUpdates || new HarnessUpdater({ records, config, refreshModels: agents => models.refresh(agents) });
  const attachments = new Attachments(records, store);
  const resources = new UserServices({ records, config, identity: googleAuth, store, legacy: { records, github, mcps, environments, organization, companies, plugins: companyPlugins }, changed: sidebarChanged,
    githubChanged: (ownerId, id) => githubWorkers.revokeConnection(ownerId, id), environmentChanged: chatId => npmGateway.revokeChat(chatId) });
  const commands = options.commands || new CommandCatalog(config, models, { installed: async chat => {
    const services = await resources.forOwner(chat.ownerId);
    return services.plugins.commands(companyForChat(chat), chat.agent);
  } });
  const githubWorkers = new GitHubWorkerGateway({ store, servicesFor: chat => resources.forOwner(chat.ownerId), ttlMs: config.sessionCapabilityTtlMs,
    ...(options.githubWorkerFetch ? { fetchImpl: options.githubWorkerFetch } : {}) });
  await environments.initialize();
  let manager = null;
  let previews = null, previewHosts = null;
  // Provisioning can be disabled while its old CloudFront origins still exist.
  // Their Host must never fall through to Relay's authenticated UI/API routes.
  const isolatePublicHosts = config.preview?.enabled || config.workerBackend === "ec2" && googleAuth.enabled && googleAuth.config.origin?.startsWith("https://");
  const browserSockets = new WebSocketServer({ noServer: true, maxPayload: 100000, perMessageDeflate: false });
  const personalSockets = new WebSocketServer({ noServer: true, maxPayload: 48 * 1024 * 1024, perMessageDeflate: false });
  const releaseIdentity = async user => {
    if (!user) return;
    previews?.revokeOwner(user.id);
    await manager?.browsers.personal?.revokeOwner(user.id);
    for (const client of sseClients) if (client.ownerId === user.id) client.close();
    for (const socket of browserSockets.clients) if (socket.ownerId === user.id) socket.close(1000, "Signed out");
    for (const response of sidebarClients) if (response.ownerId === user.id) response.end();
  };
  await googleAuth.initialize();
  const ready = readinessProbe({ records, directories: [store.dataDir, store.chatsDir],
    configured: () => !initializing && !stopping && !draining && (!googleAuth.enabled || googleAuth.info().configured) });

  const server = http.createServer(async (request, response) => {
    closeIncompleteRequestAfterResponse(request, response);
    if (stopping) return json(response, 503, { error: "Relay is restarting" }, { connection: "close" });
    let url;
    try { url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`); }
    catch { return json(response, 400, { error: "Invalid request URL" }); }
    if (isolatePublicHosts) {
      if (!request.url.startsWith("/") || request.url.startsWith("//") || request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host").length !== 1) return json(response, 400, { error: "Invalid request target" });
      if (previewHosts?.lookup(request.headers.host)) {
        if (!previews || draining) return json(response, 503, { error: "App previews are restarting" });
        try { await previews.handleHttp(request, response, url); }
        catch { if (!response.headersSent) json(response, 403, { error: "App access unavailable" }); else response.end(); }
        return;
      }
      const relayHost = new URL(googleAuth.config.origin).host;
      const internalHost = new URL(config.ec2.gatewayOrigin).host;
      const localHost = ["127.0.0.1", "localhost", "[::1]"].some(host => request.headers.host === `${host}:${server.address()?.port}`);
      const internalPath = url.pathname === "/readyz" || url.pathname.startsWith("/gateway/") || url.pathname.startsWith("/internal/deploy/");
      if (request.headers.host !== relayHost && !((request.headers.host === internalHost || localHost) && internalPath)) return json(response, 421, { error: "Unknown Relay host" });
    }
    securityHeaders(response);
    let mutationPending = false;
    try {
      if (url.pathname.startsWith("/internal/deploy/")) {
        // SSM runs this on the controller itself. Forwarded headers and browser
        // cookies do not confer operator authority, and cross-origin requests
        // must never toggle this state (including from a local browser).
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
        if (!local || request.headers.origin || request.headers["sec-fetch-site"] || request.method !== "POST") return json(response, 404, { error: "Not found" });
        if (url.pathname === "/internal/deploy/resume") {
          draining = false;
          return json(response, 200, { ok: true });
        }
        if (url.pathname !== "/internal/deploy/drain") return json(response, 404, { error: "Not found" });
        // A failed account action may have ended its HTTP request while its
        // revocation barrier still needs retry. Do not roll back to a runtime
        // that cannot restore the durable disconnection intent.
        if (agentAccounts.disconnecting.size || agentAccounts.removing.size) return json(response, 409, { ok: false, error: "Finish pending account cleanup before deploying. Retry the account disconnection or deletion." });
        const providerLogin = resources.all().some(service => service.github.pending?.size ||
          [...service.mcps.oauth.flows.values()].some(flow => flow.expiresAt > Date.now()));
        const busy = activeMutations || githubWorkers.active || previews?.active || browserAttachments || agentAccounts.flows.size || providerLogin || store.list().some(chat =>
          manager?.isBusy(chat.id) || manager?.sideChats.busy(chat.id) || ["starting", "stopping", "running", "waiting"].includes(chat.status));
        if (busy) return json(response, 409, { ok: false, error: "Wait for active work and sign-in attempts to finish" });
        draining = true;
        for (const socket of browserSockets.clients) socket.close(1012, "Relay is restarting");
        for (const socket of personalSockets.clients) socket.close(1012, "Relay is restarting");
        return json(response, 200, { ok: true });
      }
      if (draining) return json(response, 503, { error: "Relay is restarting" }, { connection: "close" });
      if (previews && ["/app-preview/open", "/api/app-preview/bootstrap"].includes(url.pathname) && await previews.handleRelay(request, response, url)) return;
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
          ["/api/auth/callback/google", "/oauth/mcp/callback"].includes(url.pathname)) {
        activeMutations++;
        mutationPending = true;
      }
      if (url.pathname === "/readyz" && request.method === "GET") {
        const ok = await ready();
        return json(response, ok ? 200 : 503, { ok });
      }
      if (await gateway.handle(request, response, url)) return;
      if (await npmGateway.handle(request, response, url)) return;
      if (url.pathname === "/webhooks/github" && request.method === "POST") {
        if (!manager.githubEvents || !config.github.webhookSecret) return json(response, 404, { error: "Not found" });
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) return json(response, 413, { error: "Webhook too large" }); chunks.push(chunk); }
        await manager.githubEvents.receive(Buffer.concat(chunks), request.headers);
        return json(response, 202, { accepted: true });
      }
      if (await githubWorkers.handle(request, response, url)) return;
      if (await handleGitHubWorkerMcp(request, response, url, { gateway: githubWorkers })) return;
      if (await resources.handleMcp(request, response, url)) return;
      if (await manager?.browsers?.handle(request, response, url)) return;
      if (await googleAuth.handle(request, response, url)) return;
      if (url.pathname === "/oauth/mcp/callback" && request.method === "GET") {
        // Browser session cookies are Strict. This callback instead requires its
        // own Lax, HttpOnly flow cookie, minted by an authenticated same-origin POST.
        const cookies = Object.fromEntries((request.headers.cookie || "").split(";").map(part => { const i = part.indexOf("="); return [part.slice(0, i).trim(), part.slice(i + 1)]; }));
        let ok = false, message;
        try { await (await resources.oauthFor(url.searchParams.get("state"))).finish(url.searchParams, cookies); ok = true; message = "Signed in successfully. Return to MCP connections to test and select this connection in an environment."; }
        catch (error) { message = error.statusCode ? error.message : "OAuth sign-in failed. Start again from MCP connections."; }
        const state = url.searchParams.get("state") || "";
        if (/^[\w-]{43}$/.test(state)) response.setHeader("set-cookie", `${oauthCookieName(state)}=; Path=/oauth/mcp/; HttpOnly; SameSite=Lax; Max-Age=0${config.cookieSecure || publicOrigin?.startsWith("https:") ? "; Secure" : ""}`);
        const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
        response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MCP sign-in</title><link rel="stylesheet" href="/styles.css"><body><main class="oauth-result" data-success="${ok}"><h1>${ok ? "MCP connected" : "Unable to connect"}</h1><p>${escape(message)}</p><a href="/#mcp-connections">Return to MCP connections</a></main><script type="module" src="/mcp-oauth-result.js"></script></body></html>`);
      }
      if (url.pathname === "/preview.html") {
        response.removeHeader("x-frame-options");
        response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts");
      }
      const vendor = { "/vendor/marked.js": "marked/lib/marked.esm.js", "/vendor/purify.js": "dompurify/dist/purify.es.mjs", "/vendor/purify-classic.js": "dompurify/dist/purify.min.js",
        "/vendor/syntax-runmode.js": "codemirror/addon/runmode/runmode-standalone.js",
        "/vendor/syntax-simple.js": "codemirror/addon/mode/simple.js",
        ...Object.fromEntries(SYNTAX_MODES.map(mode => [`/vendor/syntax-${mode}.js`, `codemirror/mode/${mode}/${mode}.js`])),
        "/vendor/codemirror.js": "codemirror/lib/codemirror.js", "/vendor/codemirror.css": "codemirror/lib/codemirror.css",
        "/vendor/codemirror-dialog.css": "codemirror/addon/dialog/dialog.css", "/vendor/codemirror-dialog.js": "codemirror/addon/dialog/dialog.js",
        "/vendor/codemirror-searchcursor.js": "codemirror/addon/search/searchcursor.js", "/vendor/codemirror-matchbrackets.js": "codemirror/addon/edit/matchbrackets.js",
        "/vendor/codemirror-vim.js": "codemirror/keymap/vim.js" }[url.pathname];
      if (vendor && request.method === "GET") {
        response.setHeader("content-type", vendor.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
        return response.end(await readFile(new URL(`../node_modules/${vendor}`, import.meta.url)));
      }
      if (!validateOrigin(request)) return json(response, 403, { error: "cross-origin request rejected" });
      if (googleAuth.enabled && url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method) && request.headers.origin !== googleAuth.config.origin) return json(response, 403, { error: "same-origin request required" });

      if (url.pathname === "/api/auth" && request.method === "GET") {
        if (googleAuth.enabled) {
          const user = await googleAuth.session(request);
          return json(response, 200, { required: true, authenticated: Boolean(user), method: "google", google: googleAuth.info(), user: googleAuth.public(user) });
        }
        return json(response, 200, { required: auth.required, authenticated: auth.authenticated(request) });
      }
      if (googleAuth.enabled && url.pathname === "/api/session") return json(response, 405, { error: "Use Google sign-in / sign-out" });
      if (url.pathname === "/api/session" && request.method === "POST") {
        const body = await bodyJson(request, config.maxBodyBytes);
        if (!auth.acceptsToken(body.token || "")) return json(response, 401, { error: "invalid access token" });
        const headers = auth.required ? { "set-cookie": auth.createCookie() } : {};
        return json(response, 200, { authenticated: true }, headers);
      }
      if (url.pathname === "/api/session" && request.method === "DELETE") {
        await releaseIdentity(await browserUsers.logout(request));
        return json(response, 200, { authenticated: false }, { "set-cookie": [auth.clearCookie(), browserUsers.cookie()] });
      }

      if (url.pathname.startsWith("/api/") && !auth.authenticated(request)) {
        return json(response, 401, { error: "authentication required" });
      }
      if (!manager && url.pathname.startsWith("/api/")) return json(response, 503, { error: "control plane is starting" });
      const user = url.pathname.startsWith("/api/") ? await browserUsers.session(request) : null;
      if (googleAuth.enabled && url.pathname.startsWith("/api/") && !user) return json(response, 401, { error: "Sign in with Google to use Relay" });
      if (url.pathname.startsWith("/api/")) {
      const { github, mcps, environments, organization, records, companies, plugins } = await resources.forOwner(user?.id);
      // Authentication/resource lookup can outlive shutdown's stream cleanup.
      // Do not let an already accepted request open a new SSE stream afterward.
      if (stopping || draining) return json(response, 503, { error: "Relay is restarting" }, { connection: "close" });
      const visibleChats = () => store.list().filter(chat => browserUsers.canRead(chat, user));
      if (url.pathname === "/api/message-search" && request.method === "POST") {
        const input = await bodyJson(request, 2000), guard = async () => {
          const current = await browserUsers.session(request);
          if (current?.id !== user?.id || current?.sessionId !== user?.sessionId || !auth.authenticated(request)
            || googleAuth.enabled && (!current || googleAuth.revoked.has(current.sessionId))) throw Object.assign(new Error("Your account changed. Reopen search."), { statusCode: 409 });
        };
        await guard();
        const result = searchMessages(visibleChats(), input);
        await guard();
        // The final asynchronous session read can overlap a transfer/deletion.
        // Recheck current authorization synchronously, before serializing any
        // saved snippet or title from the earlier snapshot.
        if (result.results.some(match => !browserUsers.canRead(store.get(match.chatId), user))) throw Object.assign(new Error("Conversation access changed. Search again."), { statusCode: 409 });
        return json(response, 200, { ...result, scope: user?.id || "shared" });
      }
      if (url.pathname === "/api/saved-prompts" && ["GET", "PATCH"].includes(request.method)) {
        const scope = user?.id || "shared", guard = async () => {
          if ((await browserUsers.session(request))?.id !== user?.id || !auth.authenticated(request)) throw Object.assign(new Error("The prompt-library account changed. Reload before continuing."), { statusCode: 409 });
        };
        await guard();
        // Legacy local provider settings are shared, even with private browser
        // users. Do not treat another such user's remembered draft as a project.
        const remembered = user && !googleAuth.enabled ? [] : await records.list("new-chat-project");
        const projects = knownPromptProjects(visibleChats(), remembered, await companies.list());
        const result = request.method === "PATCH" ? await savedPrompts.save(scope, await bodyJson(request, 600000), projects, guard) : await savedPrompts.get(scope, projects, guard);
        return json(response, 200, result);
      }
      if (url.pathname === "/api/pets" || url.pathname.startsWith("/api/pets/")) {
        const scope = user?.id || "shared", guard = async () => {
          if ((await browserUsers.session(request))?.id !== user?.id || !auth.authenticated(request)) throw Object.assign(new Error("The pet account changed. Reload /pets."), { statusCode: 409 });
        };
        const asset = /^\/api\/pets\/assets\/([a-z0-9-]+)$/.exec(url.pathname), custom = /^\/api\/pets\/custom\/(custom-[a-f0-9-]+)$/.exec(url.pathname);
        if (request.method === "GET" && asset) {
          if (url.searchParams.get("scope") !== scope) return json(response, 409, { error: "The pet account changed. Reload /pets." });
          const result = await pets.asset(scope, asset[1], guard);
          response.writeHead(200, { "content-type": result.mime, "content-length": result.data.length, "cache-control": "private, no-store", "cross-origin-resource-policy": "same-origin" });
          return response.end(result.data);
        }
        let result;
        if (url.pathname === "/api/pets" && request.method === "GET") result = await pets.get(scope, guard);
        else if (url.pathname === "/api/pets" && request.method === "PATCH") result = await pets.save(scope, await bodyJson(request, 4000), guard);
        else if (url.pathname === "/api/pets/custom" && request.method === "POST") {
          if (!user) return json(response, 403, { error: "Sign in to a private Relay account to upload custom pets." });
          result = await pets.upload(scope, await bodyJson(request, Math.ceil(PET_IMAGE_LIMIT / 3) * 4 + 100000), guard);
        } else if (custom && request.method === "DELETE") result = await pets.remove(scope, custom[1], await bodyJson(request, 4000), guard);
        else return json(response, 404, { error: "Pet route not found" });
        return json(response, 200, { ...result, account: browserUsers.public(user) });
      }
      if (["/api/statusline", "/api/tab-title", "/api/syntax-theme"].includes(url.pathname) && ["GET", "PATCH"].includes(request.method)) {
        const preferences = { "/api/statusline": statuslines, "/api/tab-title": tabTitles, "/api/syntax-theme": syntaxThemes }[url.pathname];
        const scope = user?.id || "shared", guard = async () => {
          if ((await browserUsers.session(request))?.id !== user?.id || !auth.authenticated(request)) throw Object.assign(new Error(`The ${preferences.label.toLowerCase()} account changed. Reload its settings.`), { statusCode: 409 });
        };
        const result = request.method === "PATCH" ? await preferences.save(scope, await bodyJson(request, 4000), guard) : await preferences.get(scope, guard);
        return json(response, 200, { ...result, account: browserUsers.public(user) });
      }
      if (url.pathname === "/api/keymap" && ["GET", "PATCH"].includes(request.method)) {
        const scope = user?.id || "shared", guard = async () => {
          if ((await browserUsers.session(request))?.id !== user?.id || !auth.authenticated(request)) throw Object.assign(new Error("The shortcut account changed. Reload /keymap."), { statusCode: 409 });
        };
        const result = request.method === "PATCH" ? await keymaps.save(scope, await bodyJson(request, 8000), guard) : await keymaps.get(scope, guard);
        return json(response, 200, { ...result, account: browserUsers.public(user) });
      }
      if (url.pathname === "/api/browser-account" && request.method === "GET") return json(response, 200, { user: browserUsers.public(user), ...(googleAuth.enabled ? { method: "google" } : {}) });
      if (googleAuth.enabled && url.pathname.startsWith("/api/browser-account") && request.method !== "GET") return json(response, 405, { error: "Your Chrome connections use your Google Relay account. Use Google sign-out to switch users." });
      if (["/api/browser-account/register", "/api/browser-account/login"].includes(url.pathname) && request.method === "POST") {
        const input = await bodyJson(request, 10000);
        const result = await browserUsers[url.pathname.endsWith("register") ? "register" : "login"](input, request.socket.remoteAddress);
        await browserUsers.logout(request); await releaseIdentity(user);
        return json(response, 200, { user: result.user }, { "set-cookie": result.cookie });
      }
      if (url.pathname === "/api/browser-account" && request.method === "DELETE") {
        await browserUsers.logout(request);
        await releaseIdentity(user);
        return json(response, 200, { user: null }, { "set-cookie": browserUsers.cookie() });
      }
      if (url.pathname === "/api/browser-connections" && request.method === "GET") return json(response, 200, { connections: await manager.browsers.personal.list(user, { companyId: url.searchParams.has("companyId") ? url.searchParams.get("companyId") : undefined, includeLegacy: url.searchParams.get("includeLegacy") === "1" }) });
      if (url.pathname === "/api/browser-extension/download" && request.method === "GET") {
        const files = {};
        for (const name of ["manifest.json", "worker.js", "projection-policy.js", "popup.html", "popup.css", "popup.js"]) files[`agent-relay-chrome/${name}`] = new Uint8Array(await readFile(new URL(`../chrome-extension/${name}`, import.meta.url)));
        const archive = zipSync(files);
        response.writeHead(200, { "content-type": "application/zip", "content-disposition": 'attachment; filename="agent-relay-chrome.zip"', "cache-control": "no-store" });
        response.end(Buffer.from(archive)); return;
      }
      if (url.pathname === "/api/browser-connections" && request.method === "POST") {
        browserUsers.require(user);
        return json(response, 201, await manager.browsers.personal.pair(user, await bodyJson(request, 2000)));
      }
      const browserConnection = /^\/api\/browser-connections\/(browser_[a-f0-9-]{36})$/.exec(url.pathname);
      if (browserConnection && request.method === "PATCH") { const input = await bodyJson(request, 2000); return json(response, 200, await manager.browsers.personal.assign(browserConnection[1], user, input.companyId)); }
      if (browserConnection && request.method === "DELETE") { await manager.browsers.personal.remove(browserConnection[1], user); return json(response, 200, { removed: true }); }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return json(response, 200, { ok: true, chats: visibleChats().length, activeCapabilities: broker.size });
      }
      if (url.pathname === "/api/config" && request.method === "GET") {
        return json(response, 200, {
          idleTimeoutMs: config.idleTimeoutMs,
          processIsolation: config.processIsolation,
          workerBackend: config.workerBackend,
          agents: manager.availableAgents(user?.id),
          workspaceSource: resources.isLegacy(user?.id) ? config.workspaceSource : "",
          database: records.kind,
          features: { companyScopes: true, companyRegistry: true, companyMcpConnections: true, googleLogin: googleAuth.enabled, agentAccounts: googleAuth.enabled },
          ...(googleAuth.enabled ? { user: googleAuth.public(user) } : {}),
        });
      }
      if (url.pathname === "/api/agent-accounts" || url.pathname.startsWith("/api/agent-accounts/")) {
        if (!googleAuth.enabled || !user) return json(response, 401, { error: "Sign in with Google to connect agent accounts" });
        if (url.pathname === "/api/agent-accounts" && request.method === "GET") return json(response, 200, { accounts: agentAccounts.list(user.id), providers: [{ id: "codex", label: "Codex", loginAvailable: true }, { id: "claude", label: "Claude Code", loginAvailable: true }] });
        if (url.pathname === "/api/agent-accounts" && request.method === "POST") return json(response, 201, await agentAccounts.begin(user.id, await bodyJson(request, config.maxBodyBytes)));
        const accountRoute = /^\/api\/agent-accounts\/(account_[a-f0-9-]{36})(?:\/(cancel|disconnect|code))?$/.exec(url.pathname);
        if (accountRoute && request.method === "POST" && accountRoute[2] === "code") return json(response, 200, await agentAccounts.submitCode(user.id, accountRoute[1], await bodyJson(request, config.maxBodyBytes)));
        if (accountRoute && request.method === "GET" && !accountRoute[2]) return json(response, 200, await agentAccounts.status(user.id, accountRoute[1]));
        if (accountRoute && request.method === "DELETE" && !accountRoute[2]) return json(response, 200, await agentAccounts.remove(user.id, accountRoute[1]));
        if (accountRoute && request.method === "POST" && accountRoute[2]) return json(response, 200, await agentAccounts[accountRoute[2]](user.id, accountRoute[1]));
        return json(response, 404, { error: "Agent account action not found" });
      }
      if (url.pathname === "/api/companies" && request.method === "GET") return json(response, 200, { companies: await companies.list() });
      if (url.pathname === "/api/companies" && request.method === "POST") return json(response, 201, { company: await companies.save(await bodyJson(request, 4000)) });
      const companyRoute = /^\/api\/companies\/([a-z0-9-]{1,39})$/.exec(url.pathname);
      if (companyRoute && request.method === "PATCH") return json(response, 200, { company: await companies.save(await bodyJson(request, 4000), companyRoute[1]) });
      if (url.pathname === "/api/company-plugins" && request.method === "GET") return json(response, 200, { marketplaces: await plugins.list(url.searchParams.get("companyId") || null) });
      if (url.pathname === "/api/company-plugins/inspect" && request.method === "POST") return json(response, 200, { marketplace: await plugins.preview((await bodyJson(request, 4000)).source) });
      if (url.pathname === "/api/company-plugins" && request.method === "POST") { const marketplace = await plugins.save(await bodyJson(request, config.maxBodyBytes)); commands.invalidate?.(); return json(response, 201, { marketplace }); }
      const companyPluginRoute = /^\/api\/company-plugins\/(plugin_[a-f0-9-]{36})$/.exec(url.pathname);
      if (companyPluginRoute && request.method === "PATCH") { const marketplace = await plugins.save(await bodyJson(request, config.maxBodyBytes), companyPluginRoute[1]); commands.invalidate?.(); return json(response, 200, { marketplace }); }
      if (companyPluginRoute && request.method === "DELETE") { await plugins.remove(companyPluginRoute[1]); commands.invalidate?.(); return json(response, 200, { removed: true }); }
      if (url.pathname === "/api/github" && request.method === "GET") return json(response, 200, await github.status());
      if (url.pathname === "/api/mcps" && request.method === "GET") return json(response, 200, { connections: await mcps.list() });
      if (url.pathname === "/api/mcps/presets" && request.method === "GET") return json(response, 200, { presets: MCP_PRESETS });
      if (url.pathname === "/api/mcps" && request.method === "POST") return json(response, 201, { connection: await mcps.save(await bodyJson(request, config.maxBodyBytes)) });
      const mcpRoute = /^\/api\/mcps\/(mcp_[a-f0-9-]{36})$/.exec(url.pathname);
      if (mcpRoute && request.method === "PATCH") return json(response, 200, { connection: await mcps.save(await bodyJson(request, config.maxBodyBytes), mcpRoute[1]) });
      if (mcpRoute && request.method === "DELETE") { await mcps.remove(mcpRoute[1]); return json(response, 200, { removed: true }); }
      const mcpAction = /^\/api\/mcps\/(mcp_[a-f0-9-]{36})\/(test|oauth|disconnect|cancel-oauth)$/.exec(url.pathname);
      if (mcpAction && request.method === "POST") {
        const [, id, action] = mcpAction;
        if (action === "test") return json(response, 200, { connection: await mcps.test(id) });
        if (action === "disconnect") return json(response, 200, { connection: await mcps.oauth.disconnect(id) });
        if (action === "cancel-oauth") { await mcps.oauth.cancel(id); return json(response, 200, { cancelled: true }); }
        let origin = publicOrigin;
        if (!origin) {
          const candidate = safeMcpUrl(`http://${request.headers.host}`);
          if (!["localhost", "127.0.0.1", "[::1]"].includes(candidate.hostname) || Number(candidate.port || 80) !== server.address().port) return json(response, 400, { error: "Set AGENT_WEB_PUBLIC_URL to this app’s public HTTPS address for OAuth callbacks." });
          origin = candidate.origin;
        }
        const flow = await mcps.oauth.begin(id, `${origin}/oauth/mcp/callback`);
        return json(response, 200, { authorizationUrl: flow.authorizationUrl, attemptId: flow.attemptId }, { "set-cookie": `${oauthCookieName(flow.state)}=${flow.cookie}; Path=/oauth/mcp/; HttpOnly; SameSite=Lax; Max-Age=600${origin.startsWith("https:") || config.cookieSecure ? "; Secure" : ""}` });
      }
      if (url.pathname === "/api/models" && request.method === "GET") {
        const agent = url.searchParams.get("agent");
        const agentAccountId = url.searchParams.get("account") || null;
        if (googleAuth.enabled && ["codex", "claude"].includes(agent) && !agentAccountId) return json(response, 409, { error: "Connect and select an agent account first" });
        if (googleAuth.enabled && !["mock", "codex", "claude"].includes(agent)) return json(response, 403, { error: "No agent account is connected for this user" });
        if (url.searchParams.get("refresh") === "1") models.invalidate(agent);
        return json(response, 200, await models.list(agent, { ownerId: user?.id, agentAccountId }));
      }
      if (url.pathname === "/api/github" && request.method === "POST") return json(response, 200, await github.update(await bodyJson(request, config.maxBodyBytes)));
      if (url.pathname === "/api/github" && request.method === "DELETE") return json(response, 200, await github.disconnect());
      const githubRoute = /^\/api\/github\/connections\/(github(?:_[a-f0-9-]{36})?)$/.exec(url.pathname);
      if (githubRoute && request.method === "PATCH") return json(response, 200, await github.update({ ...await bodyJson(request, config.maxBodyBytes), id: githubRoute[1] }));
      if (githubRoute && request.method === "DELETE") return json(response, 200, await github.disconnect(githubRoute[1]));
      if (url.pathname === "/api/github/device" && request.method === "POST") return json(response, 200, await github.beginDevice(await bodyJson(request, config.maxBodyBytes)));
      if (url.pathname === "/api/github/device/poll" && request.method === "POST") return json(response, 200, await github.pollDevice((await bodyJson(request, config.maxBodyBytes)).id));
      if (url.pathname === "/api/github/device/cancel" && request.method === "POST") return json(response, 200, await github.cancelDevice((await bodyJson(request, config.maxBodyBytes)).id));
      if (url.pathname === "/api/github/repositories" && request.method === "GET") return json(response, 200, { repositories: await github.repositories(url.searchParams.get("q") || "", url.searchParams.get("refresh") === "1") });
      if (url.pathname === "/api/github/branches" && request.method === "GET") return json(response, 200, { branches: await github.branches(url.searchParams.get("repository"), url.searchParams.get("connection") || undefined, url.searchParams.get("company") || undefined) });
      if (url.pathname === "/api/environments" && request.method === "GET") return json(response, 200, { environments: await environments.list(), software: SOFTWARE_CATALOG,
        instances: config.workerBackend === "ec2" ? WORKER_INSTANCE_CATALOG : [], defaultInstanceType: config.ec2.instanceType,
        region: config.ec2.region, pricingRegion: WORKER_INSTANCE_PRICING_REGION });
      if (url.pathname === "/api/environments" && request.method === "POST") return json(response, 201, { environment: await environments.save(await bodyJson(request, config.maxBodyBytes)) });
      const environmentRoute = /^\/api\/environments\/(env_[a-f0-9-]{36})(?:\/(reveal|instance-type))?$/.exec(url.pathname);
      if (environmentRoute) {
        const id = environmentRoute[1];
        if (environmentRoute[2] && request.method === "POST") {
          if (environmentRoute[2] !== "reveal") return json(response, 405, { error: "Method not allowed" });
          const key = (await bodyJson(request, config.maxBodyBytes)).key;
          const variable = (await environments.get(id, { reveal: true })).variables.find(v => v.key === key);
          return variable ? json(response, 200, { value: variable.value }) : json(response, 404, { error: "Variable not found" });
        }
        if (environmentRoute[2] === "instance-type" && request.method === "PATCH") return json(response, 200, { environment: await environments.setInstanceType(id, await bodyJson(request, 1000)) });
        if (!environmentRoute[2] && request.method === "PATCH") return json(response, 200, { environment: await environments.save(await bodyJson(request, config.maxBodyBytes), id) });
        if (!environmentRoute[2] && request.method === "DELETE") { await environments.remove(id, store.list()); return json(response, 200, { removed: true }); }
      }
      if (url.pathname === "/api/preferences" && request.method === "GET") return json(response, 200, { preferences: await records.get("preferences", "new-chat") || {}, selectionMemory: true, projectAgents: googleAuth.enabled ? await agentAccounts.projectPreferences(user.id) : {} });
      if (url.pathname === "/api/preferences/restore" && request.method === "GET") return json(response, 200, await restoreChatSelection({ records, companies, environments, github,
        chats: visibleChats(), agentAccounts, ownerId: user?.id, namedAccounts: googleAuth.enabled, availableAgents: manager.availableAgents(user?.id),
      }, { companyId: url.searchParams.get("company"), repository: url.searchParams.get("repository") || undefined }));
      if (url.pathname === "/api/preferences" && request.method === "PATCH") {
        const body = await bodyJson(request, config.maxBodyBytes);
        if (googleAuth.enabled && ["codex", "claude"].includes(body.agent)) await agentAccounts.select(user.id, body.agentAccountId, body);
        if (googleAuth.enabled && body.agent !== null && !["mock", "codex", "claude"].includes(body.agent)) return json(response, 403, { error: "No agent account is connected for this user" });
        const environment = await environments.get(body.environmentId);
        if (!Array.isArray(body.repositories) || body.repositories.length > 100 || body.repositories.some(repo => typeof repo.fullName !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo.fullName) || typeof repo.branch !== "string" || repo.branch.length > 250)) throw new Error("Invalid repository preferences");
        // Ultracode is an explicit per-chat mode, never a user/project default.
        const { ultracode: ignoredUltracode, ...preferenceInput } = body;
        const { ultracode: ignoredDefault, ...modelSettings } = body.agent ? await models.validate(body.agent, preferenceInput, { ...preferenceInput, ownerId: user?.id }) : { model: null, effort: null };
        if (body.repositories.some(repo => repo.githubConnectionId && !/^github(?:_[a-f0-9-]{36})?$/.test(repo.githubConnectionId))) throw new Error("Invalid GitHub connection preference");
        const connections = github.connections ? await github.connections() : [];
        if (body.repositories.some(repo => repo.githubConnectionId && !connections.some(connection => connection.id === repo.githubConnectionId))) throw new Error("Saved GitHub connection is no longer available");
        const preferences = { environmentId: body.environmentId, agent: ["codex", "claude", "mock"].includes(body.agent) ? body.agent : null,
          ...(["codex", "claude"].includes(body.agent) && body.agentAccountId ? { agentAccountId: body.agentAccountId } : {}),
          ...modelSettings, repositories: body.repositories.map(({ fullName, branch, githubConnectionId }) => {
            const companyId = connections.find(connection => connection.id === githubConnectionId)?.companyId;
            return { fullName, branch, ...(githubConnectionId ? { githubConnectionId } : {}), ...(companyId ? { companyId } : {}) };
          }) };
        await rememberChatSelection(records, preferences, environment);
        await records.put("preferences", "new-chat", preferences);
        if (googleAuth.enabled) await agentAccounts.rememberProject(user.id, preferences);
        return json(response, 200, { preferences });
      }
      if (url.pathname === "/api/new-chat/commands" && request.method === "GET") {
        const agent = url.searchParams.get("agent");
        if (!["codex", "claude", "mock"].includes(agent) || agent === "mock" && !config.enableMock) return json(response, 400, { error: "Choose an available agent" });
        const companyId = url.searchParams.get("companyId") || null;
        if (companyId) await companies.get(companyId);
        const context = { agent, ownerId: user?.id, agentAccountId: url.searchParams.get("agentAccountId") || null };
        // Fixture command services may only implement existing-chat discovery;
        // the built-in draft path remains readonly and account-scoped.
        return json(response, 200, await (commands.newChat ? commands : new CommandCatalog(config, models)).newChat(context, await plugins.commands(companyId, agent)));
      }
      if (url.pathname === "/api/chats" && request.method === "GET") {
        return json(response, 200, { chats: visibleChats().map(summary) });
      }
      if (url.pathname === "/api/chats" && request.method === "POST") {
        const chat = await manager.createChat(await bodyJson(request, config.maxBodyBytes), user?.id);
        return json(response, 201, { chat });
      }
      if (url.pathname === "/api/sidebar" && request.method === "GET") {
        return json(response, 200, { chats: visibleChats().map(summary), groups: await organization.listGroups(), preferences: await organization.preferences() });
      }
      if (url.pathname === "/api/sidebar/preferences" && request.method === "PATCH") {
        return json(response, 200, { preferences: await organization.savePreferences(await bodyJson(request, config.maxBodyBytes)) });
      }
      if (url.pathname === "/api/sidebar/events" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
        response.write('data: {"type":"sidebar_changed"}\n\n');
        sidebarClients.add(response);
        response.ownerId = user?.id;
        const heartbeat = setInterval(() => {
          if (user) void browserUsers.session(request).then(current => { if (current?.id !== user.id) response.end(); else response.write(": heartbeat\n\n"); }).catch(() => response.end());
          else response.write(": heartbeat\n\n");
        }, 15000);
        heartbeat.unref?.();
        request.once("close", () => { clearInterval(heartbeat); sidebarClients.delete(response); });
        return;
      }
      if (url.pathname === "/api/groups" && request.method === "POST") {
        return json(response, 201, { group: await organization.saveGroup(await bodyJson(request, config.maxBodyBytes)) });
      }
      const groupRoute = /^\/api\/groups\/(group_[a-f0-9-]{36})$/.exec(url.pathname);
      if (groupRoute && request.method === "PATCH") return json(response, 200, { group: await organization.saveGroup(await bodyJson(request, config.maxBodyBytes), groupRoute[1]) });
      if (groupRoute && request.method === "DELETE") {
        if (store.list().some(chat => chat.customGroupId === groupRoute[1] && !browserUsers.canRead(chat, user))) return json(response, 403, { error: "This group contains private chats you cannot modify" });
        await organization.removeGroup(groupRoute[1]); return json(response, 200, { removed: true });
      }

      const routed = routeChat(url.pathname);
      if (routed) {
        const { chatId, tail } = routed;
        request.guardChat = () => { if (!browserUsers.canRead(store.get(chatId), user)) throw Object.assign(new Error("Chat not found"), { statusCode: 404 }); };
        request.guardChat();
        if (["app-preview", "app-preview/open"].includes(tail)) {
          if (!previews) {
            const selectedPort = request.method === "GET" ? Number(url.searchParams.get("port")) : (await bodyJson(request, 10000)).port;
            if (!Number.isSafeInteger(selectedPort) || selectedPort < 1024 || selectedPort > 65535) return json(response, 400, { error: "Select an app port between 1024 and 65535" });
            return json(response, 200, { preview: { status: "unavailable", port: selectedPort, hostname: null, message: "Remote app previews are not configured on this Relay.", retryable: false, canRevoke: false } });
          }
          const check = async () => {
            request.guardChat();
            const current = await googleAuth.session(request);
            if (!current || current.id !== user?.id || current.sessionId !== user?.sessionId) throw Object.assign(new Error("The Relay account changed. Reopen the app preview."), { statusCode: 401 });
          };
          await check();
          let result, status = 200;
          if (tail === "app-preview" && request.method === "GET") {
            const selected = url.searchParams.get("port");
            if (url.searchParams.size !== 1 || !/^\d{4,5}$/.test(selected || "")) throw Object.assign(new Error("Select an app port"), { statusCode: 400 });
            result = await previews.status(user, chatId, Number(selected));
          } else if (["POST", "DELETE"].includes(request.method)) {
            const input = await bodyJson(request, 10000); await check();
            if (tail === "app-preview/open" && request.method === "POST") { result = await previews.open(user, chatId, input.port, input.path, input.warmingId); status = result.warming ? 202 : 200; }
            else if (tail === "app-preview" && request.method === "POST") { result = await previews.ensure(user, chatId, input.port); status = result.preview.status === "ready" ? 200 : 202; }
            else if (tail === "app-preview" && request.method === "DELETE") result = await previews.remove(user, chatId, input.port);
            else return json(response, 405, { error: "Unsupported app preview action" });
          } else return json(response, 405, { error: "Unsupported app preview action" });
          await check(); return json(response, status, result);
        }
        if (tail === "presence" && request.method === "POST") return json(response, 200, await manager.setPresence(chatId, await bodyJson(request, 1000)));
        if (tail === "machine-health" && request.method === "GET") return json(response, 200, await manager.machineHealth(chatId), { "cache-control": "private, no-store" });
        if (tail === "browser/access" && request.method === "GET") return json(response, 200, manager.browsers.personal.info(chatId, user));
        if (tail === "browser/access" && request.method === "PATCH") {
          browserUsers.require(user); const input = await bodyJson(request, 2000);
          if (input.enabled === true) {
            if (input.confirm !== true) throw new Error("Confirm granting this chat access to your signed-in Chrome profile");
            return json(response, 200, await manager.browsers.personal.enable(chatId, user, input.connectionId));
          }
          if (input.enabled !== false) throw new Error("enabled must be true or false");
          await manager.browsers.personal.revokeChat(chatId);
          return json(response, 200, manager.browsers.personal.info(chatId, user));
        }
        if (tail === "privacy" && request.method === "POST") {
          browserUsers.require(user);
          const body = await bodyJson(request, 1000);
          if (body.confirm !== true) throw new Error("Confirm making this chat private to your account");
          return json(response, 200, { chat: await manager.makePrivate(chatId, user.id) });
        }
        if (tail === "browser" && request.method === "GET") return json(response, 200, manager.browsers.info(chatId));
        if (tail === "browser" && request.method === "POST") { await manager.browsers.ensure(chatId); return json(response, 200, manager.browsers.info(chatId)); }
        if (tail === "browser" && request.method === "DELETE") { await manager.browsers.stop(chatId, false); await manager.browserIdle(chatId); return json(response, 200, { stopped: true }); }
        if (tail === "copy" && request.method === "POST") return json(response, 201, { chat: await manager.copyTranscript(chatId, await bodyJson(request, config.maxBodyBytes), user?.id) });
        if (tail === "fork" && request.method === "POST") return json(response, 201, { chat: await manager.forkChat(chatId, await bodyJson(request, 2000), user?.id || null) });
        if (tail === "rendering-sample" && request.method === "POST") return json(response, 200, { chat: await manager.appendRenderingSample(chatId, (await bodyJson(request, 1000)).confirm) });
        if (tail === "rendering-sample" && request.method === "DELETE") return json(response, 200, { chat: await manager.removeRenderingSample(chatId) });
        if (tail === "commands" && request.method === "GET") {
          const chat = store.get(chatId); if (!chat) return json(response, 404, { error: "Chat not found" });
          return json(response, 200, await commands.list(chat));
        }
        if (["apps", "apps/select"].includes(tail) && request.method === "POST") {
          const input = await bodyJson(request, 2000); request.guardChat();
          if (tail === "apps/select" && (typeof input.appId !== "string" || typeof input.threadId !== "string")) throw new Error("Choose an app from this chat's picker");
          const result = await manager.nativeApps(chatId, tail === "apps/select" ? { appId: input.appId, threadId: input.threadId } : {}, request.guardChat);
          request.guardChat(); return json(response, 200, result);
        }
        if (["plugins", "plugins/change", "hooks", "hooks/change", "experimental", "experimental/change", "memories", "memories/change"].includes(tail) && request.method === "POST") {
          const input = await bodyJson(request, 2000); request.guardChat();
          const method = tail.startsWith("hooks") ? "nativeHooks" : tail.startsWith("experimental") ? "nativeFeatures" : tail.startsWith("memories") ? "nativeMemories" : "nativePlugins";
          const result = await manager[method](chatId, tail.endsWith("/change") ? { id: input.id, action: input.action, threadId: input.threadId, revision: input.revision, confirm: input.confirm } : {}, request.guardChat);
          request.guardChat(); return json(response, 200, result);
        }
        if (["imports", "imports/status", "imports/refresh", "imports/start", "imports/acknowledge", "imports/open"].includes(tail) && request.method === "POST") {
          const input = await bodyJson(request, 16000); request.guardChat();
          const action = tail.split("/")[1] || "list";
          const selected = action === "start" ? { requestId: input.requestId, source: input.source, revision: input.revision, threadId: input.threadId, ids: input.ids, confirm: input.confirm }
            : action === "open" ? { operationId: input.operationId, sessionId: input.sessionId, threadId: input.threadId, confirm: input.confirm }
            : action === "acknowledge" ? { id: input.id, threadId: input.threadId, confirm: input.confirm } : action === "list" ? { source: input.source } : {};
          const result = await manager.nativeImports(chatId, action, selected, request.guardChat);
          request.guardChat(); return json(response, 200, result);
        }
        if (tail === "workspace-files" && request.method === "GET") return json(response, 200, await manager.workspaceFiles(chatId, "status"));
        if (/^workspace-files\/(connect|presence|list|read|attach)$/.test(tail) && request.method === "POST") {
          const input = await bodyJson(request, 12000); request.guardChat();
          const result = await manager.workspaceFiles(chatId, tail.split("/")[1], input);
          request.guardChat(); return json(response, 200, result);
        }
        if (tail === "commands/inspect" && request.method === "GET") return json(response, 200, await manager.inspectCommand(chatId, url.searchParams.get("command")));
        if (tail === "desktop-handoff" && request.method === "GET") {
          const check = async () => {
            request.guardChat();
            if ((await browserUsers.session(request))?.id !== user?.id || !auth.authenticated(request)) throw Object.assign(new Error("The account changed. Reopen /app."), { statusCode: 409 });
          };
          await check(); const result = await manager.desktopHandoff(chatId, request.guardChat); await check();
          return json(response, 200, { ...result, accountScope: user?.id || "shared" }, { "cache-control": "private, no-store" });
        }
        if (["workspace-trust/inspect", "workspace-trust/confirm"].includes(tail) && request.method === "POST") {
          const input = await bodyJson(request, 2000);
          const check = async () => {
            request.guardChat();
            if ((await browserUsers.session(request))?.id !== user?.id || !auth.authenticated(request)) throw Object.assign(Error("The account changed. Reopen workspace trust. If you submitted confirmation, trust may already have been saved."), { statusCode: 409 });
          };
          await check();
          const result = await manager.nativeWorkspaceTrust(chatId, tail.split("/")[1], { reviewId: input.reviewId, confirm: input.confirm }, check, user?.id || "shared");
          await check(); return json(response, 200, result, { "cache-control": "private, no-store" });
        }
        if (tail === "logout" && request.method === "GET") {
          const result = await manager.nativeLogout(chatId, "status", {}, request.guardChat); request.guardChat(); return json(response, 200, result);
        }
        if (["logout/inspect", "logout/confirm"].includes(tail) && request.method === "POST") {
          const input = await bodyJson(request, 2000); request.guardChat();
          const result = await manager.nativeLogout(chatId, tail.split("/")[1], { id: input.id, revision: input.revision, threadId: input.threadId, confirm: input.confirm }, request.guardChat);
          request.guardChat(); return json(response, 200, result);
        }
        if (tail === "feedback" && request.method === "GET") {
          const result = await manager.nativeFeedback(chatId, "status", {}, request.guardChat); request.guardChat();
          return json(response, 200, result);
        }
        if (["feedback/policy", "feedback/prepare", "feedback/send"].includes(tail) && request.method === "POST") {
          const input = await bodyJson(request, 30000); request.guardChat();
          const action = tail.split("/")[1];
          const selected = action === "prepare" ? { classification: input.classification, reason: input.reason, includeLogs: input.includeLogs }
            : action === "send" ? { id: input.id, revision: input.revision, threadId: input.threadId, confirm: input.confirm } : {};
          const result = await manager.nativeFeedback(chatId, action, selected, request.guardChat); request.guardChat();
          return json(response, 200, result);
        }
        if (tail === "approvals" && request.method === "GET") {
          const result = await manager.nativeApprovals(chatId, null, request.guardChat); request.guardChat();
          return json(response, 200, result);
        }
        if (tail === "approvals/retry" && request.method === "POST") {
          const input = await bodyJson(request, 2000); request.guardChat();
          const result = await manager.nativeApprovals(chatId, { id: input.id, revision: input.revision, threadId: input.threadId, confirm: input.confirm }, request.guardChat);
          request.guardChat(); return json(response, 202, result);
        }
        if (tail === "commands/inspect" && request.method === "POST") {
          const input = await bodyJson(request, 1000);
          if (input.confirm !== true) throw new Error("Confirm stopping the selected background terminal");
          if (!Object.hasOwn(input, "terminate")) throw new Error("Choose a background terminal from this chat");
          return json(response, 200, await manager.inspectCommand(chatId, "ps", input.terminate));
        }
        if (tail === "side" && request.method === "GET") return json(response, 200, manager.sideChats.get(chatId));
        if (tail === "subagents" && ["GET", "POST"].includes(request.method)) {
          request.guardChat();
          const result = request.method === "GET" ? await manager.agentThreads.get(chatId) : await manager.agentThreadAction(chatId, "refresh");
          request.guardChat(); return json(response, 200, result);
        }
        if (/^subagents\/(select|messages|stop|respond)$/.test(tail) && request.method === "POST") {
          const input = await bodyJson(request, config.maxBodyBytes); request.guardChat();
          const result = await manager.agentThreadAction(chatId, tail.split("/")[1], input);
          request.guardChat(); return json(response, 200, result);
        }
        if (tail === "side" && request.method === "POST") return json(response, 200, await manager.sideChats.open(chatId));
        if ((tail === "side" && request.method === "DELETE") || (tail.startsWith("side/") && request.method === "POST")) {
          const input = await bodyJson(request, config.maxBodyBytes);
          if (typeof input.sideId !== "string" || !input.sideId) throw new Error("Choose the active side chat");
          if (tail === "side") return json(response, 200, await manager.sideChats.close(chatId, input.sideId));
          if (tail === "side/messages") return json(response, 202, await manager.sideChats.send(chatId, input.sideId, input));
          if (tail === "side/stop") return json(response, 200, await manager.sideChats.interrupt(chatId, input.sideId));
          if (tail === "side/respond") return json(response, 200, await manager.sideChats.respond(chatId, input.sideId, input.requestId, input));
        }
        if (tail === "queue" && request.method === "POST") {
          const body = await bodyJson(request, config.maxBodyBytes);
          return json(response, 202, { chat: await manager.enqueue(chatId, body.text, body.attachments || []) });
        }
        if (tail === "queue" && request.method === "PATCH") {
          const body = await bodyJson(request, config.maxBodyBytes);
          if (body.sendNowId !== undefined) return json(response, 202, { chat: manager.startQueuedNow(chatId, body.sendNowId) });
          return json(response, 200, { chat: await manager.editQueue(chatId, body) });
        }
        if (tail === "worker-size" && request.method === "PATCH") {
          const body = await bodyJson(request, 1000);
          return json(response, 202, { chat: await manager.resizeWorker(chatId, body.instanceType) });
        }
        if (tail === "repositories" && request.method === "POST") return json(response, 200, { chat: await manager.addRepository(chatId, await bodyJson(request, config.maxBodyBytes)) });
        if (tail === "changes" && request.method === "GET") {
          const chat = store.get(chatId);
          if (!chat) return json(response, 404, { error: "Chat not found" });
          return json(response, 200, chat.workspaceChanges || { files: chat.workspaceDiff ? [{ filename: "Latest Codex turn", patch: chat.workspaceDiff }] : [], note: "A workspace snapshot is captured after the agent's next completed turn. This view does not wake a sleeping worker." });
        }
        if (tail === "attachments" && request.method === "POST") return json(response, 201, { attachment: await attachments.upload(chatId, await bodyJson(request, 7 * 1024 * 1024)) });
        const attachmentMatch = /^attachments\/(file_[a-f0-9-]{36})$/.exec(tail);
        if (attachmentMatch && request.method === "GET") {
          const [file] = await attachments.resolve(chatId, [attachmentMatch[1]]);
          request.guardChat(); return json(response, 200, { attachment: file });
        }
        if (tail === "session-info" && request.method === "GET") return json(response, 200, await manager.sessionInfo(chatId));
        if (tail === "goal" && request.method === "PATCH") return json(response, 200, { chat: await manager.goalAction(chatId, (await bodyJson(request, 1000)).action) });
        if (tail === "compact" && request.method === "POST") { await manager.compact(chatId); return json(response, 200, { compacted: true }); }
        if (tail === "pull-requests/files" && request.method === "GET") {
          return json(response, 200, await manager.pullRequests.files(chatId, url.searchParams.get("repository"), Number(url.searchParams.get("number"))));
        }
        if (tail === "pull-requests/auto-merge" && request.method === "PATCH") {
          const body = await bodyJson(request, config.maxBodyBytes);
          return json(response, 200, { chat: await manager.pullRequests.autoMerge(chatId, body.repository, body.number, body.enabled) });
        }
        if (tail === "pull-requests/subscription" && request.method === "PATCH") {
          if (!manager.githubEvents) return json(response, 409, { error: "GitHub event subscriptions require durable storage and a named agent account." });
          const body = await bodyJson(request, 2000);
          const caller = { ownerId: user?.id, session: { kind: googleAuth.enabled ? "relay-session" : "browser-user-session", id: user?.sessionId, ownerId: user?.id }, guard: request.guardChat, check: async () => {
            request.guardChat(); const current = await browserUsers.session(request); request.guardChat();
            if (!current || current.id !== user?.id || current.sessionId !== user?.sessionId) throw Object.assign(new Error("Sign in again before changing GitHub subscriptions"), { statusCode: 401 });
          } };
          return json(response, 200, { chat: await manager.githubEvents.configure(chatId, body, caller) });
        }
        if (tail === "pull-requests/event" && request.method === "PATCH") {
          if (!manager.githubEvents) return json(response, 409, { error: "GitHub events unavailable" });
          const body = await bodyJson(request, 1000);
          const caller = { ownerId: user?.id, session: { kind: googleAuth.enabled ? "relay-session" : "browser-user-session", id: user?.sessionId, ownerId: user?.id }, guard: request.guardChat, check: async () => {
            request.guardChat(); const current = await browserUsers.session(request); request.guardChat();
            if (!current || current.id !== user?.id || current.sessionId !== user?.sessionId) throw Object.assign(new Error("Sign in again before reviewing GitHub delivery"), { statusCode: 401 });
          } };
          return json(response, 200, { chat: await manager.githubEvents.review(chatId, body.id, body.action, caller) });
        }
        if (tail === "pull-requests/refresh" && request.method === "POST") {
          await manager.pullRequests.refresh(chatId); return json(response, 200, { chat: store.get(chatId) });
        }
        if (tail === "mode" && request.method === "PATCH") {
          return json(response, 200, { chat: await manager.setMode(chatId, (await bodyJson(request, config.maxBodyBytes)).mode) });
        }
        if (tail === "agent" && request.method === "PATCH") {
          const input = await bodyJson(request, config.maxBodyBytes);
          return json(response, 200, { chat: await manager.switchAgent(chatId, input.agent, input) });
        }
        if (tail === "model" && request.method === "PATCH") {
          return json(response, 200, { chat: await manager.setModel(chatId, await bodyJson(request, config.maxBodyBytes)) });
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
          const current = store.get(chatId);
          if (manager.isBusy(chatId) || ["starting", "running", "stopping"].includes(current?.status) || current?.queuedMessages?.length) {
            const chat = await manager.enqueue(chatId, body.text, body.attachments || []);
            return json(response, 202, { accepted: true, queued: true, chat });
          }
          const submitted = await manager.submit(chatId, body.text, body.attachments || []);
          submitted.completion.catch((error) => console.error(`turn ${chatId}:`, errorMessage(error)));
          return json(response, 202, { accepted: true, message: submitted.message });
        }
        if (tail === "interrupt" && request.method === "POST") {
          await bodyJson(request, 1000); request.guardChat();
          const chat = await manager.interrupt(chatId);
          request.guardChat(); return json(response, 200, { chat });
        }
        if (tail === "stop" && request.method === "POST") {
          await manager.stop(chatId, "manual");
          return json(response, 200, { stopped: true });
        }
        if (tail === "wake" && request.method === "POST") {
          await bodyJson(request, 1000); request.guardChat();
          const result = await manager.wake(chatId, request.guardChat);
          request.guardChat();
          return json(response, result.accepted ? 202 : 200, { chat: result.chat, accepted: result.accepted });
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
            if (!auth.authenticated(request) || store.get(chatId) && !browserUsers.canRead(store.get(chatId), user)) { client.close(); return; }
            if (event.chatId === chatId) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          };
          manager.on("event", onEvent);
          const heartbeat = setInterval(() => {
            void browserUsers.session(request).then(current => {
              if (!auth.authenticated(request) || user && current?.id !== user.id || !browserUsers.canRead(store.get(chatId), current)) { client.close(); return; }
              if (!response.writableEnded) response.write(": heartbeat\n\n");
            }).catch(() => client.close());
          }, 15_000);
          heartbeat.unref?.();
          const client = { response, ownerId: user?.id, close: () => { clearInterval(heartbeat); manager.off("event", onEvent); response.end(); } };
          sseClients.add(client);
          request.once("close", () => { clearInterval(heartbeat); manager.off("event", onEvent); sseClients.delete(client); });
          return;
        }
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
    } finally {
      // A disconnected HTTP client does not cancel an already running save or
      // OAuth exchange. Keep it counted until the handler itself has finished.
      if (mutationPending) activeMutations--;
    }
  });

  server.on("upgrade", async (request, socket, head) => {
    const reject = code => { socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); };
    if (stopping || draining) { reject("503 Service Unavailable"); return; }
    if (isolatePublicHosts && request.headers.host !== new URL(googleAuth.config.origin).host) {
      if (!previews || !previewHosts?.lookup(request.headers.host)) { reject("421 Misdirected Request"); return; }
      await previews.handleUpgrade(request, socket, head); return;
    }
    let url, origin;
    try { url = new URL(request.url, `http://${request.headers.host}`); origin = new URL(request.headers.origin); }
    catch { reject("403 Forbidden"); return; }
    if (url.pathname === "/browser/connect") {
      if (!manager || url.search || !/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin || "") || personalSockets.clients.size >= 100) { reject("403 Forbidden"); return; }
      personalSockets.handleUpgrade(request, socket, head, ws => manager.browsers.personal.accept(ws, origin.hostname)); return;
    }
    const routed = routeChat(url.pathname);
    const expectedProtocol = config.cookieSecure || googleAuth.config.origin?.startsWith("https:") ? "https:" : "http:";
    if (origin.host !== request.headers.host || origin.protocol !== expectedProtocol || url.search || !auth.authenticated(request)) { reject("403 Forbidden"); return; }
    let user; try { user = await browserUsers.session(request); } catch { reject("503 Service Unavailable"); return; }
    if (stopping || draining) { reject("503 Service Unavailable"); return; }
    if (!manager || !routed || routed.tail !== "browser/live" || !browserUsers.canRead(store.get(routed.chatId), user)) { reject("404 Not Found"); return; }
    browserSockets.handleUpgrade(request, socket, head, ws => {
      ws.ownerId = user?.id;
      ws.on("error", () => {});
      let alive = true;
      ws.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive || !auth.authenticated(request) || !browserUsers.canRead(store.get(routed.chatId), user)) { ws.terminate(); return; }
        if (user) void browserUsers.session(request).then(current => { if (current?.id !== user.id) ws.terminate(); }).catch(() => ws.terminate());
        alive = false; ws.ping();
      }, 15000);
      heartbeat.unref?.(); ws.once("close", () => clearInterval(heartbeat));
      browserAttachments++;
      void manager.browsers.attach(routed.chatId, ws).catch(error => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ event: "closed", value: { message: errorMessage(error) } }));
        ws.close(1011, "Browser unavailable");
      }).finally(() => { browserAttachments--; });
    });
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
        legacyOwnerId: googleAuth.legacyOwnerId,
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
      githubWorkers,
      environments,
      models,
      harnessUpdates,
      attachments,
      mcps,
      commands,
      resources,
      agentAccounts,
      packageRegistry: npmGateway,
      adapterFactory: options.adapterFactory || null,
    });
    await manager.reconcileStoppedWorkers({ background: true });
    void manager.retryDeletionCleanup().catch(error => console.error("worker deletion cleanup:", errorMessage(error)));
    manager.browsers = new SharedBrowsers({ store, config, acquire: chatId => manager.browserExecutor(chatId), onIdle: chatId => manager.browserIdle(chatId),
      // Chat presence is presentation state, never browser/process authority.
      isActive: () => false, onViewers: chatId => manager.refreshActivity(chatId), ...options.browserOptions });
    manager.browsers.personal = new BrowserConnections({ records, store, ttlMs: config.sessionCapabilityTtlMs, validateCompany: async (user, companyId) => (await resources.forOwner(user.id)).companies.get(companyId) });
    manager.browsers.personal.on("viewers", chatId => { void manager.refreshActivity(chatId).catch(() => {}); });
    manager.browsers.personal.on("changed", chatId => {
      manager.browsers.invalidateOfficial(chatId);
      manager.browsers.touch(chatId);
      for (const socket of manager.browsers.entries.get(chatId)?.viewers || []) socket.close(4001, "Browser access changed");
    });
    manager.browsers.personalScope = chatId => personalBrowserScope({store,records,resources,agentAccounts},chatId);
    manager.browsers.personal.officialScope = manager.browsers.personalScope;
    // Core worker/browser ownership is now reconciled. Optional app-preview
    // and GitHub recovery may continue before start() returns, but must not
    // make a healthy controller miss the bounded rollout readiness SLA.
    initializing = false;
    if (config.preview?.enabled) {
      try {
        const { PreviewHosts } = options.previewHosts ? {} : await import("./preview-hosts.mjs");
        const { PreviewBootstrap } = options.previewBootstrapFactory ? {} : await import("./preview-bootstrap.mjs");
        previewHosts = options.previewHosts || new PreviewHosts({ records, config: config.preview, onChange: () => { previews?.grants.prune(); sidebarChanged(); } });
        await previewHosts.initialize();
        previews = new AppPreviews({ hosts: previewHosts, identity: googleAuth, store, manager, relayOrigin: googleAuth.config.origin,
          bootstrapFactory: options.previewBootstrapFactory || (options => new PreviewBootstrap(options)), ...(options.appPreviewOptions || {}) });
        previews.start();
      } catch (error) { await manager.shutdown(); await new Promise(resolve => server.close(resolve)); throw error; }
    }
    manager.on("event", event => { if (["chat_updated", "message", "chat_deleted"].includes(event.type)) sidebarChanged(); });
    await manager.githubEvents?.initialize();
    manager.pullRequests.start();
    manager.githubEvents?.process();
    return { host: config.host, port, url: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}` };
  }

  function stop() {
    return stopping ||= shutdown();
  }
  async function shutdown() {
    githubWorkers.shutdown();
    npmGateway.shutdown();
    // Stop accepting connections before closing SSE. Otherwise a browser may
    // reconnect while workers shut down and keep server.close() waiting forever.
    const closed = new Promise(resolve => server.close(resolve));
    await previews?.close();
    if (manager) await manager.shutdown();
    await agentAccounts.close();
    await Promise.all(resources.all().map(entry => entry.github.close?.()));
    for (const client of sseClients) client.close();
    sseClients.clear();
    for (const response of sidebarClients) response.end();
    sidebarClients.clear();
    for (const socket of browserSockets.clients) socket.terminate();
    await new Promise(resolve => browserSockets.close(resolve));
    for (const socket of personalSockets.clients) socket.terminate();
    await new Promise(resolve => personalSockets.close(resolve));
    await closed;
    if (!options.records) await records.close();
  }

  return { server, store, records, organization, broker, npmGateway, config, browserUsers, googleAuth, resources, agentAccounts, start, stop, get manager() { return manager; }, get previews() { return previews; } };
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
