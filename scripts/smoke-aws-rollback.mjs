#!/usr/bin/env node
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { zipSync, strToU8 } from "fflate";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { target, engineRevision, deploymentEngine, resolveDeploymentEngine } from "./aws-deploy.mjs";
import { buildTarget } from "./aws-build.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const imagePattern = /^456808212788\.dkr\.ecr\.us-east-2\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const fail = message => { throw Error(message); };
export function parseRollbackOptions(args) {
  const options = { action: args[0] || "plan", run: false };
  if (!["plan", "build", "status", "verify"].includes(options.action)) fail("Use plan, build, status or verify");
  const names = { "--base-image": "baseImage", "--acceptance-id": "acceptanceId", "--build-id": "buildId", "--engine": "engine" };
  for (let index = 1; index < args.length; index++) {
    if (args[index] === "--run") { options.run = true; continue; }
    const name = names[args[index]];
    if (!name || !args[index + 1] || args[index + 1].startsWith("--")) fail("Invalid rollback acceptance option");
    options[name] = args[++index];
  }
  options.engine ||= deploymentEngine.entrypoint;
  if (options.run && options.action !== "plan") {
    if (!imagePattern.test(options.baseImage || "") || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.acceptanceId || "") || !path.isAbsolute(options.engine || "")) fail("Explicit acceptance requires an immutable owned base image, UUID and absolute pinned engine path");
    if (["status", "verify"].includes(options.action) && !/^[A-Za-z0-9_-]+:[a-f0-9-]{36}$/.test(options.buildId || "")) fail("Status/verify require the exact acceptance CodeBuild ID");
  }
  return options;
}

export function acceptanceArchive(baseImage, acceptanceId) {
  if (!imagePattern.test(baseImage) || !/^[a-f0-9-]{36}$/.test(acceptanceId)) fail("Invalid acceptance image recipe");
  const dockerfile = `FROM ${baseImage} AS runner\nLABEL relay.rollback.acceptance="${acceptanceId}" relay.rollback.base="${baseImage}"\nENTRYPOINT ["/bin/false"]\nCMD []\n`;
  return zipSync({ "deploy/aws/Dockerfile": strToU8(dockerfile) });
}

async function loadEngine(filename) {
  filename = await resolveDeploymentEngine({ CI_AWS_ENGINE: filename });
  return { module: await import(pathToFileURL(filename).href), source: await readFile(path.join(path.dirname(filename), "aws-rollout.py"), "utf8") };
}

export function acceptanceBuild(build, selected, options) {
  const tag = `rollback-${options.acceptanceId}`, variables = build?.environment?.environmentVariables || [];
  if (build?.id !== options.buildId || build.projectName !== selected.ImageBuildProject || build.source?.type !== "S3" || build.source.location !== `${selected.ArtifactBucket}/source/rollback-${options.acceptanceId}.zip` ||
      !build.sourceVersion || build.sourceVersion === "null" || variables.find(v => v.name === "IMAGE_TAG")?.value !== tag || variables.find(v => v.name === "ECR_REPOSITORY")?.value !== selected.ApplicationRepositoryUri) fail("Build identity/source does not match this acceptance");
  return { buildId: build.id, status: build.buildStatus, phase: build.currentPhase, tag, sourceVersion: build.sourceVersion };
}

export function acceptedRollbackReceipt(value, options) {
  if (value?.schema !== 1 || value.accepted !== true || value.acceptanceId !== options.acceptanceId || value.originalImage !== options.baseImage || !/^[a-f0-9]{64}$/.test(value.originalContainerId || "") || value.candidateExitCode !== 1 ||
      ["candidateStarted", "candidateReadinessFailed", "sameContainerRestored", "sameConfigAndMounts", "persistentVolumeVerified", "readyAfterRecovery", "candidateRemoved"].some(key => value[key] !== true) || value.secretsMutated !== false || value.dataDeleted !== false) fail("Rollback receipt did not prove controlled failure and exact recovery");
  return { schema: 1, accepted: true, acceptanceId: options.acceptanceId, originalContainerId: value.originalContainerId, originalImage: options.baseImage,
    candidateStarted: true, candidateExitCode: 1, candidateReadinessFailed: true, sameContainerRestored: true, sameConfigAndMounts: true, persistentVolumeVerified: true,
    readyAfterRecovery: true, candidateRemoved: true, secretsMutated: false, dataDeleted: false, olderPreviousSlotMayBeConsumed: true };
}

