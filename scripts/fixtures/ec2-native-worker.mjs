import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, lstat, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const execute = promisify(execFile);
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value || "");
const fail = message => { throw Error(message); };
export const nativeRemoteStages = Object.freeze(["worker-request", "worker-audit", "worker-version", "worker-access", "worker-profile", "identity-before", "first-turn", "first-result", "resume-turn", "resume-result", "identity-after", "worker-cleanup"]);
const nativeLocalStages = ["arguments", "aws-cli", "aws-target", "ssh-key", "local-workdir", "plugin", "target-recheck", "ssm-tunnel", "worker-preflight", "source-access", "native-run", "source-preservation", "session-close", "local-cleanup", "ssh-receipt", "unknown"];
const nativeCategories = ["failed", "invalid-request", "invalid-receipt", "invalid-json", "command-failed", "command-timeout", "command-aborted", "worker-audit", "metadata-isolation", "native-version", "access-schema", "access-expired", "access-too-short", "identity-auth-rejected", "identity-rate-limited", "identity-unavailable", "identity-schema", "identity-changed", "result-contract", "profile-active", "profile-ownership", "profile-cleanup-unconfirmed", "source-file-permissions", "source-file-unavailable", "source-schema", "source-scope", "source-access-expired", "source-access-too-short", "source-changed", "session-close-unconfirmed", "local-cleanup-unconfirmed"];
const nativeFlags = ["profileCleanupAttempted", "profileCleanupConfirmed", "sourceCheckAttempted", "sourceUnchanged", "sessionCloseAttempted", "sessionClosed", "localCleanupAttempted", "localCleanupConfirmed"];
export class NativeAcceptanceError extends Error {
  constructor(stage, category, flags = {}) {
    super("Native acceptance failed; private diagnostics suppressed");
    this.diagnostic = { stage: [...nativeRemoteStages, ...nativeLocalStages].includes(stage) ? stage : "unknown", category: nativeCategories.includes(category) ? category : "failed" };
    for (const key of nativeFlags) if (typeof flags[key] === "boolean") this.diagnostic[key] = flags[key];
  }
}
export function nativeFailure(error, stage = "unknown", flags = {}) {
  const value = error instanceof NativeAcceptanceError ? error.diagnostic : {};
  return new NativeAcceptanceError(value.stage || stage, value.category || (error instanceof SyntaxError ? "invalid-json" : "failed"), { ...value, ...flags });
}
export function nativeFailureReceipt(error) {
  return { schema: 1, accepted: false, diagnostic: { ...nativeFailure(error).diagnostic }, workerRetirementRequired: true };
}
export function remoteNativeFailure(error, request) {
  const value = nativeFailure(error, "worker-request").diagnostic;
  return { schema: 1, failed: true, runId: uuid(request?.runId) ? request.runId : null,
    action: ["preflight", "run", "cleanup"].includes(request?.action) ? request.action : null,
    diagnostic: { stage: nativeRemoteStages.includes(value.stage) ? value.stage : "worker-request", category: value.category,
      ...Object.fromEntries(["profileCleanupAttempted", "profileCleanupConfirmed"].filter(key => typeof value[key] === "boolean").map(key => [key, value[key]])) } };
}
export function readRemoteNativeFailure(value, request) {
  if (value?.failed !== true) return;
  const d = value.diagnostic;
  if (value.schema !== 1 || value.runId !== request.runId || value.action !== request.action || !d || !nativeRemoteStages.includes(d.stage) || !nativeCategories.includes(d.category) ||
      ["profileCleanupAttempted", "profileCleanupConfirmed"].some(key => Object.hasOwn(d, key) && typeof d[key] !== "boolean")) throw new NativeAcceptanceError("ssh-receipt", "invalid-receipt");
  throw new NativeAcceptanceError(d.stage, d.category, Object.fromEntries(["profileCleanupAttempted", "profileCleanupConfirmed"].filter(key => typeof d[key] === "boolean").map(key => [key, d[key]])));
}
const diagnosticFail = (stage, category) => { throw new NativeAcceptanceError(stage, category); };
const safeEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/nonexistent", NO_COLOR: "1", BROWSER: "/bin/false" };
async function nativeRun(command, args, options = {}) {
  try { return (await execute(command, args, { timeout: 120000, maxBuffer: 1048576, env: safeEnv, ...options })).stdout; }
  catch (error) { diagnosticFail("unknown", options.signal?.aborted || error.code === "ABORT_ERR" ? "command-aborted" : error.killed ? "command-timeout" : "command-failed"); }
}

