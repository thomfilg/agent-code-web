import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { parseRollbackOptions, acceptanceArchive, acceptanceBuild, acceptedRollbackReceipt, smokeAwsRollback } from "../scripts/smoke-aws-rollback.mjs";

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", repo = "456808212788.dkr.ecr.us-east-2.amazonaws.com/relay";
const options = { action: "verify", run: true, acceptanceId: id, baseImage: repo + "@sha256:" + "a".repeat(64), engine: "/private/engine/aws.mjs", buildId: "fixture:" + id };
const outputs = { ControllerInstanceId: "i-08c991c22089589a5", DataVolumeId: "vol-aaaaaaaaaaaaaaaaa", ArtifactBucket: "fixture-artifacts", ImageBuildProject: "fixture",
  ApplicationRepositoryUri: repo, PublicUrl: "https://example.cloudfront.net", SecretArn: "arn:aws:secretsmanager:us-east-2:456808212788:secret:fixture" };
const resources = [["ArtifactBucket", "AWS::S3::Bucket", outputs.ArtifactBucket], ["ImageBuild", "AWS::CodeBuild::Project", outputs.ImageBuildProject], ["ApplicationRepository", "AWS::ECR::Repository", "relay"], ["ImageBuildRole", "AWS::IAM::Role", "fixture-role"]].map(([LogicalResourceId, ResourceType, PhysicalResourceId]) => ({ LogicalResourceId, ResourceType, PhysicalResourceId }));
const build = { id: options.buildId, projectName: "fixture", buildStatus: "SUCCEEDED", currentPhase: "COMPLETED", source: { type: "S3", location: `${outputs.ArtifactBucket}/source/rollback-${id}.zip` }, sourceVersion: "exact-version", environment: { environmentVariables: [{ name: "IMAGE_TAG", value: `rollback-${id}` }, { name: "ECR_REPOSITORY", value: repo }] } };
const receipt = { schema: 1, accepted: true, acceptanceId: id, originalImage: options.baseImage, originalContainerId: "c".repeat(64), candidateExitCode: 1,
  candidateStarted: true, candidateReadinessFailed: true, sameContainerRestored: true, sameConfigAndMounts: true, persistentVolumeVerified: true, readyAfterRecovery: true, candidateRemoved: true, secretsMutated: false, dataDeleted: false };

