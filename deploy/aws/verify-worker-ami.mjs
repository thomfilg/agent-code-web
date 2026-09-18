#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const privateIp = value => isIP(value) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
const tagsOf = resource => Object.fromEntries((resource?.Tags || []).map(({ Key, Value }) => [Key, Value]));
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const imageTags = { ManagedBy: "agent-relay", CodexVersion: "0.154.0", ClaudeVersion: "2.1.222" };
const probeFailureCategories = new Set(["worker-user", "native-version", "image-audit", "heartbeat", "sentinel", "invalid-receipt", "ssh-host-key", "ssh-permission-denied", "ssh-connection-refused", "ssh-network-unreachable", "remote-command-missing", "ssh-transport", "remote-command-failed", "ssh-probe-timeout", "ssh-executable-unavailable"]);

function safeProbeFailure(output) {
  try {
    const diagnostic = JSON.parse(output).diagnostic;
    if (diagnostic?.stage !== "worker-probe" || !probeFailureCategories.has(diagnostic.category)) return "";
    const checks = ["finalized", "cloudInitDisabled", "ssmDisabled", "credentialsAbsent", "transportKeyMatches", "metadataReachable", "freshIdentity", "heartbeatEnabled", "watchdogActive"];
    const audit = diagnostic.category === "image-audit" ? checks.filter(key => typeof diagnostic.auditChecks?.[key] === "boolean").map(key => `${key}=${diagnostic.auditChecks[key]}`) : [];
    const categories = ["providerAuthFiles", "sshPrivateKeyFiles", "pemFiles", "ssmLibraryFiles", "ssmSnapFiles", "ssmSnapshotFiles", "ssmPackageFiles", "unexpectedAuthorizedKeys", "scanErrors"];
    const counts = diagnostic.category === "image-audit" ? categories.filter(key => Number.isInteger(diagnostic.credentialFailureCounts?.[key]) && diagnostic.credentialFailureCounts[key] >= 0 && diagnostic.credentialFailureCounts[key] <= 1000000).map(key => `${key}=${diagnostic.credentialFailureCounts[key]}`) : [];
    const metadata = diagnostic.category === "image-audit" && ["token-endpoint-accessible", "http-403-denied", "http-401-unauthorized", "unexpected-http-response", "network-unavailable", "unexpected-network-error"].includes(diagnostic.metadataProbe) ? diagnostic.metadataProbe : "";
    return `; ${diagnostic.category}${Number.isInteger(diagnostic.exitCode) && diagnostic.exitCode >= -255 && diagnostic.exitCode <= 255 ? ` (exit ${diagnostic.exitCode})` : ""}${audit.length ? `; audit checks: ${audit.join(", ")}` : ""}${counts.length ? `; credential counts: ${counts.join(", ")}` : ""}${metadata ? `; metadata probe: ${metadata}` : ""}`;
  } catch { return ""; }
}

