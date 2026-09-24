import assert from "node:assert/strict";
import test from "node:test";
import { buildTarget, buildSummary } from "../scripts/aws-build.mjs";

const outputs = { ArtifactBucket: "relay-artifacts", ImageBuildProject: "relay-build", ApplicationRepositoryUri: "456808212788.dkr.ecr.us-east-2.amazonaws.com/relay-images" };
const stack = { StackStatus: "CREATE_COMPLETE", Tags: [{ Key: "ManagedBy", Value: "12-apps-ci" }], Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
const resources = [{ ResourceType: "AWS::S3::Bucket", PhysicalResourceId: outputs.ArtifactBucket }, { ResourceType: "AWS::CodeBuild::Project", PhysicalResourceId: outputs.ImageBuildProject }, { ResourceType: "AWS::ECR::Repository", PhysicalResourceId: "relay-images" }];
const revision = "a".repeat(40);
const build = { id: "relay-build:00000000-0000-0000-0000-000000000000", projectName: "relay-build", buildStatus: "SUCCEEDED", currentPhase: "COMPLETED", sourceVersion: "immutable-s3-version", environment: { environmentVariables: [{ name: "IMAGE_TAG", value: revision }, { name: "PRIVATE_TEST_VALUE", value: "must-not-print" }] }, source: { location: `relay-artifacts/source/${revision}.zip` } };

test("image building requires completed stack and exact owned resources", () => {
  assert.equal(buildTarget(stack, resources).repository, "relay-images");
  assert.throws(() => buildTarget({ ...stack, StackStatus: "CREATE_IN_PROGRESS" }, resources));
  assert.throws(() => buildTarget({ ...stack, Tags: [] }, resources));
  for (let i = 0; i < resources.length; i++) assert.throws(() => buildTarget(stack, resources.filter((_, n) => n !== i)));
  assert.throws(() => buildTarget({ ...stack, Outputs: stack.Outputs.map(output => output.OutputKey === "ApplicationRepositoryUri" ? { ...output, OutputValue: output.OutputValue.replace("456808212788", "111111111111") } : output) }, resources));
});

test("build status is project and exact committed source bound and redacted", () => {
  const selected = buildTarget(stack, resources);
  const summary = buildSummary(build, selected);
  assert.equal(summary.revision, revision);
  assert.doesNotMatch(JSON.stringify(summary), /must-not-print|PRIVATE_TEST_VALUE/);
  assert.throws(() => buildSummary({ ...build, projectName: "unrelated" }, selected));
  assert.throws(() => buildSummary({ ...build, source: { location: "relay-artifacts/source/other.zip" } }, selected));
  assert.throws(() => buildSummary({ ...build, environment: { environmentVariables: [{ name: "IMAGE_TAG", value: "latest" }] } }, selected));
  assert.throws(() => buildSummary({ ...build, sourceVersion: undefined }, selected));
  assert.throws(() => buildSummary({ ...build, sourceVersion: "null" }, selected));
  assert.throws(() => buildSummary(build, selected, "different-upload"));
  assert.equal(buildSummary(build, selected, "immutable-s3-version").sourceVersion, "immutable-s3-version");
});
