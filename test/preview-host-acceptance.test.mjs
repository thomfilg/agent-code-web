import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { acceptanceConfig, AcceptanceJournal, runAcceptance } from "../scripts/smoke-preview-hosts.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { PreviewHostError } from "../src/preview-hosts.mjs";

const input = { schema: 1, runId: "11111111-2222-4333-8444-555555555555", expectedRoleArn: "arn:aws:iam::456808212788:role/agent-relay-mvp-ControllerRole-Fixture", vpcOriginId: "vo_fixture", controllerOriginDns: "ip-10-84-1-2.us-east-2.compute.internal" };
function fixture({ fault, records = new MemoryRecords() } = {}) {
  const { config } = acceptanceConfig(input), calls = []; let distribution, clock = 0, attempted = false;
  const aws = async (_config, service, action, args) => {
    calls.push({ service, action, args: structuredClone(args) });
    if (action === "get-caller-identity") return { Account: config.expectedAccount, Arn: `arn:aws:sts::${config.expectedAccount}:assumed-role/${fault === "wrong-role" ? "foreign" : "agent-relay-mvp-ControllerRole-Fixture"}/${config.controllerInstanceId}` };
    if (action === "get-vpc-origin") return { VpcOrigin: { Id: config.vpcOriginId, Arn: `arn:aws:cloudfront::${config.expectedAccount}:vpcorigin/${config.vpcOriginId}`, Status: "Deployed", VpcOriginEndpointConfig: { Name: `${config.deployment}-origin`, Arn: `arn:aws:ec2:${config.region}:${config.expectedAccount}:instance/${config.controllerInstanceId}`, HTTPPort: 8787, OriginProtocolPolicy: "http-only" } } };
    if (action === "describe-instances") return { Reservations: [{ Instances: [{ InstanceId: config.controllerInstanceId, PrivateDnsName: config.controllerOriginDns, Tags: [{ Key: "ManagedBy", Value: "12-apps-ci" }, { Key: "AgentRelayDeployment", Value: config.deployment }] }] }] };
    if (action === "create-distribution-with-tags") {
      assert.equal((await records.list("preview-host"))[0].createAttempted, true);
      if (attempted) throw new PreviewHostError("DistributionAlreadyExists"); attempted = true;
      distribution = { ETag: "v1", Distribution: { Id: "EFIXTURE123", ARN: `arn:aws:cloudfront::${config.expectedAccount}:distribution/EFIXTURE123`, DomainName: "dfixture.cloudfront.net", Status: fault === "never-ready" ? "InProgress" : "Deployed", DistributionConfig: structuredClone(args.DistributionConfigWithTags.DistributionConfig) }, Tags: structuredClone(args.DistributionConfigWithTags.Tags) };
      if (fault === "ambiguous-create") throw Error("PRIVATE-CREATE-DETAILS"); return structuredClone(distribution);
    }
    if (action === "list-distributions") return { DistributionList: { IsTruncated: false, Quantity: distribution ? 1 : 0, Items: distribution ? [{ Id: distribution.Distribution.Id, Comment: distribution.Distribution.DistributionConfig.Comment }] : [] } };
    if (!distribution) throw new PreviewHostError("NoSuchDistribution");
    if (action === "get-distribution") return structuredClone(distribution);
    if (action === "list-tags-for-resource") return { Tags: distribution.Tags };
    if (action === "update-distribution") { assert.equal(args.DistributionConfig.Enabled, false); distribution.Distribution.DistributionConfig = structuredClone(args.DistributionConfig); distribution.Distribution.Status = "Deployed"; distribution.ETag = "v2"; return structuredClone(distribution); }
    if (action === "delete-distribution") {
      const row = (await records.list("preview-host"))[0]; assert.equal(row.deleteRequested, true); assert.equal(distribution.Distribution.DistributionConfig.Enabled, false);
      if (fault === "delete-denied") throw new PreviewHostError("AccessDenied"); distribution = null;
      if (fault === "ambiguous-delete") throw Error("PRIVATE-DELETE-DETAILS"); return {};
    }
    assert.fail(`Unexpected fixed operation ${action}`);
  };
  const run = options => runAcceptance(input, records, { aws, now: () => clock, sleep: async ms => { clock += ms; }, pollMs: 1, createWaitMs: 4, cleanupWaitMs: 6, ...options });
  return { records, calls, run, exists: () => Boolean(distribution) };
}
test("default operator plan performs no AWS or credential reads and strict input fixes target", () => {
  const output = JSON.parse(execFileSync(process.execPath, ["scripts/smoke-preview-hosts.mjs"], { encoding: "utf8", env: { PATH: process.env.PATH } }));
  assert.equal(output.dryRun, true); assert.equal(output.awsCalls, false);
  for (const value of [{ ...input, runId: input.runId + "\n" }, { ...input, expectedRoleArn: input.expectedRoleArn.replace("456808212788", "111122223333") }, { ...input, profile: "admin" }, { ...input, controllerOriginDns: "foreign.example" }]) assert.throws(() => acceptanceConfig(value));
});
test("actual provider state machine creates one, restarts/revalidates, revokes synchronously and confirms deletion", async () => {
  const f = fixture(), receipt = await f.run(); assert.equal(receipt.ok, true); assert.equal(receipt.restartRevalidated, true); assert.equal(receipt.immediatelyRevoked, true); assert.equal(receipt.deleted, true); assert.equal(f.exists(), false);
  assert.deepEqual(receipt.successfulOperations, { create: 1, update: 1, delete: 1 });
  assert.equal(f.calls.filter(c => c.action === "create-distribution-with-tags").length, 1);
  assert.equal(f.calls.at(-1).action, "list-distributions"); assert.equal((await f.records.list("preview-host"))[0].status, "deleted");
  assert.equal(receipt.productUserConsent, false); assert.equal(receipt.applicationTrafficTested, false);
});
test("ambiguous create/delete reuse durable identity and observe exact absence, never duplicate", async () => {
  for (const fault of ["ambiguous-create", "ambiguous-delete"]) {
    const f = fixture({ fault }), receipt = await f.run(); assert.equal(receipt.ok, true); assert.equal(receipt.deleted, true);
    assert.equal(f.calls.filter(c => c.action === "create-distribution-with-tags").length, 1); assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE/);
  }
});
test("wrong controller role has no durable intention or provider mutation", async () => {
  const f = fixture({ fault: "wrong-role" }), receipt = await f.run(); assert.equal(receipt.ok, false); assert.equal(receipt.roleVerified, false); assert.equal(receipt.category, "provider-ownership-rejected");
  assert.equal(f.calls.length, 1); assert.deepEqual(await f.records.list("preview-host"), []);
});
test("failed readiness still cleans up; denied deletion never claims success and keeps exact record", async () => {
  const failed = fixture({ fault: "never-ready" }), a = await failed.run(); assert.equal(a.ok, false); assert.equal(a.category, "create-not-ready"); assert.equal(a.deleted, true);
  const denied = fixture({ fault: "delete-denied" }), b = await denied.run(); assert.equal(b.ok, false); assert.equal(b.deleted, false); assert.equal(b.category, "cleanup-unconfirmed"); assert.equal(denied.exists(), true);
  const row = (await denied.records.list("preview-host"))[0]; assert.equal(row.desired, "deleted"); assert.equal(row.deleteRequested, true); assert.equal(row.distributionId, b.distributionId);
});
test("cancellation preserves primary failure, performs cleanup and resumed journal never creates another", async () => {
  const f = fixture(), signal = AbortSignal.abort(); const first = await f.run({ signal }); assert.equal(first.category, "cancelled"); assert.equal(first.deleted, true); assert.equal(first.ready, false);
  assert.equal(f.calls.some(c => c.action === "create-distribution-with-tags"), false);
  const before = f.calls.length, second = await f.run(); assert.equal(second.ok, false); assert.equal(second.category, "existing-journal-cleanup-only"); assert.equal(second.deleted, true);
  assert.equal(f.calls.slice(before).some(c => c.action === "create-distribution-with-tags"), false);
  assert.equal((await f.run({ cleanupOnly: true })).ok, true);
});
test("private durable journal refuses scope changes/concurrent runs/symlinks and survives reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "preview-journal-test-")); let journal;
  try {
    journal = await AcceptanceJournal.open(directory, input);
    await assert.rejects(AcceptanceJournal.open(directory, input));
    const f = fixture({ records: journal }); const receipt = await f.run(); assert.equal(receipt.ok, true);
    const saved = JSON.parse(await readFile(path.join(directory, "journal.json"), "utf8")); assert.equal(saved.rows[0].status, "deleted");
    await journal.close(); journal = null;
    await assert.rejects(AcceptanceJournal.open(directory, { ...input, runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }));
    journal = await AcceptanceJournal.open(directory, input, { cleanupOnly: true }); assert.equal((await journal.list("preview-host"))[0].id, receipt.recordId); await journal.close(); journal = null;
    await chmod(path.join(directory, "journal.json"), 0o644); await assert.rejects(AcceptanceJournal.open(directory, input));
    await rm(path.join(directory, "journal.json")); await writeFile(path.join(directory, "other.json"), "{}", { mode: 0o600 }); await symlink(path.join(directory, "other.json"), path.join(directory, "journal.json")); await assert.rejects(AcceptanceJournal.open(directory, input));
  } finally { await journal?.close(); await rm(directory, { recursive: true, force: true }); }
});
