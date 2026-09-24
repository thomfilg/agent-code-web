#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
export const backupTarget = Object.freeze({ profile: "code-web", region: "us-east-2", account: "456808212788", stack: "agent-relay-mvp" });
const fail = message => { throw new Error(message); };
const id = (value, prefix) => new RegExp(`^${prefix}-[a-f0-9]{8,17}$`).test(value || "");
const tagsOf = value => Object.fromEntries((value?.Tags || []).map(tag => [tag.Key, tag.Value]));
const stackOwned = value => tagsOf(value).ManagedBy === "12-apps-ci" && tagsOf(value).AgentRelayDeployment === backupTarget.stack;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function awsCall(service, action, args = []) {
  try {
    const { stdout } = await execute("aws", ["--profile", backupTarget.profile, "--region", backupTarget.region, "--no-cli-pager", "--output", "json", service, action, ...args],
      { timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" } });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    if (service === "ssm" && action === "get-command-invocation" && String(error.stderr).includes("InvocationDoesNotExist")) throw Object.assign(Error("SSM pending"), { pending: true });
    if (service === "ec2" && action === "describe-volumes" && String(error.stderr).includes("InvalidVolume.NotFound")) throw Object.assign(Error("Exact volume not found"), { volumeNotFound: true });
    if (service === "ec2" && action === "describe-snapshots" && String(error.stderr).includes("InvalidSnapshot.NotFound")) throw Object.assign(Error("Exact snapshot not found"), { snapshotNotFound: true });
    throw Error(`AWS ${service} ${action} failed; private diagnostics suppressed. Do not blindly repeat mutations.`);
  }
}

export async function verifyBackupTarget(aws) {
  const t = backupTarget;
  if ((await aws("sts", "get-caller-identity")).Account !== t.account) fail("Wrong AWS account; no mutations allowed");
  const { Stacks: stacks } = await aws("cloudformation", "describe-stacks", ["--stack-name", t.stack]);
  const stack = stacks?.[0];
  if (stacks?.length !== 1 || stack.StackName !== t.stack || !stack.StackId?.startsWith(`arn:aws:cloudformation:${t.region}:${t.account}:stack/${t.stack}/`) ||
    !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus) || tagsOf(stack).ManagedBy !== "12-apps-ci") fail("Application stack is not completed and owned");
  const outputs = Object.fromEntries((stack.Outputs || []).map(output => [output.OutputKey, output.OutputValue]));
  const controller = outputs.ControllerInstanceId, source = outputs.DataVolumeId, repository = outputs.ApplicationRepositoryUri;
  if (!id(controller, "i") || !id(source, "vol") || outputs.DeploymentName !== t.stack || !new RegExp(`^${t.account}\\.dkr\\.ecr\\.${t.region}\\.amazonaws\\.com/[a-z0-9][a-z0-9_./-]*$`).test(repository || "")) fail("Unexpected stack outputs");
  const resources = (await aws("cloudformation", "list-stack-resources", ["--stack-name", stack.StackId])).StackResourceSummaries || [];
  if (!resources.some(r => r.LogicalResourceId === "Controller" && r.ResourceType === "AWS::EC2::Instance" && r.PhysicalResourceId === controller) ||
    !resources.some(r => r.LogicalResourceId === "DataVolume" && r.ResourceType === "AWS::EC2::Volume" && r.PhysicalResourceId === source)) fail("Controller/volume are not exact stack resources");
  const instances = (await aws("ec2", "describe-instances", ["--instance-ids", controller])).Reservations?.flatMap(r => r.Instances) || [];
  const volumes = (await aws("ec2", "describe-volumes", ["--volume-ids", source])).Volumes || [], instance = instances[0], volume = volumes[0];
  if (instances.length !== 1 || instance.InstanceId !== controller || instance.State?.Name !== "running" || !stackOwned(instance) || instance.PublicIpAddress || !instance.Placement?.AvailabilityZone?.startsWith(t.region)) fail("Controller identity/network/state mismatch");
  if (volumes.length !== 1 || volume.VolumeId !== source || !volume.Encrypted || !stackOwned(volume) || volume.State !== "in-use" || volume.AvailabilityZone !== instance.Placement.AvailabilityZone ||
    volume.Attachments?.length !== 1 || volume.Attachments[0].InstanceId !== controller || volume.Attachments[0].State !== "attached" || volume.Attachments[0].Device !== "/dev/sdf") fail("Source volume ownership/attachment mismatch");
  if (instance.BlockDeviceMappings?.some(mapping => ["/dev/sdg", "/dev/xvdg"].includes(mapping.DeviceName))) fail("Temporary restore device is occupied");
  return { controller, source, repository, stackId: stack.StackId, zone: volume.AvailabilityZone, size: volume.Size };
}

export async function verifyBackup({ execute: shouldExecute = false } = {}, { aws = awsCall, sleep = pause, log = () => {}, runId = randomUUID(), pollLimit = 240,
  hostScript = null, fingerprintScript = null } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) fail("Invalid backup run ID");
  if (!shouldExecute) return { dryRun: true, ...backupTarget, retainsSnapshot: false, restoresToNewVolume: true, maintenanceGap: true, awsChanges: false };
  hostScript ||= await readFile(new URL("./backup-host.py", import.meta.url), "utf8");
  fingerprintScript ||= await readFile(new URL("./backup-fingerprint.mjs", import.meta.url), "utf8");
  const target = await verifyBackupTarget(aws);
  // The rollout engine labels containers with the immutable stack ARN, not its
  // reusable display name. Validate the same incarnation before stopping it.
  const config = { ...target, stack: target.stackId, run: runId, fingerprintScript: Buffer.from(fingerprintScript).toString("base64") };
  const tags = [{ Key: "ManagedBy", Value: "12-apps-ci" }, { Key: "AgentRelayDeployment", Value: backupTarget.stack },
    { Key: "AgentRelayBackupRun", Value: runId }, { Key: "Purpose", Value: "backup-restore-acceptance" }];
  const tagged = value => stackOwned(value) && tagsOf(value).AgentRelayBackupRun === runId && tagsOf(value).Purpose === "backup-restore-acceptance";
  async function poll(label, check) {
    for (let i = 0; i < pollLimit; i++) { const result = await check(); if (result) return result; await sleep(5000); }
    fail(`Timed out observing ${label}; inspect run ${runId}, do not automatically repeat mutations`);
  }
  async function send(action, extra = {}) {
    const input = Buffer.from(JSON.stringify({ ...config, action, ...extra })).toString("base64");
    // Keep one root-owned helper file so an independent systemd recovery timer
    // can execute it even after SSM cancels/kills this command's process group.
    const bootstrap = `import base64,json,os,re,sys,stat,time
c=json.loads(base64.b64decode(sys.argv[1],validate=True))
assert re.fullmatch(r"[a-f0-9-]{36}",c["run"])
p="/run/relay-backup-code-"+c["run"]+".py"
code=base64.b64decode(sys.argv[2],validate=True)
if c["action"]=="hold":
 fd=os.open(p+".next",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,"wb") as f: f.write(code)
 os.link(p+".next",p)
 os.unlink(p+".next")
 os.close(os.open(p+".ready",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600))
else:
 deadline=time.monotonic()+180
 while not os.path.exists(p+".ready") and time.monotonic()<deadline: time.sleep(1)
s=os.lstat(p)
assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode & 0o077 and s.st_nlink==1
assert open(p,"rb").read()==code
os.execv("/usr/bin/python3",["/usr/bin/python3",p,sys.argv[1]])`;
    const result = await aws("ssm", "send-command", ["--document-name", "AWS-RunShellScript", "--instance-ids", target.controller,
      "--timeout-seconds", "60", "--parameters", JSON.stringify({ commands: [`python3 - '${input}' '${Buffer.from(hostScript).toString("base64")}' <<'RELAY_BACKUP_BOOTSTRAP'\n${bootstrap}\nRELAY_BACKUP_BOOTSTRAP`], executionTimeout: ["900"] }),
      "--cloud-watch-output-config", "CloudWatchOutputEnabled=false", "--comment", `Relay backup ${action} ${runId}`]);
    const command = result.Command?.CommandId;
    if (!/^[a-f0-9-]{36}$/.test(command || "")) fail("SSM command handle unavailable; original controller watchdog will recover; inspect this run");
    log({ stage: action, runId, commandId: command, instanceId: target.controller });
    return command;
  }
  async function completed(command) {
    return poll(`SSM ${command}`, async () => {
      let invocation;
      try { invocation = await aws("ssm", "get-command-invocation", ["--command-id", command, "--instance-id", target.controller]); }
      catch (error) { if (error.pending) return false; throw error; }
      if (["Pending", "InProgress", "Delayed"].includes(invocation.Status)) return false;
      if (invocation.Status !== "Success" || invocation.ResponseCode !== 0) {
        let diagnostic = "";
        try {
          const receipt = JSON.parse(invocation.StandardOutputContent);
          const stages = ["inspect", "controller", "device", "validate_source", "audit_other_writers", "http", "state", "save", "fingerprint", "recover", "arm_recovery", "disarm_recovery", "watchdog", "hold", "cleanup_restore", "restore", "run", "unknown"];
          const failures = ["BackupError", "FileNotFoundError", "PermissionError", "ValueError", "KeyError", "OSError", "JSONDecodeError", "unknown"];
          if (stages.includes(receipt.stage) && failures.includes(receipt.failure)) diagnostic = `; stage=${receipt.stage}; failure=${receipt.failure}`;
        } catch {}
        fail(`Backup host failed for command ${command}; private output suppressed${diagnostic}`);
      }
      try { return JSON.parse(invocation.StandardOutputContent); } catch { fail("Invalid backup host result"); }
    });
  }
  const host = async (action, extra) => completed(await send(action, extra));
  let holdCommand, snapshotId, restoreId, sourceRecovered = false, verified = false, cleanupConfirmed = false;
  async function snapshot() {
    const values = (await aws("ec2", "describe-snapshots", ["--snapshot-ids", snapshotId])).Snapshots || [], value = values[0];
    if (values.length !== 1 || value.SnapshotId !== snapshotId || value.OwnerId !== backupTarget.account || value.VolumeId !== target.source || !value.Encrypted || !tagged(value)) fail("Backup snapshot ownership/source mismatch");
    return value;
  }
  async function restoreVolume() {
    if (!id(restoreId, "vol") || restoreId === target.source) fail("Unsafe restore volume target");
    const values = (await aws("ec2", "describe-volumes", ["--volume-ids", restoreId])).Volumes || [], value = values[0];
    if (values.length !== 1 || value.VolumeId !== restoreId || value.SnapshotId !== snapshotId || !value.Encrypted || value.AvailabilityZone !== target.zone || value.Size !== target.size || !tagged(value) ||
      (value.Attachments || []).some(a => a.InstanceId !== target.controller || a.Device !== "/dev/sdg")) fail("Restore volume ownership/source/attachment mismatch; no cleanup attempted");
    return value;
  }
  try {
    holdCommand = await send("hold");
    try {
      const prepared = await host("probe");
      if (prepared.phase !== "snapshot-ready" || prepared.run !== runId || prepared.source !== target.source || !prepared.fingerprint?.encryptionVerified) fail("Backup lease is not ready for a cold snapshot");
      const created = await aws("ec2", "create-snapshot", ["--volume-id", target.source, "--description", `Relay ${runId} cold encrypted backup`, "--tag-specifications", JSON.stringify([{ ResourceType: "snapshot", Tags: tags }])]);
      snapshotId = created.SnapshotId;
      if (!id(snapshotId, "snap")) fail("Snapshot outcome ambiguous; retain resources and inspect this run");
      log({ stage: "snapshot-created", runId, snapshotId });
      if (!["pending", "completed"].includes((await snapshot()).State)) fail("Snapshot is not capturing the cold source");
    } finally {
      await host("release");
      const recovered = await completed(holdCommand);
      if (recovered.phase !== "recovered" || recovered.run !== runId) fail("Original controller recovery not confirmed");
      sourceRecovered = true;
    }
    await poll("snapshot completion", async () => { const value = await snapshot(); if (value.State === "error") fail("Snapshot failed"); return value.State === "completed"; });
    const created = await aws("ec2", "create-volume", ["--snapshot-id", snapshotId, "--availability-zone", target.zone, "--encrypted", "--volume-type", "gp3", "--client-token", runId,
      "--tag-specifications", JSON.stringify([{ ResourceType: "volume", Tags: tags }])]);
    restoreId = created.VolumeId;
    if (!id(restoreId, "vol") || restoreId === target.source) fail("Restore volume outcome ambiguous; inspect exact run tags");
    log({ stage: "restore-volume-created", runId, snapshotId, volumeId: restoreId });
    await poll("restore volume availability", async () => (await restoreVolume()).State === "available");
    await aws("ec2", "attach-volume", ["--volume-id", restoreId, "--instance-id", target.controller, "--device", "/dev/sdg"]);
    await poll("restore attachment", async () => (await restoreVolume()).Attachments?.[0]?.State === "attached");
    const result = await host("restore", { restore: restoreId });
    if (result.ok !== true || result.run !== runId || result.originalRecovered !== true || !result.fingerprint?.encryptionVerified) fail("Restore fingerprint verification did not pass");
    verified = true;
    return { verified, runId, snapshotId, originalRecovered: sourceRecovered, fingerprint: result.fingerprint, snapshotRetained: false, temporaryVolumeRemoved: true };
  } finally {
    // A failed/ambiguous host cleanup must never lead to force-detach/delete.
    // A failed/ambiguous restore-volume cleanup retains the snapshot for manual
    // inspection. A successful verification leaves no chat-bearing copy behind.
    if (restoreId && restoreId !== target.source && id(restoreId, "vol")) {
      const volume = await restoreVolume();
      const cleanup = await host("cleanup", { restore: restoreId });
      cleanupConfirmed = cleanup.ok === true && cleanup.restoreUnmounted === restoreId && cleanup.run === runId;
      if (!cleanupConfirmed) fail("Restore unmount is unconfirmed; volume retained for manual inspection");
      if (volume.Attachments?.length) {
        await restoreVolume();
        await aws("ec2", "detach-volume", ["--volume-id", restoreId, "--instance-id", target.controller, "--device", "/dev/sdg"]);
      }
      await poll("safe restore detach", async () => { const value = await restoreVolume(); return value.State === "available" && !value.Attachments?.length; });
      await aws("ec2", "delete-volume", ["--volume-id", restoreId]);
      await poll("restore volume deletion", async () => {
        try { await restoreVolume(); return false; }
        catch (error) { if (error.volumeNotFound) return true; throw error; }
      });
      log({ stage: "restore-volume-removed", runId, volumeId: restoreId, snapshotId, verified });
    }
    if (snapshotId && sourceRecovered && (!restoreId || cleanupConfirmed)) {
      await snapshot();
      await aws("ec2", "delete-snapshot", ["--snapshot-id", snapshotId]);
      await poll("backup snapshot deletion", async () => {
        try { await snapshot(); return false; }
        catch (error) { if (error.snapshotNotFound) return true; throw error; }
      });
      log({ stage: "snapshot-removed", runId, snapshotId, verified });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.length && !["--run", "--dry-run"].includes(args[0])) fail("Usage: node deploy/aws/verify-backup.mjs [--dry-run|--run]");
    console.log(JSON.stringify(await verifyBackup({ execute: args[0] === "--run" }, { log: value => console.log(JSON.stringify(value)) })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
