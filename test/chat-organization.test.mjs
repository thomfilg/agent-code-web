import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_STATES, compareChats, groupChats, repositoryGroup } from "../public/chat-organization.js";
import { ChatOrganization } from "../src/chat-organization.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords, RecordCipher } from "../src/database.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function fixture(t, adapterFactory) {
  const root = await temporaryDirectory(t); const records = new MemoryRecords();
  const store = new ChatStore(root, records); await store.initialize();
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost", adapterFactory });
  t.after(() => manager.shutdown());
  const organization = new ChatOrganization({ records, store });
  return { records, store, manager, organization };
}
test("first repository determines company / repo, with safe legacy and empty fallback", () => {
  assert.deepEqual(repositoryGroup({ repositories: [{ fullName: "Acme/api" }, { fullName: "Other/web" }], source: "https://github.com/wrong/ignored.git" }), { company: "Acme", repository: "api", fullName: "Acme/api" });
  assert.equal(repositoryGroup({ source: "https://github.com/12-apps/shared-packages.git" }).repository, "shared-packages");
  assert.equal(repositoryGroup({ source: "git@github.com:org/repo.git" }).company, "org");
  assert.equal(repositoryGroup({}).repository, "No repository");
});
test("pinned is exclusive but keeps assignment; custom groups override natural hierarchy", () => {
  const chats = [
    { id: "a", pinned: true, customGroupId: "g", repositories: [{ fullName: "Acme/api" }] },
    { id: "b", customGroupId: "g", repositories: [{ fullName: "Other/web" }] },
    { id: "c", repositories: [{ fullName: "Acme/api" }, { fullName: "Other/web" }] },
  ].map((chat, i) => ({ createdAt: `${i}`, updatedAt: `${i}`, ...chat }));
  const result = groupChats(chats, [{ id: "g", name: "Sprint" }], "created_desc");
  assert.equal(result.pinned[0].customGroupId, "g"); assert.equal(result.custom[0].chats[0].id, "b");
  assert.deepEqual(result.companies.map(c => [c.name, c.repositories[0].name]), [["Acme", "api"]]);
  assert.equal(chats.length, 3);
});
test("all sort orders and stable ties", () => {
  const chats = [{ id: "a", createdAt: "2026-01-01", updatedAt: "2026-03-01", workflowState: "idle" }, { id: "b", createdAt: "2026-02-01", updatedAt: "2026-02-01", workflowState: "working" }];
  for (const [sort, expected] of [["created_desc", "b"], ["created_asc", "a"], ["updated_desc", "a"], ["updated_asc", "b"], ["state", "b"]]) assert.equal([...chats].sort(compareChats(sort))[0].id, expected);
  assert.deepEqual(CHAT_STATES.map(([id]) => id), ["working", "asking_question", "idle", "pr_open", "pr_merged", "archived"]);
  assert.ok(compareChats("state")({ ...chats[0], id: "a" }, { ...chats[0], id: "b" }) < 0);
});
test("group CRUD, membership, pins, preferences and workflow survive restart", async t => {
  const { records, store, manager, organization } = await fixture(t);
  const chat = await manager.createChat({ agent: "mock" });
  const group = await organization.saveGroup({ name: "Sprint" });
  await organization.patchChat(chat.id, { pinned: true, customGroupId: group.id, workflowState: "pr_open" }, manager);
  await organization.savePreferences({ sort: "state", collapsed: [group.id] });
  const restarted = new ChatStore(store.dataDir, records); await restarted.initialize();
  assert.equal(restarted.get(chat.id).pinned, true); assert.equal(restarted.get(chat.id).customGroupId, group.id); assert.equal(restarted.get(chat.id).workflowState, "pr_open");
  assert.equal((await new ChatOrganization({ records, store: restarted }).preferences()).sort, "state");
  await organization.saveGroup({ name: "Renamed" }, group.id);
  assert.equal((await organization.listGroups())[0].name, "Renamed");
  await organization.removeGroup(group.id);
  assert.equal(store.get(chat.id).customGroupId, null); assert.equal(store.get(chat.id).pinned, true);
  assert.equal(store.list().length, 1);
});
test("group validation, concurrent duplicates and delete/move race", async t => {
  const { store, manager, organization } = await fixture(t);
  const chat = await manager.createChat({ agent: "mock" });
  await assert.rejects(organization.saveGroup({ name: "  " }), /1–80/);
  const results = await Promise.allSettled([organization.saveGroup({ name: "Sprint" }), organization.saveGroup({ name: "sprint" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const group = results.find(r => r.status === "fulfilled").value;
  const operations = await Promise.allSettled([organization.removeGroup(group.id), organization.patchChat(chat.id, { customGroupId: group.id }, manager)]);
  assert.equal(operations[1].status, "rejected"); assert.equal(store.get(chat.id).customGroupId, null);
  await assert.rejects(organization.patchChat(chat.id, { pinned: "true" }, manager), /true or false/);
  await assert.rejects(organization.patchChat(chat.id, { workflowState: "broken" }, manager), /Invalid/);
  await assert.rejects(organization.patchChat(chat.id, { repositories: [] }, manager), /Cannot change/);
  await assert.rejects(organization.savePreferences({ sort: "nonsense" }), /Invalid/);
});
test("runtime working/question/idle transitions preserve PR milestone; archive rejects prompts", async t => {
  let hooks, finish;
  const { store, manager, organization } = await fixture(t, ({ hooks: callbacks }) => {
    hooks = callbacks;
    return { start: async () => {}, send: () => new Promise(resolve => { finish = resolve; }), respond: async () => {}, stop: async () => { finish?.({ text: "stopped" }); } };
  });
  const chat = await manager.createChat({ agent: "mock" });
  await organization.patchChat(chat.id, { workflowState: "pr_open" }, manager);
  const turn = await manager.submit(chat.id, "work"); await waitFor(() => finish);
  assert.equal(store.get(chat.id).workflowState, "working");
  await assert.rejects(organization.patchChat(chat.id, { workflowState: "archived" }, manager), /Stop the working/);
  await hooks.onRequest({ requestId: "question-1", method: "item/tool/requestUserInput", params: { questions: [{ id: "a", question: "Which branch?" }] } });
  assert.equal(store.get(chat.id).workflowState, "asking_question");
  await manager.respond(chat.id, "question-1", { answers: { a: "main" } });
  assert.equal(store.get(chat.id).workflowState, "working");
  finish({ text: "done" }); await turn.completion;
  assert.equal(store.get(chat.id).workflowState, "pr_open");
  await manager.stop(chat.id); assert.equal(store.get(chat.id).workflowState, "pr_open");
  await organization.patchChat(chat.id, { workflowState: "pr_merged" }, manager);
  await organization.patchChat(chat.id, { workflowState: "archived" }, manager);
  await assert.rejects(manager.submit(chat.id, "wake"), /Unarchive/);
  await organization.patchChat(chat.id, { workflowState: "idle" }, manager);
  assert.equal(store.get(chat.id).status, "stopped");
});
test("organization records use authenticated ciphertext, bound to the record id", () => {
  const cipher = new RecordCipher(Buffer.alloc(32, 7));
  const encrypted = cipher.seal("chat-group", "1", { name: "Private company" });
  assert.equal(encrypted.includes("Private company"), false);
  assert.deepEqual(cipher.open("chat-group", "1", encrypted), { name: "Private company" });
  assert.throws(() => cipher.open("chat-group", "2", encrypted));
  encrypted[35] ^= 1; assert.throws(() => cipher.open("chat-group", "1", encrypted));
});
test("HTTP organization routes require auth, validate origin, and update sidebar", async t => {
  const root = await temporaryDirectory(t);
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "test-secret" }) });
  const { url } = await app.start(); t.after(() => app.stop());
  assert.equal((await fetch(`${url}/api/sidebar`)).status, 401);
  assert.equal((await fetch(`${url}/api/groups`, { method: "POST", body: "{}" })).status, 401);
  const login = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ token: "test-secret" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const request = async (route, method = "GET", body = {}) => { const response = await fetch(`${url}${route}`, { method, headers: { cookie }, ...(method !== "GET" ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, ...(await response.json()) }; };
  const created = await request("/api/chats", "POST", { agent: "mock" });
  const group = await request("/api/groups", "POST", { name: "HTTP group" });
  const changed = await request(`/api/chats/${created.chat.id}`, "PATCH", { pinned: true, customGroupId: group.group.id });
  assert.equal(changed.chat.pinned, true);
  assert.equal((await request("/api/sidebar")).groups.length, 1);
  assert.equal((await fetch(`${url}/api/groups`, { method: "POST", headers: { cookie, origin: "https://hostile.test" }, body: '{}' })).status, 403);
});
