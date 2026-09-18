import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { relayTemplate } from "../deploy/aws/template.mjs";

test("AWS template keeps state, controller and untrusted workers separated", () => {
  const t = relayTemplate(), r = t.Resources;
  assert.equal(r.Controller.Properties.SubnetId.Ref, "ControllerSubnet");
  assert.equal(r.ControllerSubnet.Properties.MapPublicIpOnLaunch, false);
  assert.equal(r.WorkerSubnet.Properties.MapPublicIpOnLaunch, false);
  assert.equal(r.Controller.Properties.MetadataOptions.HttpTokens, "required");
  assert.equal(r.Controller.Properties.MetadataOptions.HttpPutResponseHopLimit, 1);
  assert.equal(r.DataVolume.Properties.Encrypted, true);
  assert.equal(r.DataVolume.DeletionPolicy, "Retain");
  assert.equal(r.DataVolume.UpdateReplacePolicy, "Retain");
  assert.equal(r.ApplicationSecret.DeletionPolicy, "Retain");
  assert.equal(r.ApplicationRepository.Properties.ImageTagMutability, "IMMUTABLE");
  assert.deepEqual(r.WorkerGroup.Properties.SecurityGroupIngress, [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, SourceSecurityGroupId: { Ref: "ControllerGroup" } }]);
  assert.equal(r.ControllerGroup.Properties.SecurityGroupIngress[0].SourcePrefixListId.Ref, "CloudFrontPrefixListId");
  assert.equal(r.BuilderRole.Properties.Policies, undefined);
  const statements = r.ControllerRole.Properties.Policies.flatMap(p => p.PolicyDocument.Statement);
  assert.equal(statements.some(s => JSON.stringify(s.Action).includes("PassRole")), false);
  const stop = statements.find(s => s.Action.includes("ec2:StopInstances"));
  assert.equal(stop.Condition.StringEquals["ec2:ResourceTag/AgentRelayDeployment"].Ref, "AWS::StackName");
  assert.equal(stop.Condition.StringEquals["ec2:ResourceTag/ManagedBy"], "agent-relay");
  const images = statements.find(s => s.Action === "ec2:RunInstances" && JSON.stringify(s.Resource).includes("image/*"));
  assert.equal(images.Condition.StringEquals["ec2:ResourceTag/AgentRelayAcceptance"], "verified-v1");
  for (const statement of statements.filter(s => JSON.stringify(s.Action).includes("CreateTags"))) {
    assert.doesNotMatch(JSON.stringify(statement.Resource), /image\//);
    assert.equal(statement.Condition.StringEquals["ec2:CreateAction"], "RunInstances");
  }
  const source = JSON.stringify(t);
  assert.doesNotMatch(source, /PRIVATE KEY|GOOGLE_CLIENT_SECRET|DOPPLER_TOKEN|auth\.json/);
  assert.equal(t.Parameters.BaseImageId.Type, "AWS::EC2::Image::Id");
});

test("CloudFront forwards stateful HTTP and WebSockets without caches or public origins", () => {
  const r = relayTemplate().Resources, d = r.Distribution.Properties.DistributionConfig;
  assert.equal(d.ViewerCertificate.CloudFrontDefaultCertificate, true);
  assert.equal(d.Origins[0].VpcOriginConfig.VpcOriginId["Fn::GetAtt"][0], "VpcOrigin");
  assert.equal(d.DefaultCacheBehavior.CachePolicyId, "4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
  assert.equal(d.DefaultCacheBehavior.OriginRequestPolicyId, "216adef6-5c7f-47e4-b989-5492eafa07d3");
  assert.equal(d.DefaultCacheBehavior.ViewerProtocolPolicy, "redirect-to-https");
  assert.equal(d.DefaultCacheBehavior.Compress, false);
  assert.deepEqual(d.DefaultCacheBehavior.AllowedMethods, ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]);
  assert.ok(d.CustomErrorResponses.every(r => r.ErrorCachingMinTTL === 0));
  assert.equal(r.VpcOrigin.Properties.VpcOriginEndpointConfig.HTTPPort, 8787);
});

test("bootstrap formats only the specifically attached unformatted volume", () => {
  const script = relayTemplate().Resources.Controller.Properties.UserData["Fn::Base64"]["Fn::Sub"];
  assert.match(script, /volume_id='\$\{DataVolume\}'/);
  assert.match(script, /wipefs --no-act/);
  assert.match(script, /filesystem.*!= ext4/);
  assert.match(script, /mkfs\.ext4 "\$device"/);
  assert.match(script, /chmod 0700 \/srv\/relay\/data/);
  assert.doesNotMatch(script, /mkfs.*\/dev\/(?:sda|xvda|nvme0n1)/);
});

test("controller build is a secret-free allowlist context and pinned CLI versions", async () => {
  const dockerfile = await readFile(new URL("../deploy/aws/Dockerfile", import.meta.url), "utf8");
  const ignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
  assert.ok(ignore.startsWith("**\n"));
  assert.doesNotMatch(ignore, /!data|!\.env|!\.git(?:\/|\n)|!node_modules/);
  assert.match(dockerfile, /CODEX_VERSION=0\.154\.0/);
  assert.match(dockerfile, /CLAUDE_VERSION=2\.1\.222/);
  assert.match(dockerfile, /USER node/);
  assert.doesNotMatch(dockerfile, /COPY \. \.|ARG .*TOKEN|ARG .*SECRET|AGENT_ENABLE_MOCK=1/);
});