export async function smokeAwsRollback(options, { engineLoader = loadEngine, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {} } = {}) {
  if (!options.run || options.action === "plan") return { dryRun: true, ...target, engineRevision, phases: ["build: upload generated non-secret minimal ZIP and start existing CodeBuild", "status: observe exact build and immutable failure digest", "verify: guard current container, fail candidate readiness, prove shared-engine recovery"],
    candidateEntrypoint: ["/bin/false"], inheritedFilesystem: "identical to immutable base", secretsMutated: false, dataDeleted: false, downtimeExpected: true, olderPreviousSlotMayBeConsumed: true, buildAndSourceRetainedForEvidence: true };
  const loaded = await engineLoader(options.engine), shared = loaded.module;
  const engineOptions = { profile: target.profile, region: target.region, "expected-account": target.account, stack: target.stack };
  const aws = new shared.AwsCli(engineOptions);
  const stack = await shared.guardedStack(aws, engineOptions);
  const selected = await shared.deploymentTarget(aws, engineOptions, stack);
  const resources = (await aws.call("cloudformation", "list-stack-resources", ["--stack-name", stack.StackId])).StackResourceSummaries || [];
  Object.assign(selected, buildTarget(stack, resources));
  if (selected.ControllerInstanceId !== "i-08c991c22089589a5" || options.baseImage.split("@")[0] !== selected.ApplicationRepositoryUri) fail("Rollback acceptance is limited to the current exact MVP controller/repository");
  const base = await aws.call("ecr", "batch-get-image", ["--repository-name", selected.repository, "--image-ids", `imageDigest=${options.baseImage.split("@")[1]}`]);
  if (!base.images?.some(i => i.imageId?.imageDigest === options.baseImage.split("@")[1])) fail("Immutable healthy base image is not available");
  const repositories = (await aws.call("ecr", "describe-repositories", ["--repository-names", selected.repository])).repositories;
  if (repositories?.length !== 1 || repositories[0].repositoryUri !== selected.ApplicationRepositoryUri || repositories[0].imageTagMutability !== "IMMUTABLE") fail("Acceptance requires an immutable owned image repository");
  if (options.action === "build") {
    const projects = (await aws.call("codebuild", "batch-get-projects", ["--names", selected.ImageBuildProject])).projects;
    const project = projects?.[0], role = resources.find(r => r.LogicalResourceId === "ImageBuildRole" && r.ResourceType === "AWS::IAM::Role")?.PhysicalResourceId;
    if (projects?.length !== 1 || project.name !== selected.ImageBuildProject || project.serviceRole !== `arn:aws:iam::${target.account}:role/${role}` || project.environment?.image !== "aws/codebuild/standard:7.0" || project.environment.privilegedMode !== true) fail("Acceptance build project differs from the owned reviewed builder");
    const buildspec = { version: "0.2", phases: { pre_build: { commands: ["aws ecr get-login-password --region \"$AWS_DEFAULT_REGION\" | docker login --username AWS --password-stdin \"${ECR_REPOSITORY%/*}\""] }, build: { commands: ["docker build --file deploy/aws/Dockerfile --target runner --tag \"$ECR_REPOSITORY:$IMAGE_TAG\" .", "docker push \"$ECR_REPOSITORY:$IMAGE_TAG\""] } } };
    const directory = await mkdtemp(path.join(os.tmpdir(), "relay-rollback-source-"));
    try {
      const archive = acceptanceArchive(options.baseImage, options.acceptanceId), filename = path.join(directory, "source.zip"), key = `source/rollback-${options.acceptanceId}.zip`;
      await writeFile(filename, archive, { mode: 0o600, flag: "wx" });
      const uploaded = await aws.call("s3api", "put-object", ["--bucket", selected.ArtifactBucket, "--key", key, "--body", filename, "--server-side-encryption", "AES256"]);
      if (!uploaded.VersionId || uploaded.VersionId === "null") fail("Acceptance source requires an immutable S3 object version");
      const build = (await aws.call("codebuild", "start-build", ["--project-name", selected.ImageBuildProject, "--source-type-override", "S3", "--source-location-override", `${selected.ArtifactBucket}/${key}`, "--source-version", uploaded.VersionId,
        "--buildspec-override", JSON.stringify(buildspec), "--timeout-in-minutes-override", "10", "--queued-timeout-in-minutes-override", "5", "--idempotency-token", options.acceptanceId,
        "--environment-variables-override", JSON.stringify([{ name: "IMAGE_TAG", value: `rollback-${options.acceptanceId}`, type: "PLAINTEXT" }, { name: "ECR_REPOSITORY", value: selected.ApplicationRepositoryUri, type: "PLAINTEXT" }])])).build;
      const summary = acceptanceBuild(build, selected, { ...options, buildId: build?.id });
      if (summary.sourceVersion !== uploaded.VersionId) fail("Acceptance build source version changed");
      return { started: true, acceptanceId: options.acceptanceId, baseImage: options.baseImage, archiveSha256: digest(archive), ...summary };
    } finally { await rm(directory, { recursive: true, force: false }); }
  }
  const build = (await aws.call("codebuild", "batch-get-builds", ["--ids", options.buildId])).builds?.[0];
  const summary = acceptanceBuild(build, selected, options);
  if (summary.status !== "SUCCEEDED") {
    if (options.action === "verify") fail("Wait for the exact acceptance build to succeed before verify");
    return summary;
  }
  const details = (await aws.call("ecr", "describe-images", ["--repository-name", selected.repository, "--image-ids", `imageTag=${summary.tag}`])).imageDetails;
  if (details?.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(details[0].imageDigest || "")) fail("Acceptance candidate digest is unavailable");
  const image = `${selected.ApplicationRepositoryUri}@${details[0].imageDigest}`;
  if (image === options.baseImage) fail("Failure candidate must differ from the healthy base");
  if (options.action === "status") return { ...summary, image, baseImage: options.baseImage };
  const config = { action: "deploy", acceptanceId: options.acceptanceId, baseImage: options.baseImage, region: target.region, stack: stack.StackId,
    image, container: "relay", mount: "/srv/relay/data", destination: "/var/lib/relay", port: 8787, health: "/readyz", timeout: 30,
    secret: selected.SecretArn, registry: selected.registry, volume: selected.DataVolumeId, readyFile: "/var/lib/relay-controller-ready",
    engineGzip: gzipSync(loaded.source).toString("base64"), engineSha256: digest(loaded.source) };
  const source = await readFile(new URL("../deploy/aws/rollback-acceptance-host.py", import.meta.url), "utf8");
  const command = `python3 - '${Buffer.from(JSON.stringify(config)).toString("base64")}' <<'RELAY_ROLLBACK_ACCEPTANCE'\n${source}\nRELAY_ROLLBACK_ACCEPTANCE`;
  const sent = await aws.call("ssm", "send-command", ["--instance-ids", selected.ControllerInstanceId, "--document-name", "AWS-RunShellScript", "--timeout-seconds", "600",
    "--parameters", JSON.stringify({ commands: [command], executionTimeout: ["3000"] }), "--cloud-watch-output-config", "CloudWatchOutputEnabled=false", "--comment", "Relay controlled failed-rollout acceptance"]);
  const commandId = sent.Command?.CommandId;
  if (!/^[a-f0-9-]{36}$/.test(commandId || "")) fail("SSM acceptance command handle unavailable; inspect before retrying");
  log(`Rollback acceptance command ${commandId} submitted; observe this handle, do not resubmit.`);
  for (let attempt = 0; attempt < 600; attempt++) {
    let result;
    try { result = await aws.call("ssm", "get-command-invocation", ["--instance-id", selected.ControllerInstanceId, "--command-id", commandId]); }
    catch (error) { if (error.code === "NotYetVisible") { await sleep(5000); continue; } throw error; }
    if (["Pending", "InProgress", "Delayed"].includes(result.Status)) { await sleep(5000); continue; }
    if (result.Status !== "Success" || result.ResponseCode !== 0) fail(`Rollback acceptance ${commandId} did not pass; inspect current controller readiness before any further deployment`);
    let value; try { value = JSON.parse(result.StandardOutputContent); } catch { fail("Invalid rollback acceptance receipt; output suppressed"); }
    return { ...acceptedRollbackReceipt(value, options), commandId, candidateImage: image, buildId: options.buildId };
  }
  fail(`Observation timed out; inspect existing rollback acceptance command ${commandId}. Do not submit it again.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await smokeAwsRollback(parseRollbackOptions(process.argv.slice(2)), { log: message => console.error(message) }), null, 2)); }
  catch { console.error("Rollback acceptance failed; private output suppressed. Inspect the exact build/SSM handle and existing controller before retrying."); process.exitCode = 1; }
}
