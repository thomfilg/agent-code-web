import { WorkerLeaseAuthority } from "../../src/worker-lease-authority.mjs";
export const leaseIdentity = { deploymentId: "fixture-deployment", ownerId: `user_${"a".repeat(32)}`, chatId: `chat_${"c".repeat(32)}`,
  workerId: "i-aaaaaaaaaaaaaaaaa", provider: "codex", accountId: "account_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", attemptId: "fixture-attempt" };
export const fixtureBoot = "b".repeat(64);
export const scopedKind = kind => `user:${leaseIdentity.ownerId}:${kind}`;
export async function seedLeaseScope(records) {
  await records.put("chat", leaseIdentity.chatId, { id: leaseIdentity.chatId, ownerId: leaseIdentity.ownerId, agent: "codex", agentAccountId: leaseIdentity.accountId,
    environmentId: "env-fixture", repositories: [{ fullName: "acme/project", companyId: "acme", githubConnectionId: "github-fixture", branch: "main" }],
    revision: 1, status: "ready", messages: [], updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  await records.put("agent-account", leaseIdentity.accountId, { id: leaseIdentity.accountId, ownerId: leaseIdentity.ownerId, provider: "codex", status: "connected", revision: 1, auth: { synthetic: true }, accountIdentity: "synthetic-identity" });
  await records.put(scopedKind("company"), "acme", { id: "acme", name: "Fixture", revision: 1 });
  await records.put(scopedKind("environment"), "env-fixture", { id: "env-fixture", companies: ["acme"], allowUnassigned: false, revision: 1 });
}
export function leaseAuthority(records, overrides = {}) {
  return new WorkerLeaseAuthority({ records, deploymentId: leaseIdentity.deploymentId, bootForWorker: () => fixtureBoot, invalidateLease: () => {}, ...overrides });
}
export const leaseRequest = (issued, patch = {}) => ({ action: "status", identity: leaseIdentity, processId: "shared-chrome", processInstanceId: "synthetic-process", lease: issued.credential, ...patch });
