import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

export const googleTestEnv = {
  AGENT_GOOGLE_AUTH: "1", AGENT_WEB_PUBLIC_URL: "http://127.0.0.1:8879",
  GOOGLE_CLIENT_ID: "relay-fixture.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "fixture-google-client-secret",
  AGENT_OWNER_EMAIL: "owner@example.com", AGENT_ALLOWED_EMAILS: "member@example.com",
};

// A signed OIDC provider behind Auth.js's documented customFetch boundary.
// The real Google provider / PKCE / state / nonce / callback / session code is
// exercised, but this fixture cannot contact Google or authorize any account.
export function googleOidcFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" };
  const codes = new Map(); const requests = [];
  const issuer = "https://accounts.google.com";
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    requests,
    approve(authorization, profile = { sub: "google-owner", email: "owner@example.com", email_verified: true, name: "Relay Owner" }) {
      const url = new URL(authorization), params = url.searchParams;
      assert.equal(url.origin, issuer); assert.equal(params.get("client_id"), googleTestEnv.GOOGLE_CLIENT_ID);
      assert.equal(params.get("scope"), "openid email profile"); assert.equal(params.get("code_challenge_method"), "S256");
      assert.ok(params.get("state")); assert.ok(params.get("nonce"));
      const code = randomUUID(); codes.set(code, { params, profile });
      const callback = new URL(params.get("redirect_uri"));
      callback.searchParams.set("code", code); callback.searchParams.set("state", params.get("state"));
      return callback.href;
    },
    async fetch(input, options) {
      const request = new Request(input, options), url = new URL(request.url);
      requests.push(url.pathname);
      if (url.href === `${issuer}/.well-known/openid-configuration`) return Response.json({
        issuer, authorization_endpoint: `${issuer}/o/oauth2/v2/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"], code_challenge_methods_supported: ["S256"],
      });
      if (url.href === `${issuer}/jwks`) return Response.json({ keys: [key] });
      if (url.href === `${issuer}/token`) {
        const form = new URLSearchParams(await request.text());
        const code = codes.get(form.get("code")); codes.delete(form.get("code"));
        if (!code || createHash("sha256").update(form.get("code_verifier") || "").digest("base64url") !== code.params.get("code_challenge") || form.get("redirect_uri") !== code.params.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const basic = "Basic " + Buffer.from(`${googleTestEnv.GOOGLE_CLIENT_ID}:${googleTestEnv.GOOGLE_CLIENT_SECRET}`).toString("base64");
        assert.ok(request.headers.get("authorization") === basic || form.get("client_id") === googleTestEnv.GOOGLE_CLIENT_ID && form.get("client_secret") === googleTestEnv.GOOGLE_CLIENT_SECRET);
        const now = Math.floor(Date.now() / 1000);
        const unsigned = `${encode({ alg: "RS256", kid: "fixture" })}.${encode({ iss: issuer, aud: googleTestEnv.GOOGLE_CLIENT_ID, iat: now, exp: now + 300, nonce: code.params.get("nonce"), ...code.profile })}`;
        const token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
        return Response.json({ access_token: "fixture-google-access-token", token_type: "Bearer", expires_in: 300, id_token: token });
      }
      throw new Error(`Unexpected fixture provider request: ${url.origin}${url.pathname}`);
    },
  };
}

export function cookieClient(origin) {
  const cookies = new Map();
  return {
    cookies,
    header() { return [...cookies].map(([name, value]) => `${name}=${value}`).join("; "); },
    async request(path, options = {}) {
      const response = await fetch(new URL(path, origin), { ...options, redirect: "manual", headers: { cookie: this.header(), ...(options.method && options.method !== "GET" ? { origin } : {}), ...options.headers } });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0], split = pair.indexOf("=");
        if (/Max-Age=0/i.test(cookie)) cookies.delete(pair.slice(0, split));
        else cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      return response;
    },
    async authAction(action, extra = {}) {
      const csrf = await (await this.request("/api/auth/csrf")).json();
      return this.request(`/api/auth/${action}`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: origin + "/", ...extra }) });
    },
    async login(fixture, profile) {
      const start = await this.authAction("signin/google");
      assert.equal(start.status, 200);
      const callback = fixture.approve((await start.json()).url, profile);
      const result = await this.request(callback);
      assert.equal(result.status, 302);
      assert.equal(new URL(result.headers.get("location")).searchParams.get("error"), null);
      return (await (await this.request("/api/auth")).json()).user;
    },
  };
}
