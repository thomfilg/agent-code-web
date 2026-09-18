#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { aws, target, verifyTarget } from "./aws-deploy.mjs";

const execute = promisify(execFile);
const project = "code-web", config = "stg_aws_mvp";
const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "AGENT_OWNER_EMAIL", "AUTH_SECRET", "AGENT_ENCRYPTION_KEY"];
async function doppler(args) {
  try {
    const { stdout } = await execute("doppler", [...args, "--project", project, "--no-check-version", "--attempts", "1"], { timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, DOPPLER_DEBUG: "false" } });
    return stdout;
  } catch { throw new Error("Doppler operation failed; private output suppressed. Check repository-scoped authentication."); }
}
async function values(name) {
  const raw = await doppler(["secrets", "download", "--config", name, "--format", "json", "--no-file"]);
  try { return JSON.parse(raw); } catch { throw new Error("Doppler returned an invalid private snapshot"); }
}
async function withSecretFile(value, action) {
  // Linux operator flow: tmpfs only, never persist a secret snapshot alongside
  // source, artifacts, shell history or the CloudFormation parameter file.
  const directory = await mkdtemp("/dev/shm/relay-deploy-secrets-");
  const filename = path.join(directory, "secrets.json");
  try { await writeFile(filename, JSON.stringify(value), { mode: 0o600, flag: "wx" }); return await action(filename); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export function environmentFor(secrets, outputs, image, privateKey) {
  for (const name of required) if (typeof secrets[name] !== "string" || !secrets[name].trim()) throw new Error(`Set ${name} in Doppler ${project}/${config}`);
  if (Buffer.from(secrets.AGENT_ENCRYPTION_KEY, "base64").length !== 32 || secrets.AUTH_SECRET.length < 32) throw new Error("Invalid deployment encryption/session keys");
  const allowedEmails = (secrets.AGENT_ALLOWED_EMAILS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (allowedEmails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("Invalid deployment Google email allowlist");
  const url = new URL(outputs.PublicUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("Expected canonical HTTPS origin");
  if (image.State !== "available" || image.Architecture !== "x86_64") throw new Error("Worker image is not available x86_64");
  const tags = Object.fromEntries((image.Tags || []).map(tag => [tag.Key, tag.Value]));
  for (const [key, value] of Object.entries({ ManagedBy: "agent-relay", AgentRelayDeployment: target.stack, AgentRelayWorkerKey: outputs.WorkerKeyName, CodexVersion: "0.154.0", ClaudeVersion: "2.1.222" })) if (tags[key] !== value) throw new Error("Worker image does not match this deployment and native CLI versions");
  if (!privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")) throw new Error("Invalid worker transport key");
  for (const key of ["WorkerSubnetId", "WorkerSecurityGroupId", "WorkerKeyName"]) if (!outputs[key]) throw new Error("Missing worker stack output");
  return { ...Object.fromEntries(required.map(key => [key, secrets[key]])),
    AGENT_WEB_PUBLIC_URL: url.origin, AGENT_GOOGLE_AUTH: "1", AGENT_COOKIE_SECURE: "1", AGENT_ALLOWED_EMAILS: allowedEmails.join(","),
    AGENT_WEB_HOST: "0.0.0.0", AGENT_WEB_PORT: "8787", AGENT_DATABASE_MODE: "embedded",
    AGENT_CONTROL_DIR: "/var/lib/relay/control", AGENT_DATA_DIR: "/var/lib/relay/state", AGENT_ENABLE_MOCK: "0",
    AGENT_PROCESS_ISOLATION: "none", AGENT_WORKER_BACKEND: "ec2", CODEX_AUTH_MODE: "gateway", CLAUDE_AUTH_MODE: "gateway",
    AWS_REGION: target.region, AWS_DEFAULT_REGION: target.region,
    AGENT_EC2_DEPLOYMENT: target.stack, AGENT_EC2_GATEWAY_ORIGIN: url.origin, AGENT_EC2_AMI_ID: image.ImageId,
    AGENT_EC2_SUBNET_ID: outputs.WorkerSubnetId, AGENT_EC2_SECURITY_GROUP_ID: outputs.WorkerSecurityGroupId,
    AGENT_EC2_KEY_NAME: outputs.WorkerKeyName, AGENT_EC2_USE_PUBLIC_IP: "0", AGENT_EC2_INSTANCE_TYPE: "t3.medium",
    AGENT_WORKER_SSH_KEY_BASE64: Buffer.from(privateKey).toString("base64"),
  };
}

export function assertWorkerKey(derived, pair, expectedName) {
  const normalize = value => typeof value === "string" && /^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(value.trim()) ? value.trim().split(" ").slice(0, 2).join(" ") : null;
  const publicKey = normalize(derived);
  if (!publicKey || pair?.KeyName !== expectedName || normalize(pair.PublicKey) !== publicKey) throw new Error("Operator private key does not match the deployment's worker public key");
}

export function assertWorkerOnlyUpdate(current, next) {
  if (!current || !next || !/^ami-[a-f0-9]{8,17}$/.test(current.AGENT_EC2_AMI_ID || "") || !/^ami-[a-f0-9]{8,17}$/.test(next.AGENT_EC2_AMI_ID || "")) throw new Error("Worker update requires an existing published environment");
  const keys = Object.keys(current).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(next).sort()) || keys.some(key => typeof current[key] !== "string" || typeof next[key] !== "string" || key !== "AGENT_EC2_AMI_ID" && current[key] !== next[key])) throw new Error("Worker-only update cannot change credentials, identity, access or other settings; use Doppler publication");
}

export function parsePublishedEnvironment(serialized) {
  try {
    if (typeof serialized !== "string" || serialized.length > 1048576) throw new Error();
    const value = JSON.parse(serialized);
    if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length > 128 || Object.entries(value).some(([key, item]) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || typeof item !== "string" || item.length > 262144)) throw new Error();
    return value;
  } catch { throw new Error("Published AWS environment is malformed; private contents suppressed"); }
}

export async function publishWorkerOnlyUpdate(secretArn, current, next, { awsCall = aws, secretFile = withSecretFile, version = randomUUID() } = {}) {
  if (current.ARN !== secretArn || !current.VersionStages?.includes("AWSCURRENT") || !/^[a-zA-Z0-9-]{32,64}$/.test(current.VersionId || "") || !/^[a-f0-9-]{36}$/.test(version)) throw new Error("Worker update requires the exact current secret version");
  const previous = parsePublishedEnvironment(current.SecretString);
  assertWorkerOnlyUpdate(previous, next);
  if (previous.AGENT_EC2_AMI_ID === next.AGENT_EC2_AMI_ID) return { changed: false };
  const stage = `relay-worker-${version}`;
  try {
    const written = await secretFile(next, filename => awsCall(["secretsmanager", "put-secret-value"], ["--secret-id", secretArn, "--client-request-token", version, "--version-stages", stage, "--secret-string", `file://${filename}`]));
    if (written.ARN !== secretArn || written.VersionId !== version) throw new Error("Worker candidate version was not confirmed; current version was not promoted");
    // Compare-and-swap: a concurrent credential publication must win, never be
    // overwritten with the older credentials captured for this metadata change.
    await awsCall(["secretsmanager", "update-secret-version-stage"], ["--secret-id", secretArn, "--version-stage", "AWSCURRENT", "--move-to-version-id", version, "--remove-from-version-id", current.VersionId]);
    const observed = await awsCall(["secretsmanager", "get-secret-value"], ["--secret-id", secretArn, "--version-stage", "AWSCURRENT"]);
    if (observed.ARN !== secretArn || observed.VersionId !== version) throw new Error("Worker update was superseded or not confirmed; inspect the current configuration");
    const confirmed = parsePublishedEnvironment(observed.SecretString);
    assertWorkerOnlyUpdate(next, confirmed);
    if (confirmed.AGENT_EC2_AMI_ID !== next.AGENT_EC2_AMI_ID) throw new Error("Worker image update was not confirmed");
    return { changed: true };
  } finally {
    // Remove only our temporary label; AWSCURRENT/AWSPREVIOUS are untouched.
    await awsCall(["secretsmanager", "update-secret-version-stage"], ["--secret-id", secretArn, "--version-stage", stage, "--remove-from-version-id", version]).catch(() => {});
  }
}

export async function main(args) {
  const [action, flag, value] = args;
  if (!["initialize", "check", "publish", "update-worker"].includes(action)) throw new Error("Usage: aws-secrets.mjs initialize --initialize-from-dev | check | publish --worker-ami ami-ID | update-worker --worker-ami ami-ID");
  if (action === "initialize") {
    if (flag !== "--initialize-from-dev" || value) throw new Error("Explicit --initialize-from-dev is required to copy only Google/owner settings into the separate AWS config");
    const list = JSON.parse(await doppler(["configs", "--json"]));
    const configs = Array.isArray(list) ? list : list.configs;
    if (!configs.some(item => item.name === config)) await doppler(["configs", "create", config, "--environment", "stg"]);
    const existing = await values(config);
    if (Object.keys(existing).some(key => !key.startsWith("DOPPLER_") && !required.includes(key) && key !== "AGENT_ALLOWED_EMAILS")) throw new Error("Deployment config contains unrelated settings; refusing to overwrite them");
    const source = await values("dev");
    for (const key of required.slice(0, 3)) if (!source[key]?.trim()) throw new Error(`Missing ${key} in the explicitly selected source`);
    // A new Doppler branch can inherit its environment's Google settings.
    // Preserve matching values; never replace a different configured identity.
    for (const key of required.slice(0, 3)) if (existing[key]?.trim() && existing[key] !== source[key]) throw new Error(`Existing ${key} differs from the explicit source; configure this deployment manually`);
    const selected = Object.fromEntries(required.slice(0, 3).map(key => [key, existing[key] || source[key]]));
    selected.AUTH_SECRET = existing.AUTH_SECRET || randomBytes(48).toString("base64url");
    selected.AGENT_ENCRYPTION_KEY = existing.AGENT_ENCRYPTION_KEY || randomBytes(32).toString("base64");
    selected.AGENT_ALLOWED_EMAILS = existing.AGENT_ALLOWED_EMAILS || "";
    await withSecretFile(selected, filename => doppler(["secrets", "upload", filename, "--config", config, "--silent"]));
    console.log(JSON.stringify({ project, config, initialized: true, copied: required.slice(0, 3), generated: required.slice(3), localDevChanged: false }));
    return;
  }
  let secrets = action === "update-worker" ? null : await values(config);
  if (action === "check") {
    const missing = required.filter(key => !secrets[key]?.trim());
    console.log(JSON.stringify({ project, config, configured: !missing.length, missing }));
    if (missing.length) throw new Error("Deployment secrets are incomplete");
    return;
  }
  if (flag !== "--worker-ami" || !/^ami-[a-f0-9]{8,17}$/.test(value || "")) throw new Error("Publish requires --worker-ami ami-ID");
  await verifyTarget();
  const stack = (await aws(["cloudformation", "describe-stacks"], ["--stack-name", target.stack])).Stacks?.[0];
  if (!["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack?.StackStatus) || !stack.Tags?.some(tag => tag.Key === "ManagedBy" && tag.Value === "12-apps-ci")) throw new Error("Deployment stack is not ready or owned");
  const outputs = Object.fromEntries(stack.Outputs.map(output => [output.OutputKey, output.OutputValue]));
  if (!outputs.SecretArn?.startsWith(`arn:aws:secretsmanager:${target.region}:${target.account}:secret:`)) throw new Error("Invalid deployment secret target");
  const resources = (await aws(["cloudformation", "list-stack-resources"], ["--stack-name", target.stack])).StackResourceSummaries;
  if (!resources.some(resource => resource.ResourceType === "AWS::SecretsManager::Secret" && resource.PhysicalResourceId === outputs.SecretArn)) throw new Error("Secret is not owned by the deployment stack");
  let current;
  if (action === "update-worker") {
    current = await aws(["secretsmanager", "get-secret-value"], ["--secret-id", outputs.SecretArn, "--version-stage", "AWSCURRENT"]);
    secrets = parsePublishedEnvironment(current.SecretString);
  }
  const image = (await aws(["ec2", "describe-images"], ["--image-ids", value, "--owners", target.account])).Images?.[0];
  if (!image) throw new Error("Worker image is not owned by this account");
  const keyPath = path.join(os.homedir(), ".local/share/agent-relay-aws-mvp/worker-ed25519");
  const keyInfo = await lstat(keyPath);
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || keyInfo.nlink !== 1 || keyInfo.mode & 0o077 || keyInfo.size > 16384) throw new Error("Worker private key must be an ordinary private file");
  const key = await readFile(keyPath, "utf8");
  let derived;
  try { derived = (await execute("ssh-keygen", ["-y", "-f", keyPath], { timeout: 10000, maxBuffer: 16384 })).stdout.trim(); }
  catch { throw new Error("Could not verify the worker private key; diagnostics suppressed"); }
  const pair = (await aws(["ec2", "describe-key-pairs"], ["--key-names", outputs.WorkerKeyName, "--include-public-key"])).KeyPairs?.[0];
  assertWorkerKey(derived, pair, outputs.WorkerKeyName);
  const environment = environmentFor(secrets, outputs, image, key);
  if (action === "update-worker") {
    const result = await publishWorkerOnlyUpdate(outputs.SecretArn, current, environment);
    console.log(JSON.stringify({ workerUpdated: result.changed, workerImage: value, credentialsChanged: false, source: "Existing Doppler-published AWS environment", restartRequired: result.changed }));
    return;
  }
  await withSecretFile(environment, filename => aws(["secretsmanager", "put-secret-value"], ["--secret-id", outputs.SecretArn, "--secret-string", `file://${filename}`]));
  console.log(JSON.stringify({ published: true, source: `${project}/${config}`, publicUrl: outputs.PublicUrl, googleCallback: `${outputs.PublicUrl}/api/auth/callback/google`, credentialsPrinted: false, accountImports: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
