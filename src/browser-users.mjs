import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const cookieName = "relay_browser_identity";
const hash = value => createHash("sha256").update(value).digest("hex");
const publicUser = user => user ? { id: user.id, username: user.username } : null;
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function sessionToken(request) {
  const raw = (request.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  return raw && /^[\w-]{43}$/.test(raw) ? raw : null;
}

export class BrowserUsers {
  constructor(records, { secure = false, now = Date.now } = {}) { this.records = records; this.secure = secure; this.now = now; this.queue = Promise.resolve(); this.attempts = new Map(); this.busy = 0; }
  cookie(token = "") { return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 30 * 86400 : 0}${this.secure ? "; Secure" : ""}`; }
  credentials(input) {
    const username = String(input.username || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(username)) throw error("Username must have 3–40 letters, numbers, dots, hyphens or underscores");
    if (typeof input.password !== "string" || input.password.length < 12 || input.password.length > 1024) throw error("Use a password with 12–1,024 characters");
    return { username, password: input.password };
  }
  limit(address) {
    const now = this.now();
    for (const [key, item] of this.attempts) if (item.until <= now) this.attempts.delete(key);
    if (this.attempts.size > 2000 || this.busy >= 8) throw error("Sign-in is busy. Try again shortly.", 429);
    const item = this.attempts.get(address) || { count: 0, until: now + 15 * 60000 };
    if (++item.count > 20) throw error("Too many sign-in attempts. Try again in 15 minutes.", 429);
    this.attempts.set(address, item);
  }
  async passwordHash(password, salt) {
    this.busy++;
    try { return Buffer.from(await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString("hex"); }
    finally { this.busy--; }
  }
  async register(input, address = "local") {
    this.limit(address); const { username, password } = this.credentials(input);
    const pending = this.queue.then(async () => {
      if (await this.records.get("browser-user", username)) throw error("That username is already registered", 409);
      const salt = randomBytes(24).toString("hex");
      const user = { id: `user_${randomUUID()}`, username, salt, passwordHash: await this.passwordHash(password, salt), createdAt: this.now() };
      await this.records.put("browser-user", username, user);
      return this.startSession(user);
    });
    this.queue = pending.catch(() => {}); return pending;
  }
  async login(input, address = "local") {
    this.limit(address); const { username, password } = this.credentials(input);
    const user = await this.records.get("browser-user", username);
    const candidate = await this.passwordHash(password, user?.salt || "0".repeat(48));
    if (!user || !timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(user.passwordHash, "hex"))) throw error("Invalid username or password", 401);
    return this.startSession(user);
  }
  async startSession(user) {
    const token = randomBytes(32).toString("base64url");
    const sessions = await this.records.list("browser-user-session");
    for (const session of sessions) if (session.expiresAt <= this.now()) await this.records.delete("browser-user-session", session.id);
    // Bound persistent session storage without reusing or exposing a token.
    const owned = sessions.filter(session => session.ownerId === user.id).sort((a, b) => b.createdAt - a.createdAt);
    for (const session of owned.slice(9)) await this.records.delete("browser-user-session", session.id);
    const id = hash(token);
    await this.records.put("browser-user-session", id, { id, ownerId: user.id, username: user.username, createdAt: this.now(), expiresAt: this.now() + 30 * 86400000 });
    return { user: publicUser(user), cookie: this.cookie(token) };
  }
  async session(request) {
    const token = sessionToken(request); if (!token) return null;
    const saved = await this.records.get("browser-user-session", hash(token));
    if (!saved || saved.expiresAt <= this.now()) return null;
    return { id: saved.ownerId, username: saved.username, sessionId: saved.id, expiresAt: saved.expiresAt };
  }
  async logout(request) {
    const user = await this.session(request), token = sessionToken(request);
    if (token) await this.records.delete("browser-user-session", hash(token));
    return user;
  }
  public(user) { return publicUser(user); }
  canRead(chat, user) { return Boolean(chat && (!chat.ownerId || chat.ownerId === user?.id && (!user.expiresAt || user.expiresAt > this.now()))); }
  require(user) { if (!user) throw error("Sign in to your private browser account first", 401); return user; }
}
