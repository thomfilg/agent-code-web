// Operator-controlled admission marker, not cryptographic attestation. The
// controller IAM role cannot tag images. Never cache this check across acquire.
export const workerAcceptanceVersion = "verified-v1";
export const workerAcceptanceId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const workerImageTags = image => Object.fromEntries((image?.Tags || []).map(({ Key, Value }) => [Key, Value]));

export function assertWorkerImage(image, { imageId, account, deployment, keyName, accepted = true }) {
  const tags = workerImageTags(image), mappings = image?.BlockDeviceMappings || [];
  const roots = mappings.filter(mapping => mapping.DeviceName === image?.RootDeviceName && mapping.Ebs);
  // Canonical AMIs include inert ephemeral hints; every actual EBS disk must
  // be encrypted and exactly one must be the boot root.
  const disksValid = image?.RootDeviceType === "ebs" && roots.length === 1 && mappings.every(mapping => mapping.Ebs
    ? mapping.Ebs.Encrypted === true && !mapping.VirtualName && !Object.hasOwn(mapping, "NoDevice")
    : /^ephemeral\d+$/.test(mapping.VirtualName || "") && /^\/dev\/sd[b-z]$/.test(mapping.DeviceName || "") && !Object.hasOwn(mapping, "NoDevice"));
  if (!/^ami-[a-f0-9]{8,17}$/.test(imageId || "") || image?.ImageId !== imageId || !/^\d{12}$/.test(image.OwnerId || "") ||
      (account && image.OwnerId !== account) || image.State !== "available" || image.Architecture !== "x86_64" || image.Public !== false || !disksValid ||
      Object.entries({ ManagedBy: "agent-relay", AgentRelayDeployment: deployment, AgentRelayWorkerKey: keyName, CodexVersion: "0.154.0", ClaudeVersion: "2.1.222" }).some(([key, value]) => !value || tags[key] !== value)) {
    throw new Error("Worker AMI must be a private encrypted verified image owned and baked for this deployment, SSH key, and pinned CLI versions");
  }
  if (accepted && (tags.AgentRelayAcceptance !== workerAcceptanceVersion || !workerAcceptanceId.test(tags.AgentRelayAcceptanceId || ""))) {
    throw new Error("Worker AMI has no current verified-v1 acceptance; run the fresh-worker verifier before admission");
  }
  return image;
}

export function workerImageIdentity(image) {
  return JSON.stringify([image.ImageId, image.OwnerId, image.CreationDate, image.Architecture, image.RootDeviceType, image.RootDeviceName,
    image.BlockDeviceMappings.map(mapping => [mapping.DeviceName, mapping.VirtualName, mapping.Ebs?.SnapshotId, mapping.Ebs?.VolumeSize, mapping.Ebs?.Encrypted]).sort((a, b) => a[0].localeCompare(b[0]))]);
}
