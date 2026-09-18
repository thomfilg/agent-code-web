import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";

const fields = ["ownerId", "sessionId", "chatId", "hostname", "port", "runtimeGeneration"];
const prefixes = { ticket: "pbt_", grant: "psg_" };
const id = value => typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9_.:-]/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const digest = token => createHash("sha256").update(token).digest();

export class PreviewGrantError extends Error {
  constructor() { super("Preview access is unavailable."); this.name = "PreviewGrantError"; }
}
const deny = () => { throw new PreviewGrantError(); };

function hostname(value) {
  if (!(typeof value === "string" && value.length <= 253 && value === value.toLowerCase() && !isIP(value) &&
    value.includes(".") && !value.endsWith(".localhost") && !value.endsWith(".local") &&
    value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) return false;
  try {
    // URL parsers also recognize abbreviated/hex/octal IPv4 forms that isIP
    // does not. Assigned DNS names must survive canonical HTTPS URL parsing.
    const parsed = new URL(`https://${value}`);
    return parsed.hostname === value && !isIP(parsed.hostname);
  } catch { return false; }
}

function binding(input) {
  // Controller-owned plain primitives only; do not invoke supplied accessors,
  // retain mutable objects or accidentally retain extra private fields.
  try {
    if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) deny();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) deny();
    const values = {};
    for (const field of fields) {
      const property = Object.getOwnPropertyDescriptor(input, field);
      if (!property || !Object.hasOwn(property, "value")) deny();
      values[field] = property.value;
    }
    if (![values.ownerId, values.sessionId, values.chatId].every(id) || !hostname(values.hostname) ||
        !integer(values.port, 1024, 65535) || !(id(values.runtimeGeneration) || integer(values.runtimeGeneration, 0, Number.MAX_SAFE_INTEGER))) deny();
    return Object.freeze(values);
  } catch { deny(); }
}

/** Dormant, server-only primitive. It creates no routes, cookies or listeners.
 * isCurrent must synchronously validate controller-owned assignment + identity.
 * Callers must revoke on subsequent lifecycle changes to abort active leases.
 */
export class PreviewGrants {
  #entries = new Map();
  #closed = false;
  #isCurrent;
  #now;
  #lastTime = -Infinity;
  #ticketTtl;
  #grantTtl;
  #maxEntries;
  #maxPerOwner;
  #checking = false;
  #revoking = 0;

  constructor({ isCurrent, now = () => performance.timeOrigin + performance.now(),
    ticketTtlMs = 60000, grantTtlMs = 300000, maxEntries = 1024, maxPerOwner = 64 } = {}) {
    if (typeof isCurrent !== "function" || typeof now !== "function" ||
        !integer(ticketTtlMs, 1, 60000) || !integer(grantTtlMs, 1, 300000) ||
        !integer(maxEntries, 1, 10000) || !integer(maxPerOwner, 1, maxEntries)) deny();
    this.#isCurrent = isCurrent; this.#now = now;
    this.#ticketTtl = ticketTtlMs; this.#grantTtl = grantTtlMs;
    this.#maxEntries = maxEntries; this.#maxPerOwner = maxPerOwner;
  }

  #time() {
    let now;
    try { now = this.#now(); } catch { this.close(); deny(); }
    // A custom/regressing clock must not extend access indefinitely.
    if (typeof now !== "number" || !Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 300000 || now < this.#lastTime) {
      this.close(); deny();
    }
    this.#lastTime = now; return now;
  }

  #drop(entry) {
    if (this.#entries.get(entry.key) !== entry) return false;
    this.#entries.delete(entry.key); clearTimeout(entry.timer);
    entry.controller.abort(); return true;
  }

