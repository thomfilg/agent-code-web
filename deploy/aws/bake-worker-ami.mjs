#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { hibernationCandidate, hibernationRecipe } from "./worker-hibernation.mjs";
import { workerSupervisorVersion } from "../../src/worker-supervisor-service.mjs";

const recipePath = fileURLToPath(new URL("worker-cloud-init.yaml", import.meta.url));
const exec = promisify(execFile);
export const CLI_VERSIONS = { codex: "0.154.0", claude: "2.1.222" };
export const EC2_USER_DATA_MAX_BYTES = 16 * 1024;
const awsOperations = {
  sts: ["get-caller-identity"],
  cloudformation: ["describe-stacks", "describe-stack-resource"],
  ec2: ["describe-instances", "describe-subnets", "describe-security-groups", "describe-images", "describe-key-pairs", "get-console-output", "run-instances", "create-image", "terminate-instances"],
  iam: ["get-instance-profile", "get-role", "list-attached-role-policies", "list-role-policies"],
  ssm: ["describe-instance-information", "send-command", "get-command-invocation"],
};
const awsErrorCodes = new Set(["InvalidParameterValue", "InvalidParameterCombination", "UnauthorizedOperation", "AccessDenied", "AccessDeniedException", "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId", "RequestExpired", "RequestLimitExceeded", "Throttling", "ThrottlingException", "ServiceUnavailable", "InternalError", "InvalidAMIID.NotFound", "InvalidInstanceID.NotFound", "InvocationDoesNotExist"]);

function knownAwsOperation(args) {
  let index = 0;
  while (index < args.length) {
    if (["--profile", "--region"].includes(args[index])) index += 2;
    else if (args[index] === "--no-cli-pager") index++;
    else break;
  }
  const service = args[index], action = args[index + 1];
  if (!Object.hasOwn(awsOperations, service) || !awsOperations[service].includes(action)) return null;
  return { service, action, apiAction: action.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join("") };
}

function awsFailure(args, category) {
  const operation = knownAwsOperation(args);
  const error = new Error(`AWS ${operation ? `${operation.service}/${operation.action}` : "operation"} failed (${category}); private diagnostics suppressed`);
  error.code = category;
  return error;
}

export function safeBakerAwsFailure(args, error) {
  const operation = knownAwsOperation(args);
  const match = typeof error?.stderr === "string" && error.stderr.match(/^An error occurred \(([A-Za-z0-9.]+)\) when calling the ([A-Za-z0-9]+) operation(?: \(reached max retries: \d+\))?:/m);
  let category = "unclassified";
  if (operation && match?.[2] === operation.apiAction && awsErrorCodes.has(match[1]) && (match[1] !== "InvocationDoesNotExist" || operation.service === "ssm" && operation.action === "get-command-invocation")) category = match[1];
  else if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") category = "output-limit";
  else if (error?.code === "ETIMEDOUT" || error?.killed === true && error?.signal === "SIGTERM") category = "timeout";
  else if (error?.code === "ENOENT") category = "executable-unavailable";
  // Never retain a cause: exec errors include argv, stdout and private stderr.
  return awsFailure(args, category);
}

export function gzipWorkerUserData(recipe) {
  // EC2 limits the decoded payload, not its base64 wire representation.
  // cloud-init detects gzip before parsing the original #cloud-config text.
  const compressed = gzipSync(Buffer.from(recipe, "utf8"), { level: 9 });
  if (compressed.length > EC2_USER_DATA_MAX_BYTES) throw new Error("Compressed worker user-data exceeds the EC2 16 KiB limit; no builder was launched");
  return compressed;
}

export function safeBootstrapReceipt(output) {
  try {
    const value = JSON.parse(output);
    const stages = ["init-local", "init-network", "modules-config", "modules-final", "package-update-upgrade-install", "scripts-user", "ssh"];
    const checkNames = ["node", "codex", "claude", "docker", "chrome", "readyMarker", "finalizer", "auditHelper", "systemdVerified"];
    if (value.kind !== "relay-worker-bootstrap" || value.schema !== 1 || !["done", "running", "error", "disabled", "not run", "unknown"].includes(value.status) || !Array.isArray(value.failedModules) || value.failedModules.some(stage => !stages.includes(stage)) || typeof value.sshOrderingCycle !== "boolean" || checkNames.some(key => typeof value.checks?.[key] !== "boolean")) return null;
    return { status: value.status, failedModules: [...new Set(value.failedModules)], checks: Object.fromEntries(checkNames.map(key => [key, value.checks[key]])), sshOrderingCycle: value.sshOrderingCycle };
  } catch { return null; }
}

