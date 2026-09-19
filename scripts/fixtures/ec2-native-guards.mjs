import { isIP } from "node:net";
import { assertWorkerImage } from "../../src/worker-image.mjs";

export const nativeTarget = Object.freeze({ profile: "code-web", region: "us-east-2", account: "456808212788", deployment: "agent-relay-mvp", controller: "i-08c991c22089589a5" });
const tagsOf = value => Object.fromEntries((value?.Tags || []).map(({ Key, Value }) => [Key, Value]));
const privateIp = value => isIP(value) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
const fail = message => { throw Error(message); };

// Same ownership contract as verify-worker-ami; unlike that operator this one
// never provisions, stops or terminates an instance. A fresh native-only tag
// explicitly distinguishes the already-launched disposable worker from chats.
export async function guardNativeTarget(options, json) {
  const t = nativeTarget;
  if ((await json("sts", "get-caller-identity")).Account !== t.account) fail("Unexpected native acceptance AWS account");
  const stacks = await json("cloudformation", "describe-stacks", "--stack-name", t.deployment, "--query", "Stacks");
  const stack = stacks?.[0];
  if (stacks?.length !== 1 || stack.StackName !== t.deployment || !stack.StackId?.startsWith(`arn:aws:cloudformation:${t.region}:${t.account}:stack/${t.deployment}/`) ||
      !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus) || tagsOf(stack).ManagedBy !== "12-apps-ci") fail("Native acceptance requires the exact completed stack");
  const outputs = Object.fromEntries((stack.Outputs || []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  const resources = await json("cloudformation", "list-stack-resources", "--stack-name", t.deployment, "--query", "StackResourceSummaries");
  const resource = (logical, type) => {
    const found = resources.filter(r => r.LogicalResourceId === logical && r.ResourceType === type);
    if (found.length !== 1 || !found[0].PhysicalResourceId) fail("Missing exact native acceptance stack resource");
    return found[0].PhysicalResourceId;
  };
  for (const [output, logical, type] of [["ControllerInstanceId", "Controller", "AWS::EC2::Instance"], ["WorkerSubnetId", "WorkerSubnet", "AWS::EC2::Subnet"],
    ["WorkerSecurityGroupId", "WorkerGroup", "AWS::EC2::SecurityGroup"], ["WorkerKeyName", "WorkerKey", "AWS::EC2::KeyPair"]]) {
    if (!outputs[output] || outputs[output] !== resource(logical, type)) fail("Unowned native acceptance stack output");
  }
  if (outputs.DeploymentName !== t.deployment || outputs.ControllerInstanceId !== t.controller) fail("Unexpected native acceptance controller/deployment");
  const owned = value => tagsOf(value).ManagedBy === "12-apps-ci" && tagsOf(value).AgentRelayDeployment === t.deployment;
  const controllerGroup = resource("ControllerGroup", "AWS::EC2::SecurityGroup");
  const controllers = await json("ec2", "describe-instances", "--instance-ids", t.controller, "--query", "Reservations[].Instances[]");
  const controller = controllers?.[0];
  if (controllers?.length !== 1 || controller.InstanceId !== t.controller || !owned(controller) || controller.State?.Name !== "running" || controller.PublicIpAddress ||
      controller.SubnetId !== resource("ControllerSubnet", "AWS::EC2::Subnet") || controller.SecurityGroups?.length !== 1 || controller.SecurityGroups[0].GroupId !== controllerGroup ||
      controller.IamInstanceProfile?.Arn !== `arn:aws:iam::${t.account}:instance-profile/${resource("ControllerProfile", "AWS::IAM::InstanceProfile")}`) fail("Native acceptance controller ownership/isolation failed");
  const subnets = await json("ec2", "describe-subnets", "--subnet-ids", outputs.WorkerSubnetId, "--query", "Subnets");
  const groups = await json("ec2", "describe-security-groups", "--group-ids", outputs.WorkerSecurityGroupId, "--query", "SecurityGroups");
  const subnet = subnets?.[0], group = groups?.[0], ingress = group?.IpPermissions;
  if (subnets?.length !== 1 || groups?.length !== 1 || subnet.SubnetId !== outputs.WorkerSubnetId || group.GroupId !== outputs.WorkerSecurityGroupId ||
      !owned(subnet) || !owned(group) || subnet.OwnerId !== t.account || group.OwnerId !== t.account || subnet.MapPublicIpOnLaunch || subnet.VpcId !== group.VpcId ||
      ingress?.length !== 1 || ingress[0].IpProtocol !== "tcp" || ingress[0].FromPort !== 22 || ingress[0].ToPort !== 22 || ingress[0].UserIdGroupPairs?.length !== 1 ||
      ingress[0].UserIdGroupPairs[0].GroupId !== controllerGroup || ingress[0].IpRanges?.length || ingress[0].Ipv6Ranges?.length || ingress[0].PrefixListIds?.length) fail("Native acceptance worker network is not private/controller-only");
  const images = await json("ec2", "describe-images", "--image-ids", options.imageId, "--owners", t.account, "--query", "Images");
  const image = images?.[0];
  assertWorkerImage(image, { imageId: options.imageId, account: t.account, deployment: t.deployment, keyName: outputs.WorkerKeyName });
  const mappings = image?.BlockDeviceMappings || [];
  const roots = mappings.filter(mapping => mapping.DeviceName === image?.RootDeviceName && mapping.Ebs);
  // Canonical includes inert instance-store hints. The explicitly guarded
  // t3.medium worker has no instance store; every actual EBS disk stays encrypted.
  const disksValid = image?.RootDeviceType === "ebs" && roots.length === 1 && mappings.every(mapping => mapping.Ebs
    ? mapping.Ebs.Encrypted === true && !mapping.VirtualName && !Object.hasOwn(mapping, "NoDevice")
    : /^ephemeral\d+$/.test(mapping.VirtualName || "") && /^\/dev\/sd[b-z]$/.test(mapping.DeviceName || "") && !Object.hasOwn(mapping, "NoDevice"));
  if (images?.length !== 1 || image.ImageId !== options.imageId || image.OwnerId !== t.account || image.State !== "available" || image.Architecture !== "x86_64" || image.Public ||
      !disksValid || Object.entries({ ManagedBy: "agent-relay", AgentRelayDeployment: t.deployment,
        AgentRelayWorkerKey: outputs.WorkerKeyName, CodexVersion: "0.154.0", ClaudeVersion: "2.1.222" }).some(([key, value]) => tagsOf(image)[key] !== value)) fail("Native acceptance requires the private pinned deployment AMI");
  const keys = await json("ec2", "describe-key-pairs", "--key-names", outputs.WorkerKeyName, "--include-public-key", "--query", "KeyPairs");
  if (keys?.length !== 1 || keys[0].KeyName !== outputs.WorkerKeyName || !owned(keys[0]) || !/^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(keys[0].PublicKey?.trim() || "")) fail("Native acceptance requires the exact deployment public key");
  const workers = await json("ec2", "describe-instances", "--instance-ids", options.workerId, "--query", "Reservations[].Instances[]");
  const worker = workers?.[0], tags = tagsOf(worker);
  if (workers?.length !== 1 || worker.InstanceId !== options.workerId || worker.InstanceId === t.controller || worker.State?.Name !== "running" || worker.InstanceType !== "t3.medium" ||
      tags.ManagedBy !== "agent-relay" || tags.AgentRelayDeployment !== t.deployment || tags.AgentRelayNativeAcceptance !== options.acceptanceId || tags.AgentWebChat || tags.AgentRelayVerification ||
      worker.ImageId !== options.imageId || worker.SubnetId !== outputs.WorkerSubnetId || worker.SecurityGroups?.length !== 1 || worker.SecurityGroups[0].GroupId !== outputs.WorkerSecurityGroupId ||
      worker.KeyName !== outputs.WorkerKeyName || worker.IamInstanceProfile || worker.PublicIpAddress || worker.MetadataOptions?.HttpEndpoint !== "disabled" || !privateIp(worker.PrivateIpAddress) ||
      worker.NetworkInterfaces?.some(n => n.Association?.PublicIp || n.Ipv6Addresses?.length)) fail("Native acceptance worker ownership/isolation failed");
  return { host: worker.PrivateIpAddress, publicKey: keys[0].PublicKey.trim().split(/\s+/).slice(0, 2).join(" "), workerId: options.workerId };
}
