import { fileURLToPath } from "node:url";
import path from "node:path";

// Application infrastructure only. Provisioning, rollout and rollback live in
// 12-apps/ci; this template contains no user credentials or deployment engine.
const ref = name => ({ Ref: name });
const sub = value => ({ "Fn::Sub": value });
const get = (name, key) => ({ "Fn::GetAtt": [name, key] });
const tags = extra => [{ Key: "ManagedBy", Value: "12-apps-ci" }, { Key: "AgentRelayDeployment", Value: ref("AWS::StackName") }, ...(extra || [])];
const assume = service => ({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }] });
const allow = (Action, Resource, Condition) => ({ Effect: "Allow", Action, Resource, ...(Condition ? { Condition } : {}) });
const policy = (name, statements) => ({ PolicyName: name, PolicyDocument: { Version: "2012-10-17", Statement: statements } });

export function relayTemplate() {
  const r = {};
  const resource = (name, Type, Properties, rest = {}) => r[name] = { Type, Properties, ...rest };
  resource("Vpc", "AWS::EC2::VPC", { CidrBlock: "10.84.0.0/16", EnableDnsSupport: true, EnableDnsHostnames: true, Tags: tags() });
  resource("InternetGateway", "AWS::EC2::InternetGateway", { Tags: tags() });
  resource("GatewayAttachment", "AWS::EC2::VPCGatewayAttachment", { VpcId: ref("Vpc"), InternetGatewayId: ref("InternetGateway") });
  resource("PublicSubnet", "AWS::EC2::Subnet", { VpcId: ref("Vpc"), AvailabilityZone: ref("AvailabilityZone"), CidrBlock: "10.84.0.0/24", MapPublicIpOnLaunch: false, Tags: tags() });
  resource("ControllerSubnet", "AWS::EC2::Subnet", { VpcId: ref("Vpc"), AvailabilityZone: ref("AvailabilityZone"), CidrBlock: "10.84.1.0/24", MapPublicIpOnLaunch: false, Tags: tags() });
  resource("WorkerSubnet", "AWS::EC2::Subnet", { VpcId: ref("Vpc"), AvailabilityZone: ref("AvailabilityZone"), CidrBlock: "10.84.2.0/24", MapPublicIpOnLaunch: false, Tags: tags() });
  resource("PublicRoutes", "AWS::EC2::RouteTable", { VpcId: ref("Vpc"), Tags: tags() });
  resource("PrivateRoutes", "AWS::EC2::RouteTable", { VpcId: ref("Vpc"), Tags: tags() });
  for (const subnet of ["PublicSubnet", "ControllerSubnet", "WorkerSubnet"]) resource(subnet + "Routes", "AWS::EC2::SubnetRouteTableAssociation", { SubnetId: ref(subnet), RouteTableId: ref(subnet === "PublicSubnet" ? "PublicRoutes" : "PrivateRoutes") });
  resource("PublicInternet", "AWS::EC2::Route", { RouteTableId: ref("PublicRoutes"), DestinationCidrBlock: "0.0.0.0/0", GatewayId: ref("InternetGateway") }, { DependsOn: "GatewayAttachment" });
  resource("NatAddress", "AWS::EC2::EIP", { Domain: "vpc", Tags: tags() });
  resource("Nat", "AWS::EC2::NatGateway", { AllocationId: get("NatAddress", "AllocationId"), SubnetId: ref("PublicSubnet"), Tags: tags() }, { DependsOn: "PublicInternet" });
  resource("PrivateInternet", "AWS::EC2::Route", { RouteTableId: ref("PrivateRoutes"), DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: ref("Nat") });
  resource("S3Endpoint", "AWS::EC2::VPCEndpoint", { VpcId: ref("Vpc"), ServiceName: sub("com.amazonaws.${AWS::Region}.s3"), VpcEndpointType: "Gateway", RouteTableIds: [ref("PrivateRoutes")] });
  resource("ControllerGroup", "AWS::EC2::SecurityGroup", { GroupDescription: "Relay controller; CloudFront VPC origin only", VpcId: ref("Vpc"), Tags: tags(), SecurityGroupIngress: [{ IpProtocol: "tcp", FromPort: 8787, ToPort: 8787, SourcePrefixListId: ref("CloudFrontPrefixListId") }], SecurityGroupEgress: [{ IpProtocol: "-1", CidrIp: "0.0.0.0/0" }] });
  resource("WorkerGroup", "AWS::EC2::SecurityGroup", { GroupDescription: "One-chat workers; SSH only from Relay controller", VpcId: ref("Vpc"), Tags: tags(), SecurityGroupIngress: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, SourceSecurityGroupId: ref("ControllerGroup") }], SecurityGroupEgress: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" }, { IpProtocol: "tcp", FromPort: 80, ToPort: 80, CidrIp: "0.0.0.0/0" }] });
  resource("WorkerKey", "AWS::EC2::KeyPair", { KeyName: sub("${AWS::StackName}-worker"), PublicKeyMaterial: ref("WorkerPublicKey"), Tags: tags() });
  resource("ApplicationRepository", "AWS::ECR::Repository", { ImageTagMutability: "IMMUTABLE", ImageScanningConfiguration: { ScanOnPush: true }, EncryptionConfiguration: { EncryptionType: "AES256" }, Tags: tags() }, { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  resource("ArtifactBucket", "AWS::S3::Bucket", { BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] }, PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }, VersioningConfiguration: { Status: "Enabled" }, Tags: tags() }, { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  resource("ArtifactBucketPolicy", "AWS::S3::BucketPolicy", { Bucket: ref("ArtifactBucket"), PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [get("ArtifactBucket", "Arn"), sub("${ArtifactBucket.Arn}/*")], Condition: { Bool: { "aws:SecureTransport": "false" } } }] } });
  resource("ApplicationSecret", "AWS::SecretsManager::Secret", { Description: "Relay controller environment; populated from dedicated Doppler config after provision", Tags: tags() }, { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  const ssmPolicy = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore";
  resource("ControllerRole", "AWS::IAM::Role", { AssumeRolePolicyDocument: assume("ec2.amazonaws.com"), ManagedPolicyArns: [ssmPolicy], Tags: tags(), Policies: [policy("ControllerResources", [
    allow(["secretsmanager:GetSecretValue"], ref("ApplicationSecret")),
    allow(["ecr:GetAuthorizationToken"], "*"),
    allow(["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], get("ApplicationRepository", "Arn")),
    allow(["ec2:DescribeInstances", "ec2:DescribeInstanceStatus", "ec2:DescribeImages"], "*"),
    allow(["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances", "ec2:ModifyInstanceAttribute"], sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/*"), { StringEquals: { "ec2:ResourceTag/AgentRelayDeployment": ref("AWS::StackName"), "ec2:ResourceTag/ManagedBy": "agent-relay" } }),
    allow("ec2:RunInstances", [sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:subnet/${WorkerSubnet}"), sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:security-group/${WorkerGroup}"), sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:key-pair/${WorkerKey}"), sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:network-interface/*")]),
    allow("ec2:RunInstances", sub("arn:${AWS::Partition}:ec2:${AWS::Region}::image/*"), { StringEquals: { "ec2:ResourceTag/AgentRelayDeployment": ref("AWS::StackName"), "ec2:ResourceTag/AgentRelayAcceptance": "verified-v1" } }),
    allow("ec2:RunInstances", [sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/*"), sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:volume/*")], { StringEquals: { "aws:RequestTag/AgentRelayDeployment": ref("AWS::StackName"), "aws:RequestTag/ManagedBy": "agent-relay" } }),
    allow("ec2:CreateTags", [sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/*"), sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:volume/*")], { StringEquals: { "ec2:CreateAction": "RunInstances", "aws:RequestTag/AgentRelayDeployment": ref("AWS::StackName") } }),
  ])] });
  resource("ControllerProfile", "AWS::IAM::InstanceProfile", { Roles: [ref("ControllerRole")] });
  // Used only while baking a credential-free worker image; never attach this
  // or the controller role to the final one-chat worker instances.
  resource("BuilderRole", "AWS::IAM::Role", { AssumeRolePolicyDocument: assume("ec2.amazonaws.com"), ManagedPolicyArns: [ssmPolicy], Tags: tags() });
  resource("BuilderProfile", "AWS::IAM::InstanceProfile", { Roles: [ref("BuilderRole")] });
  resource("DataVolume", "AWS::EC2::Volume", { AvailabilityZone: ref("AvailabilityZone"), Size: 40, VolumeType: "gp3", Encrypted: true, Tags: tags([{ Key: "Name", Value: sub("${AWS::StackName}-data") }]) }, { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  const bootstrap = `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io curl unzip python3 jq nvme-cli
systemctl enable --now docker
curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.35.20.zip -o /tmp/awscli.zip
cd /tmp
unzip -q awscli.zip
./aws/install
rm -rf /tmp/aws /tmp/awscli.zip
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
volume_id='\${DataVolume}'
deadline=$((SECONDS + 600))
device=''
until [ -n "$device" ]; do
  for candidate in /dev/nvme*n1; do
    [ -b "$candidate" ] || continue
    serial=$(lsblk -dn -o SERIAL "$candidate" | tr -d ' -')
    [ "$serial" != "$(printf '%s' "$volume_id" | tr -d '-')" ] || device="$candidate"
  done
  [ "$SECONDS" -lt "$deadline" ] || exit 1
  [ -n "$device" ] || sleep 2
done
filesystem=$(blkid -s TYPE -o value "$device" || true)
if [ -z "$filesystem" ]; then
  # Refuse to overwrite any filesystem/signature or partitioned disk.
  [ -z "$(wipefs --no-act --noheadings --output TYPE "$device")" ]
  [ "$(lsblk -n -o NAME "$device" | wc -l)" -eq 1 ]
  mkfs.ext4 "$device"
elif [ "$filesystem" != ext4 ]; then
  exit 1
fi
install -d -m 0755 /srv/relay/data
uuid=$(blkid -s UUID -o value "$device")
printf 'UUID=%s /srv/relay/data ext4 defaults,nofail 0 2\n' "$uuid" >> /etc/fstab
mount /srv/relay/data
chown 1000:1000 /srv/relay/data
chmod 0700 /srv/relay/data
install -d -m 0700 /run/relay-deploy
touch /var/lib/relay-controller-ready
`;
  resource("Controller", "AWS::EC2::Instance", { ImageId: ref("BaseImageId"), InstanceType: "t3.medium", SubnetId: ref("ControllerSubnet"), SecurityGroupIds: [ref("ControllerGroup")], IamInstanceProfile: ref("ControllerProfile"), MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 1, HttpEndpoint: "enabled" }, CreditSpecification: { CPUCredits: "standard" }, BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeType: "gp3", VolumeSize: 24, Encrypted: true, DeleteOnTermination: true } }], UserData: { "Fn::Base64": sub(bootstrap) }, Tags: tags([{ Key: "Name", Value: ref("AWS::StackName") }]) }, { DependsOn: "PrivateInternet" });
  resource("DataAttachment", "AWS::EC2::VolumeAttachment", { Device: "/dev/sdf", InstanceId: ref("Controller"), VolumeId: ref("DataVolume") });
  resource("VpcOrigin", "AWS::CloudFront::VpcOrigin", { VpcOriginEndpointConfig: { Name: sub("${AWS::StackName}-origin"), Arn: sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Controller}"), HTTPPort: 8787, HTTPSPort: 443, OriginProtocolPolicy: "http-only" }, Tags: tags() });
  resource("Distribution", "AWS::CloudFront::Distribution", { DistributionConfig: { Enabled: true, Comment: sub("${AWS::StackName}: private Relay origin, no response caching"), HttpVersion: "http2and3", IPV6Enabled: true, PriceClass: "PriceClass_100", ViewerCertificate: { CloudFrontDefaultCertificate: true }, Origins: [{ Id: "controller", DomainName: get("Controller", "PrivateDnsName"), VpcOriginConfig: { VpcOriginId: get("VpcOrigin", "Id"), OriginReadTimeout: 60, OriginKeepaliveTimeout: 60 } }], DefaultCacheBehavior: { TargetOriginId: "controller", ViewerProtocolPolicy: "redirect-to-https", AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"], CachedMethods: ["GET", "HEAD"], Compress: false, CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", OriginRequestPolicyId: "216adef6-5c7f-47e4-b989-5492eafa07d3" }, CustomErrorResponses: [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504].map(ErrorCode => ({ ErrorCode, ErrorCachingMinTTL: 0 })) }, Tags: tags() });
  // A leaf policy avoids a ControllerRole -> VpcOrigin -> Controller cycle.
  // Workers receive neither this role nor any CloudFront/IMDS credentials.
  const previewTags = { ManagedBy: "agent-relay-preview", AgentRelayDeployment: ref("AWS::StackName"), AgentRelayPurpose: "app-preview-v1" };
  const previewTagKeys = [...Object.keys(previewTags), "AgentRelayPreview", "AgentRelayOwner", "AgentRelayChat", "AgentRelayPort"];
  const resourceConditions = Object.fromEntries(Object.entries(previewTags).map(([key, value]) => [`aws:ResourceTag/${key}`, value]));
  const createConditions = {
    StringEquals: Object.fromEntries(Object.entries(previewTags).map(([key, value]) => [`aws:RequestTag/${key}`, value])),
    "ForAllValues:StringEquals": { "aws:TagKeys": previewTagKeys },
    Null: Object.fromEntries(previewTagKeys.map(key => [`aws:RequestTag/${key}`, "false"])),
  };
  resource("PreviewHostingPolicy", "AWS::IAM::Policy", { PolicyName: "ScopedAppPreviewHosts", Roles: [ref("ControllerRole")], PolicyDocument: { Version: "2012-10-17", Statement: [
    { Sid: "NeverUseRelayDistribution", Effect: "Deny", Action: "cloudfront:*", Resource: sub("arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}") },
    { Sid: "RecoverSavedCreateIntent", ...allow("cloudfront:ListDistributions", "*") },
    { Sid: "ReadExactExistingVpcOrigin", ...allow("cloudfront:GetVpcOrigin", sub("arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:vpcorigin/${VpcOrigin.Id}")) },
    { Sid: "CreateTaggedPreviewOnly", ...allow("cloudfront:CreateDistribution", "*", createConditions) },
    // CloudFront has no ec2:CreateAction equivalent. Required request tags
    // constrain creation but are not an IAM-only anti-adoption boundary for
    // unrelated untagged distributions. Durable callerReference/config checks
    // in trusted controller code are mandatory; no standalone TagResource API.
    { Sid: "TagAtPreviewCreation", ...allow("cloudfront:TagResource", sub("arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/*"), { ...createConditions, StringEqualsIfExists: resourceConditions }) },
    { Sid: "ManageOwnedPreviewOnly", ...allow(["cloudfront:GetDistribution", "cloudfront:ListTagsForResource", "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution"], sub("arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/*"), { StringEquals: resourceConditions }) },
  ] } }, { Condition: "AppPreviewsEnabled" });
  resource("BuildLog", "AWS::Logs::LogGroup", { RetentionInDays: 14, Tags: tags() });
  resource("ImageBuildRole", "AWS::IAM::Role", { AssumeRolePolicyDocument: assume("codebuild.amazonaws.com"), Tags: tags(), Policies: [policy("ImageBuild", [
    allow(["s3:GetObject", "s3:GetObjectVersion"], sub("${ArtifactBucket.Arn}/source/*")),
    allow(["ecr:GetAuthorizationToken"], "*"),
    allow(["ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"], get("ApplicationRepository", "Arn")),
    allow(["logs:CreateLogStream", "logs:PutLogEvents"], [get("BuildLog", "Arn"), sub("${BuildLog.Arn}:*")]),
  ])] });
  const buildspec = { version: "0.2", phases: { pre_build: { commands: ["test -n \"$IMAGE_TAG\"", "aws ecr get-login-password --region \"$AWS_DEFAULT_REGION\" | docker login --username AWS --password-stdin \"${ECR_REPOSITORY%/*}\""] }, build: { commands: ["docker build --file deploy/aws/Dockerfile --target runner --tag \"$ECR_REPOSITORY:$IMAGE_TAG\" .", "docker push \"$ECR_REPOSITORY:$IMAGE_TAG\""] } } };
  resource("ImageBuild", "AWS::CodeBuild::Project", { ServiceRole: get("ImageBuildRole", "Arn"), Artifacts: { Type: "NO_ARTIFACTS" }, Source: { Type: "S3", Location: sub("${ArtifactBucket}/source/bootstrap.zip"), BuildSpec: JSON.stringify(buildspec) }, Environment: { Type: "LINUX_CONTAINER", ComputeType: "BUILD_GENERAL1_SMALL", Image: "aws/codebuild/standard:7.0", PrivilegedMode: true, EnvironmentVariables: [{ Name: "ECR_REPOSITORY", Value: get("ApplicationRepository", "RepositoryUri") }] }, TimeoutInMinutes: 30, QueuedTimeoutInMinutes: 10, LogsConfig: { CloudWatchLogs: { Status: "ENABLED", GroupName: ref("BuildLog") } }, Tags: tags() });
  return {
    AWSTemplateFormatVersion: "2010-09-09", Description: "Agent Relay MVP isolated controller and per-chat EC2 workers; single-AZ and retained encrypted data",
    Parameters: {
      EnableAppPreviews: { Type: "String", Default: "false", AllowedValues: ["false", "true"], Description: "Explicitly allow trusted controller per-chat CloudFront preview lifecycle" },
      AvailabilityZone: { Type: "AWS::EC2::AvailabilityZone::Name" },
      BaseImageId: { Type: "AWS::EC2::Image::Id", Description: "Pin the resolved Ubuntu 24.04 amd64 AMI; do not implicitly replace the controller during an application update" },
      CloudFrontPrefixListId: { Type: "String", AllowedPattern: "pl-[a-f0-9]+" },
      WorkerPublicKey: { Type: "String", AllowedPattern: "ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?" },
    }, Conditions: { AppPreviewsEnabled: { "Fn::Equals": [ref("EnableAppPreviews"), "true"] } }, Resources: r,
    Outputs: Object.fromEntries(Object.entries({
      ControllerInstanceId: ref("Controller"), ArtifactBucket: ref("ArtifactBucket"), ApplicationRepositoryUri: get("ApplicationRepository", "RepositoryUri"), SecretArn: ref("ApplicationSecret"), PublicUrl: sub("https://${Distribution.DomainName}"), DataVolumeId: ref("DataVolume"), DistributionId: ref("Distribution"), WorkerSubnetId: ref("WorkerSubnet"), WorkerSecurityGroupId: ref("WorkerGroup"), WorkerKeyName: ref("WorkerKey"), BuilderInstanceProfile: ref("BuilderProfile"), BaseImageId: ref("BaseImageId"), DeploymentName: ref("AWS::StackName"), ImageBuildProject: ref("ImageBuild"), ControllerRoleArn: get("ControllerRole", "Arn"), VpcOriginId: get("VpcOrigin", "Id"), ControllerOriginDns: get("Controller", "PrivateDnsName"), PreviewHostingEnabled: ref("EnableAppPreviews"),
    }).map(([key, Value]) => [key, { Value }]))
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(relayTemplate(), null, 2));
