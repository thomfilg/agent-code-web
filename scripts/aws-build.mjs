#!/usr/bin/env node
// Build is deliberately separate from rollout: source is a committed archive,
// the service role has no application-secret access, deployment takes a digest.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aws, target, verifyTarget } from "./aws-deploy.mjs";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ready = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]);

export function buildTarget(stack, resources) {
  if (!ready.has(stack?.StackStatus) || !stack.Tags?.some(tag => tag.Key === "ManagedBy" && tag.Value === "12-apps-ci")) throw new Error("Deployment stack is not ready or owned");
  const outputs = Object.fromEntries((stack.Outputs || []).map(item => [item.OutputKey, item.OutputValue]));
  for (const [name, type] of Object.entries({ ArtifactBucket: "AWS::S3::Bucket", ImageBuildProject: "AWS::CodeBuild::Project" })) {
    if (!outputs[name] || !resources.some(item => item.ResourceType === type && item.PhysicalResourceId === outputs[name])) throw new Error(`Unowned ${name}`);
  }
  const prefix = `${target.account}.dkr.ecr.${target.region}.amazonaws.com/`;
  if (!outputs.ApplicationRepositoryUri?.startsWith(prefix)) throw new Error("Unexpected repository account or region");
  const repository = outputs.ApplicationRepositoryUri.slice(prefix.length);
  if (!/^[a-z0-9][a-z0-9._/-]+$/.test(repository) || !resources.some(item => item.ResourceType === "AWS::ECR::Repository" && item.PhysicalResourceId === repository)) throw new Error("Unowned image repository");
  return { ...outputs, repository };
}

export function buildSummary(build, selected) {
  if (build?.projectName !== selected.ImageBuildProject) throw new Error("Build does not belong to this deployment");
  const tag = build.environment?.environmentVariables?.find(item => item.name === "IMAGE_TAG")?.value;
  if (!/^[a-f0-9]{40}$/.test(tag || "") || build.source?.location !== `${selected.ArtifactBucket}/source/${tag}.zip`) throw new Error("Build does not identify an exact committed source archive");
  return { id: build.id, status: build.buildStatus, phase: build.currentPhase, revision: tag, logGroup: build.logs?.groupName, logStream: build.logs?.streamName };
}

export async function main(args) {
  const [action, value, ...rest] = args;
  if (!["start", "status"].includes(action) || rest.length || action === "start" && value || action === "status" && !/^[A-Za-z0-9_-]+:[a-f0-9-]{36}$/.test(value || "")) throw new Error("Usage: aws-build.mjs start | status PROJECT:BUILD_UUID");
  await verifyTarget();
  const stack = (await aws(["cloudformation", "describe-stacks"], ["--stack-name", target.stack])).Stacks?.[0];
  const resources = (await aws(["cloudformation", "list-stack-resources"], ["--stack-name", target.stack])).StackResourceSummaries || [];
  const selected = buildTarget(stack, resources);
  if (action === "status") {
    const build = (await aws(["codebuild", "batch-get-builds"], ["--ids", value])).builds?.[0];
    const summary = buildSummary(build, selected);
    if (summary.status === "SUCCEEDED") {
      const image = (await aws(["ecr", "describe-images"], ["--repository-name", selected.repository, "--image-ids", `imageTag=${summary.revision}`])).imageDetails?.[0];
      if (!/^sha256:[a-f0-9]{64}$/.test(image?.imageDigest || "")) throw new Error("Successful build has no immutable image");
      summary.image = `${selected.ApplicationRepositoryUri}@${image.imageDigest}`;
    }
    console.log(JSON.stringify(summary));
    return;
  }
  const revision = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid source revision");
  // Untracked developer fixtures and private data never enter git archive.
  // Require all tracked deploy inputs to be committed before building them.
  const changed = (await execute("git", ["diff", "--name-only", "HEAD", "--", "src", "public", "deploy", "chrome-extension", "package.json", "package-lock.json", "scripts/build-auth.mjs"], { cwd: root })).stdout.trim();
  if (changed) throw new Error("Commit tracked runtime changes before creating an immutable build");
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-aws-source-"));
  const filename = path.join(directory, "source.zip"), key = `source/${revision}.zip`;
  try {
    await execute("git", ["archive", "--format=zip", `--output=${filename}`, revision, ".dockerignore", "deploy/aws", "package.json", "package-lock.json", "scripts/build-auth.mjs", "src", "public", "chrome-extension"], { cwd: root });
    await aws(["s3api", "put-object"], ["--bucket", selected.ArtifactBucket, "--key", key, "--body", filename, "--server-side-encryption", "AES256"]);
    const result = await aws(["codebuild", "start-build"], ["--project-name", selected.ImageBuildProject, "--source-type-override", "S3", "--source-location-override", `${selected.ArtifactBucket}/${key}`, "--environment-variables-override", JSON.stringify([{ name: "IMAGE_TAG", value: revision, type: "PLAINTEXT" }])]);
    console.log(JSON.stringify({ started: true, ...buildSummary(result.build, selected) }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
