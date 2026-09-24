import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

// Actual HTTP + OAuth test server: no provider accounts or model requests.
export async function startMcpFixture({ port = 0, requireAuth = true, anonymousInitialize = false, mcpPath = "/mcp", oauthPrefix = "", issuerParameter = true, beforeMcpRequest = null,
  advertisedOrigin = null, linear = false, workspace = "fixture-workspace", accessToken = "fixture-access-secret", refreshToken = "fixture-refresh-secret", dynamicRegistration = true, preRegisteredClients = [], beforeExchange = null } = {}) {
  const codes = new Map(), clients = new Map(preRegisteredClients.map(client => [client.client_id, client])); let refreshes = 0, exchanges = 0, calls = 0, pkce = true, rejectTokens = false, failTool = false;
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      const read = async () => { let body = ""; for await (const chunk of req) body += chunk; return body; };
      const issuer = advertisedOrigin || origin;
      if (url.pathname === `/.well-known/oauth-protected-resource${mcpPath}`) return json(200, { resource: `${issuer}${mcpPath}`, authorization_servers: [issuer], scopes_supported: linear ? ["read", "write"] : ["mcp:read", "mcp:write"] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { issuer, authorization_endpoint: `${issuer}${oauthPrefix}/authorize`, token_endpoint: `${issuer}${oauthPrefix}/token`, ...(dynamicRegistration ? { registration_endpoint: `${issuer}${oauthPrefix}/register` } : {}), response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic"], code_challenge_methods_supported: pkce ? ["S256"] : [], ...(issuerParameter ? { authorization_response_iss_parameter_supported: true } : {}) });
      if (url.pathname === `${oauthPrefix}/register`) { const metadata = JSON.parse(await read()); const client = { ...metadata, client_id: randomUUID() }; clients.set(client.client_id, client); return json(201, client); }
      if ([`${oauthPrefix}/authorize`, `${oauthPrefix}/approve`, `${oauthPrefix}/deny`].includes(url.pathname)) {
        const params = url.searchParams;
        if (!clients.get(params.get("client_id"))?.redirect_uris.includes(params.get("redirect_uri")) || params.get("code_challenge_method") !== "S256") return json(400, { error: "invalid_request" });
        if (url.pathname === `${oauthPrefix}/authorize`) {
          res.setHeader("content-type", "text/html"); return res.end(`<!doctype html><title>Fixture OAuth consent</title><h1>Allow Agent Relay to use fixture tools?</h1><a href="${oauthPrefix}/approve?${params.toString()}">Approve access</a><a href="${oauthPrefix}/deny?${params.toString()}">Decline access</a>`);
        }
        if (url.pathname === `${oauthPrefix}/deny`) { const redirect = new URL(params.get("redirect_uri")); redirect.searchParams.set("state", params.get("state")); redirect.searchParams.set("error", "access_denied"); res.writeHead(302, { location: redirect.href }); return res.end(); }
        const code = randomUUID(); codes.set(code, Object.fromEntries(params));
        const redirect = new URL(params.get("redirect_uri")); redirect.searchParams.set("state", params.get("state")); redirect.searchParams.set("code", code); if (issuerParameter) redirect.searchParams.set("iss", issuer);
        res.writeHead(302, { location: redirect.href }); return res.end();
      }
      if (url.pathname === `${oauthPrefix}/token`) {
        const params = new URLSearchParams(await read());
        if (params.get("grant_type") === "authorization_code") {
          exchanges++; await beforeExchange?.(); const code = codes.get(params.get("code")); codes.delete(params.get("code"));
          if (!code || code.client_id !== params.get("client_id") || code.redirect_uri !== params.get("redirect_uri") || createHash("sha256").update(params.get("code_verifier") || "").digest("base64url") !== code.code_challenge) return json(400, { error: "invalid_grant" });
        } else if (params.get("grant_type") === "refresh_token" && params.get("refresh_token") === refreshToken && !rejectTokens) refreshes++;
        else return json(400, { error: "invalid_grant" });
        return json(200, { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, scope: linear ? "read" : "mcp:read" });
      }
      if (url.pathname !== mcpPath) return json(404, { error: "not_found" });
      if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
      const rpc = JSON.parse(await read());
      await beforeMcpRequest?.(rpc);
      if ((requireAuth && req.headers.authorization !== `Bearer ${accessToken}` || rejectTokens) && !(anonymousInitialize && ["initialize", "notifications/initialized"].includes(rpc.method))) {
        res.setHeader("www-authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${mcpPath}"`); return json(401, { error: "unauthorized" });
      }
      if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
      if (rpc.method === "initialize") return json(200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: rpc.params.protocolVersion, serverInfo: { name: "relay-fixture", version: "1.0" }, capabilities: { tools: {} } } });
      if (rpc.method === "tools/list") return json(200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: linear ? "list_teams" : "fixture_echo", description: "Reads fixture data without changing anything", inputSchema: { type: "object", properties: linear ? { limit: { type: "number" } } : { text: { type: "string" } } } }] } });
      if (rpc.method === "tools/call") { calls++; return json(200, { jsonrpc: "2.0", id: rpc.id, result: { ...(failTool ? { isError: true } : {}), content: [{ type: "text", text: linear ? JSON.stringify({ teams: [{ id: workspace }] }) : rpc.params.arguments.text }] } }); }
      return json(200, { jsonrpc: "2.0", id: rpc.id, result: {} });
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, server, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }), get refreshes() { return refreshes; }, get exchanges() { return exchanges; }, get calls() { return calls; }, set pkce(value) { pkce = value; }, set rejectTokens(value) { rejectTokens = value; }, set failTool(value) { failTool = value; } };
}
