import assert from "node:assert/strict";
import test from "node:test";
import { BrowserAuth } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";

test("non-loopback binding requires UI authentication", () => {
  assert.throws(() => loadConfig({ AGENT_WEB_HOST: "0.0.0.0" }), /AUTH_TOKEN is required/);
  assert.equal(loadConfig({ AGENT_WEB_HOST: "0.0.0.0", AGENT_WEB_AUTH_TOKEN: "private" }).host, "0.0.0.0");
});

test("browser authentication uses a signed HttpOnly cookie", () => {
  const auth = new BrowserAuth({ token: "private" });
  assert.equal(auth.acceptsToken("wrong"), false);
  const cookie = auth.createCookie();
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const request = { headers: { cookie: cookie.split(";")[0] } };
  assert.equal(auth.authenticated(request), true);
  assert.equal(auth.authenticated({ headers: { cookie: "agent_web_session=forged" } }), false);
  assert.equal(auth.authenticated({ headers: { cookie: "agent_web_session=%invalid" } }), false);
  assert.equal(auth.authenticated({ headers: { cookie: request.headers.cookie + "; unrelated=%invalid" } }), true);
});
