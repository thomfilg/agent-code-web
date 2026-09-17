// Claude print mode requires an explicit startup opt-in. Its bearer-only
// gateway transport cannot perform the native organization lookup itself.
// Perform that same authenticated lookup in the controller, never in a worker
// holding a master key. No cached or guessed result authorizes Fast.
import { companyForChat } from "../public/company-scope.js";
import { createHash } from "node:crypto";
const endpoint = "https://api.anthropic.com/api/claude_code_penguin_mode";
const reasons = new Set(["free", "preference", "extra_usage_disabled", "network_error", "unknown", "not_first_party", "disabled_by_env", "model_not_allowed", "sdk_opt_in_required", "pending"]);
export const claudeFastScope = chat => JSON.stringify([chat.id, chat.agent, chat.ownerId, chat.environmentId, chat.workspace, companyForChat(chat)]);
export const claudeFastCredential = config => createHash("sha256").update(`relay-claude-fast\0${config.authMode}\0${config.providerKey || ""}`).digest("hex");
export function claudeFastRequest(text) {
  const match = /^\/fast(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const action = (match[1] || "").trim();
  if (action && !["on", "off"].includes(action)) throw new Error("Use /fast, /fast on, or /fast off");
  return action || "toggle";
}

export function claudeFastState(event) {
  if (!["off", "on", "cooldown"].includes(event?.fast_mode_state)) return null;
  return { state: event.fast_mode_state, ...(reasons.has(event.fast_mode_disabled_reason) ? { disabledReason: event.fast_mode_disabled_reason } : {}) };
}

export async function checkClaudeFastAvailability(config, { signal, fetchImpl = fetch } = {}) {
  if (config.authMode !== "gateway" || !config.providerKey) throw new Error("Fast requires a private Claude profile with configured gateway credentials.");
  // A key for a custom upstream must not be sent to a different provider.
  const upstream = new URL(config.upstreamBaseUrl);
  if (upstream.origin !== "https://api.anthropic.com" || upstream.pathname.replace(/\/$/, "") || upstream.username || upstream.password || upstream.search) {
    throw new Error("Fast availability cannot be verified for this custom Claude upstream. Configure an authenticated availability integration before enabling Fast.");
  }
  let response;
  try {
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]);
    response = await fetchImpl(endpoint, { method: "GET", headers: { "x-api-key": config.providerKey, accept: "application/json" }, redirect: "error", signal: bounded });
    if (!response.ok || !/application\/json/i.test(response.headers.get("content-type") || "")) throw new Error("Invalid availability response");
    let raw = "";
    for await (const chunk of response.body) { raw += new TextDecoder().decode(chunk); if (raw.length > 4096) throw new Error("Oversized availability response"); }
    const result = JSON.parse(raw);
    if (typeof result?.enabled !== "boolean") throw new Error("Missing availability decision");
    if (!result.enabled) return { enabled: false, disabledReason: reasons.has(result.disabled_reason) ? result.disabled_reason : "preference" };
    return { enabled: true };
  } catch {
    // Never expose response bodies, keys or upstream errors to chat/history.
    if (signal?.aborted) throw new Error("Fast availability check interrupted");
    throw new Error("Could not verify Claude Fast availability. Fast was not enabled; check gateway connectivity and account access, then retry.");
  } finally { await response?.body?.cancel().catch(() => {}); }
}

export function claudeFastUnavailable(reason) {
  return `Claude Fast is unavailable: ${{ free: "the account requires paid credits", preference: "disabled by the organization", extra_usage_disabled: "usage credits are not enabled", disabled_by_env: "disabled by worker policy", model_not_allowed: "the model is not allowed by policy" }[reason] || "native availability could not be confirmed"}.`;
}
