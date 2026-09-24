#!/usr/bin/env node
import { constants } from "node:fs";
import { open, lstat, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { nativeTarget, guardNativeTarget } from "./fixtures/ec2-native-guards.mjs";
import { prepareSessionPlugin } from "./fixtures/session-manager-plugin.mjs";
import { awsArgs, runPrivate, openNativeTunnel, nativeProbeOverSsh } from "./fixtures/ec2-native-transport.mjs";
import { NativeAcceptanceError, nativeFailure, nativeFailureReceipt } from "./fixtures/ec2-native-worker.mjs";

const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value || "");
const fail = message => { throw Error(message); };
export function parseNativeOptions(args) {
  const result = { run: false, sshKey: path.join(os.homedir(), ".local/share/agent-relay-aws-mvp/worker-ed25519") };
  const names = { "--worker-id": "workerId", "--image-id": "imageId", "--acceptance-id": "acceptanceId", "--claude-auth": "claudeAuth", "--ssh-key": "sshKey" };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--run") { result.run = true; continue; }
    const name = names[args[index]];
    if (!name || !args[index + 1] || args[index + 1].startsWith("--")) fail("Unknown/incomplete native acceptance argument");
    result[name] = args[++index];
  }
  if (result.run && (!/^i-[a-f0-9]{8,17}$/.test(result.workerId || "") || !/^ami-[a-f0-9]{8,17}$/.test(result.imageId || "") ||
      !uuid(result.acceptanceId) || !path.isAbsolute(result.claudeAuth || "") || !path.isAbsolute(result.sshKey))) fail("Native --run requires exact worker/image/acceptance IDs and absolute credential/key paths");
  return result;
}

async function privateFile(filename) {
  let file;
  try {
    try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { throw new NativeAcceptanceError("source-access", ["EACCES", "EPERM", "ELOOP"].includes(error.code) ? "source-file-permissions" : "source-file-unavailable"); }
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077) throw new NativeAcceptanceError("source-access", "source-file-permissions");
    if (stat.size > 262144) throw new NativeAcceptanceError("source-access", "source-schema");
    const bytes = Buffer.alloc(262145), result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 262144) throw new NativeAcceptanceError("source-access", "source-schema");
    return bytes.subarray(0, result.bytesRead);
  } finally { await file?.close(); }
}
export async function readNativeAccess(filename) {
  const content = await privateFile(filename), hash = value => createHash("sha256").update(value).digest("hex");
  const before = hash(content); let credential;
  try { credential = JSON.parse(content)?.claudeAiOauth; } catch { throw new NativeAcceptanceError("source-access", "source-schema"); }
  if (typeof credential?.accessToken !== "string" || !credential.accessToken || credential.accessToken.length > 64000 || /[\x00-\x20\x7f]/.test(credential.accessToken) ||
      !Number.isSafeInteger(credential.expiresAt)) throw new NativeAcceptanceError("source-access", "source-schema");
  if (!Array.isArray(credential.scopes) || !credential.scopes.includes("user:inference")) throw new NativeAcceptanceError("source-access", "source-scope");
  if (credential.expiresAt <= Date.now()) throw new NativeAcceptanceError("source-access", "source-access-expired");
  if (credential.expiresAt < Date.now() + 600000) throw new NativeAcceptanceError("source-access", "source-access-too-short");
  // Never return the original object: it normally also contains refreshToken.
  return { accessToken: credential.accessToken, expiresAt: credential.expiresAt,
    assertUnchanged: async () => { if (hash(await privateFile(filename)) !== before) throw new NativeAcceptanceError("source-preservation", "source-changed"); } };
}