export function parseVerificationOptions(args) {
  const options = { profile: "", dryRun: false };
  const names = { "--profile": "profile", "--region": "region", "--expected-account": "account", "--deployment": "deployment", "--image-id": "imageId" };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--dry-run") { options.dryRun = true; continue; }
    const key = names[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Unknown/incomplete acceptance argument: ${args[index]}`);
    options[key] = args[++index];
  }
  for (const [key, pattern] of Object.entries({ account: /^\d{12}$/, deployment: /^[A-Za-z][A-Za-z0-9-]{0,127}$/, region: /^[a-z]{2}(?:-[a-z]+)+-\d$/, imageId: /^ami-[a-f0-9]{8,17}$/ })) if (!pattern.test(options[key] || "")) throw new Error(`Missing/invalid acceptance argument: ${key}`);
  return options;
}

export function verifyReceipt(receipt, { verificationId, workerId, phase, previous } = {}) {
  if (receipt?.schema !== 1 || receipt.verificationId !== verificationId || receipt.workerId !== workerId || receipt.phase !== phase || receipt.heartbeatFresh !== true || receipt.sentinelPresent !== true || receipt.versions?.codex !== "codex-cli 0.154.0" || receipt.versions?.claude !== "2.1.222 (Claude Code)") throw new Error("Worker acceptance receipt is incomplete or belongs to another probe");
  const audit = receipt.audit;
  for (const key of ["valid", "finalized", "cloudInitDisabled", "ssmDisabled", "credentialsAbsent", "transportKeyMatches", "freshIdentity", "heartbeatEnabled", "watchdogActive"]) if (audit?.[key] !== true) throw new Error(`Worker image acceptance failed: ${key}`);
  if (audit.schema !== 1 || audit.metadataReachable !== false || !/^[a-f0-9]{64}$/.test(audit.machine || "") || !audit.hostKeys || !Object.keys(audit.hostKeys).length || Object.entries(audit.hostKeys).some(([key, value]) => !/^ssh_host_(rsa|ecdsa|ed25519)_key\.pub$/.test(key) || !/^[a-f0-9]{64}$/.test(value))) throw new Error("Worker identity or metadata audit is invalid");
  const knownHosts = receipt.knownHosts;
  if (typeof knownHosts !== "string" || knownHosts.length > 4096 || !knownHosts.trim().split("\n").every(line => new RegExp(`^verify-${workerId} (?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+$`).test(line))) throw new Error("Worker acceptance lacks a pinned public SSH host identity");
  if (previous && (previous.audit.machine !== audit.machine || Object.keys(previous.audit.hostKeys).length !== Object.keys(audit.hostKeys).length || Object.entries(previous.audit.hostKeys).some(([key, value]) => audit.hostKeys[key] !== value) || previous.knownHosts !== knownHosts)) throw new Error("Worker machine/SSH identity changed across stop/start");
  return receipt;
}

async function defaultRun(args) {
  try { return (await execute(process.env.AWS_BIN || "aws", args, { timeout: 65_000, maxBuffer: 1_048_576, env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" } })).stdout.trim(); }
  catch (error) {
    if (String(error.stderr).includes("InvocationDoesNotExist")) throw new Error("InvocationDoesNotExist");
    throw new Error("AWS worker acceptance command failed; private diagnostics suppressed");
  }
}

export async function verifyWorkerImage(o, { run = defaultRun, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {}, pollLimit = 90 } = {}) {
  if (o.dryRun) return { dryRun: true, account: o.account, deployment: o.deployment, imageId: o.imageId, region: o.region, actions: ["preflight", "private-worker-launch", "controller-SSM-SSH-audit", "stop-start-persistence", "terminate-exact-test-worker"], promptsSent: false, accountImports: false };
  const aws = (...args) => run([...(o.profile ? ["--profile", o.profile] : []), "--region", o.region, "--no-cli-pager", ...args]);
  const json = async (...args) => JSON.parse(await aws(...args, "--output", "json"));
  const identity = await json("sts", "get-caller-identity");
  if (identity.Account !== o.account) throw new Error("Unexpected AWS account; no acceptance resources changed");
  const stacks = await json("cloudformation", "describe-stacks", "--stack-name", o.deployment, "--query", "Stacks");
  const stack = stacks?.[0];
  if (stacks?.length !== 1 || stack.StackName !== o.deployment || !stack.StackId?.includes(`:cloudformation:${o.region}:${o.account}:stack/${o.deployment}/`) || !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus) || tagsOf(stack).ManagedBy !== "12-apps-ci") throw new Error("Acceptance requires the exact completed deployment stack");
  const outputs = Object.fromEntries((stack.Outputs || []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  if (outputs.DeploymentName !== o.deployment) throw new Error("Unexpected deployment output");
  const resources = await json("cloudformation", "list-stack-resources", "--stack-name", o.deployment, "--query", "StackResourceSummaries");
  const resource = (logical, type) => {
    const matched = resources.filter(item => item.LogicalResourceId === logical && item.ResourceType === type);
    if (matched.length !== 1) throw new Error(`Missing exact stack-owned resource: ${logical}`);
    return matched[0].PhysicalResourceId;
  };
  for (const [output, logical, type] of [["ControllerInstanceId", "Controller", "AWS::EC2::Instance"], ["SecretArn", "ApplicationSecret", "AWS::SecretsManager::Secret"], ["WorkerSubnetId", "WorkerSubnet", "AWS::EC2::Subnet"], ["WorkerSecurityGroupId", "WorkerGroup", "AWS::EC2::SecurityGroup"], ["WorkerKeyName", "WorkerKey", "AWS::EC2::KeyPair"]]) if (!outputs[output] || outputs[output] !== resource(logical, type)) throw new Error(`Unowned acceptance output: ${output}`);
  if (!outputs.SecretArn.startsWith(`arn:aws:secretsmanager:${o.region}:${o.account}:secret:`)) throw new Error("Unexpected controller secret account/region");
  const owned = object => tagsOf(object).ManagedBy === "12-apps-ci" && tagsOf(object).AgentRelayDeployment === o.deployment;
  const subnets = await json("ec2", "describe-subnets", "--subnet-ids", outputs.WorkerSubnetId, "--query", "Subnets");
  const groups = await json("ec2", "describe-security-groups", "--group-ids", outputs.WorkerSecurityGroupId, "--query", "SecurityGroups");
  if (subnets?.length !== 1 || groups?.length !== 1 || !owned(subnets[0]) || !owned(groups[0]) || subnets[0].SubnetId !== outputs.WorkerSubnetId || groups[0].GroupId !== outputs.WorkerSecurityGroupId || subnets[0].OwnerId !== o.account || groups[0].OwnerId !== o.account || subnets[0].MapPublicIpOnLaunch || subnets[0].VpcId !== groups[0].VpcId) throw new Error("Acceptance worker network is not private/deployment-owned");
  const controllerGroup = resource("ControllerGroup", "AWS::EC2::SecurityGroup");
  const ingress = groups[0].IpPermissions;
  if (ingress?.length !== 1 || ingress[0].IpProtocol !== "tcp" || ingress[0].FromPort !== 22 || ingress[0].ToPort !== 22 || ingress[0].UserIdGroupPairs?.length !== 1 || ingress[0].UserIdGroupPairs[0].GroupId !== controllerGroup || ingress[0].IpRanges?.length || ingress[0].Ipv6Ranges?.length || ingress[0].PrefixListIds?.length) throw new Error("Acceptance permits only controller-to-worker SSH ingress");
  const images = await json("ec2", "describe-images", "--image-ids", o.imageId, "--owners", o.account, "--query", "Images");
  const image = images?.[0], tags = tagsOf(image);
  // Canonical images retain optional instance-store hints. The fixed t3.medium
  // verifier has no instance store; require an encrypted EBS root/all EBS disks
  // without treating those inert ephemeral hints as unencrypted EBS volumes.
  const mappings = image?.BlockDeviceMappings || [];
  const rootDisks = mappings.filter(mapping => mapping.DeviceName === image?.RootDeviceName && mapping.Ebs);
  const disksValid = image?.RootDeviceType === "ebs" && rootDisks.length === 1 && mappings.every(mapping => mapping.Ebs
    ? mapping.Ebs.Encrypted === true && !mapping.VirtualName && !Object.hasOwn(mapping, "NoDevice")
    : /^ephemeral\d+$/.test(mapping.VirtualName || "") && /^\/dev\/sd[b-z]$/.test(mapping.DeviceName || "") && !Object.hasOwn(mapping, "NoDevice"));
  if (images?.length !== 1 || image.ImageId !== o.imageId || image.OwnerId !== o.account || image.State !== "available" || image.Architecture !== "x86_64" || image.Public || !disksValid || Object.entries({ ...imageTags, AgentRelayDeployment: o.deployment, AgentRelayWorkerKey: outputs.WorkerKeyName }).some(([key, value]) => tags[key] !== value)) throw new Error("Acceptance requires a private encrypted pinned AMI owned by this deployment");
  const keys = await json("ec2", "describe-key-pairs", "--key-names", outputs.WorkerKeyName, "--include-public-key", "--query", "KeyPairs");
  const publicKey = keys?.[0]?.PublicKey?.trim();
  if (keys?.length !== 1 || keys[0].KeyName !== outputs.WorkerKeyName || !owned(keys[0]) || !/^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(publicKey || "")) throw new Error("Acceptance key must belong to this deployment");
  async function controller() {
    const instances = await json("ec2", "describe-instances", "--instance-ids", outputs.ControllerInstanceId, "--query", "Reservations[].Instances[]");
    const current = instances?.[0];
    if (instances?.length !== 1 || current.InstanceId !== outputs.ControllerInstanceId || !owned(current) || current.State?.Name !== "running" || current.PublicIpAddress || current.SubnetId !== resource("ControllerSubnet", "AWS::EC2::Subnet") || current.SecurityGroups?.length !== 1 || current.SecurityGroups[0].GroupId !== controllerGroup || current.IamInstanceProfile?.Arn !== `arn:aws:iam::${o.account}:instance-profile/${resource("ControllerProfile", "AWS::IAM::InstanceProfile")}`) throw new Error("Controller is not a running private instance owned by this deployment");
  }
  await controller();
  const controllerScript = await readFile(new URL("verify-worker-controller.py", import.meta.url), "utf8");
  const verificationId = randomUUID(), sentinel = randomUUID(), chatId = `chat_${randomBytes(16).toString("hex")}`;
  let workerId;
  let workerHost;
  let cleaned = false;
  async function worker(terminationObservation = false) {
    const matches = await json("ec2", "describe-instances", "--instance-ids", workerId, "--query", "Reservations[].Instances[]");
    const current = matches?.[0], currentTags = tagsOf(current);
    if (matches?.length !== 1 || current.InstanceId !== workerId || currentTags.ManagedBy !== "agent-relay" || currentTags.AgentRelayDeployment !== o.deployment || currentTags.AgentRelayVerification !== verificationId || currentTags.AgentWebChat !== chatId || current.ImageId !== o.imageId) throw new Error("Test worker ownership changed; refusing mutation");
    // EC2 releases interfaces during shutting-down, not only after terminated.
    // This reduced check is read-only: no mutation can follow it without a new
    // strict check, and immutable identity plus every ownership tag still match.
    if (!(terminationObservation && ["shutting-down", "terminated"].includes(current.State?.Name)) && (current.SubnetId !== outputs.WorkerSubnetId || current.SecurityGroups?.length !== 1 || current.SecurityGroups[0].GroupId !== outputs.WorkerSecurityGroupId || current.KeyName !== outputs.WorkerKeyName || current.IamInstanceProfile || current.PublicIpAddress || current.MetadataOptions?.HttpEndpoint !== "disabled")) throw new Error("Test worker isolation changed; refusing mutation");
    return current;
  }
  async function poll(description, check) {
    for (let attempt = 0; attempt < pollLimit; attempt++) {
      const value = await check();
      if (value) return value;
      if (attempt % 12 === 0) log(`Waiting for ${description}...`);
      await sleep(5000);
    }
    throw new Error(`Acceptance timed out: ${description}`);
  }
  async function probe(phase, previous) {
    await controller();
    const current = await worker();
    if (current.State?.Name !== "running" || !privateIp(current.PrivateIpAddress)) throw new Error("Test worker is not privately reachable/running");
    workerHost = current.PrivateIpAddress;
    const payload = { account: o.account, region: o.region, secretArn: outputs.SecretArn, verificationId, workerId, host: workerHost, publicKey, phase, sentinel, ...(previous ? { knownHosts: previous.knownHosts } : {}) };
    const code = `import base64;exec(base64.b64decode('${Buffer.from(controllerScript).toString("base64")}'))`;
    const command = `python3 -I -c ${quote(code)} ${quote(Buffer.from(JSON.stringify(payload)).toString("base64"))}`;
    const sent = await json("ssm", "send-command", "--instance-ids", outputs.ControllerInstanceId, "--document-name", "AWS-RunShellScript", "--timeout-seconds", "120", "--parameters", JSON.stringify({ commands: [command], executionTimeout: ["420"] }));
    const commandId = sent.Command?.CommandId;
    if (!/^[a-f0-9-]{36}$/.test(commandId || "")) throw new Error("Acceptance SSM did not return a command ID");
    const result = await poll(`${phase} worker audit`, async () => {
      let invocation;
      try { invocation = await json("ssm", "get-command-invocation", "--instance-id", outputs.ControllerInstanceId, "--command-id", commandId); }
      catch (error) { if (error.message === "InvocationDoesNotExist") return false; throw error; }
      if (["Pending", "InProgress", "Delayed"].includes(invocation.Status)) return false;
      if (invocation.Status !== "Success" || invocation.ResponseCode !== 0) throw new Error(`Worker acceptance audit failed (${phase})${safeProbeFailure(invocation.StandardOutputContent)}; inspect scoped SSM command ${commandId}; private output suppressed`);
      try { return verifyReceipt(JSON.parse(invocation.StandardOutputContent), { verificationId, workerId, phase, previous }); }
      catch { throw new Error(`Worker acceptance receipt failed validation (${phase}); no private output emitted`); }
    });
    return { ...result, commandId };
  }
  let receipt;
  let primaryFailure;
  try {
    const Tags = [{ Key: "ManagedBy", Value: "agent-relay" }, { Key: "AgentRelayDeployment", Value: o.deployment }, { Key: "AgentRelayVerification", Value: verificationId }, { Key: "AgentWebChat", Value: chatId }, { Key: "Name", Value: `${o.deployment}-image-verification` }];
    const launched = await json("ec2", "run-instances", "--image-id", o.imageId, "--instance-type", "t3.medium", "--client-token", verificationId,
      "--network-interfaces", JSON.stringify([{ DeviceIndex: 0, SubnetId: outputs.WorkerSubnetId, Groups: [outputs.WorkerSecurityGroupId], AssociatePublicIpAddress: false, DeleteOnTermination: true }]),
      "--key-name", outputs.WorkerKeyName, "--metadata-options", "HttpTokens=required,HttpEndpoint=disabled", "--instance-initiated-shutdown-behavior", "stop", "--credit-specification", "CpuCredits=standard",
      "--block-device-mappings", JSON.stringify([{ DeviceName: image.RootDeviceName, Ebs: { VolumeType: "gp3", VolumeSize: Math.max(20, rootDisks[0].Ebs.VolumeSize || 20), Encrypted: true, DeleteOnTermination: true } }]),
      "--tag-specifications", JSON.stringify(["instance", "volume"].map(ResourceType => ({ ResourceType, Tags }))), "--query", "Instances[0].InstanceId");
    if (!/^i-[a-f0-9]{8,17}$/.test(launched || "")) throw new Error("Invalid acceptance worker ID");
    workerId = launched;
    log(`Acceptance worker ${workerId} launched privately; no role or metadata access.`);
    await poll("fresh worker running", async () => (await worker()).State?.Name === "running");
    const fresh = await probe("fresh");
    await worker();
    await aws("ec2", "stop-instances", "--instance-ids", workerId);
    await poll("test worker stopped", async () => (await worker()).State?.Name === "stopped");
    await worker();
    await aws("ec2", "start-instances", "--instance-ids", workerId);
    await poll("test worker resumed", async () => (await worker()).State?.Name === "running");
    const resumed = await probe("resumed", fresh);
    receipt = { accepted: true, schema: 1, account: o.account, region: o.region, deployment: o.deployment, imageId: o.imageId, verificationId, workerId, controllerId: outputs.ControllerInstanceId,
      checks: { freshBoot: true, disabledMetadata: true, noInstanceRole: true, privateNetwork: true, credentialScrub: true, pinnedNativeVersions: true, freshMachineAndHostIdentity: true, identitySurvivedStopStart: true, sentinelSurvivedStopStart: true, heartbeatFreshAfterBoot: true, controllerSecretStayedLocal: true },
      evidence: { freshCommandId: fresh.commandId, resumedCommandId: resumed.commandId, machineHash: resumed.audit.machine, hostKeyHashes: resumed.audit.hostKeys }, promptsSent: false, accountImports: false };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (workerId) {
      try {
        const observed = await worker(true);
        if (!["shutting-down", "terminated"].includes(observed.State?.Name)) {
          await worker();
          await aws("ec2", "terminate-instances", "--instance-ids", workerId);
        }
        await poll("test worker termination", async () => (await worker(true)).State?.Name === "terminated");
        cleaned = true;
        log(`Confirmed termination of only acceptance worker ${workerId} and its disposable encrypted root volume.`);
      } catch (error) {
        if (primaryFailure) throw new Error(`${primaryFailure.message}; cleanup unconfirmed for acceptance worker ${workerId}; inspect exact deployment-owned instance before any further mutation`, { cause: primaryFailure });
        throw error;
      }
    }
  }
  return { ...receipt, cleanedUp: cleaned };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await verifyWorkerImage(parseVerificationOptions(process.argv.slice(2)), { log: message => console.error(message) }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