function fixture({ drift = false, mutateReceipt = x => x, buildStatus = "SUCCEEDED" } = {}) {
  const calls = [], archive = [], stack = { StackId: "arn:aws:cloudformation:us-east-2:456808212788:stack/agent-relay-mvp/fixture", StackStatus: "CREATE_COMPLETE", Tags: [{ Key: "ManagedBy", Value: "12-apps-ci" }], Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
  const engineLoader = async () => ({ source: "# fixture engine source", module: {
    guardedStack: async () => { if (drift) throw Error("Wrong AWS owner"); return stack; },
    deploymentTarget: async () => ({ ...outputs, registry: repo.split("/")[0] }),
    AwsCli: class { async call(service, operation, args = []) {
      calls.push({ service, operation, args });
      if (operation === "list-stack-resources") return { StackResourceSummaries: resources };
      if (operation === "batch-get-image") return { images: [{ imageId: { imageDigest: "sha256:" + "a".repeat(64) } }] };
      if (operation === "describe-repositories") return { repositories: [{ repositoryUri: repo, imageTagMutability: "IMMUTABLE" }] };
      if (operation === "batch-get-projects") return { projects: [{ name: "fixture", serviceRole: "arn:aws:iam::456808212788:role/fixture-role", environment: { image: "aws/codebuild/standard:7.0", privilegedMode: true } }] };
      if (operation === "put-object") { archive.push(await readFile(args[args.indexOf("--body") + 1])); return { VersionId: "exact-version" }; }
      if (operation === "start-build") return { build: { ...build, buildStatus: "IN_PROGRESS" } };
      if (operation === "batch-get-builds") return { builds: [{ ...build, buildStatus }] };
      if (operation === "describe-images") return { imageDetails: [{ imageDigest: "sha256:" + "b".repeat(64) }] };
      if (operation === "send-command") return { Command: { CommandId: id } };
      if (operation === "get-command-invocation") return { Status: "Success", ResponseCode: 0, StandardOutputContent: JSON.stringify(mutateReceipt(receipt)), StandardErrorContent: "PRIVATE" };
      throw Error("Unexpected fixture operation");
    } },
  } });
  return { engineLoader, calls, archive };
}

test("default rollback plan performs no engine load, AWS calls or artifact creation", async () => {
  const result = await smokeAwsRollback(parseRollbackOptions([]), { engineLoader: () => { throw Error(); } });
  assert.equal(result.dryRun, true); assert.equal(result.downtimeExpected, true); assert.equal(result.olderPreviousSlotMayBeConsumed, true);
  assert.throws(() => parseRollbackOptions(["verify", "--run"]));
  assert.throws(() => parseRollbackOptions(["destroy"]));
});

test("failure archive contains only an immutable-base Dockerfile and no executable build steps", () => {
  const files = unzipSync(acceptanceArchive(options.baseImage, id)); assert.deepEqual(Object.keys(files), ["deploy/aws/Dockerfile"]);
  const text = strFromU8(files["deploy/aws/Dockerfile"]); assert.ok(text.startsWith(`FROM ${options.baseImage} AS runner\n`));
  assert.match(text, /ENTRYPOINT \["\/bin\/false"\]/); assert.match(text, /CMD \[\]/); assert.doesNotMatch(text, /RUN |COPY |ADD |TOKEN|SECRET/);
  assert.throws(() => acceptanceArchive("mutable:latest", id));
});

test("build uploads minimal versioned source and uses existing narrowly scoped builder with unique tag", async () => {
  const f = fixture(); const result = await smokeAwsRollback({ ...options, action: "build" }, f);
  assert.equal(result.started, true); assert.equal(result.sourceVersion, "exact-version"); assert.equal(f.archive.length, 1);
  const started = f.calls.find(x => x.operation === "start-build"); assert.ok(started.args.includes("exact-version")); assert.ok(started.args.includes(id));
  assert.equal(f.calls.some(x => x.operation === "send-command" || x.service === "secretsmanager"), false);
  assert.deepEqual(Object.keys(unzipSync(f.archive[0])), ["deploy/aws/Dockerfile"]);
});

test("verify uses original pinned engine in scoped SSM and allowlists exact recovery receipt", async () => {
  const f = fixture({ mutateReceipt: x => ({ ...x, private: "DO NOT PRINT" }) });
  const result = await smokeAwsRollback(options, f); assert.equal(result.accepted, true); assert.doesNotMatch(JSON.stringify(result), /DO NOT PRINT/);
  const sent = f.calls.find(x => x.operation === "send-command"); assert.ok(sent.args.includes(outputs.ControllerInstanceId));
  const params = JSON.parse(sent.args[sent.args.indexOf("--parameters") + 1]);
  const config = JSON.parse(Buffer.from(params.commands[0].match(/^python3 - '([^']+)'/)[1], "base64"));
  assert.equal(gunzipSync(Buffer.from(config.engineGzip, "base64")).toString(), "# fixture engine source");
  assert.equal(config.stack.includes("stack/agent-relay-mvp/"), true); assert.equal(config.timeout, 30); assert.equal(config.mount, "/srv/relay/data");
  assert.equal(f.calls.some(x => /delete|put-secret|update-secret|terminate-instances/.test(x.operation)), false);
});

test("scope drift, pending builds and incomplete receipts cannot start/claim acceptance", async () => {
  const foreign = fixture({ drift: true }); await assert.rejects(smokeAwsRollback(options, foreign)); assert.equal(foreign.calls.length, 0);
  const pending = fixture({ buildStatus: "IN_PROGRESS" }); await assert.rejects(smokeAwsRollback(options, pending)); assert.equal(pending.calls.some(x => x.operation === "send-command"), false);
  for (const patch of [{ sameContainerRestored: false }, { candidateExitCode: 2 }, { candidateStarted: false }, { readyAfterRecovery: false }, { dataDeleted: true }]) assert.throws(() => acceptedRollbackReceipt({ ...receipt, ...patch }, options));
  assert.throws(() => acceptanceBuild({ ...build, sourceVersion: "null" }, outputs, options));
  assert.throws(() => acceptanceBuild({ ...build, id: "foreign" }, outputs, options));
});
