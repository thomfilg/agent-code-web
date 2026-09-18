#!/usr/bin/env node
// Explicit controller-role acceptance only. Mount this file into the reviewed
// image; do not load application env, secrets, database or product user records.
import { open, lstat, readFile, rename, unlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { PreviewHosts, runPreviewAws, PreviewHostError } from "../src/preview-hosts.mjs";

const fixed = Object.freeze({ expectedAccount: "456808212788", deployment: "agent-relay-mvp", region: "us-east-2", controllerInstanceId: "i-08c991c22089589a5", relayDistributionId: "E2FQ8W4AL72G7G" });
const id = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value) && value.length === 36;
const deny = () => { throw new Error("Preview host acceptance configuration or journal is invalid."); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export function acceptanceConfig(input) {
  const keys = ["schema", "runId", "expectedRoleArn", "vpcOriginId", "controllerOriginDns"];
  if (!input || input.schema !== 1 || !id(input.runId) || Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key)) ||
    typeof input.expectedRoleArn !== "string" || !/^arn:aws:iam::456808212788:role\/agent-relay-mvp-ControllerRole-[A-Za-z0-9]+$/.test(input.expectedRoleArn) || /[\r\n\u2028\u2029]/.test(input.expectedRoleArn)) deny();
  const config = { ...fixed, enabled: true, awsBin: "aws", profile: "", vpcOriginId: input.vpcOriginId, controllerOriginDns: input.controllerOriginDns, maxHosts: 1, maxPerOwner: 1, maxPerChat: 1 };
  new PreviewHosts({ records: { list() {}, put() {} }, config }); // Same strict production configuration validation.
  return { config, runId: input.runId, expectedRoleArn: input.expectedRoleArn, scope: { ownerId: `operator-${input.runId}`, chatId: `acceptance-${input.runId}` }, port: 43123 };
}

export class AcceptanceJournal {
  constructor(directory, input, state) { this.directory = directory; this.filename = path.join(directory, "journal.json"); this.input = input; this.state = state; }
  static async open(directory, input, { cleanupOnly = false, uid = process.getuid() } = {}) {
    acceptanceConfig(input);
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || dir.mode & 0o077 || await realpath(directory) !== directory) deny();
    const filename = path.join(directory, "journal.json"), journal = new AcceptanceJournal(directory, input, null); let state;
    // Acquire before reading: another completed run must not be replaced with
    // a snapshot read while that run was still writing its intention.
    journal.lock = await open(path.join(directory, "journal.lock"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.nlink !== 1 || info.mode & 0o077 || info.size > 65536) deny();
        state = JSON.parse(await readFile(filename, "utf8"));
        if (state?.schema !== 1 || !isDeepStrictEqual(state.input, input) || !Array.isArray(state.rows) || state.rows.length > 1) deny();
      } catch (error) { if (error.code !== "ENOENT") deny(); if (cleanupOnly) deny(); state = { schema: 1, input, rows: [] }; }
      await journal.save(state);
    } catch (error) { await journal.close(); throw error; }
    return journal;
  }
  async save(state) {
    const temp = path.join(this.directory, `journal-${randomUUID()}.tmp`); let file;
    try {
      file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(JSON.stringify(state)); await file.sync(); await file.close(); file = null;
      await rename(temp, this.filename);
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY); try { await directory.sync(); } finally { await directory.close(); }
      this.state = structuredClone(state);
    } finally { await file?.close(); await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  async list(kind) { if (kind !== "preview-host") deny(); return structuredClone(this.state.rows); }
  async put(kind, recordId, value) {
    if (kind !== "preview-host" || value.id !== recordId || this.state.rows.some(row => row.id !== recordId)) deny();
    const { scope, port } = acceptanceConfig(this.input);
    if (value.ownerId !== scope.ownerId || value.chatId !== scope.chatId || value.port !== port) deny();
    await this.save({ ...this.state, rows: [value] }); return structuredClone(value);
  }
  async close() { if (this.lock) { await this.lock.close(); this.lock = null; await unlink(path.join(this.directory, "journal.lock")); } }
}

