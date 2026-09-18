#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { relayTemplate } from "../deploy/aws/template.mjs";

const execute = promisify(execFile);
export const target = Object.freeze({ profile: "code-web", region: "us-east-2", account: "456808212788", stack: "agent-relay-mvp" });
export const engineRevision = "848182b33461640e9ac0feb7315f747a67877c88";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operatorDirectory = path.join(os.homedir(), ".local/share/agent-relay-aws-mvp");

export async function aws(operation, args = []) {
  try {
    const { stdout } = await execute("aws", ["--profile", target.profile, "--region", target.region, "--no-cli-pager", "--output", "json", ...operation, ...args], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" } });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch { throw new Error(`AWS ${operation.join(" ")} failed; credential-bearing diagnostics suppressed`); }
}

export async function verifyTarget() {
  const identity = await aws(["sts", "get-caller-identity"]);
  if (identity.Account !== target.account) throw new Error("Unexpected AWS account. No changes made.");
}

async function privateOperatorDirectory() {
  await mkdir(operatorDirectory, { mode: 0o700, recursive: true });
  const info = await lstat(operatorDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error("Operator directory must be private and not a symlink");
}

async function provisionParameters() {
  const key = path.join(operatorDirectory, "worker-ed25519");
  let present = false;
  try { const info = await lstat(key); if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error("Worker private key permissions are unsafe"); present = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!present) await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "agent-relay-mvp-worker", "-f", key]);
  const publicKey = (await readFile(key + ".pub", "utf8")).trim();
  const derived = (await execute("ssh-keygen", ["-y", "-f", key])).stdout.trim();
  if (derived.split(" ").slice(0, 2).join(" ") !== publicKey.split(" ").slice(0, 2).join(" ")) throw new Error("Worker key pair does not match");
  const prefix = await aws(["ec2", "describe-managed-prefix-lists"], ["--filters", "Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing"]);
  const prefixId = prefix.PrefixLists?.[0]?.PrefixListId;
  if (!/^pl-[a-f0-9]+$/.test(prefixId || "")) throw new Error("CloudFront managed prefix list is unavailable");
  // Persist the initial AMI selection. Re-running application deployment must
  // not silently replace the controller because Ubuntu published a new AMI.
  const paramsPath = path.join(operatorDirectory, "parameters.json");
  let baseImage;
  try { baseImage = JSON.parse(await readFile(paramsPath, "utf8")).find(p => p.ParameterKey === "BaseImageId")?.ParameterValue; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  baseImage ||= (await aws(["ssm", "get-parameter"], ["--name", "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"])).Parameter?.Value;
  if (!/^ami-[a-f0-9]{8,17}$/.test(baseImage || "")) throw new Error("Could not resolve a pinned Ubuntu image");
  const parameters = Object.entries({ AvailabilityZone: "us-east-2a", BaseImageId: baseImage, CloudFrontPrefixListId: prefixId, WorkerPublicKey: publicKey }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }));
  await writeFile(paramsPath, JSON.stringify(parameters, null, 2), { mode: 0o600 });
  return paramsPath;
}

export async function main(args, env = process.env) {
  const [action, ...extra] = args;
  if (!["plan", "provision", "status", "deploy", "rollback"].includes(action)) throw new Error("Usage: node scripts/aws-deploy.mjs plan|provision|status|deploy|rollback [--image ECR_URI@sha256:DIGEST] [--command-id UUID]");
  const engine = env.CI_AWS_ENGINE;
  if (!engine || !path.isAbsolute(engine)) throw new Error("Set CI_AWS_ENGINE to the absolute scripts/deploy/aws.mjs path in the documented pinned 12-apps/ci checkout");
  await access(engine);
  const engineRoot = path.resolve(path.dirname(engine), "../..");
  const installedRevision = (await execute("git", ["-C", engineRoot, "rev-parse", "HEAD"])).stdout.trim();
  const engineChanges = (await execute("git", ["-C", engineRoot, "diff", "--name-only", "HEAD", "--", "scripts/deploy"])).stdout.trim();
  if (installedRevision !== engineRevision || engineChanges) throw new Error(`Use the clean reviewed 12-apps/ci engine revision ${engineRevision}`);
  if (extra.some((value, index) => index % 2 === 0 && !["--image", "--command-id"].includes(value))) throw new Error("Only --image or --command-id may be passed through; deployment target is pinned");
  await verifyTarget();
  const options = [action, "--profile", target.profile, "--region", target.region, "--expected-account", target.account, "--stack", target.stack, "--container", "relay", "--mount", "/srv/relay/data", "--destination", "/var/lib/relay", "--ready-file", "/var/lib/relay-controller-ready", "--port", "8787", "--health", "/readyz", ...extra];
  if (["plan", "provision"].includes(action)) {
    await privateOperatorDirectory();
    const templatePath = path.join(operatorDirectory, "template.json");
    await writeFile(templatePath, JSON.stringify(relayTemplate(), null, 2), { mode: 0o600 });
    options.push("--template", templatePath);
    if (action === "provision") options.push("--parameters", await provisionParameters());
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [engine, ...options], { cwd: root, env, stdio: "inherit" });
    child.once("error", () => reject(new Error("Could not start the shared AWS engine")));
    child.once("exit", code => resolve(code ?? 1));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
