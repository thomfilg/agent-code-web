#!/usr/bin/env node
// Deprecated cloud-only compatibility entrypoint. Browser operations, receipt
// validation and observed process cleanup belong to smoke-deployed-login.mjs.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { smokeDeployedLogin, LoginProbeError } from "./smoke-deployed-login.mjs";
import { transportOrigin } from "./smoke-deployed-transports.mjs";

export class LegacyBrowserProbeError extends Error {
  constructor(category) {
    super(category === "local-retired"
      ? "The legacy localhost browser probe is retired; use the local browser acceptance suites. For AWS use: node scripts/smoke-deployed-login.mjs --run"
      : category === "invalid-arguments"
        ? "Use: node scripts/smoke-deployed-login.mjs --run. This legacy entrypoint accepts no argument or only the fixed AWS origin."
        : "Legacy readiness check failed; private response suppressed.");
    this.category = ["local-retired", "invalid-arguments", "readiness-failed"].includes(category) ? category : "readiness-failed";
  }
}

export function parseLegacyBrowserOptions(args) {
  if (args.length === 1 && args[0] === "http://localhost:8787") throw new LegacyBrowserProbeError("local-retired");
  if (args.length > 1 || args.length === 1 && args[0] !== transportOrigin) throw new LegacyBrowserProbeError("invalid-arguments");
  // The old no-argument invocation was explicitly live, unlike the new
  // operator's default dry plan. Preserve it without ever clicking Google.
  return { run: true, checkGoogleRedirect: false };
}

export async function smokeLegacyDeployedBrowser(args, { signal, fetchImpl = fetch, loginProbe = smokeDeployedLogin } = {}) {
  const options = parseLegacyBrowserOptions(args);
  const controller = new AbortController();
  try {
    const response = await fetchImpl(transportOrigin + "/readyz", { credentials: "omit", redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
    if (response.status !== 200) { await response.body?.cancel(); throw 0; }
    let body = "", bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > 1024) throw 0;
      body += Buffer.from(chunk).toString("utf8");
    }
    const value = JSON.parse(body);
    if (!value || Object.keys(value).length !== 1 || value.ok !== true) throw 0;
  } catch { throw new LegacyBrowserProbeError("readiness-failed"); }
  finally { controller.abort(); }
  const receipt = await loginProbe(options, { signal });
  return { ...receipt, readiness: true, compatibilityEntrypoint: "smoke-deployed-browser", replacement: "node scripts/smoke-deployed-login.mjs --run" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => controller.abort());
  try { console.log(JSON.stringify(await smokeLegacyDeployedBrowser(process.argv.slice(2), { signal: controller.signal }), null, 2)); }
  catch (error) {
    const result = error instanceof LegacyBrowserProbeError
      ? { ok: false, category: error.category, message: error.message }
      : error instanceof LoginProbeError
        ? { ok: false, phase: error.phase, category: error.category, ...(error.cleanup ? { cleanup: error.cleanup } : {}) }
        : { ok: false, category: "failed" };
    console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}