export async function runAcceptance(input, records, { aws = runPreviewAws, now = Date.now, sleep = wait, signal, createWaitMs = 600000, cleanupWaitMs = 900000, pollMs = 10000, cleanupOnly = false } = {}) {
  const spec = acceptanceConfig(input), roleName = spec.expectedRoleArn.split("/").at(-1);
  const expectedSession = `arn:aws:sts::${fixed.expectedAccount}:assumed-role/${roleName}/${fixed.controllerInstanceId}`;
  let roleVerified = false, primary = null, row, ready = false, restartRevalidated = false, immediatelyRevoked = false, deleted = false;
  let phase = "identity", phaseDeadline = Infinity;
  const counts = { create: 0, update: 0, delete: 0 };
  const guardedAws = async (service, action, args, options) => {
    const remaining = phaseDeadline - now(); if (remaining <= 0) throw new PreviewHostError();
    const signals = [options?.signal, phase === "create" ? signal : null, Number.isFinite(remaining) ? AbortSignal.timeout(Math.max(1, Math.ceil(remaining))) : null].filter(Boolean);
    const result = await aws(spec.config, service, action, args, signals.length ? { ...options, signal: AbortSignal.any(signals) } : options);
    if (action === "get-caller-identity") { if (result.Account !== fixed.expectedAccount || result.Arn !== expectedSession) throw new PreviewHostError("ownership-mismatch"); roleVerified = true; }
    if (action === "create-distribution-with-tags") counts.create++;
    if (action === "update-distribution") counts.update++;
    if (action === "delete-distribution") counts.delete++;
    return result;
  };
  let hosts = new PreviewHosts({ records, config: spec.config, aws: guardedAws });
  try {
    await hosts.initialize();
    const previous = hosts.list(spec.scope);
    if ((await records.list("preview-host")).length !== previous.length || previous.length > 1) deny();
    row = previous[0];
    // IAM identity is checked before even persisting a new create intention and
    // again by the production guard before every reconcile batch.
    await guardedAws("sts", "get-caller-identity", {});
    if (row) primary = cleanupOnly ? null : "existing-journal-cleanup-only";
    else if (cleanupOnly) primary = "missing-journal";
    else {
      phase = "create"; phaseDeadline = now() + createWaitMs;
      row = await hosts.ensure({ ...spec.scope, port: spec.port });
      while (now() < phaseDeadline && !signal?.aborted) {
        await hosts.reconcile({ limit: 1 }); row = hosts.get(row.id, spec.scope);
        if (row.status === "ready") { ready = hosts.lookup(row.hostname)?.id === row.id; break; }
        if (row.status === "error" && !row.retryable) { primary = "provider-ownership-rejected"; break; }
        await sleep(Math.max(0, Math.min(pollMs, phaseDeadline - now())));
      }
      if (!ready && !primary) primary = signal?.aborted ? "cancelled" : "create-not-ready";
      if (ready) {
        const saved = row; await hosts.close(); hosts = new PreviewHosts({ records, config: spec.config, aws: guardedAws }); await hosts.initialize();
        if (hosts.lookup(saved.hostname) !== null || hosts.get(saved.id, spec.scope).status !== "pending") deny();
        await hosts.reconcile({ limit: 1 }); row = hosts.get(saved.id, spec.scope);
        restartRevalidated = row.status === "ready" && row.distributionId === saved.distributionId && row.hostname === saved.hostname && hosts.lookup(row.hostname)?.id === row.id;
        if (!restartRevalidated) primary = "restart-not-revalidated";
      }
    }
  } catch (error) { primary ||= error instanceof PreviewHostError && error.code === "ownership-mismatch" ? "provider-ownership-rejected" : "acceptance-failed"; }
  finally {
    if (row && roleVerified) {
      try {
        phase = "cleanup"; phaseDeadline = now() + cleanupWaitMs;
        const revoked = hosts.revoke(row.id, spec.scope); immediatelyRevoked = !row.hostname || hosts.lookup(row.hostname) === null; await revoked;
        while (now() < phaseDeadline) {
          await hosts.reconcile({ limit: 1 }); row = hosts.get(row.id, spec.scope);
          if (row.status === "deleted") { deleted = true; break; }
          await sleep(Math.max(0, Math.min(pollMs, phaseDeadline - now())));
        }
      } catch { /* Exact journal retained; failure does not become cleanup success. */ }
    }
    await hosts.close().catch(() => { primary ||= "close-unconfirmed"; });
  }
  const ok = !primary && deleted && immediatelyRevoked && (cleanupOnly || ready && restartRevalidated);
  return { schema: 1, ok, category: primary || (deleted ? null : "cleanup-unconfirmed"), roleVerified, ready, restartRevalidated, immediatelyRevoked, deleted,
    recordId: row?.id || null, distributionId: row?.distributionId || null, hostname: row?.hostname || null, successfulOperations: counts,
    journalRetained: true, productUserConsent: false, productDataUsed: false, applicationTrafficTested: false };
}

async function cli(args) {
  if (!args.length) { console.log(JSON.stringify({ dryRun: true, awsCalls: false, requires: "explicit --run or --cleanup, exact controller-role container, private /acceptance journal, public JSON stdin", productUserConsent: false })); return; }
  if (args.length !== 1 || !["--run", "--cleanup"].includes(args[0]) || process.getuid() !== 1000 ||
    Object.keys(process.env).some(name => name.startsWith("AWS_") && !["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PAGER", "AWS_CLI_AUTO_PROMPT"].includes(name) || /^(?:GOOGLE_CLIENT_SECRET|AUTH_SECRET|AGENT_ENCRYPTION_KEY|DOPPLER_TOKEN|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AGENT_WORKER_SSH_KEY_BASE64)$/.test(name))) deny();
  let inputText = ""; const inputTimer = setTimeout(() => process.stdin.destroy(new Error("Bounded public input required")), 5000);
  try { for await (const chunk of process.stdin) { inputText += chunk; if (Buffer.byteLength(inputText) > 4096) deny(); } } finally { clearTimeout(inputTimer); }
  const input = JSON.parse(inputText), cleanupOnly = args[0] === "--cleanup";
  const records = await AcceptanceJournal.open("/acceptance", input, { cleanupOnly });
  const abort = new AbortController(), cancel = () => abort.abort(); process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  let receipt;
  try { receipt = await runAcceptance(input, records, { signal: abort.signal, cleanupOnly }); }
  finally {
    process.off("SIGTERM", cancel); process.off("SIGINT", cancel);
    try { await records.close(); if (receipt) receipt.journalClosed = true; }
    catch { if (receipt) { receipt.journalClosed = false; receipt.ok = false; receipt.category ||= "journal-close-unconfirmed"; } else throw new Error("Journal close unconfirmed"); }
  }
  console.log(JSON.stringify(receipt)); if (!receipt.ok) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cli(process.argv.slice(2)); } catch { console.error(JSON.stringify({ ok: false, category: "operator-invalid-or-unconfirmed", journalRetained: true, productUserConsent: false })); process.exitCode = 1; }
}
