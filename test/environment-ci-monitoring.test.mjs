import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRecords } from "../src/database.mjs";
import { Companies } from "../src/companies.mjs";
import { Environments } from "../src/environments.mjs";
import { GitHubEvents } from "../src/github-events.mjs";
import { ChatStore } from "../src/store.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const ownerId = `user_${"a".repeat(32)}`;
const accountId = "account_00000000-0000-0000-0000-000000000001";
const connectionId = "github_00000000-0000-0000-0000-000000000002";

async function savedEnvironment(records, ciMonitoring) {
  const companies = new Companies(records); await companies.save({ id: "acme", name: "Acme" });
  const environments = new Environments(records);
  const environment = await environments.save({ name: "Development", backend: "local", companyId: "acme", software: [], variables: [], ...(ciMonitoring ? { ciMonitoring } : {}) });
  return { environments, environment };
}

test("environment CI monitoring defaults are selected, validated and persisted", async () => {
  const records = new MemoryRecords(), { environments, environment } = await savedEnvironment(records);
  assert.deepEqual(environment.ciMonitoring, { notifyFailures: true, wakePassing: true });
  assert.deepEqual((await environments.runtime(environment.id, { repositories: [{ fullName: "acme/repo" }] })).ciMonitoring, { notifyFailures: true, wakePassing: true });
  const changed = await environments.save({ ...environment, ciMonitoring: { notifyFailures: false, wakePassing: true } }, environment.id);
  assert.deepEqual(changed.ciMonitoring, { notifyFailures: false, wakePassing: true });
  await assert.rejects(environments.save({ ...changed, ciMonitoring: { notifyFailures: "yes", wakePassing: true } }, environment.id), /enabled or disabled explicitly/);
});

test("new PR monitoring inherits its environment while an explicit PR override remains local", async t => {
  const records = new MemoryRecords(), { environments, environment } = await savedEnvironment(records, { notifyFailures: true, wakePassing: false });
  await records.put("agent-account", accountId, { id: accountId, ownerId, provider: "codex", status: "connected", auth: { type: "oauth" }, accountIdentity: "fixture-account", subject: "fixture-subject" });
  const connection = { id: connectionId, companyId: "acme", accountId: 77, token: "fixture-github-token", revision: 1 };
  await records.put("github_connection", connectionId, connection);
  const store = new ChatStore(await temporaryDirectory(t), records); await store.initialize();
  const repository = { id: 123, fullName: "acme/repo", githubConnectionId: connectionId, branch: "main" };
  const chat = await store.create({ title: "CI defaults", agent: "codex", ownerId, agentAccountId: accountId, environmentId: environment.id, repositories: [repository] });
  const events = new GitHubEvents({ records, store, github: { requireConnection: async () => connection }, monitor: { tracked() {}, refresh: async () => {} }, isLegacy: () => true, environmentForChat: async () => environments.get(environment.id) });
  const pr = { repository: "acme/repo", repositoryId: 123, number: 9, state: "open", verifiedAt: new Date().toISOString(), headSha: "b".repeat(40), headRef: "feature", connectionRevision: 1 };
  await events.reconcileAutomatic(chat.id, [pr]);
  let state = await events.state(chat.id), subscription = state.subscriptions[0];
  assert.deepEqual({ notifyFailures: subscription.notifyFailures, wakePassing: subscription.wakePassing, inherited: subscription.inherited, automatic: subscription.automatic }, { notifyFailures: true, wakePassing: false, inherited: true, automatic: false });
  await events.configure(chat.id, { repository: "acme/repo", number: 9, notifyFailures: false, wakePassing: false, revision: state.revision }, { ownerId });
  state = await events.state(chat.id); subscription = state.subscriptions[0];
  assert.equal(subscription.inherited, false);
  const latest = await environments.get(environment.id);
  await environments.save({ ...latest, ciMonitoring: { notifyFailures: true, wakePassing: true } }, environment.id);
  await events.reconcileAutomatic(chat.id, [pr]);
  subscription = (await events.state(chat.id)).subscriptions[0];
  assert.deepEqual({ notifyFailures: subscription.notifyFailures, wakePassing: subscription.wakePassing }, { notifyFailures: false, wakePassing: false });
});
