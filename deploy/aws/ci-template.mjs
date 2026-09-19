#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ciTarget = Object.freeze(JSON.parse(readFileSync(new URL("./ci-target.json", import.meta.url), "utf8")));
const arn = service => `arn:aws:${service}:${ciTarget.region}:${ciTarget.account}:`;
const fail = message => { throw new Error(message); };

// Offline renderer only. A separate operator explicitly provisions this leaf
// stack. No credentials, AWS client, provider import or environment activation.
export function ciDeploymentTemplate({ stack, existingProviderArn = "", createProvider = false }) {
  if (!stack || stack.StackName !== ciTarget.applicationStack ||
      !stack.StackId?.startsWith(arn("cloudformation") + `stack/${ciTarget.applicationStack}/`) ||
      !/^[A-Za-z0-9-]{1,64}$/.test(stack.StackId.split("/").at(-1)) ||
      !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus) ||
      !stack.Tags?.some(tag => tag.Key === "ManagedBy" && tag.Value === "12-apps-ci")) {
    fail("Use the completed, owned application stack in the pinned AWS account and region.");
  }
  const outputs = Object.fromEntries((stack.Outputs || []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  if (outputs.DeploymentName !== ciTarget.applicationStack || !/^i-[a-f0-9]{8,17}$/.test(outputs.ControllerInstanceId || "")) fail("Application outputs must identify this deployment and one exact controller instance.");
  const registry = `${ciTarget.account}.dkr.ecr.${ciTarget.region}.amazonaws.com/`;
  const repositoryName = outputs.ApplicationRepositoryUri?.startsWith(registry) ? outputs.ApplicationRepositoryUri.slice(registry.length) : "";
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(repositoryName)) fail("Application ECR repository must belong to the pinned account and region.");
  const providerArn = `arn:aws:iam::${ciTarget.account}:oidc-provider/token.actions.githubusercontent.com`;
  if (existingProviderArn && existingProviderArn !== providerArn) fail("Existing GitHub OIDC provider must be the exact provider in the pinned account.");
  if (Boolean(existingProviderArn) === Boolean(createProvider)) fail("Choose an existing provider ARN OR explicitly create a new provider after checking none exists.");

  const tags = [{ Key: "ManagedBy", Value: "12-apps-ci" }, { Key: "AgentRelayDeployment", Value: ciTarget.applicationStack }, { Key: "Purpose", Value: "github-rollout-only" }];
  const regional = { StringEquals: { "aws:RequestedRegion": ciTarget.region } };
  const allow = (Sid, Action, Resource, Condition = regional) => ({ Sid, Effect: "Allow", Action, Resource, ...(Condition ? { Condition } : {}) });
  const resources = {};
  if (createProvider) resources.GitHubOidcProvider = {
    Type: "AWS::IAM::OIDCProvider", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
    Properties: { Url: "https://token.actions.githubusercontent.com", ClientIdList: ["sts.amazonaws.com"], Tags: tags },
  };
  resources.RolloutRole = {
    Type: "AWS::IAM::Role",
    Properties: {
      Description: "Manual Relay application rollout only; no infrastructure, image publishing or direct secret access",
      MaxSessionDuration: 3600,
      Tags: tags,
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
        Principal: { Federated: existingProviderArn || { Ref: "GitHubOidcProvider" } },
        Condition: { StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": ciTarget.oidcSubject,
        } },
      }] },
      Policies: [{ PolicyName: "ExactControllerRollout", PolicyDocument: { Version: "2012-10-17", Statement: [
        allow("ReadApplicationStack", ["cloudformation:DescribeStacks", "cloudformation:ListStackResources"], stack.StackId),
        allow("DescribeControllerAndVolume", ["ec2:DescribeInstances", "ec2:DescribeVolumes"], "*"),
        allow("VerifyPublishedDigest", "ecr:BatchGetImage", arn("ecr") + "repository/" + repositoryName),
        allow("ObserveSsmCommand", ["ssm:DescribeInstanceInformation", "ssm:GetCommandInvocation"], "*"),
        allow("RunShellDocumentOnExactController", "ssm:SendCommand", [
          `arn:aws:ssm:${ciTarget.region}::document/AWS-RunShellScript`,
          arn("ec2") + "instance/" + outputs.ControllerInstanceId,
        ]),
      ] } }],
    },
  };
  // GetCallerIdentity does not require an IAM Allow. No sts:* wildcard grant.
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Separate Relay GitHub OIDC rollout role; never update the application stack or adopt an existing provider",
    Metadata: { ApplicationStackId: stack.StackId, EngineRevision: ciTarget.engineRevision, Repository: ciTarget.repository, Environment: ciTarget.environment },
    Resources: resources,
    Outputs: {
      RolloutRoleArn: { Value: { "Fn::GetAtt": ["RolloutRole", "Arn"] } },
      GitHubOidcProviderArn: { Value: existingProviderArn || { Ref: "GitHubOidcProvider" } },
      ExpectedOidcSubject: { Value: ciTarget.oidcSubject },
      ApplicationStackId: { Value: stack.StackId },
    },
  };
}

export async function renderCiTemplate(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--stack-json", "--output", "--existing-provider-arn", "--create-provider"].includes(key) || key in options) fail("Invalid or repeated CI template argument.");
    if (key === "--create-provider") { options[key] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) fail("Incomplete CI template argument.");
    options[key] = value;
  }
  if (!options["--stack-json"] || !options["--output"]) fail("Provide --stack-json from DescribeStacks and a new --output file; choose --existing-provider-arn or --create-provider.");
  let stack;
  try { stack = JSON.parse(await readFile(options["--stack-json"], "utf8")); }
  catch { fail("Cannot read application stack JSON; file contents suppressed."); }
  if (!Array.isArray(stack.Stacks) || stack.Stacks.length !== 1) fail("DescribeStacks input must contain exactly one application stack.");
  const template = ciDeploymentTemplate({ stack: stack.Stacks[0], existingProviderArn: options["--existing-provider-arn"], createProvider: options["--create-provider"] });
  await writeFile(options["--output"], JSON.stringify(template, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { rendered: true, awsChanges: false, ciStack: ciTarget.ciStack };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await renderCiTemplate(process.argv.slice(2)))); }
  catch (error) {
    console.error(error.code ? "Could not create a new CI template file; existing files are never overwritten." : error.message);
    process.exitCode = 1;
  }
}
