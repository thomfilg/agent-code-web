const phases = new Set(["arguments", "aws-cli", "aws-target", "ssh-key", "local-workdir", "plugin", "tunnel", "preflight", "target-recheck", "site-start", "app-start", "ui", "entry", "fixture-login-and-browser-start", "guest-navigation", "canvas-input", "live-update-pixels", "renderer-sandbox", "stop-chrome", "transcript", "cleanup", "unknown",
  ...["320x640", "390x844", "640x960", "834x1112", "1280x800", "1920x1080"].map(value => `viewport-${value}`)]);
const categories = new Set(["failed", "assertion-failed", "aborted", "ui-timeout", "ui-command-failed", "chrome-sandbox", "chrome-missing", "chrome-permission", "chrome-pipe", "chrome-timeout", "chrome-exited", "transport-closed", "cleanup-unconfirmed"]);
const flags = ["siteStarted", "chromeVersionStarted", "chromeVersionReady", "browserWorkerStarted", "browserReady", "appStopAttempted", "appStopped", "siteStopAttempted", "siteStopped", "workersStopAttempted", "workersStopped", "sessionCloseAttempted", "sessionClosed", "localCleanupAttempted", "localCleanupConfirmed"];
const sandboxFlags = ["scanComplete", "nonRoot", "pipeOnly", "noSandboxBypass", "rendererSeccomp", "rendererNamespace"];
export function classifyGuestFailure(value) {
  const message = String(value?.message || value || "").slice(-12000);
  if (value?.name === "AbortError") return "aborted";
  if (/No usable sandbox|Failed to move to new namespace|zygote_host_impl_linux|sandbox.*(?:failed|denied)|apparmor.*DENIED/i.test(message)) return "chrome-sandbox";
  if (/ENOENT|not found|No such file/i.test(message)) return "chrome-missing";
  if (/EACCES|Permission denied|Operation not permitted/i.test(message)) return "chrome-permission";
  if (/EPIPE|remote.debugging.pipe|pipe.*(?:closed|broken)/i.test(message)) return "chrome-pipe";
  if (/Chrome .+ timed out|Shared Chrome startup timed out/.test(message)) return "chrome-timeout";
  if (/Chrome exited/.test(message)) return "chrome-exited";
  if (/TimeoutError|Timeout \d+ms exceeded|timed out/i.test(message)) return "ui-timeout";
  if (/disconnected|connection closed|Remote worker launcher failed/i.test(message)) return "transport-closed";
  if (value?.name === "AssertionError") return "assertion-failed";
  return "failed";
}
export function safeGuestDiagnostics(value = {}) {
  const result = {};
  for (const key of flags) if (typeof value[key] === "boolean") result[key] = value[key];
  if (categories.has(value.browserFailure)) result.browserFailure = value.browserFailure;
  if (["ownership", "scan-incomplete", "chrome-active", "failed"].includes(value.siteFailure)) result.siteFailure = value.siteFailure;
  for (const key of ["versionExitCode", "browserExitCode"]) if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 255) result[key] = value[key];
  if (value.sandbox && typeof value.sandbox === "object") {
    result.sandbox = {};
    for (const key of sandboxFlags) if (typeof value.sandbox[key] === "boolean") result.sandbox[key] = value.sandbox[key];
    for (const key of ["roots", "processes", "renderers"]) if (Number.isInteger(value.sandbox[key]) && value.sandbox[key] >= 0 && value.sandbox[key] <= 10000) result.sandbox[key] = value.sandbox[key];
  }
  return result;
}
export class GuestAcceptanceError extends Error {
  constructor(phase, category, details = {}) {
    super("Guest Chrome acceptance failed; private diagnostics suppressed");
    this.diagnostic = { phase: phases.has(phase) ? phase : "unknown", category: categories.has(category) ? category : "failed", ...safeGuestDiagnostics(details) };
  }
}
export function guestFailure(error, phase, details = {}) {
  return new GuestAcceptanceError(error instanceof GuestAcceptanceError ? error.diagnostic.phase : phase,
    error instanceof GuestAcceptanceError ? error.diagnostic.category : classifyGuestFailure(error),
    { ...(error instanceof GuestAcceptanceError ? error.diagnostic : {}), ...details });
}
export const guestFailureReceipt = error => ({ schema: 1, accepted: false, diagnostic: guestFailure(error, "unknown").diagnostic, workerRetirementRequired: true });

// Observe the production worker without changing its source, launch flags or
// private pipes. Retain only fixed classifications, never native stderr.
export function observeGuestChild(child, kind, diagnostics) {
  let tail = "";
  child.stderr.on("data", chunk => {
    tail = (tail + chunk).slice(-12000);
    const category = classifyGuestFailure(tail);
    if (category !== "failed") diagnostics.browserFailure = category;
  });
  child.once("error", error => { diagnostics.browserFailure = classifyGuestFailure(error); });
  child.once("close", code => {
    tail = "";
    if (Number.isInteger(code) && code >= 0 && code <= 255) diagnostics[kind === "version" ? "versionExitCode" : "browserExitCode"] = code;
    if (kind === "version" && code === 0) diagnostics.chromeVersionReady = true;
  });
}

export async function confirmGuestChildStopped(child, terminate, confirmMs = 3000) {
  let observed = false, wake, timer;
  const ended = () => { observed = true; wake?.(); };
  const exited = () => observed || Number.isInteger(child.exitCode) || typeof child.signalCode === "string";
  child.once("exit", ended); child.once("close", ended);
  try {
    await terminate(child, 2500);
    if (!exited()) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, confirmMs); });
    if (!exited()) throw new GuestAcceptanceError("cleanup", "cleanup-unconfirmed");
  } finally { clearTimeout(timer); child.removeListener("exit", ended); child.removeListener("close", ended); }
}

export async function cleanupGuestFixture({ app, site, children, connection, directory, terminate, remove, diagnostics, confirmWorkerMs = 3000 }) {
  let failed = false;
  const check = async (key, fn) => {
    diagnostics[key + "Attempted"] = true;
    try { await fn(); diagnostics[{ appStop: "appStopped", siteStop: "siteStopped", workersStop: "workersStopped", sessionClose: "sessionClosed", localCleanup: "localCleanupConfirmed" }[key]] = true; }
    catch (error) { failed = true; if (key === "siteStop") diagnostics.siteFailure = ["ownership", "scan-incomplete", "chrome-active"].includes(error?.guestSiteCode) ? error.guestSiteCode : "failed"; }
  };
  // app.stop waits for pending SharedBrowsers.ensure and its browser stop;
  // never scan/delete a workspace before that shutdown has settled.
  if (app) await check("appStop", () => app.stop());
  if (site) await check("siteStop", async () => { if ((await site.command("stop"))?.cleanedUp !== true) throw Error(); });
  if (children.size) await check("workersStop", async () => {
    const results = await Promise.allSettled([...children].map(child => confirmGuestChildStopped(child, terminate, confirmWorkerMs)));
    if (results.some(result => result.status === "rejected")) throw Error();
  });
  if (connection) await check("sessionClose", () => connection.close());
  if (directory) await check("localCleanup", () => remove(directory, { recursive: true, force: false }));
  return failed;
}