export function validateProbeReceipt(receipt, id, action) {
  if (receipt?.schema !== 1 || receipt.runId !== id) fail("Native acceptance receipt identity mismatch");
  if (action === "preflight") { if (receipt.preflight !== true || receipt.credentialFree !== true) fail("Native acceptance preflight failed"); return; }
  if (receipt.cleanedUp !== true) fail("Native worker cleanup was not confirmed");
  if (action === "cleanup") return;
  if (receipt.accepted !== true || receipt.provider !== "claude" || receipt.turns !== 2 || receipt.model !== "haiku" || receipt.firstReplyOk !== true ||
      receipt.resumedContext !== true || receipt.identityStable !== true || receipt.accessOnly !== true || receipt.githubCredentialsTransferred !== false ||
      !Number.isFinite(receipt.costUsdUpperBound) || receipt.costUsdUpperBound < 0 || receipt.costUsdUpperBound > 0.1) fail("Native Claude acceptance was not complete");
}

export async function smokeEc2Native(options, dependencies = {}) {
  if (!options.run) return { dryRun: true, ...nativeTarget, required: ["--run", "--worker-id", "--image-id", "--acceptance-id", "--claude-auth"],
    actions: ["guard-exact-existing-disposable-worker", "verify-private-signed-SSM-plugin", "SSM-private-SSH-tunnel", "fresh-native-audit", "Claude-Haiku-OK-and-resume", "verify-source-unchanged", "remove-exact-native-profile", "close-exact-SSM-session"],
    maximumModelTurns: 2, maximumBudgetUsd: 0.1, refreshTokensTransferred: false, githubCredentialsTransferred: false, accountImports: false, instanceLifecycle: "operator must terminate the exact dedicated worker afterward" };
  const { run = runPrivate, guard = guardNativeTarget, plugin = prepareSessionPlugin, tunnel: startTunnel = openNativeTunnel, probe = nativeProbeOverSsh,
    readAccess = readNativeAccess, signal, log = () => {} } = dependencies;
  const json = async (...args) => JSON.parse(await run("aws", awsArgs([...args, "--output", "json"]), { signal }));
  let stage = "aws-cli", target, directory, transport, source, attempted = false, validatedRun = false, receipt, primary;
  const flags = { profileCleanupAttempted: false, profileCleanupConfirmed: false, sourceCheckAttempted: false, sourceUnchanged: false,
    sessionCloseAttempted: false, sessionClosed: false, localCleanupAttempted: false, localCleanupConfirmed: false };
  const recheck = async () => {
    const current = await guard(options, json);
    if (current.host !== target.host || current.publicKey !== target.publicKey) fail("Native worker target changed during acceptance");
  };
  try {
    // Pin the inspected CLI transport implementation, which supports SSM token
    // in env rather than process argv. Do not silently accept older fallbacks.
    if (!/^aws-cli\/2\.35\.20\s/.test(await run("aws", ["--version"], { signal }))) fail("Native acceptance requires the reviewed AWS CLI 2.35.20");
    stage = "aws-target"; target = await guard(options, json);
    stage = "ssh-key";
    const key = await lstat(options.sshKey);
    if (!key.isFile() || key.isSymbolicLink() || key.nlink !== 1 || key.uid !== process.getuid() || key.mode & 0o077) fail("Native transport key must remain private and owned");
    const publicKey = (await run("ssh-keygen", ["-y", "-f", options.sshKey], { signal })).trim().split(/\s+/).slice(0, 2).join(" ");
    if (publicKey !== target.publicKey) fail("Native transport key does not match the exact deployment");
    stage = "local-workdir"; directory = await mkdtemp(path.join(os.tmpdir(), "relay-ec2-native-"));
    stage = "plugin";
    log("Verifying the signed private transport package; no account data has been read.");
    const installed = await plugin(directory, { run: (cmd, args) => run(cmd, args, { signal }) });
    stage = "target-recheck"; await recheck();
    stage = "ssm-tunnel";
    transport = await startTunnel(target, directory, installed, { run, signal });
    const request = { runId: options.acceptanceId, action: "preflight" };
    stage = "worker-preflight";
    validateProbeReceipt(await probe({ options, directory, tunnel: transport, request, first: true, run, signal }), options.acceptanceId, "preflight");
    stage = "target-recheck"; await recheck();
    stage = "source-access";
    source = await readAccess(options.claudeAuth);
    signal?.throwIfAborted();
    log("Fresh worker verified. Sending two bounded access-only Claude turns; GitHub remains controller-only.");
    stage = "native-run";
    attempted = true;
    receipt = await probe({ options, directory, tunnel: transport, request: { action: "run", runId: options.acceptanceId, accessToken: source.accessToken, expiresAt: source.expiresAt }, run, signal });
    validateProbeReceipt(receipt, options.acceptanceId, "run");
    validatedRun = true;
    flags.profileCleanupAttempted = true; flags.profileCleanupConfirmed = true;
  } catch (error) {
    primary = nativeFailure(error, stage);
    for (const key of Object.keys(flags)) if (typeof primary.diagnostic[key] === "boolean") flags[key] = primary.diagnostic[key];
  } finally {
    // A failed/aborted SSH stream must not imply that its remote finally ran.
    // Try the exact owned cleanup over a new SSH channel without credentials.
    if (attempted && !validatedRun && transport) {
      flags.profileCleanupAttempted = true; flags.profileCleanupConfirmed = false;
      try {
        // A cancelled run still needs read-only guards and cleanup with their
        // own bounded timeout instead of the cancelled signal.
        const current = await guard(options, async (...args) => JSON.parse(await run("aws", awsArgs([...args, "--output", "json"]))));
        if (current.host !== target.host || current.publicKey !== target.publicKey) fail("Native cleanup target changed");
        validateProbeReceipt(await probe({ options, directory, tunnel: transport, request: { action: "cleanup", runId: options.acceptanceId }, run }), options.acceptanceId, "cleanup");
        flags.profileCleanupConfirmed = true;
      } catch { primary ||= new NativeAcceptanceError("worker-cleanup", "profile-cleanup-unconfirmed"); }
    }
    if (source) {
      flags.sourceCheckAttempted = true;
      try { await source.assertUnchanged(); flags.sourceUnchanged = true; }
      catch { primary ||= new NativeAcceptanceError("source-preservation", "source-changed"); }
    }
    if (transport) {
      flags.sessionCloseAttempted = true;
      try { await transport.close(); flags.sessionClosed = true; }
      catch { primary ||= new NativeAcceptanceError("session-close", "session-close-unconfirmed"); }
    }
    if (directory) {
      flags.localCleanupAttempted = true;
      try { await rm(directory, { recursive: true, force: false }); flags.localCleanupConfirmed = true; }
      catch { primary ||= new NativeAcceptanceError("local-cleanup", "local-cleanup-unconfirmed"); }
    }
  }
  if (primary) throw nativeFailure(primary, stage, flags);
  // Explicit allowlist: never print raw remote output, hashes or account IDs.
  return { schema: 1, accepted: true, ...nativeTarget, workerId: options.workerId, imageId: options.imageId, acceptanceId: options.acceptanceId,
    turns: 2, model: "haiku", firstReplyOk: true, resumedContext: true, identityStable: true, sourceUnchanged: true, profileRemoved: true, sessionClosed: true,
    accessOnly: true, costUsdUpperBound: receipt.costUsdUpperBound, githubCredentialsTransferred: false, accountImports: false, workerRetirementRequired: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const abort = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => abort.abort());
  try { console.log(JSON.stringify(await smokeEc2Native(parseNativeOptions(process.argv.slice(2)), { signal: abort.signal, log: message => console.error(message) }), null, 2)); }
  catch (error) {
    console.error(JSON.stringify(nativeFailureReceipt(nativeFailure(error, "arguments"))));
    console.error("EC2 native acceptance failed. Confirm exact worker retirement and any unconfirmed cleanup. No product account was imported; private diagnostics remain suppressed."); process.exitCode = 1;
  }
}
