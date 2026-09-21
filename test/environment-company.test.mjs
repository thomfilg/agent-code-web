import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRecords } from "../src/database.mjs";
import { Companies } from "../src/companies.mjs";
import { Environments } from "../src/environments.mjs";
import { environmentAllows, environmentCompany } from "../public/environment-scope.js";
import { rememberChatSelection, restoreChatSelection } from "../src/chat-preferences.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const chat = companyId => ({ repositories: [{ fullName: "owner/project", companyId }] });
async function fixture() {
  const records = new MemoryRecords(), companies = new Companies(records);
  await companies.save({ id: "first", name: "First" });
  await companies.save({ id: "second", name: "Second" });
  const environments = new Environments(records, "local", { companies, validateSelection: async () => {}, forCompany: async company => [company] });
  return { records, companies, environments };
}
const draft = { name: "Project", backend: "local", companies: ["first"], variables: [{ key: "TOKEN", value: "fixture-private", secret: true }, { key: "REGION", value: "west", secret: false }] };

test("new and changed environments require one registered company and reject contradictory grants", async () => {
  const { environments } = await fixture();
  for (const scope of [{ companies: [] }, { companies: ["first", "second"] }, { companies: ["first"], allowUnassigned: true }, { companies: ["unknown"] }, { companies: ["first"], companyId: "second" }]) {
    await assert.rejects(environments.save({ ...draft, ...scope }), { statusCode: 400 });
  }
  const environment = await environments.save(draft);
  assert.equal(environment.companyId, "first"); assert.equal(environment.scopeNeedsReview, false);
  assert.equal(JSON.stringify(environment).includes("fixture-private"), false);
  assert.deepEqual((await environments.runtime(environment.id, chat("first"))).variables, { REGION: "west" });
  await assert.rejects(environments.runtime(environment.id, chat("second")), { statusCode: 403 });
  await assert.rejects(environments.runtime(environment.id), { statusCode: 403 });
  await assert.rejects(environments.save({ ...environment, companies: ["first", "second"] }, environment.id), { statusCode: 400 });
});

test("legacy ambiguous records remain intact and unreadable to new workers until explicit revision-checked assignment", async () => {
  const { records, companies, environments } = await fixture();
  for (const scope of [{}, { organization: "first" }, { companies: [] }, { companies: ["first", "second"] }, { companies: ["first"], allowUnassigned: true }, { companies: ["first"], companyId: "second" }, { companies: ["missing"] }]) {
    const original = { ...draft, id: "legacy", revision: 8, variablesEnabled: false, setupScript: "echo fixture", software: ["node"], ...scope };
    if (!Object.hasOwn(scope, "companies")) delete original.companies;
    await records.put("environment", original.id, original);
    const restored = new Environments(records, "local", { companies, validateSelection: async () => {}, forCompany: async () => [] });
    assert.equal((await restored.get(original.id)).scopeNeedsReview, true);
    assert.equal((await restored.list())[0].scopeNeedsReview, true);
    for (const company of ["first", "second"]) await assert.rejects(restored.runtime(original.id, chat(company)), /needs company review/);
    assert.deepEqual(await records.get("environment", original.id), original, "reading/admission never migrates encrypted payloads");
    const masked = await restored.get(original.id);
    await assert.rejects(restored.save({ ...masked, name: "Name only" }, original.id), /explicit company review/);
  }
  let changes = 0; environments.onSaved = () => { changes++; };
  const old = await environments.get("legacy");
  await assert.rejects(environments.save({ ...old, companies: ["first"] }, old.id), /explicit company review/);
  await assert.rejects(environments.save({ ...old, companies: ["first"], revision: 7 }, old.id), { statusCode: 409 });
  const assigned = await environments.save({ name: old.name, backend: old.backend, companyId: "second", allowUnassigned: false, revision: old.revision, confirmCompanyAssignment: true }, old.id);
  assert.equal(changes, 1); assert.equal(assigned.scopeNeedsReview, false); assert.equal(assigned.revision, 9);
  const raw = await environments.get(old.id, { reveal: true });
  assert.deepEqual(raw.variables, draft.variables.map(variable => ({ ...variable, enabled: true })));
  assert.equal(raw.variablesEnabled, false); assert.equal(raw.setupScript, "echo fixture"); assert.deepEqual(raw.software, ["node"]);
  await assert.rejects(environments.runtime(old.id, chat("first")), { statusCode: 403 });
  assert.deepEqual((await environments.runtime(old.id, chat("second"))).variables, {});
});

