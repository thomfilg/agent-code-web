import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "agent_web_session";

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function equal(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return [part.trim(), ""];
    let value; try { value = decodeURIComponent(part.slice(index + 1)); } catch { value = ""; }
    return [part.slice(0, index).trim(), value];
  }).filter(([name]) => name));
}

export class BrowserAuth {
  constructor({ token, secure = false, maxAgeSeconds = 604_800 }) {
    this.token = token;
    this.secure = secure;
    this.maxAgeSeconds = maxAgeSeconds;
  }

  get required() {
    return Boolean(this.token);
  }

  acceptsToken(candidate) {
    return !this.required || equal(candidate, this.token);
  }

  createCookie() {
    const issuedAt = Math.floor(Date.now() / 1000);
    const value = `${issuedAt}.${randomBytes(12).toString("base64url")}`;
    const session = `${value}.${sign(value, this.token)}`;
    return `${COOKIE_NAME}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.maxAgeSeconds}${this.secure ? "; Secure" : ""}`;
  }

  clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secure ? "; Secure" : ""}`;
  }

  authenticated(request) {
    if (!this.required) return true;
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || "")?.[1];
    if (bearer && this.acceptsToken(bearer)) return true;
    const session = cookies(request.headers.cookie)[COOKIE_NAME] || "";
    const [issuedAt, nonce, signature] = session.split(".");
    if (!issuedAt || !nonce || !signature) return false;
    const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
    if (!Number.isFinite(age) || age < 0 || age > this.maxAgeSeconds) return false;
    return equal(signature, sign(`${issuedAt}.${nonce}`, this.token));
  }
}
