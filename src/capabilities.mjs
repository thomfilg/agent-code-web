import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

function digest(token) {
  return createHash("sha256").update(token).digest();
}
const hashPattern = /^[a-f0-9]{64}$/;

export class CapabilityBroker {
  #entries = new Map();

  constructor({ ttlMs, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  issue({ chatId, provider, renewable = false, validWhile = null }) {
    if (renewable && typeof validWhile !== "function") throw new Error("Renewable capabilities require a controller-owned scope guard");
    this.revokeChat(chatId);
    const token = `cap_${randomBytes(32).toString("base64url")}`;
    const hash = digest(token);
    const key = hash.toString("hex"), entry = {
      hash,
      chatId,
      provider,
      expiresAt: this.now() + this.ttlMs,
      validWhile,
      observers: new Set(),
    };
    this.#entries.set(key, entry);
    if (renewable) {
      // Only the owning controller renews a live lease. Worker traffic cannot
      // extend it, resurrect an expired token or cross a revoked scope.
      entry.timer = setInterval(() => {
        if (this.#entries.get(key) !== entry || !this.#live(key, entry)) return;
        entry.expiresAt = this.now() + this.ttlMs;
      }, Math.max(1, Math.floor(this.ttlMs / 3)));
      entry.timer.unref?.();
    }
    return token;
  }

  snapshotHash(chatId, provider) {
    const matches = [];
    for (const [key, entry] of this.#entries) if (entry.chatId === chatId && entry.provider === provider && this.#live(key, entry)) matches.push(key);
    if (matches.length > 1) throw new Error("Capability scope is ambiguous");
    return matches[0] || null;
  }

  restoreHash({ hash, chatId, provider, renewable = false, validWhile = null }) {
    if (!hashPattern.test(hash || "")) throw new Error("Capability checkpoint hash is invalid");
    if (renewable && typeof validWhile !== "function") throw new Error("Renewable capabilities require a controller-owned scope guard");
    const existing = this.#entries.get(hash);
    if (existing && this.#live(hash, existing) && (existing.chatId !== chatId || existing.provider !== provider)) {
      throw new Error("Capability checkpoint is already owned by another scope");
    }
    this.revokeChat(chatId);
    const bytes = Buffer.from(hash, "hex"), entry = { hash: bytes, chatId, provider,
      expiresAt: this.now() + this.ttlMs, validWhile, observers: new Set() };
    this.#entries.set(hash, entry);
    if (renewable) {
      entry.timer = setInterval(() => {
        if (this.#entries.get(hash) !== entry || !this.#live(hash, entry)) return;
        entry.expiresAt = this.now() + this.ttlMs;
      }, Math.max(1, Math.floor(this.ttlMs / 3)));
      entry.timer.unref?.();
    }
    return hash;
  }

  restoreToken({ token, chatId, provider, renewable = false, validWhile = null }) {
    if (!/^cap_[A-Za-z0-9_-]{43}$/.test(token || "")) throw new Error("Capability checkpoint token is invalid");
    this.restoreHash({ hash: digest(token).toString("hex"), chatId, provider, renewable, validWhile });
    return token;
  }

  validateHash(hash, provider) {
    if (!hashPattern.test(hash || "")) return null;
    const entry = this.#entries.get(hash);
    if (!entry || entry.provider !== provider || !this.#live(hash, entry)) return null;
    return { chatId: entry.chatId, provider: entry.provider, expiresAt: entry.expiresAt };
  }

  validate(token, provider) {
    if (!token || typeof token !== "string") return null;
    const candidate = digest(token);
    const key = candidate.toString("hex"), entry = this.#entries.get(key);
    if (!entry || entry.provider !== provider || !this.#live(key, entry)) return null;
    if (!timingSafeEqual(candidate, entry.hash)) return null;
    return { chatId: entry.chatId, provider: entry.provider, expiresAt: entry.expiresAt };
  }

  #live(key, entry) {
    let allowed = entry.expiresAt > this.now();
    try { if (allowed && entry.validWhile) allowed = entry.validWhile() === true; }
    catch { allowed = false; }
    if (!allowed) this.#remove(key, entry);
    return allowed;
  }

  #remove(key, entry) {
    clearInterval(entry.timer);
    entry.observers.clear();
    this.#entries.delete(key);
  }

  revoke(token) {
    if (!token || typeof token !== "string") return;
    const key = digest(token).toString("hex"), entry = this.#entries.get(key);
    if (entry) this.#remove(key, entry);
  }

  revokeChat(chatId) {
    for (const [key, entry] of this.#entries) {
      if (entry.chatId === chatId) this.#remove(key, entry);
    }
  }

  observeProvider(token, provider, listener) {
    if (!this.validate(token, provider)) throw new Error("The worker capability expired before observation could start");
    const entry = this.#entries.get(digest(token).toString("hex"));
    entry.observers.add(listener);
    return () => entry.observers.delete(listener);
  }

  captureProviderObserver(token, provider) {
    if (!this.validate(token, provider)) return () => {};
    const entry = this.#entries.get(digest(token).toString("hex")), listeners = [...entry.observers];
    // Bind the response to observers present at REQUEST start. A late response
    // cannot affect a later turn using the same capability, or a revoked one.
    return value => {
      if (!this.validate(token, provider)) return;
      for (const listener of listeners) if (entry.observers.has(listener)) { try { listener(value); } catch { /* Observers must not break provider forwarding. */ } }
    };
  }

  prune() {
    for (const [key, entry] of this.#entries) this.#live(key, entry);
  }

  get size() {
    this.prune();
    return this.#entries.size;
  }
}
