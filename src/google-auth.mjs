import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createApiAuth, Google, customFetch } from "../.generated/shared-auth.mjs";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const emailOf = value => String(value || "").trim().toLowerCase();
const userId = subject => `user_${createHash("sha256").update(`google:${subject}`).digest("hex").slice(0, 32)}`;
const publicUser = user => user ? { id: user.id, username: user.email, email: user.email, name: user.name, provider: "google" } : null;
const lifetime = 30 * 86400;

export function sameOriginRedirect(value, origin) {
  try {
    const url = new URL(value, origin);
    return url.origin === origin && !url.username && !url.password ? url.href : origin + "/";
  } catch { return origin + "/"; }
}

/** Relay identity/storage adapter. OAuth, PKCE, CSRF and cookies belong to the
 * tested @12-apps/auth server factory, not another home-grown login protocol. */
export class GoogleAuth {
  constructor(records, config, { fetchImpl, now = Date.now, onSignOut = async () => {} } = {}) {
    this.records = records; this.config = config; this.enabled = config.enabled;
    this.now = now; this.fetch = fetchImpl; this.onSignOut = onSignOut;
    this.revoked = new Map();
    this.queue = Promise.resolve(); this.legacyOwnerId = null;
  }
  async initialize() {
    if (!this.enabled) return;
    this.api = null;
    this.legacyOwnerId = (await this.records.get("relay-auth", "legacy-owner"))?.ownerId || null;
    const { clientId, clientSecret, origin, ownerEmail } = this.config;
    this.missing = [!clientId && "GOOGLE_CLIENT_ID", !clientSecret && "GOOGLE_CLIENT_SECRET", !origin && "AGENT_WEB_PUBLIC_URL", !ownerEmail && "AGENT_OWNER_EMAIL"].filter(Boolean);
    if (this.missing.length) return;
    let secret = this.config.secret || (await this.records.get("relay-auth", "session-secret"))?.value;
    if (!secret) {
      secret = randomBytes(48).toString("base64url");
      await this.records.put("relay-auth", "session-secret", { value: secret });
    }
    this.api = createApiAuth({
      secret, authUrl: origin, basePath: "/api/auth", trustHost: true,
      providers: [Google({ clientId, clientSecret,
        checks: ["pkce", "state", "nonce"],
        authorization: { params: { scope: "openid email profile", prompt: "select_account" } },
        ...(this.fetch ? { [customFetch]: this.fetch } : {}),
      })],
      signInPage: "/", adminEmails: [], sessionAdmin: () => false, maxAge: lifetime,
      signInGate: ({ email, provider }) => provider === "google" && this.allowedEmail(email),
    });
    // Other Auth.js apps may run on localhost on another port. Cookies are not
    // port-scoped: use Relay names so login/sign-out cannot replace theirs.
    const prefix = origin.startsWith("https:") ? "__Host-" : "";
    this.api.config.cookies = Object.fromEntries(["sessionToken", "callbackUrl", "csrfToken", "pkceCodeVerifier", "state", "nonce"].map(name => [name, { name: `${prefix}relay.auth.${name}` }]));
    // Host-owned identity is Google's immutable subject, never a display name,
    // an email match to a password account, or Auth.js's random transient ID.
    const callbacks = { ...this.api.config.callbacks };
    this.api.config.callbacks.signIn = async input => {
      if (input.account?.provider !== "google" || input.profile?.email_verified !== true ||
          typeof input.profile?.sub !== "string" || !input.profile.sub || input.profile.sub.length > 255 ||
          input.account.providerAccountId !== input.profile.sub) return false;
      return callbacks.signIn(input);
    };
    this.api.config.callbacks.jwt = async input => {
      const token = await callbacks.jwt(input);
      if (input.account) {
        const user = await this.saveIdentity(input.profile);
        token.id = user.id; token.sub = user.id; token.email = user.email;
        token.name = user.name; delete token.picture;
        token.relaySessionId = randomUUID();
        token.relayExpiresAt = this.now() + lifetime * 1000;
        for (const old of await this.records.list("relay-session")) if (old.expiresAt <= this.now()) await this.records.delete("relay-session", old.id);
        await this.records.put("relay-session", token.relaySessionId, { id: token.relaySessionId, ownerId: user.id, expiresAt: token.relayExpiresAt });
      }
      return token;
    };
    this.api.config.callbacks.session = async input => {
      const session = await callbacks.session(input);
      const saved = await this.records.get("relay-session", input.token.relaySessionId || "");
      const user = saved && await this.records.get("relay-user", saved.ownerId);
      if (!user || saved.ownerId !== input.token.id || saved.expiresAt <= this.now() || !this.allowedEmail(user.email)) return null;
      return { user: publicUser(user), expires: new Date(saved.expiresAt).toISOString(), relaySessionId: saved.id };
    };
    this.api.config.callbacks.redirect = ({ url }) => sameOriginRedirect(url, origin);
    this.api.config.events = { signOut: async ({ token }) => {
      const saved = token?.relaySessionId && await this.records.get("relay-session", token.relaySessionId);
      if (!saved) return;
      await this.revoke({ id: saved.ownerId, sessionId: saved.id, expiresAt: saved.expiresAt });
    } };
    // Do not log provider responses, codes, tokens or user data, even when the
    // host environment happens to have AUTH_DEBUG set for another application.
    this.api.config.debug = false;
    this.api.config.logger = { error: () => {}, warn: () => {}, debug: () => {} };
  }
  allowedEmail(email) {
    const normalized = emailOf(email);
    return normalized === this.config.ownerEmail || this.config.allowedEmails.includes(normalized);
  }
  saveIdentity(profile) {
    const operation = this.queue.then(async () => {
      const id = userId(profile.sub), old = await this.records.get("relay-user", id);
      const user = { id, subject: profile.sub, email: emailOf(profile.email), name: String(profile.name || "").slice(0, 200), createdAt: old?.createdAt || this.now() };
      await this.records.put("relay-user", id, user);
      if (!this.legacyOwnerId && user.email === this.config.ownerEmail) {
        await this.records.put("relay-auth", "legacy-owner", { ownerId: id });
        this.legacyOwnerId = id;
      }
      return user;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  info() {
    return { enabled: this.enabled, configured: Boolean(this.api), missing: this.missing || [], callbackUrl: this.config.origin ? `${this.config.origin}/api/auth/callback/google` : null, origin: this.config.origin || null };
  }
  request(request, body) {
    // Never derive OAuth redirects or cookie security from untrusted forwarded
    // headers. Only the operator-configured public origin is authoritative.
    const headers = new Headers();
    for (const key of ["cookie", "content-type", "x-auth-return-redirect"]) if (request.headers[key]) headers.set(key, request.headers[key]);
    return new Request(new URL(request.url || "/", this.config.origin), { method: request.method || "GET", headers, ...(body !== undefined ? { body } : {}) });
  }
  async session(request) {
    if (!this.api) return null;
    const session = await this.api.auth(this.request({ url: request.url, headers: request.headers, method: "GET" }));
    return session ? { ...session.user, sessionId: session.relaySessionId, expiresAt: Date.parse(session.expires) } : null;
  }
  async logout(request) {
    const user = await this.session(request);
    if (user) await this.revoke(user);
    return user;
  }
  async revoke(user) {
    this.revoked.set(user.sessionId, user.expiresAt);
    for (const [id, expiry] of this.revoked) if (expiry <= this.now()) this.revoked.delete(id);
    // In-memory browser/preview capabilities must end before potentially slow
    // database persistence. Await both operations without an unhandled rejection.
    await Promise.all([Promise.resolve(this.onSignOut(user)), this.records.delete("relay-session", user.sessionId)]);
  }
  public(user) { return publicUser(user); }
  require(user) { if (!user) throw fail("Sign in with Google first", 401); return user; }
  canRead(chat, user) {
    return Boolean(user && !this.revoked.has(user.sessionId) && user.expiresAt > this.now() && chat && (chat.ownerId ? chat.ownerId === user.id : user.id === this.legacyOwnerId));
  }
  isOwner(user) { return Boolean(user && user.id === this.legacyOwnerId); }
  async handle(request, response, url) {
    if (!this.enabled || !url.pathname.startsWith("/api/auth/")) return false;
    const action = url.pathname.slice("/api/auth/".length);
    const allowed = request.method === "GET" ? ["csrf", "session", "callback/google"] : request.method === "POST" ? ["signin/google", "signout"] : [];
    const reply = (status, data) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(data)); return true; };
    if (!allowed.includes(action)) return reply(404, { error: "Authentication route not found" });
    if (!this.api) return reply(503, { error: "Google sign-in is not configured", ...this.info() });
    if (request.method === "POST") {
      if (request.headers.origin !== this.config.origin) return reply(403, { error: "Cross-origin sign-in rejected" });
      if (!String(request.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) return reply(415, { error: "Sign-in requires a form submission" });
    }
    if (action === "session") return reply(200, { user: this.public(await this.session(request)) });
    let body;
    if (request.method === "POST") {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 8192) return reply(413, { error: "Sign-in form is too large" }); chunks.push(chunk); }
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      form.set("callbackUrl", sameOriginRedirect(form.get("callbackUrl") || "/", this.config.origin));
      body = form.toString();
    }
    const previous = action === "callback/google" ? await this.session(request) : null;
    const result = await this.api.handler(this.request(request, body));
    const cookies = result.headers.getSetCookie();
    const sessionCookie = this.api.config.cookies.sessionToken.name;
    if (previous && cookies.some(cookie => (cookie.startsWith(sessionCookie + "=") || cookie.startsWith(sessionCookie + ".")) && !/Max-Age=0/i.test(cookie))) {
      await this.revoke(previous);
    }
    response.statusCode = result.status;
    for (const [name, value] of result.headers) if (name !== "set-cookie" && name !== "content-security-policy") response.setHeader(name, value);
    if (cookies.length) response.setHeader("set-cookie", cookies);
    response.setHeader("cache-control", "no-store");
    response.end(Buffer.from(await result.arrayBuffer())); return true;
  }
}