  #current(entry) {
    if (this.#closed || this.#entries.get(entry.key) !== entry) return false;
    if (entry.expiresAt <= this.#time()) { this.#drop(entry); return false; }
    let allowed = false;
    try {
      this.#checking = true;
      const result = this.#isCurrent(entry.binding);
      allowed = result === true;
      // Async guards are not admitted. Consume a rejected promise silently so
      // an accidental async guard cannot produce secret-bearing unhandled logs.
      if (!allowed && result && typeof result.then === "function") void Promise.resolve(result).catch(() => {});
    } catch { /* All guard failures are the same fixed denial. */ }
    finally { this.#checking = false; }
    // A synchronous guard may revoke/close reentrantly. Never resurrect it.
    if (!allowed || this.#closed || this.#entries.get(entry.key) !== entry || entry.expiresAt <= this.#time()) {
      this.#drop(entry); return false;
    }
    return true;
  }

  #find(token, kind) {
    if (this.#closed || this.#checking || this.#revoking || typeof token !== "string" || token.length !== 47 || !new RegExp(`^${prefixes[kind]}[A-Za-z0-9_-]{43}$`).test(token)) deny();
    const hash = digest(token), entry = this.#entries.get(hash.toString("hex"));
    if (!entry || entry.kind !== kind || !timingSafeEqual(hash, entry.hash) || !this.#current(entry)) deny();
    return entry;
  }

  #create(kind, saved) {
    const expiresAt = this.#time() + (kind === "ticket" ? this.#ticketTtl : this.#grantTtl);
    let token, hash, key;
    // Collisions are cryptographically negligible, but never overwrite a lease.
    for (let attempt = 0; attempt < 5; attempt++) {
      token = prefixes[kind] + randomBytes(32).toString("base64url"); hash = digest(token); key = hash.toString("hex");
      if (!this.#entries.has(key)) break;
      if (attempt === 4) deny();
    }
    const controller = new AbortController();
    const entry = { key, hash, kind, binding: saved, expiresAt, controller };
    entry.lease = Object.freeze({ binding: saved, signal: controller.signal, expiresAt });
    this.#entries.set(key, entry);
    // A live bridge is revoked at the deadline even without another request.
    // The relative timer remains bounded even when a test injects its clock.
    entry.timer = setTimeout(() => this.#drop(entry), Math.max(0, expiresAt - this.#time()));
    entry.timer.unref();
    return { token, entry };
  }

  issueTicket(controllerOwnedBinding) {
    if (this.#closed || this.#checking || this.#revoking) deny();
    const saved = binding(controllerOwnedBinding);
    this.prune();
    if (this.#closed || this.#entries.size >= this.#maxEntries ||
        [...this.#entries.values()].filter(entry => entry.binding.ownerId === saved.ownerId).length >= this.#maxPerOwner) deny();
    // Reserve before calling the guard so reentrant revocation/capacity checks
    // see this issuance; a denied result drops it immediately.
    const { token, entry } = this.#create("ticket", saved);
    if (!this.#current(entry)) { this.#drop(entry); deny(); }
    return Object.freeze({ ticket: token, expiresAt: entry.expiresAt });
  }

  exchangeTicket(ticket, observedHostname) {
    if (this.#revoking) deny();
    const entry = this.#find(ticket, "ticket");
    // Host is comparison-only, never destination authority. Wrong-host attempts
    // do not consume a still-live ticket; successful exchange consumes it once.
    if (!hostname(observedHostname) || observedHostname !== entry.binding.hostname) deny();
    this.#drop(entry);
    const created = this.#create("grant", entry.binding);
    if (!this.#current(created.entry)) { this.#drop(created.entry); deny(); }
    return Object.freeze({ grant: created.token, expiresAt: created.entry.expiresAt });
  }

  authorize(grant, observedHostname) {
    const entry = this.#find(grant, "grant");
    if (!hostname(observedHostname) || observedHostname !== entry.binding.hostname) deny();
    return entry.lease;
  }

  #revoke(predicate) {
    let count = 0;
    this.#revoking++;
    try {
      for (const entry of [...this.#entries.values()]) if (predicate(entry.binding)) count += Number(this.#drop(entry));
      return count;
    } finally { this.#revoking--; }
  }
  revokeOwner(ownerId) { if (!id(ownerId)) deny(); return this.#revoke(value => value.ownerId === ownerId); }
  revokeSession(ownerId, sessionId) {
    if (!id(ownerId) || !id(sessionId)) deny();
    return this.#revoke(value => value.ownerId === ownerId && value.sessionId === sessionId);
  }
  revokeChat(ownerId, chatId) {
    if (!id(ownerId) || !id(chatId)) deny();
    return this.#revoke(value => value.ownerId === ownerId && value.chatId === chatId);
  }
  revokeGrant(grant) {
    if (typeof grant !== "string" || grant.length !== 47 || !/^psg_[A-Za-z0-9_-]{43}$/.test(grant)) return false;
    const entry = this.#entries.get(digest(grant).toString("hex"));
    return entry?.kind === "grant" ? this.#drop(entry) : false;
  }
  prune() {
    if (this.#checking) deny();
    for (const entry of [...this.#entries.values()]) this.#current(entry);
    return this.#entries.size;
  }
  close() { this.#closed = true; for (const entry of [...this.#entries.values()]) this.#drop(entry); }
  get size() { return this.prune(); }
}