test("bootstrap has no implicit company grant; registry removal and owner boundaries fail closed", async () => {
  const { records, environments } = await fixture();
  await environments.initialize();
  const [template] = await environments.list();
  assert.equal(template.scopeNeedsReview, true);
  await assert.rejects(environments.runtime(template.id, chat("first")), { statusCode: 403 });
  const saved = await environments.save(draft);
  await records.delete("company", "first");
  assert.equal((await environments.get(saved.id)).scopeNeedsReview, true);
  await assert.rejects(environments.runtime(saved.id, chat("first")), { statusCode: 403 });
  const other = new Environments(new MemoryRecords());
  await assert.rejects(other.save(draft), { statusCode: 400 });
  await assert.rejects(other.get(saved.id), { statusCode: 404 });
});

test("environment names are company-local; conflicting reassignments leave the original record untouched", async () => {
  const { records, environments } = await fixture();
  await records.put("environment", "legacy", { ...draft, name: "Dev", id: "legacy", companies: ["first", "second"] });
  const first = await environments.save({ ...draft, name: "Dev" });
  const second = await environments.save({ ...draft, name: "Dev", companies: ["second"] });
  assert.notEqual(first.id, second.id);
  await assert.rejects(environments.save({ ...draft, name: "dev" }), /already exists in this company/);
  const original = await records.get("environment", first.id);
  await assert.rejects(environments.save({ ...first, companies: ["second"], companyId: "second" }, first.id), /already exists in this company/);
  assert.deepEqual(await records.get("environment", first.id), original);
});

test("an EC2 environment machine default has a narrow revision-checked update", async () => {
  const { records, environments } = await fixture();
  const saved = await environments.save({ ...draft, backend: "ec2", instanceType: "t3.medium" });
  const updated = await environments.setInstanceType(saved.id, { instanceType: "m7i.xlarge", revision: saved.revision });
  assert.equal(updated.instanceType, "m7i.xlarge");
  assert.equal(updated.revision, saved.revision + 1);
  assert.equal(JSON.stringify(updated).includes("fixture-private"), false);
  assert.deepEqual((await environments.get(saved.id, { reveal: true })).variables, draft.variables.map(variable => ({ ...variable, enabled: true })));
  await assert.rejects(environments.setInstanceType(saved.id, { instanceType: "t3.large", revision: saved.revision }), { statusCode: 409 });
  await assert.rejects(environments.setInstanceType(saved.id, { instanceType: "r9g.metal", revision: updated.revision }), /supported worker machine size/);
  const local = await environments.save({ ...draft, name: "Local", backend: "local" });
  await assert.rejects(environments.setInstanceType(local.id, { instanceType: "t3.large", revision: local.revision }), /require an EC2 environment/);
});

test("remembered selection cannot restore or grant an ambiguous environment", async () => {
  const { records, companies, environments } = await fixture();
  const environment = { ...draft, id: "legacy", companies: ["first", "second"], revision: 1 };
  await records.put("environment", environment.id, environment);
  const selection = { environmentId: environment.id, agent: "mock", ...chat("first") };
  await assert.rejects(rememberChatSelection(records, selection, environment), /one company/);
  await assert.rejects(rememberChatSelection(records, { ...selection, repositories: [] }, environment), /one company/);
  await records.put("new-chat-company", "first", { companyId: "first", selection });
  const restored = await restoreChatSelection({ records, companies, environments, chats: [], github: { resolveSelections: async repos => repos }, namedAccounts: false, availableAgents: [{ id: "mock", enabled: true }] }, { companyId: "first" });
  assert.equal(restored.selection.environmentId, null); assert.match(restored.warnings.join(" "), /environment is unavailable/);
  assert.equal(environmentCompany(environment), null); assert.equal(environmentAllows(environment, "first"), false);
});

test("ambiguous environment admission cannot create a chat, acquire a worker or mutate existing conversations", async t => {
  const { records, environments } = await fixture();
  await records.put("environment", "legacy", { ...draft, id: "legacy", companies: ["first", "second"], revision: 1 });
  const directory = await temporaryDirectory(t), store = new ChatStore(directory, records);
  await store.initialize();
  const existing = await store.create({ agent: "mock", environmentId: "legacy", ...chat("first") });
  await store.appendMessage(existing.id, { role: "user", text: "Keep this conversation" });
  let acquisitions = 0, stops = 0;
  const manager = new RuntimeManager({ store, config: testConfig(directory), environments, broker: new CapabilityBroker({ ttlMs: 10000 }),
    github: { resolveSelections: async repos => repos }, workerBackend: { acquire: async () => { acquisitions++; }, sleep: async () => { stops++; } } });
  t.after(() => manager.shutdown());
  await assert.rejects(manager.createChat({ agent: "mock", environmentId: "legacy", ...chat("first") }), /needs company review/);
  await environments.list();
  assert.equal(store.list().length, 1); assert.equal(acquisitions, 0); assert.equal(stops, 0);
  assert.equal(store.get(existing.id).messages[0].text, "Keep this conversation");
});