const finalizerStages = new Set(["initial", "transport-key", "builder-identity", "ssm-disable", "ssm-purge", "filesystem-scrub", "identity-scrub", "credential-scan", "service-enable", "finalize-marker", "poweroff"]);
export function safeFinalizerReceipt(output) {
  if (typeof output !== "string" || output.length > 1_048_576) return null;
  const candidates = [output];
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(output)) {
    try { candidates.push(Buffer.from(output.replaceAll(/\s/g, ""), "base64").toString("utf8")); } catch {}
  }
  const receipts = new Set();
  for (const candidate of candidates) for (const line of candidate.split(/\r?\n/)) {
    if (line === "AGENT_RELAY_FINALIZER_OK_V1") receipts.add("ok");
    const failed = line.match(/^AGENT_RELAY_FINALIZER_FAILED_V1 stage=([a-z-]+)$/);
    if (failed && finalizerStages.has(failed[1])) receipts.add(`failed:${failed[1]}`);
  }
  if (receipts.size !== 1) return null;
  const [receipt] = receipts;
  return receipt === "ok" ? { ok: true } : { ok: false, stage: receipt.slice(7) };
}

export function parseOptions(args) {
  const options = { region: "us-east-1", profile: "", instanceType: "t3.medium", volumeGb: 20, dryRun: false };
  const keys = { "--expected-account": "expectedAccount", "--region": "region", "--profile": "profile", "--subnet-id": "subnetId", "--security-group-id": "securityGroupId", "--key-name": "keyName", "--builder-instance-profile": "builderInstanceProfile", "--base-image-id": "baseImageId", "--deployment": "deployment", "--instance-type": "instanceType", "--volume-gb": "volumeGb", "--name": "name" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") { options.dryRun = true; continue; }
    if (args[i] === "--hibernation-candidate") { options.hibernationCandidate = true; continue; }
    const key = keys[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Unknown or incomplete baker argument: ${args[i]}`);
    options[key] = args[++i];
  }
  const patterns = { expectedAccount: /^\d{12}$/, subnetId: /^subnet-[a-f0-9]{8,17}$/, securityGroupId: /^sg-[a-f0-9]{8,17}$/, baseImageId: /^ami-[a-f0-9]{8,17}$/, deployment: /^[A-Za-z][A-Za-z0-9-]{0,127}$/, keyName: /^[A-Za-z0-9_.-]{1,255}$/, builderInstanceProfile: /^[\w+=,.@-]{1,128}$/, region: /^[a-z]{2}(?:-[a-z]+)+-\d$/ };
  for (const [key, pattern] of Object.entries(patterns)) if (!pattern.test(options[key] || "")) throw new Error(`Missing or invalid baker option: ${key}`);
  if (!/^t3\.(small|medium|large|xlarge)$/.test(options.instanceType)) throw new Error("Use a supported x86_64 t3 builder size");
  options.volumeGb = Number(options.volumeGb);
  if (!Number.isSafeInteger(options.volumeGb) || options.volumeGb < 20 || options.volumeGb > 100) throw new Error("Builder volume must be 20–100 GiB");
  const ramGb = { "t3.small": 2, "t3.medium": 4, "t3.large": 8, "t3.xlarge": 16 }[options.instanceType];
  if (options.hibernationCandidate && options.volumeGb < 16 + ramGb) throw new Error("Hibernation candidate volume must leave 16 GiB beyond instance RAM");
  options.name ||= `${options.deployment}-worker-${Date.now()}`;
  if (!/^[A-Za-z0-9_.-]{3,128}$/.test(options.name)) throw new Error("Invalid AMI name");
  return options;
}

export async function runBakerAws(args, execute = exec) {
  // Only this local operator process receives AWS auth, never the guest.
  try { return (await execute(process.env.AWS_BIN || "aws", args, { timeout: 65_000, maxBuffer: 1_048_576 })).stdout.trim(); }
  catch (error) { throw safeBakerAwsFailure(args, error); }
}

export async function bakeWorkerImage(options, { run = runBakerAws, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {}, recipe = null, pollLimit = 180 } = {}) {
  const o = options;
  const plan = { expectedAccount: o.expectedAccount, deployment: o.deployment, region: o.region, subnetId: o.subnetId, securityGroupId: o.securityGroupId, keyName: o.keyName, builderInstanceProfile: o.builderInstanceProfile, baseImageId: o.baseImageId, versions: CLI_VERSIONS, privateOnly: true, finalWorkerRole: null, finalWorkerMetadata: "disabled", ...(o.hibernationCandidate ? { hibernationCandidate, productionReady: false } : {}) };
  recipe ||= await readFile(recipePath, "utf8");
  if (o.hibernationCandidate) recipe = hibernationRecipe(recipe);
  for (const [pkg, version] of [["@openai/codex", CLI_VERSIONS.codex], ["@anthropic-ai/claude-code", CLI_VERSIONS.claude]]) if (!recipe.includes(`${pkg}@${version}`)) throw new Error("Worker recipe must contain the pinned CLI versions");
  gzipWorkerUserData(recipe); // Early local rejection, including dry-run.
  if (o.dryRun) return { dryRun: true, ...plan };
  const aws = (...args) => run([...(o.profile ? ["--profile", o.profile] : []), "--region", o.region, "--no-cli-pager", ...args]);
  const json = async (...args) => {
    const output = await aws(...args, "--output", "json");
    try { return JSON.parse(output); }
    catch { throw awsFailure(args, "invalid-response"); }
  };
  const bakeId = randomUUID();
  const tags = [{ Key: "ManagedBy", Value: "agent-relay" }, { Key: "AgentRelayDeployment", Value: o.deployment }, { Key: "AgentRelayWorkerKey", Value: o.keyName }, { Key: "CodexVersion", Value: CLI_VERSIONS.codex }, { Key: "ClaudeVersion", Value: CLI_VERSIONS.claude }, { Key: "AgentRelaySupervisor", Value: workerSupervisorVersion }];
  if (o.hibernationCandidate) tags.push({ Key: "AgentRelayHibernation", Value: hibernationCandidate });
  let builderId;
  let temporary;
  async function builder(terminationObservation = false) {
    const instances = await json("ec2", "describe-instances", "--instance-ids", builderId, "--query", "Reservations[].Instances[]");
    const instance = instances?.[0];
    const t = Object.fromEntries((instance?.Tags || []).map(({ Key, Value }) => [Key, Value]));
    if (instances?.length !== 1 || instance.InstanceId !== builderId || instance.ImageId !== o.baseImageId || tags.some(tag => t[tag.Key] !== tag.Value) || t.AgentRelayBake !== bakeId) {
      throw new Error("Builder ownership/network/profile mismatch; refusing to mutate it");
    }
    // EC2 may detach network/profile data while terminating. This exception is
    // read-only and retains exact ID, AMI and every ownership/version tag. Any
    // mutation below requires another strict observation immediately before it.
    if (!(terminationObservation && ["shutting-down", "terminated"].includes(instance.State?.Name)) &&
        (instance.SubnetId !== o.subnetId || instance.SecurityGroups?.length !== 1 || instance.SecurityGroups[0].GroupId !== o.securityGroupId || instance.PublicIpAddress || instance.KeyName !== o.keyName ||
        instance.IamInstanceProfile?.Arn !== `arn:aws:iam::${o.expectedAccount}:instance-profile/${o.builderInstanceProfile}`)) {
      throw new Error("Builder ownership/network/profile mismatch; refusing to mutate it");
    }
    return instance;
  }
  async function poll(label, check, limit = pollLimit) {
    for (let attempt = 0; attempt < limit; attempt++) {
      const value = await check();
      if (value) return value;
      if (attempt % 6 === 0) log(`Waiting for ${label}...`);
      await sleep(10_000);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function ssm(commands, executionTimeout = "1800") {
    await builder();
    const result = await json("ssm", "send-command", "--instance-ids", builderId, "--document-name", "AWS-RunShellScript", "--timeout-seconds", "120", "--parameters", JSON.stringify({ commands, executionTimeout: [executionTimeout] }));
    const commandId = result.Command?.CommandId;
    if (!/^[a-f0-9-]{36}$/.test(commandId || "")) throw new Error("SSM did not return a command ID");
    return poll("SSM command completion", async () => {
      let invocation;
      try { invocation = await json("ssm", "get-command-invocation", "--instance-id", builderId, "--command-id", commandId); }
      catch (error) { if (error.code === "InvocationDoesNotExist") return false; throw error; }
      if (["Pending", "InProgress", "Delayed"].includes(invocation.Status)) return false;
      if (invocation.Status !== "Success" || invocation.ResponseCode !== 0) {
        const receipt = safeBootstrapReceipt(invocation.StandardOutputContent);
        const status = ["Failed", "Cancelled", "Cancelling", "TimedOut"].includes(invocation.Status) ? invocation.Status : "unexpected-status";
        throw new Error(`Builder SSM command failed (${status}); inspect command ${commandId} in AWS${receipt ? `; safe bootstrap receipt: ${JSON.stringify(receipt)}` : ""}`);
      }
      return invocation;
    });
  }
  let primaryFailure;
  let receipt;
  try {
    const identity = await json("sts", "get-caller-identity");
    if (identity.Account !== o.expectedAccount) throw new Error("AWS account does not match --expected-account; no resources were changed");
    const stacks = await json("cloudformation", "describe-stacks", "--stack-name", o.deployment, "--query", "Stacks");
    const stack = stacks?.[0];
    const outputs = Object.fromEntries((stack?.Outputs || []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
    const expectedOutputs = { WorkerSubnetId: o.subnetId, WorkerSecurityGroupId: o.securityGroupId, WorkerKeyName: o.keyName, BuilderInstanceProfile: o.builderInstanceProfile, DeploymentName: o.deployment,
      ...(!o.hibernationCandidate ? { BaseImageId: o.baseImageId } : {}) };
    if (stacks?.length !== 1 || stack.StackName !== o.deployment || !stack.StackId?.includes(`:cloudformation:${o.region}:${o.expectedAccount}:stack/${o.deployment}/`) || !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus) ||
        Object.entries(expectedOutputs).some(([key, value]) => outputs[key] !== value)) {
      throw new Error("Baker inputs must exactly match a completed deployment's CloudFormation outputs");
    }
    const owned = resource => resource?.Tags?.some(t => t.Key === "AgentRelayDeployment" && t.Value === o.deployment) && resource.Tags.some(t => t.Key === "ManagedBy" && t.Value === "12-apps-ci");
    const subnets = await json("ec2", "describe-subnets", "--subnet-ids", o.subnetId, "--query", "Subnets");
    const groups = await json("ec2", "describe-security-groups", "--group-ids", o.securityGroupId, "--query", "SecurityGroups");
    if (subnets?.length !== 1 || groups?.length !== 1 || subnets[0].SubnetId !== o.subnetId || groups[0].GroupId !== o.securityGroupId || subnets[0].OwnerId !== o.expectedAccount || groups[0].OwnerId !== o.expectedAccount || !owned(subnets[0]) || !owned(groups[0]) || subnets[0].MapPublicIpOnLaunch || subnets[0].VpcId !== groups[0].VpcId) throw new Error("Worker subnet/security group must be private and owned by this deployment/account");
    const controllerGroup = await json("cloudformation", "describe-stack-resource", "--stack-name", o.deployment, "--logical-resource-id", "ControllerGroup", "--query", "StackResourceDetail.PhysicalResourceId");
    const ingress = groups[0].IpPermissions;
    const egress = groups[0].IpPermissionsEgress;
    if (!/^sg-[a-f0-9]{8,17}$/.test(controllerGroup || "") || ingress?.length !== 1 || ingress[0].IpProtocol !== "tcp" || ingress[0].FromPort !== 22 || ingress[0].ToPort !== 22 || ingress[0].IpRanges?.length || ingress[0].Ipv6Ranges?.length || ingress[0].PrefixListIds?.length || ingress[0].UserIdGroupPairs?.length !== 1 || ingress[0].UserIdGroupPairs[0].GroupId !== controllerGroup ||
        egress?.length !== 2 || egress.some(rule => rule.IpProtocol !== "tcp" || ![80, 443].includes(rule.FromPort) || rule.ToPort !== rule.FromPort || rule.IpRanges?.length !== 1 || rule.IpRanges[0].CidrIp !== "0.0.0.0/0" || rule.Ipv6Ranges?.length || rule.PrefixListIds?.length || rule.UserIdGroupPairs?.length)) {
      throw new Error("Worker security group must allow only controller SSH ingress and HTTP(S) egress");
    }
    const profile = await json("iam", "get-instance-profile", "--instance-profile-name", o.builderInstanceProfile, "--query", "InstanceProfile");
    if (profile?.InstanceProfileName !== o.builderInstanceProfile || profile.Roles?.length !== 1 || !profile.Arn?.includes(`:iam::${o.expectedAccount}:instance-profile/`)) throw new Error("Builder instance profile is not owned by the expected account");
    const role = await json("iam", "get-role", "--role-name", profile.Roles[0].RoleName, "--query", "Role");
    const policies = await json("iam", "list-attached-role-policies", "--role-name", role.RoleName, "--query", "AttachedPolicies");
    const inline = await json("iam", "list-role-policies", "--role-name", role.RoleName, "--query", "PolicyNames");
    if (!owned(role) || role.Arn !== profile.Roles[0].Arn || policies?.length !== 1 || policies[0].PolicyArn !== "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" || inline?.length !== 0) throw new Error("Builder role must be deployment-owned and limited to AmazonSSMManagedInstanceCore");
    const base = await json("ec2", "describe-images", "--image-ids", o.baseImageId, "--query", "Images[0]");
    const release = o.hibernationCandidate ? "ubuntu-jammy-22.04-amd64-server-" : "ubuntu-noble-24.04-amd64-server-";
    // Canonical's current Jammy parameter can still point at an hvm-ssd/gp2
    // source AMI even though this launch always replaces the root mapping with
    // an encrypted gp3 volume below. Accept both official Jammy namespaces,
    // but keep the ordinary Noble baker pinned to its gp3 namespace.
    const namePrefixes = (o.hibernationCandidate ? ["ubuntu/images/hvm-ssd/", "ubuntu/images/hvm-ssd-gp3/"] : ["ubuntu/images/hvm-ssd-gp3/"]).map(prefix => prefix + release);
    const namePrefix = namePrefixes.find(prefix => base?.Name?.startsWith(prefix));
    const serial = namePrefix ? base.Name.slice(namePrefix.length) : null;
    const supportedJammy = !o.hibernationCandidate || /^\d{8}(?:\.\d+)?$/.test(serial || "") && serial.slice(0, 8) >= "20230303";
    if (base?.ImageId !== o.baseImageId || base.State !== "available" || base.Architecture !== "x86_64" || base.VirtualizationType !== "hvm" || base.RootDeviceType !== "ebs"
      || base.OwnerId !== "099720109477" || !namePrefix || !supportedJammy) {
      throw new Error(`Base image must be an available official Canonical Ubuntu ${o.hibernationCandidate ? "22.04" : "24.04"} amd64 AMI`);
    }
    const keys = await json("ec2", "describe-key-pairs", "--key-names", o.keyName, "--include-public-key", "--query", "KeyPairs");
    const key = keys?.[0];
    const normalizedKey = typeof key?.PublicKey === "string" ? key.PublicKey.trim() : "";
    if (keys?.length !== 1 || key.KeyName !== o.keyName || !owned(key) || !/^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(normalizedKey)) throw new Error("Worker key pair must be deployment-owned and expose one valid public key");
    const publicKey = normalizedKey.split(" ").slice(0, 2).join(" ");
    const compressedUserData = gzipWorkerUserData(recipe.replaceAll("__RELAY_WORKER_PUBLIC_KEY_BASE64__", Buffer.from(`${publicKey}\n`).toString("base64")));
    temporary = await mkdtemp(path.join(tmpdir(), "relay-worker-bake-"));
    const userData = path.join(temporary, "cloud-init.yaml.gz");
    await writeFile(userData, compressedUserData, { mode: 0o600, flag: "wx" });
    const launched = await json("ec2", "run-instances", "--image-id", o.baseImageId, "--instance-type", o.instanceType, "--client-token", bakeId,
      ...(o.hibernationCandidate ? ["--hibernation-options", "Configured=true"] : []),
      "--network-interfaces", JSON.stringify([{ DeviceIndex: 0, SubnetId: o.subnetId, Groups: [o.securityGroupId], AssociatePublicIpAddress: false, DeleteOnTermination: true }]),
      "--key-name", o.keyName, "--iam-instance-profile", JSON.stringify({ Name: o.builderInstanceProfile }), "--metadata-options", "HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1",
      "--instance-initiated-shutdown-behavior", "stop", "--credit-specification", "CpuCredits=standard",
      "--block-device-mappings", JSON.stringify([{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: o.volumeGb, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true } }]),
      // fileb preserves gzip bytes. The EC2 CLI customization encodes them
      // once; pre-encoding here would send base64 text instead of gzip.
      "--user-data", `fileb://${userData}`, "--tag-specifications", JSON.stringify(["instance", "volume"].map(ResourceType => ({ ResourceType, Tags: [...tags, { Key: "AgentRelayBake", Value: bakeId }, { Key: "Name", Value: `${o.deployment}-worker-builder` }] }))), "--query", "Instances[0].InstanceId");
    if (!/^i-[a-f0-9]{8,17}$/.test(launched || "")) throw new Error("Invalid builder instance ID");
    builderId = launched;
    log(`Private builder ${builderId} launched. No SSH or provider credentials are used.`);
    await poll("private SSM registration", async () => {
      await builder();
      const info = await json("ssm", "describe-instance-information", "--filters", JSON.stringify([{ Key: "InstanceIds", Values: [builderId] }]), "--query", "InstanceInformationList");
      return info?.length === 1 && info[0].InstanceId === builderId && info[0].PingStatus === "Online";
    });
    const bootstrap = await readFile(new URL("worker-bootstrap-check.py", import.meta.url), "utf8");
    await ssm([`python3 -I -c 'import base64;exec(base64.b64decode("${Buffer.from(bootstrap).toString("base64")}"))'`]);
    log("Pinned CLIs verified. Scheduling credential scrub and builder shutdown.");
    await ssm(["set -eu", "systemd-run --unit=agent-relay-image-finalize --on-active=15s /usr/local/sbin/agent-web-finalize-image"], "60");
    await poll("sanitized builder shutdown", async () => (await builder()).State?.Name === "stopped");
    const finalizer = await poll("sanitized builder finalizer receipt", async () => {
      const consoleOutput = await json("ec2", "get-console-output", "--instance-id", builderId, "--latest");
      return safeFinalizerReceipt(consoleOutput?.Output);
    }, Math.min(pollLimit, 12));
    if (!finalizer.ok) throw new Error(`Builder finalizer failed (${finalizer.stage}); no image was created`);
    // No StopInstances: an interrupted scrub must fail, not produce an AMI.
    const imageId = await json("ec2", "create-image", "--instance-id", builderId, "--name", o.name,
      "--description", "Agent Relay private worker: no credentials; deployment-specific SSH public key",
      "--tag-specifications", JSON.stringify(["image", "snapshot"].map(ResourceType => ({ ResourceType, Tags: tags }))), "--query", "ImageId");
    if (!/^ami-[a-f0-9]{8,17}$/.test(imageId || "")) throw new Error("Invalid created image ID");
    await poll("worker AMI availability", async () => {
      const image = await json("ec2", "describe-images", "--image-ids", imageId, "--query", "Images[0]");
      if (image?.State === "failed") throw new Error(`Worker AMI ${imageId} failed; inspect and clean up its image/snapshot explicitly`);
      return image?.ImageId === imageId && image.State === "available";
    });
    log(`Worker AMI ready: ${imageId}. A fresh IMDS-disabled boot still requires deployment acceptance.`);
    receipt = { imageId, builderId, ...plan };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      if (builderId) {
        const observed = await builder(true);
        if (!["shutting-down", "terminated"].includes(observed.State?.Name)) {
          await builder(); // Strict recheck before mutation, never broad filters.
          await aws("ec2", "terminate-instances", "--instance-ids", builderId);
        }
        await poll("temporary builder termination", async () => (await builder(true)).State?.Name === "terminated");
        log(`Confirmed termination of temporary builder ${builderId}; any created AMI/snapshot is retained.`);
      }
    } catch (error) {
      const cleanup = `cleanup unconfirmed for temporary builder ${builderId}; inspect the exact deployment-owned instance before further mutation`;
      throw new Error(`${primaryFailure ? `${primaryFailure.message}; ` : ""}${error.message}; ${cleanup}`);
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
  return { ...receipt, cleanedUp: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await bakeWorkerImage(parseOptions(process.argv.slice(2)), { log: message => console.error(message) }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
