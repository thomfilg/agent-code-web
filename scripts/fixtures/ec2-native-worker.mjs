import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, lstat, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const execute = promisify(execFile);
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value || "");
const fail = message => { throw Error(message); };
const safeEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/nonexistent", NO_COLOR: "1", BROWSER: "/bin/false" };
async function nativeRun(command, args, options = {}) {
  try { return (await execute(command, args, { timeout: 120000, maxBuffer: 1048576, env: safeEnv, ...options })).stdout; }
  catch { fail("Native worker command failed; private output suppressed"); }
}

export function validateNativeResult(value, session, expected) {
  if (value?.type !== "result" || value.subtype !== "success" || value.is_error || value.session_id !== session || value.result?.trim() !== expected ||
      !Number.isInteger(value.num_turns) || value.num_turns > 1 || value.num_turns < 1 || !Number.isFinite(value.total_cost_usd) || value.total_cost_usd < 0 || value.total_cost_usd > 0.05 ||
      !value.modelUsage || !Object.keys(value.modelUsage).length || Object.keys(value.modelUsage).some(name => !name.includes("haiku"))) fail("Native Claude result did not satisfy the bounded acceptance contract");
  return value.total_cost_usd;
}

export async function runNativeProbe(request, { run = nativeRun, fetchImpl = fetch, rootBase = "/opt/agent-web", signal } = {}) {
  if (!uuid(request?.runId) || !["preflight", "run", "cleanup"].includes(request.action)) fail("Invalid native acceptance request");
  const directory = path.join(rootBase, "native-acceptance-" + request.runId);
  const cleanup = async () => {
    let stat; try { stat = await lstat(directory); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || await realpath(directory) !== directory) fail("Native cleanup ownership changed; retain and terminate the dedicated worker");
    const owner = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
    if (owner.runId !== request.runId || !Number.isInteger(owner.pid) || owner.pid < 1) fail("Native cleanup marker changed; terminate the dedicated worker");
    if (request.action === "cleanup") {
      let active = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") active = false; }
      if (active) fail("Native probe may still be running; terminate the dedicated worker instead of removing its active profile");
    }
    await rm(directory, { recursive: true, force: false });
  };
  if (request.action === "cleanup") { await cleanup(); return { schema: 1, runId: request.runId, cleanedUp: true }; }
  const audit = JSON.parse(await run("sudo", ["-n", "/usr/local/sbin/agent-web-audit-image"], { signal }));
  for (const name of ["valid", "finalized", "cloudInitDisabled", "ssmDisabled", "credentialsAbsent", "transportKeyMatches", "freshIdentity", "heartbeatEnabled", "watchdogActive"]) if (audit[name] !== true) fail("Fresh worker audit failed");
  if (audit.metadataReachable !== false || audit.schema !== 1) fail("Worker metadata isolation failed");
  if ((await run("claude", ["--version"], { signal })).trim() !== "2.1.222 (Claude Code)") fail("Unexpected native Claude version");
  if (request.action === "preflight") return { schema: 1, runId: request.runId, preflight: true, credentialFree: true };
  if (typeof request.accessToken !== "string" || !request.accessToken || request.accessToken.length > 64000 || /[\x00-\x20\x7f]/.test(request.accessToken) ||
      !Number.isSafeInteger(request.expiresAt) || request.expiresAt < Date.now() + 600000 || Object.keys(request).some(key => !["action", "runId", "accessToken", "expiresAt"].includes(key))) fail("Use a current access-only credential; refresh tokens and extra fields are forbidden");
  let created = false, result;
  const identity = async () => {
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/profile", { headers: { Authorization: `Bearer ${request.accessToken}`, "Cache-Control": "no-cache" }, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (!response.ok) fail("Claude identity could not be verified");
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 262144) fail("Claude identity response exceeded its limit"); chunks.push(chunk); }
    const data = JSON.parse(Buffer.concat(chunks));
    if (typeof data.account?.uuid !== "string" || typeof data.organization?.uuid !== "string") fail("Unexpected Claude identity response");
    return createHash("sha256").update(JSON.stringify([request.runId, data.account.uuid, data.organization.uuid])).digest("hex");
  };
  try {
    await mkdir(directory, { mode: 0o700 }); created = true;
    await writeFile(path.join(directory, "owner.json"), JSON.stringify({ runId: request.runId, pid: process.pid }), { mode: 0o600, flag: "wx" });
    for (const name of ["claude", "tmp", "workspace"]) await mkdir(path.join(directory, name), { mode: 0o700 });
    const before = await identity();
    const env = { ...safeEnv, HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, "claude"), TMPDIR: path.join(directory, "tmp"),
      CLAUDE_CODE_OAUTH_TOKEN: request.accessToken, CLAUDE_CODE_ENTRYPOINT: "local-agent", CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CI: "1" };
    const common = ["--print", "--output-format", "json", "--model", "haiku", "--max-turns", "1", "--max-budget-usd", "0.05", "--tools", "",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--settings", '{"disableAllHooks":true}'];
    const first = JSON.parse(await run("claude", [...common, "--session-id", request.runId,
      `Remember acceptance marker ${request.runId}. Reply with exactly OK. Do not use tools.`], { cwd: path.join(directory, "workspace"), env, signal }));
    const firstCost = validateNativeResult(first, request.runId, "OK");
    const resumed = JSON.parse(await run("claude", [...common, "--resume", request.runId,
      "Reply only with the acceptance marker from the preceding turn. Do not use tools."], { cwd: path.join(directory, "workspace"), env, signal }));
    const resumedCost = validateNativeResult(resumed, request.runId, request.runId);
    if (await identity() !== before) fail("Claude account identity changed during acceptance");
    result = { schema: 1, runId: request.runId, accepted: true, provider: "claude", turns: 2, model: "haiku", firstReplyOk: true, resumedContext: true,
      identityStable: true, accessOnly: true, costUsdUpperBound: firstCost + resumedCost, githubCredentialsTransferred: false };
  } finally { if (created) await cleanup(); }
  return { ...result, cleanedUp: true };
}

if (process.argv[1] === "--relay-native-probe") {
  const abort = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => abort.abort());
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 262144) throw Error(); chunks.push(chunk); }
    console.log(JSON.stringify(await runNativeProbe(JSON.parse(Buffer.concat(chunks)), { signal: abort.signal })));
  } catch { console.error("EC2 native acceptance failed; private diagnostics suppressed. Verify exact worker cleanup."); process.exitCode = 1; }
}
