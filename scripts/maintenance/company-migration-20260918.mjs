// One-shot, explicitly authorized production migration. No network or file IO.
// The operator must run the plan in one DB transaction with the controller stopped.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const targets = Object.freeze({
  chat: "chat_d50034e32eef41d2a9de0f63288a9d7a",
  personal: "github_754523ec-0856-4434-9673-654ba6859358",
  work: "github_e4648eee-be80-40c5-a59d-da6645d2fc4e",
  linear: "mcp_a4c405e2-d0e1-488b-ba86-55482c0dc40d",
  environment: "env_d7588948-bf4c-4585-adf4-001defac3931",
  workEnvironment: "env_7a0c6d8e-2419-4e72-9eba-821140610c19",
  receipt: "company-migration-20260918",
});
const check = (condition, label) => { if (!condition) throw new Error(`Migration preflight failed: ${label}`); };
const equal = (actual, expected, label) => check(isDeepStrictEqual(actual, expected), label);

export async function migrationPlan(records, time = new Date().toISOString()) {
  check(!await records.get("maintenance", targets.receipt), "already applied; verify instead of replaying");
  const owner = await records.get("relay-auth", "legacy-owner");
  const chats = await records.list("chat"), chat = chats.find(row => row.id === targets.chat);
  check(chats.length === 1 && chat && owner?.ownerId && chat.ownerId === owner.ownerId, "exact chat ownership/inventory");
  equal(chat.repositories.map(repo => [repo.fullName, repo.githubConnectionId]).sort(), [
    ["12-apps/future-pay", targets.personal], ["g2i-ai/clickdown", targets.work],
  ], "exact mixed repositories");
  check(chat.environmentId === targets.environment, "chat environment");
  check(!(await records.list("company")).length, "company registry changed");
  check(!(await records.list("connection")).length, "unexpected legacy connection");
  equal((await records.list("github_connection")).map(row => row.id).sort(), [targets.personal, targets.work].sort(), "GitHub inventory");
  equal((await records.list("mcp")).map(row => row.id), [targets.linear], "MCP inventory");
  equal((await records.list("environment")).map(row => row.id), [targets.environment], "environment inventory");
  const personal = await records.get("github_connection", targets.personal);
  const work = await records.get("github_connection", targets.work);
  const linear = await records.get("mcp", targets.linear);
  const environment = await records.get("environment", targets.environment);
  check(personal.revision === 5 && personal.login === "thomfilg" && personal.token && !personal.companyId, "personal GitHub changed");
  equal(personal.companies, ["12-apps", "thomfilg"], "personal scope changed");
  check(work.revision === 2 && work.login === "thompson-filgueiras-g2i" && work.token && !work.companyId && !work.companies, "work GitHub changed");
  check(linear.revision === 8 && linear.name === "linear" && linear.url === "https://mcp.linear.app/mcp" && linear.oauth?.tokens && !linear.companyId, "Linear changed");
  equal(linear.companies, ["12-apps", "g2i"], "Linear scope changed");
  check(environment.revision === 4 && environment.backend === "ec2", "environment changed");
  equal(environment.companies, ["12-apps", "thomfilg"], "environment scope changed");
  equal(environment.mcpIds, [], "environment MCP selection changed");
  const writes = [], deletes = [];
  const put = (kind, value) => writes.push({ kind, id: value.id, value });
  for (const [id, name] of [["12-apps", "thomfilg + 12-apps"], ["g2i", "g2i"]]) {
    put("company", { id, name, revision: 1, createdAt: time, updatedAt: time });
  }
  for (const [old, companyId] of [[personal, "12-apps"], [work, "g2i"]]) {
    const { companies, organization, allowUnassigned, ...rest } = old;
    put("github_connection", { ...rest, companyId, revision: old.revision + 1, updatedAt: time });
  }
  put("mcp", { ...linear, companyId: "g2i", companies: ["g2i"], organization: "g2i", allowUnassigned: false,
    authGeneration: randomUUID(), revision: linear.revision + 1, updatedAt: time });
  put("environment", { ...environment, name: "thomfilg + 12-apps", companies: ["12-apps"], allowUnassigned: false,
    revision: environment.revision + 1, updatedAt: time });
  // Fresh company workspace: no copying variables or setup commands across companies.
  put("environment", { id: targets.workEnvironment, name: "g2i", backend: "ec2", companies: ["g2i"], allowUnassigned: false,
    mcpIds: [], description: "", variablesEnabled: true, variables: [], software: [], setupScript: "",
    networkAccess: "worker_default", archived: false, revision: 1, createdAt: time, updatedAt: time });
  const preferences = await records.get("preferences", "new-chat");
  if (preferences) writes.push({ kind: "preferences", id: "new-chat", value: { ...preferences,
    repositories: (preferences.repositories || []).filter(repo => repo.githubConnectionId === targets.personal)
      .map(repo => ({ ...repo, companyId: "12-apps" })) } });
  for (const kind of ["chat", "native-fork", "native-agents", "native-import", "native-approvals", "native-feedback", "native-logout", "desktop-handoff"]) {
    deletes.push({ kind, id: targets.chat });
  }
  for (const attachment of await records.list("attachment")) if (attachment.chatId === targets.chat) deletes.push({ kind: "attachment", id: attachment.id });
  // Keep provider IDs for the existing ownership-checked asynchronous cleanup.
  for (const preview of await records.list("preview-host")) if (preview.chatId === targets.chat && preview.status !== "deleted") {
    check(preview.ownerId === owner.ownerId, "preview ownership changed");
    put("preview-host", { ...preview, desired: "deleted", status: "revoking", pendingStep: preview.distributionId ? "disable" : "create", error: null, updatedAt: time });
  }
  return { writes, deletes, summary: { deletedChat: targets.chat, companies: ["12-apps", "g2i"],
    githubCredentialsPreserved: personal.token === writes.find(row => row.id === targets.personal).value.token && work.token === writes.find(row => row.id === targets.work).value.token,
    linearCredentialsPreserved: isDeepStrictEqual(linear.oauth, writes.find(row => row.id === targets.linear).value.oauth),
    environmentVariablesPreserved: isDeepStrictEqual(environment.variables, writes.find(row => row.id === targets.environment).value.variables),
    workEnvironment: targets.workEnvironment } };
}

export async function applyMigrationPlan(records, plan) {
  for (const row of plan.writes) await records.put(row.kind, row.id, row.value);
  for (const row of plan.deletes) await records.delete(row.kind, row.id);
  await records.put("maintenance", targets.receipt, { id: targets.receipt, ...plan.summary, appliedAt: new Date().toISOString() });
  return plan.summary;
}
