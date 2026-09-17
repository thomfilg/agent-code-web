import { Transform } from "node:stream";

// Inspect only the top-level speed field while forwarding the original bytes.
// Never buffer prompts, images, nested tool input or an entire request body.
export function observeClaudeFastRequest() {
  let depth = 0, quoted = false, escaped = false, role = null, token = "", oversized = false;
  let expected = "root", key = null, fast = false, complete = false, invalid = false;
  const stream = new Transform({ transform(chunk, encoding, done) {
    for (const byte of chunk) {
      if (invalid) break;
      if (quoted) {
        if (byte === 34 && !escaped) {
          quoted = false;
          if (role && !oversized) {
            try {
              const value = JSON.parse(`"${token}"`);
              if (role === "key") key = value;
              else if (key === "speed") fast = value === "fast";
            } catch { invalid = true; }
          }
          if (depth === 1) expected = role === "key" ? "colon" : "separator";
          role = null; token = ""; continue;
        }
        if (role && !oversized) { if (token.length < 128) token += String.fromCharCode(byte); else { oversized = true; key = null; } }
        if (byte === 92 && !escaped) escaped = true; else escaped = false;
        continue;
      }
      if ([9, 10, 13, 32].includes(byte)) continue;
      if (complete) { invalid = true; break; }
      if (depth === 0 && byte !== 123) { invalid = true; break; }
      if (byte === 34) {
        quoted = true; escaped = false; token = ""; oversized = false;
        role = depth === 1 ? expected === "key" ? "key" : expected === "value" ? "value" : null : null;
        continue;
      }
      if (byte === 123 || byte === 91) {
        if (depth === 0 && (byte !== 123 || expected !== "root")) { invalid = true; break; }
        depth++; if (depth === 1) expected = "key"; continue;
      }
      if (byte === 125 || byte === 93) {
        depth--; if (depth < 0) { invalid = true; break; }
        if (depth === 0) complete = true; else if (depth === 1) expected = "separator";
        continue;
      }
      if (depth === 1 && byte === 58) { expected = "value"; if (key === "speed") fast = false; continue; }
      if (depth === 1 && byte === 44) { expected = "key"; key = null; continue; }
      if (depth === 1 && expected === "value") expected = "separator";
    }
    done(null, chunk);
  } });
  return { stream, isFast: () => complete && !invalid && fast };
}

const creditReasons = new Set(["out_of_credits", "org_level_disabled_until", "org_spend_cap_reached"]);
export function claudeFastRejection(status, headers, body = "", now = Date.now()) {
  if (status === 400) {
    try {
      const value = JSON.parse(body);
      if (typeof value.error?.message === "string" && value.error.message.includes("Fast mode is not enabled")) return { type: "disabled", reason: "preference" };
    } catch { /* A malformed/unbounded error is not an entitlement decision. */ }
    return null;
  }
  if (![429, 529].includes(status)) return null;
  const overage = headers.get("anthropic-ratelimit-unified-overage-disabled-reason");
  if (overage !== null) return creditReasons.has(overage) ? { type: "credits", reason: overage } : { type: "disabled", reason: "extra_usage_disabled" };
  // Installed Claude 2.1.222 retries <20s delays in the same turn, otherwise
  // uses at least 10 minutes (30 minutes if Retry-After is absent/invalid).
  const seconds = Number.parseInt(headers.get("retry-after"), 10);
  const delay = Number.isSafeInteger(seconds) && Number.isSafeInteger(now + seconds * 1000) ? seconds * 1000 : null;
  if (delay !== null && delay < 20000) return null;
  return { type: "cooldown", reason: status === 529 ? "overloaded" : "rate_limit", until: now + Math.max(delay ?? 1800000, 600000) };
}

export function observeClaudeFastResponse({ upstream, isFast, notify, credential, now = Date.now }) {
  const chunks = []; let size = 0;
  return new Transform({
    transform(chunk, encoding, done) {
      if (upstream.status === 400 && size <= 4096) { size += chunk.length; if (size <= 4096) chunks.push(chunk); else chunks.length = 0; }
      done(null, chunk);
    },
    flush(done) {
      if (isFast()) {
        const feedback = claudeFastRejection(upstream.status, upstream.headers, size <= 4096 ? Buffer.concat(chunks).toString("utf8") : "", now());
        if (feedback) notify({ ...feedback, credential });
      }
      done();
    },
  });
}
