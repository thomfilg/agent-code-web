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
