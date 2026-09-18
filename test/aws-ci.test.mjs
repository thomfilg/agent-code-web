import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ciDeploymentTemplate, ciTarget, renderCiTemplate } from "../deploy/aws/ci-template.mjs";
import { target, engineRevision } from "../scripts/aws-deploy.mjs";

const providerArn = `arn:aws:iam::${ciTarget.account}:oidc-provider/token.actions.githubusercontent.com`;
const instance = "i-0123456789abcdef0";
const stackId = `arn:aws:cloudformation:${ciTarget.region}:${ciTarget.account}:stack/${ciTarget.applicationStack}/fixture`;
function stack(overrides = {}) {
  return {
    StackName: ciTarget.applicationStack, StackId: stackId, StackStatus: "CREATE_COMPLETE",
    Tags: [{ Key: "ManagedBy", Value: "12-apps-ci" }],
    Outputs: Object.entries({ DeploymentName: ciTarget.applicationStack, ControllerInstanceId: instance, ApplicationRepositoryUri: `${ciTarget.account}.dkr.ecr.${ciTarget.region}.amazonaws.com/relay-fixture`, UnrelatedSensitiveOutput: "never-copy-this" }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
    ...overrides,
  };
}
const existing = value => ciDeploymentTemplate({ stack: value || stack(), existingProviderArn: providerArn });

test("CI target matches the reviewed application target and shared engine", () => {
  assert.equal(ciTarget.account, target.account);
  assert.equal(ciTarget.region, target.region);
  assert.equal(ciTarget.applicationStack, target.stack);
  assert.equal(ciTarget.engineRevision, engineRevision);
  assert.equal(ciTarget.enabledByDefault, false);
  assert.notEqual(ciTarget.ciStack, ciTarget.applicationStack);
});

test("leaf references an existing provider without adopting or modifying it", () => {
  const t = existing();
  assert.deepEqual(Object.keys(t.Resources), ["RolloutRole"]);
  assert.equal(t.Resources.RolloutRole.Type, "AWS::IAM::Role");
  const trust = t.Resources.RolloutRole.Properties.AssumeRolePolicyDocument.Statement;
  assert.equal(trust.length, 1);
  assert.equal(trust[0].Principal.Federated, providerArn);
  assert.equal(trust[0].Action, "sts:AssumeRoleWithWebIdentity");
  assert.deepEqual(trust[0].Condition, { StringEquals: {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:thomfilg@648890/agent-code-web@1370075262:environment:aws-mvp",
  } });
  assert.doesNotMatch(JSON.stringify(t), /never-copy-this|StringLike|secretsmanager|iam:PassRole/);
});

test("creating a provider is explicit and retained; conflicting or foreign provider choices fail", () => {
  const t = ciDeploymentTemplate({ stack: stack(), createProvider: true });
  assert.deepEqual(t.Resources.GitHubOidcProvider.Properties.ClientIdList, ["sts.amazonaws.com"]);
  assert.equal(t.Resources.GitHubOidcProvider.DeletionPolicy, "Retain");
  assert.equal(t.Resources.GitHubOidcProvider.UpdateReplacePolicy, "Retain");
  assert.deepEqual(t.Resources.RolloutRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal, { Federated: { Ref: "GitHubOidcProvider" } });
  for (const options of [{}, { existingProviderArn: providerArn, createProvider: true }, { existingProviderArn: providerArn.replace(ciTarget.account, "123456789012") }, { existingProviderArn: providerArn.replace("token.actions", "foreign.actions") }]) {
    assert.throws(() => ciDeploymentTemplate({ stack: stack(), ...options }), /provider/i);
  }
});

test("foreign, unstable, unowned or incomplete application metadata cannot render authority", () => {
  for (const value of [
    stack({ StackName: "another-app" }), stack({ StackStatus: "CREATE_IN_PROGRESS" }), stack({ Tags: [] }),
    stack({ StackId: stackId.replace(ciTarget.account, "123456789012") }),
    stack({ StackId: stackId.replace(ciTarget.region, "us-west-1") }),
    stack({ StackId: stackId.replace("/fixture", "/*") }),
    stack({ Outputs: [] }),
    stack({ Outputs: stack().Outputs.map(output => output.OutputKey === "ApplicationRepositoryUri" ? { ...output, OutputValue: "123456789012.dkr.ecr.us-east-2.amazonaws.com/foreign" } : output) }),
    stack({ Outputs: stack().Outputs.map(output => output.OutputKey === "ControllerInstanceId" ? { ...output, OutputValue: "*" } : output) }),
  ]) assert.throws(() => existing(value));
});

test("policy grants only exact stack/repository/controller rollout, never infrastructure or direct secret access", () => {
  const role = existing().Resources.RolloutRole.Properties;
  assert.equal(role.ManagedPolicyArns, undefined);
  assert.equal(role.Policies.length, 1);
  const statements = role.Policies[0].PolicyDocument.Statement;
  assert.deepEqual(statements.flatMap(s => s.Action).sort(), ["cloudformation:DescribeStacks", "cloudformation:ListStackResources", "ec2:DescribeInstances", "ec2:DescribeVolumes", "ecr:BatchGetImage", "ssm:DescribeInstanceInformation", "ssm:GetCommandInvocation", "ssm:SendCommand"].sort());
  for (const statement of statements) assert.deepEqual(statement.Condition, { StringEquals: { "aws:RequestedRegion": ciTarget.region } });
  assert.equal(statements.find(s => s.Sid === "ReadApplicationStack").Resource, stackId);
  assert.equal(statements.find(s => s.Sid === "VerifyPublishedDigest").Resource, `arn:aws:ecr:${ciTarget.region}:${ciTarget.account}:repository/relay-fixture`);
  assert.deepEqual(statements.find(s => s.Sid === "RunShellDocumentOnExactController").Resource, [
    `arn:aws:ssm:${ciTarget.region}::document/AWS-RunShellScript`,
    `arn:aws:ec2:${ciTarget.region}:${ciTarget.account}:instance/${instance}`,
  ]);
  assert.deepEqual(statements.filter(s => s.Resource === "*").map(s => s.Sid), ["DescribeControllerAndVolume", "ObserveSsmCommand"]);
});

test("offline renderer handles one stack, never overwrites files, and rejects ambiguous arguments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-ci-template-"));
  try {
    const input = path.join(directory, "stack.json"), output = path.join(directory, "ci.json");
    await writeFile(input, JSON.stringify({ Stacks: [stack()] }));
    const args = ["--stack-json", input, "--output", output, "--existing-provider-arn", providerArn];
    assert.deepEqual(await renderCiTemplate(args), { rendered: true, awsChanges: false, ciStack: ciTarget.ciStack });
    assert.equal(JSON.parse(await readFile(output, "utf8")).Resources.RolloutRole.Type, "AWS::IAM::Role");
    await assert.rejects(renderCiTemplate(args), error => error.code === "EEXIST");
    await assert.rejects(renderCiTemplate([...args, "--output", "another"]), /repeated/);
    await writeFile(input, JSON.stringify({ Stacks: [stack(), stack()] }));
    await assert.rejects(renderCiTemplate(args), /exactly one/);
    await writeFile(input, "private-malformed-file-value");
    await assert.rejects(renderCiTemplate(args), error => /suppressed/.test(error.message) && !error.message.includes("private-malformed"));
  } finally { await rm(directory, { recursive: true }); }
});

test("manual consumer is off by default, main-only, pinned twice and never provisions or inherits credentials", async () => {
  const workflow = await readFile(new URL("../.github/workflows/aws-mvp-deploy.yml", import.meta.url), "utf8");
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(workflow, /vars\.ENABLE_DEPLOY_AWS == 'true'/);
  assert.match(workflow, /github\.repository == 'thomfilg\/agent-code-web'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /inputs\.action == 'status' \|\| inputs\.confirm_rollout/);
  assert.match(workflow, /options: \[status, deploy, rollback\]/);
  assert.match(workflow, /environment: aws-mvp/);
  assert.equal(workflow.includes("secrets: inherit"), false);
  assert.doesNotMatch(workflow, /\$\{\{ secrets\.|docker build|run:|provision|destroy/);
  assert.equal(workflow.match(new RegExp(ciTarget.engineRevision, "g"))?.length, 2);
  assert.ok(workflow.includes(`expected_account: '${ciTarget.account}'`));
  assert.ok(workflow.includes(`region: ${ciTarget.region}`));
  assert.ok(workflow.includes(`stack: ${ciTarget.applicationStack}`));
  assert.ok(workflow.includes(`ready_file: ${ciTarget.readyFile}`));
});
