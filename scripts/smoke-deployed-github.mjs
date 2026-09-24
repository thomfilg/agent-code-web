#!/usr/bin/env node
// Negative-only release probe: fixed destinations, no cookies/account access,
// tools/call, Git pack upload, native worker, model turn or AWS operation.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transportOrigin } from "./smoke-deployed-transports.mjs";

const syntheticAuthorization = `Bearer cap_${"A".repeat(43)}`;
const foreignOrigin = "https://cross-origin.invalid";
const gitRoot = "/gateway/github/git/1.git/";
const discovery = gitRoot + "info/refs?service=git-upload-pack";
const gitDenied = "GitHub worker request denied. Resume the chat or reconnect GitHub.\n";
const mcpScope = JSON.stringify({ error: "GitHub access is unavailable or changed. Check the selected connection and repository, then restart the agent if needed." });
const mcpOrigin = JSON.stringify({ error: "GitHub gateway accepts only agent capability requests" });
const mcpRead = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const git = (id, pathname, status, headers = {}, method = "GET") => ({ id, pathname, status, headers, method, type: "text/plain", body: gitDenied });
const mcp = (id, status, headers = {}, { method = "POST", pathname = "/gateway/github/mcp", body = mcpScope } = {}) => ({
  id, pathname, status, headers, method, type: "application/json", body,
  ...(method === "POST" ? { requestBody: mcpRead } : {}),
});
// IDs/routes/methods are code-owned. No CLI flag may choose a URL or credential.
const probes = [
  git("git-anonymous", discovery, 401),
  git("git-unissued-capability", discovery, 401, { authorization: syntheticAuthorization }),
  git("git-cross-origin", discovery, 401, { authorization: syntheticAuthorization, origin: foreignOrigin }),
  git("git-unsupported-path", gitRoot + "unsupported", 404, { authorization: syntheticAuthorization }),
  git("git-unsupported-method", discovery, 400, { authorization: syntheticAuthorization }, "OPTIONS"),
  git("git-unsupported-query", discovery + "&unsupported=1", 400, { authorization: syntheticAuthorization }),
  mcp("mcp-anonymous", 401),
  mcp("mcp-unissued-capability", 401, { authorization: syntheticAuthorization }),
  mcp("mcp-cross-origin", 403, { authorization: syntheticAuthorization, origin: foreignOrigin }, { body: mcpOrigin }),
  // Even the Relay's own browser origin is not an agent capability request.
  mcp("mcp-browser-origin", 403, { authorization: syntheticAuthorization, origin: transportOrigin }, { body: mcpOrigin }),
  mcp("mcp-unsupported-method", 401, { authorization: syntheticAuthorization }, { method: "OPTIONS" }),
  mcp("mcp-unsupported-query", 403, { authorization: syntheticAuthorization }, { pathname: "/gateway/github/mcp?unsupported=1", body: mcpOrigin }),
  mcp("mcp-unsupported-path", 404, { authorization: syntheticAuthorization }, { method: "GET", pathname: "/gateway/github/mcp/unsupported", body: JSON.stringify({ error: "not found" }) }),
];

export function parseDeployedGitHubOptions(args) {
  if (args.length === 0) return { run: false };
  if (args.length === 1 && args[0] === "--run") return { run: true };
  throw new Error("Use only optional --run; the HTTPS destination and synthetic requests are fixed");
}

class DenialProbeError extends Error {
  constructor(probeId, category, status = null) {
    super("Deployed GitHub rejection check failed; private diagnostics suppressed");
    this.probeId = probeId; this.category = category; this.status = status;
  }
}

async function checkedResponse(probe, response) {
  const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
  const reject = category => { throw new DenialProbeError(probe.id, category, status); };
  if (status !== probe.status) reject("unexpected-status");
  if (response.headers.get("content-type")?.split(";")[0] !== probe.type ||
    !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") || "") ||
    response.headers.get("set-cookie") !== null || response.headers.get("location") !== null) reject("unexpected-headers");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) reject("oversized-response");
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length; if (bytes > 2048) reject("oversized-response");
    chunks.push(Buffer.from(chunk));
  }
  // Inspect only these bounded fixed public errors. Never print arbitrary bodies.
  const actual = Buffer.concat(chunks).toString("utf8");
  if (probe.type === "application/json") {
    let value; try { value = JSON.stringify(JSON.parse(actual)); } catch { reject("unexpected-body"); }
    if (value !== probe.body) reject("unexpected-body");
  } else if (actual !== probe.body) reject("unexpected-body");
  return status;
}

export async function smokeDeployedGitHub(options, { fetchImpl = fetch, signal } = {}) {
  const boundary = { origin: transportOrigin, verificationScope: "negative-route-behavior-only", deploymentIdentityVerified: false,
    authenticatedAccessVerified: false, providerOperationsRequested: 0, accountImports: 0, modelPrompts: 0, awsMutations: 0 };
  if (!options.run) return { schema: 1, dryRun: true, ...boundary, checks: probes.map(({ id, method }) => ({ id, method })) };
  const overall = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]), receipts = [];
  for (const probe of probes) {
    const started = Date.now(), abort = new AbortController(); let response;
    try {
      overall.throwIfAborted();
      response = await fetchImpl(transportOrigin + probe.pathname, {
        method: probe.method, redirect: "error", credentials: "omit", cache: "no-store",
        headers: { accept: "application/json, text/plain", ...probe.headers,
          ...(probe.requestBody ? { "content-type": "application/json" } : {}) },
        ...(probe.requestBody ? { body: probe.requestBody } : {}),
        signal: AbortSignal.any([overall, abort.signal, AbortSignal.timeout(10000)]),
      });
      const status = await checkedResponse(probe, response);
      receipts.push({ id: probe.id, method: probe.method, status, fixedRejectionVerified: true, elapsedMs: Date.now() - started });
    } catch (error) {
      if (error instanceof DenialProbeError) throw error;
      throw new DenialProbeError(probe.id, overall.aborted ? "cancelled-or-deadline" : "transport-failed");
    } finally { abort.abort(); await response?.body?.cancel().catch(() => {}); }
  }
  return { schema: 1, dryRun: false, ...boundary, checkedAt: new Date().toISOString(), checks: receipts,
    deploymentBindingRequired: "Pair this behavior-only receipt with the independently verified immutable deployment image/revision; it does not identify running code." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => controller.abort());
  try { console.log(JSON.stringify(await smokeDeployedGitHub(parseDeployedGitHubOptions(process.argv.slice(2)), { signal: controller.signal }), null, 2)); }
  catch (error) {
    console.error(JSON.stringify(error instanceof DenialProbeError
      ? { ok: false, probe: error.probeId, category: error.category, status: error.status }
      : { ok: false, category: "invalid-options-or-probe-failure" }));
    process.exitCode = 1;
  }
}
