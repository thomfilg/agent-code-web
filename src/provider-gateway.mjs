import { Readable, pipeline } from "node:stream";
import { errorMessage } from "./utils.mjs";
import { claudeFastCredential } from "./claude-fast.mjs";
import { observeClaudeFastRequest, observeClaudeFastResponse } from "./claude-fast-transport.mjs";

const HOP_BY_HOP = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);

function bearerFrom(request) {
  const authorization = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] || request.headers["x-api-key"] || "";
}

function copyRequestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function copyResponseHeaders(upstream, response) {
  for (const [name, value] of upstream.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || ["content-encoding", "content-length"].includes(name.toLowerCase())) continue;
    response.setHeader(name, value);
  }
  response.setHeader("cache-control", "no-store");
}

function routeFor(urlPath) {
  if (urlPath === "/gateway/openai" || urlPath.startsWith("/gateway/openai/")) {
    return { provider: "openai", suffix: urlPath.slice("/gateway/openai".length) || "/" };
  }
  if (urlPath === "/gateway/anthropic" || urlPath.startsWith("/gateway/anthropic/")) {
    return { provider: "anthropic", suffix: urlPath.slice("/gateway/anthropic".length) || "/" };
  }
  return null;
}

function allowedProviderPath(provider, suffix) {
  if (provider === "openai") return suffix === "/v1/responses" || suffix.startsWith("/v1/responses/");
  return suffix === "/v1/messages" || suffix.startsWith("/v1/messages/");
}

function upstreamUrl(baseUrl, suffix, search) {
  const target = new URL(baseUrl);
  const basePath = target.pathname.replace(/\/$/, "");
  target.pathname = `${basePath}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  target.search = search;
  target.hash = "";
  return target;
}

export class ProviderGateway {
  constructor({ config, broker, fetchImpl = fetch, now = Date.now }) {
    this.config = config;
    this.broker = broker;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async handle(request, response, url) {
    const route = routeFor(url.pathname);
    if (!route) return false;

    if (!["GET", "POST"].includes(request.method || "GET") || !allowedProviderPath(route.provider, route.suffix)) {
      response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"error":"provider endpoint is outside this agent capability"}\n');
      return true;
    }

    const capability = this.broker.validate(bearerFrom(request), route.provider);
    if (!capability) {
      response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"error":"invalid or expired worker capability"}\n');
      return true;
    }

    const providerConfig = route.provider === "openai" ? this.config.codex : this.config.claude;
    if (!providerConfig.providerKey) {
      response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(`{"error":"${route.provider} gateway key is not configured"}\n`);
      return true;
    }

    const target = upstreamUrl(providerConfig.upstreamBaseUrl, route.suffix, url.search);
    const headers = copyRequestHeaders(request);
    headers.set("user-agent", "agent-web-poc/0.1");
    if (route.provider === "openai") headers.set("authorization", `Bearer ${providerConfig.providerKey}`);
    else headers.set("x-api-key", providerConfig.providerKey);

    const controller = new AbortController();
    request.once("aborted", () => { controller.abort(); fastRequest?.stream.destroy(); });
    const fastRequest = route.provider === "anthropic" && request.method === "POST" && route.suffix === "/v1/messages" ? observeClaudeFastRequest() : null;
    const notify = fastRequest ? this.broker.captureProviderObserver(bearerFrom(request), route.provider) : null;
    const credential = fastRequest ? claudeFastCredential(providerConfig) : null;
    try {
      const hasBody = !["GET", "HEAD"].includes(request.method || "GET");
      const upstream = await this.fetchImpl(target, {
        method: request.method,
        headers,
        body: hasBody ? fastRequest ? request.pipe(fastRequest.stream) : request : undefined,
        duplex: hasBody ? "half" : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
      response.statusCode = upstream.status;
      copyResponseHeaders(upstream, response);
      if (!upstream.body) response.end();
      else {
        const source = Readable.fromWeb(upstream.body);
        const finished = error => { if (error && !response.destroyed) response.destroy(); };
        if (fastRequest) pipeline(source, observeClaudeFastResponse({ upstream, isFast: fastRequest.isFast, notify, credential, now: this.now }), response, finished);
        else pipeline(source, response, finished);
      }
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      }
      response.end(`${JSON.stringify({ error: "provider gateway failure", detail: errorMessage(error) })}\n`);
    }
    return true;
  }
}
