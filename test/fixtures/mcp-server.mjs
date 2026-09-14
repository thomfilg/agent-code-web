import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

// Actual HTTP + OAuth test server: no provider accounts or model requests.
export async function startMcpFixture({ port = 0, requireAuth = true, anonymousInitialize = false } = {}) {
  const codes = new Map(), clients = new Map(); let refreshes = 0, exchanges = 0, calls = 0, pkce = true, rejectTokens = false;
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      const read = async () => { let body = ""; for await (const chunk of req) body += chunk; return body; };
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp:read"] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: pkce ? ["S256"] : [], authorization_response_iss_parameter_supported: true });
      if (url.pathname === "/register") { const metadata = JSON.parse(await read()); const client = { ...metadata, client_id: randomUUID() }; clients.set(client.client_id, client); return json(201, client); }
      if (["/authorize", "/approve"].includes(url.pathname)) {
        const params = url.searchParams;
        if (!clients.get(params.get("client_id"))?.redirect_uris.includes(params.get("redirect_uri")) || params.get("code_challenge_method") !== "S256") return json(400, { error: "invalid_request" });
        if (url.pathname === "/authorize") {
          res.setHeader("content-type", "text/html"); return res.end(`<!doctype html><title>Fixture OAuth consent</title><h1>Allow Agent Relay to use fixture tools?</h1><a href="/approve?${params.toString()}">Approve access</a>`);
        }
        const code = randomUUID(); codes.set(code, Object.fromEntries(params));
        const redirect = new URL(params.get("redirect_uri")); redirect.searchParams.set("state", params.get("state")); redirect.searchParams.set("code", code); redirect.searchParams.set("iss", origin);
        res.writeHead(302, { location: redirect.href }); return res.end();
      }
      if (url.pathname === "/token") {
        const params = new URLSearchParams(await read());
        if (params.get("grant_type") === "authorization_code") {
          exchanges++; const code = codes.get(params.get("code")); codes.delete(params.get("code"));
          if (!code || code.client_id !== params.get("client_id") || code.redirect_uri !== params.get("redirect_uri") || createHash("sha256").update(params.get("code_verifier") || "").digest("base64url") !== code.code_challenge) return json(400, { error: "invalid_grant" });
        } else if (params.get("grant_type") === "refresh_token" && params.get("refresh_token") === "fixture-refresh-secret") refreshes++;
        else return json(400, { error: "invalid_grant" });
        return json(200, { access_token: "fixture-access-secret", refresh_token: "fixture-refresh-secret", token_type: "Bearer", expires_in: 3600, scope: "mcp:read" });
      }
      if (url.pathname !== "/mcp") return json(404, { error: "not_found" });
      if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
      const rpc = JSON.parse(await read());
      if ((requireAuth && req.headers.authorization !== "Bearer fixture-access-secret" || rejectTokens) && !(anonymousInitialize && ["initialize", "notifications/initialized"].includes(rpc.method))) {
        res.setHeader("www-authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`); return json(401, { error: "unauthorized" });
      }
      if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
      if (rpc.method === "initialize") return json(200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: rpc.params.protocolVersion, serverInfo: { name: "relay-fixture", version: "1.0" }, capabilities: { tools: {} } } });
      if (rpc.method === "tools/list") return json(200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "fixture_echo", description: "Echoes a message without changing anything", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
      if (rpc.method === "tools/call") { calls++; return json(200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: rpc.params.arguments.text }] } }); }
      return json(200, { jsonrpc: "2.0", id: rpc.id, result: {} });
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, server, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }), get refreshes() { return refreshes; }, get exchanges() { return exchanges; }, get calls() { return calls; }, set pkce(value) { pkce = value; }, set rejectTokens(value) { rejectTokens = value; } };
}
