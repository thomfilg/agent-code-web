import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRecords } from "../src/database.mjs";
import { userRecords } from "../src/user-services.mjs";
import { chatSelection, rememberChatSelection, restoreChatSelection } from "../src/chat-preferences.mjs";

const repo = (fullName, companyId, branch = "dev") => ({ fullName, companyId, branch, githubConnectionId: `github-${companyId}` });
const environment = company => ({ id: `env-${company}`, companies: [company], archived: false });
const selection = company => ({ environmentId: `env-${company}`, agent: "codex", agentAccountId: `account-${company}`, model: "fixture", effort: "high",
  repositories: [repo(company === "g2i" ? "g2i-ai/macrosoft" : "12-apps/future-pay", company)] });
function fixture(records = new MemoryRecords()) {
  const calls = [], f = { records, calls, chats: [], namedAccounts: true, ownerId: "alice", availableAgents: [{ id: "codex", enabled: true }, { id: "mock", enabled: true }],
    companies: { get: async id => { if (!["g2i", "personal"].includes(id)) throw Error("Company unavailable"); } },
    environments: { list: async () => [environment("g2i"), environment("personal")] },
    github: { resolveSelections: async (repos, { company }) => { calls.push(["repositories", company]); if (repos.some(repo => repo.companyId !== company) || f.revokeRepo) throw Error("Unavailable repository/branch"); return repos; } },
    agentAccounts: { select: async (owner, id, value) => { calls.push(["account", owner, id]); if (f.revokeAccount || id !== `account-${value.repositories[0]?.companyId}`) throw Error("Unavailable account"); } },
  };
  return f;
}

test("allowlisted full options persist independently per company and project, without message or credential state", async () => {
  const f = fixture(), work = selection("g2i"), personal = selection("personal");
  personal.repositories.push(repo("12-apps/shared-packages", "personal", "main"));
  await rememberChatSelection(f.records, { ...work, prompt: "PRIVATE PROMPT", attachments: [{ token: "PRIVATE TOKEN" }], messages: ["PRIVATE TEXT"], browserAccess: true }, environment("g2i"));
  await rememberChatSelection(f.records, personal, environment("personal"));
  const other = { ...work, repositories: [repo("g2i-ai/second", "g2i")] };
  await rememberChatSelection(f.records, other, environment("g2i"));
  assert.deepEqual((await restoreChatSelection(f, { companyId: "g2i" })).selection, other);
  assert.deepEqual((await restoreChatSelection(f, { companyId: "g2i", repository: "G2I-AI/MACROSOFT" })).selection, work);
  assert.deepEqual((await restoreChatSelection(f, { companyId: "personal" })).selection, personal);
  const stored = JSON.stringify(await f.records.list("new-chat-project"));
  assert.doesNotMatch(stored, /PRIVATE|messages|attachments|browserAccess/);
  assert.deepEqual(Object.keys(chatSelection(work)).sort(), ["agent", "agentAccountId", "effort", "environmentId", "model", "repositories"]);
});

test("per-owner record namespaces survive re-instantiation and do not inherit another owner's options", async () => {
  const records = new MemoryRecords(), alice = fixture(userRecords(records, "alice")), bob = fixture(userRecords(records, "bob"));
  await rememberChatSelection(alice.records, selection("g2i"), environment("g2i"));
  assert.equal((await restoreChatSelection(bob, { companyId: "g2i", repository: "g2i-ai/macrosoft" })).found, false);
  const restarted = fixture(userRecords(records, "alice"));
  assert.deepEqual((await restoreChatSelection(restarted, { companyId: "g2i", repository: "g2i-ai/macrosoft" })).selection, selection("g2i"));
});

test("project seed uses the latest authorized same-company chat, never its prompt or attachments", async () => {
  const f = fixture(), work = selection("g2i");
  await rememberChatSelection(f.records, work, environment("g2i"), "2026-09-19T10:00:00Z");
  f.chats = [{ ...work, effort: "low", updatedAt: "2026-09-19T11:00:00Z", messages: ["NEVER COPY"], attachments: ["NEVER COPY"] },
    { ...selection("personal"), repositories: [repo("g2i-ai/macrosoft", "personal")], effort: "max", updatedAt: "2026-09-19T12:00:00Z" }];
  const restored = await restoreChatSelection(f, { companyId: "g2i", repository: "g2i-ai/macrosoft" });
  assert.equal(restored.selection.effort, "low"); assert.doesNotMatch(JSON.stringify(restored), /NEVER COPY/);
  assert.equal((await restoreChatSelection(f, { companyId: "g2i" })).selection.effort, "high", "Company switch prefers its explicit unsent draft");
});

test("revoked repository/branch/account and archived environments fail closed without substituting another company", async () => {
  const f = fixture(); await rememberChatSelection(f.records, selection("g2i"), environment("g2i"));
  f.revokeRepo = true; f.revokeAccount = true;
  f.environments.list = async () => [{ ...environment("g2i"), archived: true }, { ...environment("g2i"), id: "another-work-environment" }, environment("personal")];
  const { selection: saved, warnings } = await restoreChatSelection(f, { companyId: "g2i" });
  assert.deepEqual(saved.repositories, []); assert.equal(saved.environmentId, null);
  assert.equal(saved.agentAccountId, null); assert.equal(saved.agent, null); assert.equal(saved.model, null);
  assert.equal(warnings.length, 3);
  await assert.rejects(restoreChatSelection(f, { companyId: "another-company" }), /Company unavailable/);
});

test("an unavailable provider does not silently replace or erase the saved account choice", async () => {
  const f = fixture(); await rememberChatSelection(f.records, selection("g2i"), environment("g2i"));
  f.availableAgents = [{ id: "mock", enabled: true }];
  const result = await restoreChatSelection(f, { companyId: "g2i" });
  assert.equal(result.selection.agent, null); assert.equal(result.selection.agentAccountId, null);
  assert.match(result.warnings.join(" "), /saved agent is unavailable/);
  assert.equal((await f.records.get("new-chat-company", "g2i")).selection.agentAccountId, "account-g2i");
});

test("cross-company and incompatible environment snapshots are rejected; legacy defaults only restore their matching company", async () => {
  const f = fixture(), work = selection("g2i");
  await assert.rejects(rememberChatSelection(f.records, { ...work, repositories: [...work.repositories, repo("12-apps/future-pay", "personal")] }, environment("g2i")), /one company/);
  await assert.rejects(rememberChatSelection(f.records, work, environment("personal")), /one company/);
  await f.records.put("preferences", "new-chat", work);
  assert.equal((await restoreChatSelection(f, { companyId: "personal" })).found, false);
  assert.deepEqual((await restoreChatSelection(f, { companyId: "g2i" })).selection, work);
  assert.deepEqual(await f.records.list("new-chat-company"), [], "Reading legacy preferences does not rewrite/migrate another scope");
});

test("empty unfinished company drafts persist without agent account and never inherit another project's repositories", async () => {
  const f = fixture(), unfinished = { environmentId: "env-g2i", agent: null, repositories: [] };
  await rememberChatSelection(f.records, unfinished, environment("g2i"));
  const restored = await restoreChatSelection(f, { companyId: "g2i" });
  assert.equal(restored.found, true); assert.deepEqual(restored.selection.repositories, []); assert.equal(restored.selection.agent, null);
  assert.deepEqual(f.calls, [], "No repository/account/agent operations for an empty selection");
});
