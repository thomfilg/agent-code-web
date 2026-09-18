import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createAgentWebServer } from "../src/server.mjs";
import { googleOidcFixture, googleTestEnv } from "./fixtures/google-oidc.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const origin = "https://relay.fixture.example";

async function fixture(t) {
  const provider = googleOidcFixture(), directory = await temporaryDirectory(t);
  const app = await createAgentWebServer({ config: testConfig(directory, {
    ...googleTestEnv, AGENT_WEB_PUBLIC_URL: origin, AUTH_SECRET: "private-synthetic-origin-fixture-".repeat(2),
  }), googleAuthOptions: { fetchImpl: provider.fetch } });
  const { url } = await app.start();
  t.after(() => app.stop());
  return { app, provider, url };
}

function client(f, prefix = "") {
  const cookies = new Map(), observedCookies = [];
  return {
    observedCookies,
    request(path, { method = "GET", body, requestOrigin = origin } = {}) {
      return new Promise((resolve, reject) => {
        const target = new URL(f.url);
        const req = http.request({ hostname: target.hostname, port: Number(target.port),
          path: prefix + path, method, agent: false,
          headers: { host: "untrusted-host.example:9999", forwarded: 'host="forwarded.example";proto=http',
            "x-forwarded-host": "forwarded.example", "x-forwarded-proto": "http",
            cookie: [...cookies].map(([key, value]) => key + "=" + value).join("; "),
            ...(method === "POST" ? { origin: requestOrigin, "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" } : {}),
          } }, response => {
          const chunks = [];
          response.on("data", chunk => chunks.push(chunk)); response.once("error", reject);
          response.once("end", () => {
            for (const cookie of response.headers["set-cookie"] || []) {
              observedCookies.push(cookie);
              const pair = cookie.split(";", 1)[0], index = pair.indexOf("=");
              if (/Max-Age=0/i.test(cookie)) cookies.delete(pair.slice(0, index));
              else cookies.set(pair.slice(0, index), pair.slice(index + 1));
            }
            resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() });
          });
        });
        req.once("error", reject); req.end(body);
      });
    },
  };
}

test("shared auth factory pins OAuth and cookie security to configured origin despite absolute-form URL and forged Host", async t => {
  const f = await fixture(t);
  for (const prefix of ["", "https://absolute.example", "http://absolute.example:9000", "//absolute.example"]) {
    const browser = client(f, prefix);
    const csrf = await browser.request("/api/auth/csrf"); assert.equal(csrf.status, 200);
    const start = await browser.request("/api/auth/signin/google", { method: "POST",
      body: new URLSearchParams({ csrfToken: JSON.parse(csrf.text).csrfToken, callbackUrl: "https://redirect.example/private" }).toString() });
    assert.equal(start.status, 200);
    const authorization = new URL(JSON.parse(start.text).url);
    assert.equal(authorization.origin, "https://accounts.google.com");
    assert.equal(authorization.searchParams.get("redirect_uri"), origin + "/api/auth/callback/google");
    const callback = new URL(f.provider.approve(authorization.href));
    const result = await browser.request(callback.pathname + callback.search);
    assert.equal(result.status, 302); assert.equal(result.headers.location, origin + "/");
    const session = await browser.request("/api/auth/session");
    assert.equal(session.status, 200); assert.equal(JSON.parse(session.text).user.email, "owner@example.com");
    assert.ok(browser.observedCookies.some(value => value.startsWith("__Host-relay.auth.sessionToken=")));
    for (const cookie of browser.observedCookies) {
      assert.match(cookie, /^__Host-relay\.auth\./); assert.match(cookie, /; Secure(?:;|$)/i);
      assert.match(cookie, /; HttpOnly(?:;|$)/i); assert.doesNotMatch(cookie, /; Domain=/i);
      assert.doesNotMatch(cookie, /absolute\.example|untrusted-host\.example|forwarded\.example|redirect\.example/);
    }
  }
  assert.equal((await f.app.records.list("relay-user")).length, 1, "synthetic immutable subject only");
  assert.ok(f.provider.requests.every(path => ["/.well-known/openid-configuration", "/token", "/jwks"].includes(path)));
});

test("absolute-form auth requests do not bypass exact POST Origin or CSRF checks", async t => {
  const f = await fixture(t), browser = client(f, "https://absolute.example");
  const csrf = JSON.parse((await browser.request("/api/auth/csrf")).text).csrfToken;
  const wrongOrigin = await browser.request("/api/auth/signin/google", { method: "POST", requestOrigin: "https://absolute.example",
    body: new URLSearchParams({ csrfToken: csrf }).toString() });
  assert.equal(wrongOrigin.status, 403);
  const wrongCsrf = await browser.request("/api/auth/signin/google", { method: "POST", body: "csrfToken=incorrect" });
  assert.equal(new URL(JSON.parse(wrongCsrf.text).url).origin, origin);
  assert.equal(f.provider.requests.length, 0);
  assert.equal((await f.app.records.list("relay-user")).length, 0);
  assert.equal((await f.app.records.list("relay-session")).length, 0);
});