export function validateNativeResult(value, session, expected) {
  if (value?.type !== "result" || value.subtype !== "success" || value.is_error || value.session_id !== session || value.result?.trim() !== expected ||
      !Number.isInteger(value.num_turns) || value.num_turns > 1 || value.num_turns < 1 || !Number.isFinite(value.total_cost_usd) || value.total_cost_usd < 0 || value.total_cost_usd > 0.05 ||
      !value.modelUsage || !Object.keys(value.modelUsage).length || Object.keys(value.modelUsage).some(name => !name.includes("haiku"))) diagnosticFail("unknown", "result-contract");
  return value.total_cost_usd;
}

export async function runNativeProbe(request, { run = nativeRun, fetchImpl = fetch, rootBase = "/opt/agent-web", signal } = {}) {
  const context = { stage: "worker-request", flags: {} };
  try { return await executeNativeProbe(request, { run, fetchImpl, rootBase, signal }, context); }
  catch (error) {
    const safe = nativeFailure(error, context.stage, context.flags);
    if (safe.diagnostic.stage === "unknown") safe.diagnostic.stage = context.stage;
    throw safe;
  }
}
async function executeNativeProbe(request, { run, fetchImpl, rootBase, signal }, context) {
  if (!uuid(request?.runId) || !["preflight", "run", "cleanup"].includes(request.action)) diagnosticFail(context.stage, "invalid-request");
  const directory = path.join(rootBase, "native-acceptance-" + request.runId);
  const cleanup = async () => {
    let stat; try { stat = await lstat(directory); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || await realpath(directory) !== directory) diagnosticFail("worker-cleanup", "profile-ownership");
    const owner = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
    if (owner.runId !== request.runId || !Number.isInteger(owner.pid) || owner.pid < 1) diagnosticFail("worker-cleanup", "profile-ownership");
    if (request.action === "cleanup") {
      let active = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") active = false; }
      if (active) diagnosticFail("worker-cleanup", "profile-active");
    }
    await rm(directory, { recursive: true, force: false });
  };
  if (request.action === "cleanup") {
    context.stage = "worker-cleanup"; context.flags.profileCleanupAttempted = true; context.flags.profileCleanupConfirmed = false;
    await cleanup(); context.flags.profileCleanupConfirmed = true; return { schema: 1, runId: request.runId, cleanedUp: true };
  }
  context.stage = "worker-audit";
  const audit = JSON.parse(await run("sudo", ["-n", "/usr/local/sbin/agent-web-audit-image"], { signal }));
  for (const name of ["valid", "finalized", "cloudInitDisabled", "ssmDisabled", "credentialsAbsent", "transportKeyMatches", "freshIdentity", "heartbeatEnabled", "watchdogActive"]) if (audit[name] !== true) diagnosticFail(context.stage, "worker-audit");
  if (audit.metadataReachable !== false || audit.schema !== 1) diagnosticFail(context.stage, "metadata-isolation");
  context.stage = "worker-version";
  if ((await run("claude", ["--version"], { signal })).trim() !== "2.1.222 (Claude Code)") diagnosticFail(context.stage, "native-version");
  if (request.action === "preflight") return { schema: 1, runId: request.runId, preflight: true, credentialFree: true };
  context.stage = "worker-access";
  if (typeof request.accessToken !== "string" || !request.accessToken || request.accessToken.length > 64000 || /[\x00-\x20\x7f]/.test(request.accessToken) ||
      !Number.isSafeInteger(request.expiresAt) || Object.keys(request).some(key => !["action", "runId", "accessToken", "expiresAt"].includes(key))) diagnosticFail(context.stage, "access-schema");
  if (request.expiresAt <= Date.now()) diagnosticFail(context.stage, "access-expired");
  if (request.expiresAt < Date.now() + 600000) diagnosticFail(context.stage, "access-too-short");
  let created = false, result, primary;
  const identity = async () => {
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/profile", { headers: { Authorization: `Bearer ${request.accessToken}`, "Cache-Control": "no-cache" }, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (!response.ok) diagnosticFail(context.stage, [401, 403].includes(response.status) ? "identity-auth-rejected" : response.status === 429 ? "identity-rate-limited" : "identity-unavailable");
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 262144) fail("Claude identity response exceeded its limit"); chunks.push(chunk); }
    const data = JSON.parse(Buffer.concat(chunks));
    if (typeof data.account?.uuid !== "string" || typeof data.organization?.uuid !== "string") diagnosticFail(context.stage, "identity-schema");
    return createHash("sha256").update(JSON.stringify([request.runId, data.account.uuid, data.organization.uuid])).digest("hex");
  };
  try {
    context.stage = "worker-profile";
    await mkdir(directory, { mode: 0o700 }); created = true;
    await writeFile(path.join(directory, "owner.json"), JSON.stringify({ runId: request.runId, pid: process.pid }), { mode: 0o600, flag: "wx" });
    for (const name of ["claude", "tmp", "workspace"]) await mkdir(path.join(directory, name), { mode: 0o700 });
    context.stage = "identity-before"; const before = await identity();
    const env = { ...safeEnv, HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, "claude"), TMPDIR: path.join(directory, "tmp"),
      CLAUDE_CODE_OAUTH_TOKEN: request.accessToken, CLAUDE_CODE_ENTRYPOINT: "local-agent", CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CI: "1" };
    const common = ["--print", "--output-format", "json", "--model", "haiku", "--max-turns", "1", "--max-budget-usd", "0.05", "--tools", "",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--settings", '{"disableAllHooks":true}'];
    context.stage = "first-turn";
    const firstOutput = await run("claude", [...common, "--session-id", request.runId,
      `Remember acceptance marker ${request.runId}. Reply with exactly OK. Do not use tools.`], { cwd: path.join(directory, "workspace"), env, signal });
    context.stage = "first-result"; const first = JSON.parse(firstOutput);
    const firstCost = validateNativeResult(first, request.runId, "OK");
    context.stage = "resume-turn";
    const resumedOutput = await run("claude", [...common, "--resume", request.runId,
      "Reply only with the acceptance marker from the preceding turn. Do not use tools."], { cwd: path.join(directory, "workspace"), env, signal });
    context.stage = "resume-result"; const resumed = JSON.parse(resumedOutput);
    const resumedCost = validateNativeResult(resumed, request.runId, request.runId);
    context.stage = "identity-after";
    if (await identity() !== before) diagnosticFail(context.stage, "identity-changed");
    result = { schema: 1, runId: request.runId, accepted: true, provider: "claude", turns: 2, model: "haiku", firstReplyOk: true, resumedContext: true,
      identityStable: true, accessOnly: true, costUsdUpperBound: firstCost + resumedCost, githubCredentialsTransferred: false };
  } catch (error) { primary = nativeFailure(error, context.stage); if (primary.diagnostic.stage === "unknown") primary.diagnostic.stage = context.stage; }
  finally {
    if (created) {
      context.flags.profileCleanupAttempted = true; context.flags.profileCleanupConfirmed = false;
      try { await cleanup(); context.flags.profileCleanupConfirmed = true; }
      catch { primary ||= new NativeAcceptanceError("worker-cleanup", "profile-cleanup-unconfirmed"); }
    }
  }
  if (primary) throw primary;
  return { ...result, cleanedUp: true };
}

if (process.argv[1] === "--relay-native-probe") {
  const abort = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => abort.abort());
  let request;
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 262144) throw Error(); chunks.push(chunk); }
    request = JSON.parse(Buffer.concat(chunks));
    console.log(JSON.stringify(await runNativeProbe(request, { signal: abort.signal })));
  } catch (error) {
    // Protocol delivery succeeded, but the operation failed. The caller must
    // validate identity and reject this fixed envelope; it is never success.
    console.log(JSON.stringify(remoteNativeFailure(error, request)));
  }
}
