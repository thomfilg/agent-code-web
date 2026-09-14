import { createHash, randomUUID } from "node:crypto";

export const nowIso = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

export function safeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return createHash("sha256").update(a).digest().equals(createHash("sha256").update(b).digest());
}

export function clampText(value, max, field = "value") {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new TypeError(`${field} cannot be empty`);
  if (text.length > max) throw new TypeError(`${field} cannot exceed ${max} characters`);
  return text;
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function redact(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/cap_[A-Za-z0-9_-]{20,}/g, "cap_***")
    .replace(/(?:api[_-]?key|authorization|token|secret)(\s*[:=]\s*)[^\s,;]+/gi, "$1***");
}
