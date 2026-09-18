import { randomBytes, timingSafeEqual } from "node:crypto";
import { auth, discoverOAuthServerInfo, refreshAuthorization, selectResourceURL } from "@modelcontextprotocol/sdk/client/auth.js";
import { isLinearMcp } from "../public/mcp-provider.js";

const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const loginRequired = () => Object.assign(new Error("Sign in with OAuth in MCP connections, then restart the worker."), { statusCode: 401 });
const nonce = () => randomBytes(32).toString("base64url");
const equal = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const oauthCookieName = state => `relay_mcp_${state.slice(0, 16)}`;

export function safeMcpUrl(value, { loopback = true } = {}) {
  let url; try { url = new URL(value); } catch { throw invalid("Invalid MCP or OAuth URL"); }
  if (url.username || url.password || url.hash || !(url.protocol === "https:" || (loopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw invalid("MCP and OAuth URLs must use HTTPS (HTTP is allowed only on loopback).");
  return url;
}

// Never follow redirects carrying an access token, refresh token, or client secret.
// Provider error bodies can contain credentials: they must not reach the UI/logs.
export function oauthFetch(fetchImpl, serverUrl) {
  return async (url, options = {}) => {
    safeMcpUrl(url, { loopback: new URL(serverUrl).protocol === "http:" });
    const response = await fetchImpl(url, { ...options, redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(15000), ...(options.signal ? [options.signal] : [])]) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw invalid("OAuth endpoint redirected. Configure the final MCP URL."); }
    return response;
  };
}

class OAuthProvider {
  constructor(connection, data, flow = null) { this.connection = connection; this.data = data; this.flow = flow; }
  get redirectUrl() { return this.data.redirectUrl; }
  get clientMetadata() {
    return { client_name: "Agent Relay", redirect_uris: [this.redirectUrl], response_types: ["code"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: this.connection.oauthClientId && this.data.clientInformation?.client_secret ? "client_secret_basic" : "none", ...(this.connection.oauthScopes ? { scope: this.connection.oauthScopes } : {}) };
  }
  state() { return this.flow?.state; }
  clientInformation() { return this.data.clientInformation; }
  saveClientInformation(value) { this.data.clientInformation = value; }
  tokens() { return this.data.tokens; }
  saveTokens(value) {
    if (!/^Bearer$/i.test(value.token_type) || /[\r\n\0]/.test(value.access_token)) throw invalid("OAuth server returned an unsupported access token.");
    this.data.tokens = value;
    this.data.expiresAt = value.expires_in === undefined ? null : Date.now() + value.expires_in * 1000;
  }
  redirectToAuthorization(url) { if (!this.flow) throw loginRequired(); safeMcpUrl(url, { loopback: new URL(this.connection.url).protocol === "http:" }); this.flow.authorizationUrl = url.href; }
  saveCodeVerifier(value) { if (!this.flow) throw loginRequired(); this.flow.verifier = value; }
  codeVerifier() { if (!this.flow?.verifier) throw invalid("OAuth sign-in expired. Start again."); return this.flow.verifier; }
  discoveryState() { return this.data.discovery; }
  saveDiscoveryState(value) { this.data.discovery = value; }
}

export class McpOAuth {
  constructor(connections) { this.connections = connections; this.flows = new Map(); this.refreshes = new Map(); this.attempts = new Map(); }
  status(id) {
    const attempt = this.attempts.get(id);
    if (!attempt) return null;
    if (["connecting", "pending"].includes(attempt.status) && attempt.expiresAt <= Date.now()) {
      this.forget(id);
      this.attempts.set(id, { status: "expired", message: "Sign-in expired. Connect again when you are ready." });
    }
    const { state, ...status } = this.attempts.get(id);
    return status;
  }
  forget(id) {
    for (const [state, flow] of this.flows) if (flow.id === id) this.flows.delete(state);
    this.attempts.delete(id);
  }
  invalidate(id) {
    const attempt = this.attempts.get(id);
    this.forget(id);
    if (["pending", "connecting"].includes(attempt?.status)) this.attempts.set(id, { id: attempt.id, status: "cancelled", message: "Connection settings changed. Start sign-in again." });
  }
  async cancel(id) {
    await this.connections.get(id);
    const attemptId = this.attempts.get(id)?.id;
    this.forget(id);
    this.attempts.set(id, { id: attemptId, status: "cancelled", message: "Sign-in cancelled. Existing authorization was not changed." });
    await this.connections.queue;
  }
  async begin(id, redirectUrl) {
    for (const [state, flow] of this.flows) if (flow.expiresAt < Date.now()) this.flows.delete(state);
    if (this.flows.size >= 30) throw invalid("Too many pending sign-ins. Wait a few minutes and try again.");
    let connection = await this.connections.get(id);
    if (connection.type !== "http" || connection.authMode !== "oauth") throw invalid("Choose OAuth authentication and save the connection first.");
    safeMcpUrl(redirectUrl);
    const flow = { state: nonce(), attemptId: nonce(), cookie: nonce(), id, expiresAt: Date.now() + 600000 };
    this.forget(id);
    this.attempts.set(id, { id: flow.attemptId, state: flow.state, status: "connecting", expiresAt: flow.expiresAt, message: "Preparing secure sign-in…" });
    await this.connections.queue;
    if (this.attempts.get(id)?.state !== flow.state) throw invalid("Sign-in was cancelled or replaced. Connect again.");
    connection = await this.connections.get(id); flow.revision = connection.revision;
    // Reuse registration only for the same callback. Never reuse tokens: Connect
    // means explicit consent, including servers with anonymous initialization.
    const data = { redirectUrl, ...(connection.oauth?.redirectUrl === redirectUrl ? { clientInformation: connection.oauth.clientInformation } : {}) };
    if (connection.oauthClientId) data.clientInformation = { client_id: connection.oauthClientId, ...(connection.oauthClientSecret ? { client_secret: connection.oauthClientSecret } : {}) };
    const provider = new OAuthProvider(connection, data, flow), fetchFn = oauthFetch(this.connections.fetch, connection.url);
    try {
      data.discovery = await discoverOAuthServerInfo(connection.url, { fetchFn });
      const metadata = data.discovery.authorizationServerMetadata;
      if (!metadata?.code_challenge_methods_supported?.includes("S256")) throw invalid("The OAuth server must advertise PKCE S256 support.");
      for (const field of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) if (metadata[field]) safeMcpUrl(metadata[field], { loopback: new URL(connection.url).protocol === "http:" });
      if (!data.clientInformation && !metadata.registration_endpoint) throw invalid("This server needs a pre-registered OAuth client. Enter its client ID in Advanced OAuth settings.");
      // Metadata is selected at the start, then pinned through callback and refresh.
      const scope = connection.oauthScopes || (isLinearMcp(connection.url) ? "read" : data.discovery.resourceMetadata?.scopes_supported?.join(" ") || metadata.scopes_supported?.join(" "));
      await auth(provider, { serverUrl: connection.url, scope, fetchFn });
      if (!flow.authorizationUrl) throw invalid("OAuth server did not provide a sign-in URL.");
      if (this.attempts.get(id)?.state !== flow.state) throw invalid("Sign-in was cancelled or replaced. Connect again.");
      if ((await this.connections.get(id)).revision !== flow.revision) throw invalid("Connection changed. Start sign-in again.");
      flow.data = data; this.flows.set(flow.state, flow);
      this.attempts.set(id, { id: flow.attemptId, state: flow.state, status: "pending", expiresAt: flow.expiresAt, message: "Waiting for your approval in the provider window. Choose the workspace for this connection." });
      return { state: flow.state, attemptId: flow.attemptId, cookie: flow.cookie, authorizationUrl: flow.authorizationUrl };
    } catch (error) {
      const failure = error.statusCode ? error : invalid("OAuth setup failed. Check the endpoint, server availability, and OAuth client registration settings.");
      if (this.attempts.get(id)?.state === flow.state) this.attempts.set(id, { id: flow.attemptId, status: "failed", message: failure.message });
      throw failure;
    }
  }
  async finish(params, cookies) {
    const state = params.get("state") || "", flow = this.flows.get(state);
    if (!flow || flow.expiresAt < Date.now() || !equal(cookies[oauthCookieName(state)], flow.cookie)) throw invalid("Invalid or expired OAuth sign-in. Start again from MCP connections in the same browser.");
    this.flows.delete(state); // Single use, even if consent was denied or exchange fails.
    try {
      if (params.has("error")) throw invalid("OAuth authorization was declined. No new credentials were saved.");
      const connection = await this.connections.get(flow.id);
      if (connection.revision !== flow.revision) throw invalid("Connection changed during sign-in. Start again.");
      const metadata = flow.data.discovery.authorizationServerMetadata, issuer = params.get("iss");
      if ((issuer && issuer !== metadata.issuer) || (metadata.authorization_response_iss_parameter_supported && !issuer)) throw invalid("OAuth issuer mismatch. No credentials were exchanged.");
      const code = params.get("code");
      if (!code || code.length > 8192) throw invalid("OAuth callback is missing an authorization code.");
      try {
        await auth(new OAuthProvider(connection, flow.data, flow), { serverUrl: connection.url, authorizationCode: code, fetchFn: oauthFetch(this.connections.fetch, connection.url) });
      } catch { throw invalid("OAuth token exchange failed. Start sign-in again; check the registered callback URL if it keeps failing."); }
      const saved = await this.connections.update(flow.id, flow.revision, current => {
        if (this.attempts.get(flow.id)?.state !== flow.state) throw invalid("Sign-in was cancelled or replaced. No new credentials were saved.");
        return { ...current, oauth: flow.data, authGeneration: nonce(), revision: current.revision + 1, health: { status: "unverified", message: "Signed in. Test connection to verify access and discover tools." } };
      }, { guard: () => this.attempts.get(flow.id)?.state === flow.state });
      if (this.attempts.get(flow.id)?.state === flow.state) this.attempts.set(flow.id, { id: flow.attemptId, status: "complete", message: "Signed in. Verify access before selecting the connection in an environment." });
      return saved;
    } catch (error) {
      if (this.attempts.get(flow.id)?.state === flow.state) this.attempts.set(flow.id, { id: flow.attemptId, status: "failed", message: error.statusCode ? error.message : "OAuth sign-in failed. Start again from MCP connections." });
      throw error;
    }
  }
  async disconnect(id) {
    const c = await this.connections.get(id);
    this.forget(id);
    return this.connections.update(id, c.revision, ({ oauth, ...current }) => ({ ...current, authGeneration: nonce(), revision: current.revision + 1, health: { status: "needs_auth", message: "Disconnected. Sign in to enable access again." } }));
  }
  async accessDenied(connection) {
    const current = await this.connections.get(connection.id);
    if (current.authGeneration !== connection.authGeneration) return;
    await this.connections.update(current.id, current.revision, value => ({ ...value, health: { status: "needs_auth", checkedAt: new Date().toISOString(), message: "The provider rejected this connection. Reconnect and check workspace permissions; no other account was used." } }));
  }
  async headers(connection) {
    if (connection.authMode !== "oauth") return new Headers(connection.headers || {});
    // A guarded credential write may be rolling back after cancellation. Never
    // hand a worker tokens from that provisional database state.
    await this.connections.queue;
    let current = await this.connections.get(connection.id);
    if (current.authGeneration !== connection.authGeneration || !current.oauth?.tokens) throw loginRequired();
    if (current.oauth.expiresAt !== null && current.oauth.expiresAt <= Date.now() + 30000) {
      let refresh = this.refreshes.get(current.id);
      if (!refresh) {
        refresh = this.refresh(current).finally(() => this.refreshes.delete(current.id));
        this.refreshes.set(current.id, refresh);
      }
      await refresh; current = await this.connections.get(connection.id);
    }
    if (current.authGeneration !== connection.authGeneration || !current.oauth?.tokens) throw loginRequired();
    return new Headers({ Authorization: `Bearer ${current.oauth.tokens.access_token}` });
  }
  async refresh(connection) {
    const data = structuredClone(connection.oauth), discovery = data.discovery;
    if (!data.tokens?.refresh_token) { await this.accessDenied(connection); throw loginRequired(); }
    const provider = new OAuthProvider(connection, data);
    try {
      const tokens = await refreshAuthorization(discovery.authorizationServerUrl, { metadata: discovery.authorizationServerMetadata, clientInformation: data.clientInformation, refreshToken: data.tokens.refresh_token, resource: await selectResourceURL(connection.url, provider, discovery.resourceMetadata), fetchFn: oauthFetch(this.connections.fetch, connection.url) });
      provider.saveTokens(tokens);
      await this.connections.update(connection.id, connection.revision, current => ({ ...current, oauth: data }));
    } catch { await this.accessDenied(connection).catch(() => {}); throw loginRequired(); }
  }
}
