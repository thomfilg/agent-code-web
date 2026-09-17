import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

function digest(token) {
  return createHash("sha256").update(token).digest();
}

export class CapabilityBroker {
  #entries = new Map();

  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
  }

  issue({ chatId, provider }) {
    this.revokeChat(chatId);
    const token = `cap_${randomBytes(32).toString("base64url")}`;
    const hash = digest(token);
    this.#entries.set(hash.toString("hex"), {
      hash,
      chatId,
      provider,
      expiresAt: Date.now() + this.ttlMs,
      observers: new Set(),
    });
    return token;
  }

  validate(token, provider) {
    if (!token || typeof token !== "string") return null;
    const candidate = digest(token);
    const entry = this.#entries.get(candidate.toString("hex"));
    if (!entry || entry.provider !== provider || entry.expiresAt <= Date.now()) return null;
    if (!timingSafeEqual(candidate, entry.hash)) return null;
    return { chatId: entry.chatId, provider: entry.provider, expiresAt: entry.expiresAt };
  }

  revokeChat(chatId) {
    for (const [key, entry] of this.#entries) {
      if (entry.chatId === chatId) this.#entries.delete(key);
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
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }

  get size() {
    this.prune();
    return this.#entries.size;
  }
}
