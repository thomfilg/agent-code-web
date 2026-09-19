import assert from "node:assert/strict";
import test from "node:test";
import { backupTarget, verifyBackup, verifyBackupTarget } from "../deploy/aws/verify-backup.mjs";
import { fingerprintRows, fingerprintDatabase } from "../deploy/aws/backup-fingerprint.mjs";
import { RecordCipher, openDatabase } from "../src/database.mjs";
import { temporaryDirectory } from "./helpers.mjs";
import net from "node:net";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";

const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", controller = "i-0123456789abcdef0", source = "vol-0123456789abcdef0", restore = "vol-abcdef01234567890", snapshot = "snap-0123456789abcdef0";
const tags = [{ Key: "ManagedBy", Value: "12-apps-ci" }, { Key: "AgentRelayDeployment", Value: backupTarget.stack }];
const runTags = [...tags, { Key: "AgentRelayBackupRun", Value: runId }, { Key: "Purpose", Value: "backup-restore-acceptance" }];
const fingerprint = { version: 1, records: 1, recordsSha256: "a".repeat(64), attachments: 0, attachmentBytes: 0, attachmentsSha256: "b".repeat(64), encryptionVerified: true };
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); });
function fixture({ bad = null, fails = null } = {}) {
  const calls = [], commands = new Map(); let n = 0, attached = false, deleted = false;
  const aws = async (service, action, args = []) => {
    calls.push({ service, action, args });
    if (fails === action) throw Error("injected provider failure");
    const val = flag => args[args.indexOf(flag) + 1];
    if (action === "get-caller-identity") return { Account: bad === "account" ? "000000000000" : backupTarget.account };
    if (action === "describe-stacks") return { Stacks: [{ StackName: backupTarget.stack, StackId: `arn:aws:cloudformation:${backupTarget.region}:${backupTarget.account}:stack/${backupTarget.stack}/fixture`, StackStatus: "CREATE_COMPLETE", Tags: bad === "stack" ? [] : tags,
      Outputs: Object.entries({ ControllerInstanceId: controller, DataVolumeId: source, DeploymentName: backupTarget.stack, ApplicationRepositoryUri: `${backupTarget.account}.dkr.ecr.${backupTarget.region}.amazonaws.com/relay` }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] };
    if (action === "list-stack-resources") return { StackResourceSummaries: bad === "resources" ? [] : [{ LogicalResourceId: "Controller", ResourceType: "AWS::EC2::Instance", PhysicalResourceId: controller }, { LogicalResourceId: "DataVolume", ResourceType: "AWS::EC2::Volume", PhysicalResourceId: source }] };
    if (action === "describe-instances") return { Reservations: [{ Instances: [{ InstanceId: controller, State: { Name: "running" }, Tags: bad === "controller" ? [] : tags, Placement: { AvailabilityZone: "us-east-2a" }, BlockDeviceMappings: bad === "occupied" ? [{ DeviceName: "/dev/sdg" }] : [] }] }] };
    if (action === "describe-volumes") {
      if (deleted && bad !== "delete-visible" && val("--volume-ids") === restore) throw Object.assign(Error("not found"), { volumeNotFound: true });
      const volume = val("--volume-ids") === source ? { VolumeId: source, Encrypted: bad !== "encrypted", Tags: bad === "volume" ? [] : tags, State: "in-use", AvailabilityZone: "us-east-2a", Size: 40, Attachments: [{ InstanceId: controller, State: "attached", Device: "/dev/sdf" }] }
        : { VolumeId: restore, SnapshotId: snapshot, Encrypted: true, Tags: bad === "restore-owner" ? [] : runTags, State: attached ? "in-use" : "available", AvailabilityZone: "us-east-2a", Size: 40, Attachments: attached ? [{ InstanceId: controller, State: "attached", Device: "/dev/sdg" }] : [] };
      return { Volumes: [volume] };
    }
    if (action === "send-command") {
      const script = JSON.parse(val("--parameters")).commands[0], payload = JSON.parse(Buffer.from(script.match(/^python3 - '([^']+)'/)[1], "base64").toString());
      assert.equal(payload.stack, `arn:aws:cloudformation:${backupTarget.region}:${backupTarget.account}:stack/${backupTarget.stack}/fixture`, "Host ownership must match the rollout's immutable stack ARN label");
      const command = `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
      commands.set(command, payload.action);
      if (fails === `host-${payload.action}`) commands.set(command, "failure");
      return { Command: { CommandId: command } };
    }
    if (action === "get-command-invocation") {
      const step = commands.get(val("--command-id"));
      if (step === "failure") return { Status: "Failed", ResponseCode: 1, StandardOutputContent: "private-host-output" };
      const result = step === "probe" ? { phase: "snapshot-ready", run: runId, source, fingerprint }
        : step === "hold" ? { phase: "recovered", run: runId } : step === "cleanup" ? { ok: true, run: runId, restoreUnmounted: restore }
        : step === "restore" ? { ok: true, run: runId, originalRecovered: true, fingerprint } : { ok: true };
      return { Status: "Success", ResponseCode: 0, StandardOutputContent: JSON.stringify(result) };
    }
    if (action === "create-snapshot") return { SnapshotId: snapshot };
    if (action === "describe-snapshots") return { Snapshots: [{ SnapshotId: snapshot, VolumeId: source, OwnerId: backupTarget.account, Encrypted: true, Tags: runTags, State: "completed" }] };
    if (action === "create-volume") return { VolumeId: restore };
    if (action === "attach-volume") { attached = true; return {}; }
    if (action === "detach-volume") { attached = false; return {}; }
    if (action === "delete-volume") { deleted = true; return {}; }
    throw Error(`unexpected fixture ${service} ${action}`);
  };
  return { calls, commands, aws, options: { aws, runId, sleep: async () => {}, pollLimit: 2, hostScript: "# static fixture", fingerprintScript: "// static fixture" } };
}

test("backup plan is AWS-free and target identity/resources fail closed before mutation", async () => {
  const plan = fixture(); assert.equal((await verifyBackup({}, plan.options)).awsChanges, false); assert.equal(plan.calls.length, 0);
  for (const bad of ["account", "stack", "resources", "controller", "encrypted", "volume", "occupied"]) {
    const f = fixture({ bad }); await assert.rejects(verifyBackup({ execute: true }, f.options));
    assert.ok(f.calls.every(call => !["send-command", "create-snapshot", "create-volume"].includes(call.action)));
  }
});

test("cold snapshot restores to a distinct encrypted volume, proves fingerprint and cleans only its exact temporary copy", async () => {
  const f = fixture(), result = await verifyBackup({ execute: true }, f.options);
  assert.deepEqual(result.fingerprint, fingerprint); assert.equal(result.snapshotId, snapshot); assert.equal(result.temporaryVolumeRemoved, true);
  assert.deepEqual([...f.commands.values()], ["hold", "probe", "release", "restore", "cleanup"]);
  const actions = f.calls.map(c => c.action);
  assert.ok(actions.indexOf("create-snapshot") < actions.indexOf("create-volume"));
  assert.ok(f.calls.find(c => c.action === "create-volume").args.includes("--encrypted"));
  for (const action of ["attach-volume", "detach-volume", "delete-volume"]) assert.ok(f.calls.find(c => c.action === action).args.includes(restore));
  assert.equal(actions.includes("delete-snapshot"), false);
  assert.equal(f.calls.some(c => c.action === "delete-volume" && c.args.includes(source)), false);
});

test("snapshot failure still releases and recovers the original; no restore resource is created", async () => {
  const f = fixture({ fails: "create-snapshot" }); await assert.rejects(verifyBackup({ execute: true }, f.options));
  assert.deepEqual([...f.commands.values()], ["hold", "probe", "release"]);
  assert.ok(f.calls.some(c => c.action === "get-command-invocation" && c.args.includes([...f.commands.keys()][0])));
  assert.equal(f.calls.some(c => c.action === "create-volume"), false);
});

test("verification failure cleans its copy but retains snapshot; unknown cleanup never force-detaches", async () => {
  for (const fails of ["host-restore", "host-cleanup"]) {
    const f = fixture({ fails }); await assert.rejects(verifyBackup({ execute: true }, f.options), error => !error.message.includes("private-host-output"));
    assert.equal(f.calls.some(c => c.action === "delete-snapshot"), false);
    assert.equal(f.calls.some(c => c.action === "delete-volume"), fails !== "host-cleanup");
    assert.equal(f.calls.some(c => c.args.includes("--force")), false);
  }
});

test("foreign restore tags prevent attaching or deleting the volume", async () => {
  const f = fixture({ bad: "restore-owner" }); await assert.rejects(verifyBackup({ execute: true }, f.options), /ownership/);
  assert.equal(f.calls.some(c => ["attach-volume", "delete-volume", "detach-volume"].includes(c.action)), false);
});

test("delete acceptance without observed disappearance is never reported as completed cleanup", async () => {
  const f = fixture({ bad: "delete-visible" });
  await assert.rejects(verifyBackup({ execute: true }, f.options), /Timed out observing restore volume deletion/);
  assert.equal(f.calls.filter(call => call.action === "delete-volume").length, 1);
});

test("fingerprints verify every encrypted payload and attachment without returning names, IDs or data", () => {
  const cipher = new RecordCipher(Buffer.alloc(32, 4)), rows = [
    { kind: "attachment", id: "private-id", value: { name: "private-name", data: Buffer.from("private-content").toString("base64"), size: 15 } },
    { kind: "system", id: "encryption-check", value: { ok: true } },
  ].map(({ value, ...row }) => ({ ...row, payload: cipher.seal(row.kind, row.id, value) }));
  const result = fingerprintRows(rows, cipher); assert.equal(result.records, 2); assert.equal(result.attachments, 1); assert.equal(result.attachmentBytes, 15);
  assert.doesNotMatch(JSON.stringify(result), /private-/); assert.throws(() => fingerprintRows(rows, new RecordCipher(Buffer.alloc(32, 5))));
  assert.throws(() => fingerprintRows(rows.slice(0, 1), cipher), /Encryption verification/);
});

test("database-only reader verifies a real embedded PostgreSQL copy without initializing or modifying Relay records", async t => {
  const root = await temporaryDirectory(t), directory = path.join(root, "source"), restored = path.join(root, "restored"), port = await freePort();
  const records = await openDatabase({ mode: "embedded", directory, port });
  await records.put("attachment", "fixture", { size: 3, data: "YWJj" }); await records.put("backup-fixture", "one", { value: "fixture-only" });
  const before = (await records.pool.query("SELECT payload FROM relay_records ORDER BY kind,id")).rows.map(row => row.payload.toString("hex"));
  await records.close();
  const first = await fingerprintDatabase({ directory, port }); await cp(directory, restored, { recursive: true });
  const second = await fingerprintDatabase({ directory: restored, port }); assert.deepEqual(second, first); assert.equal(second.records, 3);
  const reopened = await openDatabase({ mode: "embedded", directory, port });
  try { assert.deepEqual((await reopened.pool.query("SELECT payload FROM relay_records ORDER BY kind,id")).rows.map(row => row.payload.toString("hex")), before); }
  finally { await reopened.close(); }
  await assert.rejects(fingerprintDatabase({ directory: path.join(root, "missing"), port }));
});

test("host helper contains no formatting, force detach, host environment output or Relay app startup", async () => {
  const code = await readFile(new URL("../deploy/aws/backup-host.py", import.meta.url), "utf8");
  assert.match(code, /12-apps-controller-rollout\.lock/); assert.match(code, /"--network", "none"/); assert.match(code, /"--entrypoint", "node"/);
  assert.doesNotMatch(code, /mkfs\.|"--force"|src\/server\.mjs|docker.*logs/);
});
