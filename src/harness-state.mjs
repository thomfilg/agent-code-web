const DAY_MS = 24 * 60 * 60 * 1000;
const SAFE_FAILURE = "Update failed; using the last-known-good harness.";
const safeVersion = value => typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : null;
const safeDate = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function publicHarnessUpdate(state) {
  if (!state) return null;
  const status = ["checking", "current", "updated", "failed"].includes(state.status) ? state.status : "failed";
  return { status,
    lastAttemptAt: safeDate(state.lastAttemptAt), lastSuccessAt: safeDate(state.lastSuccessAt),
    installed: { codex: safeVersion(state.installed?.codex), claude: safeVersion(state.installed?.claude) },
    latest: { codex: safeVersion(state.latest?.codex), claude: safeVersion(state.latest?.claude) },
    error: status === "failed" ? SAFE_FAILURE : null };
}

export { DAY_MS as HARNESS_UPDATE_INTERVAL_MS, SAFE_FAILURE as HARNESS_UPDATE_FAILURE, safeVersion as safeHarnessVersion };
