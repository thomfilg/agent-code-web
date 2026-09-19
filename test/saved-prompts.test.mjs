import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { validatePrompts, promptAvailable, promptProjectKey } from "../public/saved-prompts-model.js";
import { SavedPrompts, knownPromptProjects } from "../src/saved-prompts.mjs";
import { MemoryRecords, openDatabase } from "../src/database.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const project = { companyId: "acme", repository: "owner/project" };
const prompt = (text = "A private reusable prompt", projects = []) => ({ id: `prompt_${randomUUID()}`, text, availability: projects.length ? "projects" : "all", projects });
test("saved prompts validate bounded literal content, project identity, ordering and availability", () => {
  const item = prompt("<script>not executed</script>\nOriginal text", [project]);
  assert.deepEqual(validatePrompts([item]), [item]);
  assert(promptAvailable(item, { ...project, repository: "OWNER/PROJECT" }));
  assert(!promptAvailable(item, { ...project, companyId: "other" })); assert(!promptAvailable(item, null)); assert(promptAvailable(prompt(), null));
  for (const value of [null, {}, [item, item], [{ ...item, id: "../x" }], [{ ...item, ownerId: "other" }], [{ ...item, text: " " }], [{ ...item, text: "x".repeat(20001) }], [{ ...item, text: "\0" }], [{ ...item, projects: [] }], [{ ...item, availability: "all" }], [{ ...item, projects: [project, project] }], [{ ...item, projects: [{ ...project, companyId: "acme-" }] }], Array.from({ length: 101 }, () => prompt())]) assert.throws(() => validatePrompts(value));
  assert.throws(() => validatePrompts(Array.from({ length: 30 }, () => prompt("x".repeat(20000)))), /too large/);
});
test("known projects only include visible primary repositories and registered companies", () => {
  const chat = { repositories: [{ fullName: "Owner/Project", companyId: "acme" }, { fullName: "owner/secondary", companyId: "acme" }] };
  const projects = knownPromptProjects([chat, { repositories: [{ fullName: "other/private", companyId: "missing" }] }], [{ selection: chat }, { selection: { repositories: [{ fullName: "owner/draft", companyId: "acme" }] } }], [{ id: "acme" }]);
  assert.deepEqual(projects.map(promptProjectKey), [JSON.stringify(["acme", "owner/draft"]), JSON.stringify(["acme", "owner/project"])]);
});
test("owner libraries persist separately; CAS, unknown projects and revoked saves fail closed", async () => {
  const records = new MemoryRecords(), first = new SavedPrompts(records), second = new SavedPrompts(records);
  const initial = await first.get("alice", [project]), item = prompt("Alice only", [project]);
  const results = await Promise.allSettled([first.save("alice", { ...initial, items: [item] }, [project]), second.save("alice", { ...initial, items: [item] }, [project])]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(results.find(result => result.status === "rejected").reason.statusCode, 409);
  assert.deepEqual((await second.get("alice", [project])).items, [item]); assert.deepEqual((await first.get("bob", [project])).items, []);
  await assert.rejects(first.save("bob", { ...initial, items: [item] }, [project]), { statusCode: 409 });
  await assert.rejects(first.save("alice", { ...initial, revision: 1, items: [prompt("Unknown", [{ ...project, companyId: "other" }])] }, [project]), { statusCode: 400 });
  let checks = 0;
  await assert.rejects(first.save("alice", { ...initial, revision: 1, items: [] }, [project], async () => { if (++checks === 2) throw Object.assign(Error("Revoked"), { statusCode: 409 }); }), { statusCode: 409 });
  assert.deepEqual((await first.get("alice", [project])).items, [item]);
  const edited = { ...item, text: "Existing unavailable project remains editable" };
  assert.deepEqual((await first.save("alice", { ...initial, revision: 1, items: [edited] }, [])).items, [edited]);
});
test("saved prompts HTTP requires authentication/origin and isolates owners without worker or provider actions", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(); let workers = 0;
  const app = await createAgentWebServer({ records, config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "prompt-fixture" }), adapterFactory: () => { workers++; throw Error("No worker allowed"); } });
  const { url } = await app.start(); t.after(() => app.stop());
  const call = (route, { cookie, body, method, origin } = {}) => fetch(`${url}${route}`, { method: method || (body ? "POST" : "GET"), headers: { authorization: "Bearer prompt-fixture", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = async username => { const response = await call("/api/browser-account/register", { body: { username, password: "saved-prompt-fixture-password" } }); assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0]; };
  assert.equal((await fetch(`${url}/api/saved-prompts`)).status, 401);
  const alice = await register("prompt-alice"), bob = await register("prompt-bob");
  const a = await (await call("/api/saved-prompts", { cookie: alice })).json(), b = await (await call("/api/saved-prompts", { cookie: bob })).json();
  assert.notEqual(a.scope, b.scope);
  await records.put("new-chat-project", "legacy-shared", { selection: { repositories: [{ fullName: "owner/private-draft", companyId: "acme" }] } });
  await (await app.resources.forOwner(null)).companies.save({ id: "acme", name: "Acme" });
  const aliceChat = await app.store.create({ ownerId: a.scope, agent: "mock", title: "Alice project", repositories: [{ fullName: project.repository, companyId: "acme" }] });
  await app.store.create({ ownerId: b.scope, agent: "mock", title: "Bob project", repositories: [{ fullName: "owner/bob", companyId: "acme" }] });
  assert.deepEqual((await (await call("/api/saved-prompts", { cookie: alice })).json()).projects, [project]);
  const item = prompt("Alice private text", [project]), body = { ...a, items: [item] };
  assert.equal((await call("/api/saved-prompts", { cookie: alice, method: "PATCH", body, origin: "https://other.invalid" })).status, 403);
  assert.equal((await call("/api/saved-prompts", { cookie: alice, method: "PATCH", body })).status, 200);
  assert.equal((await call("/api/saved-prompts", { cookie: bob, method: "PATCH", body })).status, 409);
  assert.deepEqual((await (await call("/api/saved-prompts", { cookie: bob })).json()).items, []);
  assert.deepEqual((await (await call("/api/saved-prompts")).json()).items, []);
  await call("/api/browser-account", { cookie: alice, method: "DELETE" });
  assert.equal((await call("/api/saved-prompts", { cookie: alice, method: "PATCH", body: { ...body, revision: 1 } })).status, 409);
  assert.equal(workers, 0); assert.deepEqual(app.store.get(aliceChat.id).messages, []);
});
test("real PostgreSQL saved-prompt CAS is encrypted, durable, cross-instance and rollback-safe", { timeout: 60000 }, async t => {
  const directory = await temporaryDirectory(t, "relay-saved-prompts-pg-"), socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const config = { mode: "embedded", directory, port }; let records = await openDatabase(config);
  try {
  let service = new SavedPrompts(records); const item = prompt("PRIVATE_SAVED_PROMPT_SENTINEL"), input = { scope: "alice", revision: 0, items: [item] };
  const outcomes = await Promise.allSettled([service.save("alice", input, []), new SavedPrompts(records).save("alice", input, [])]);
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(value => value.status === "rejected").reason.statusCode, 409);
  const raw = (await records.pool.query("SELECT payload FROM relay_records WHERE kind='saved-prompts'")).rows[0].payload;
  assert(!raw.includes(item.text));
  await records.close(); records = await openDatabase(config); service = new SavedPrompts(records);
  assert.deepEqual((await service.get("alice", [])).items, [item]);
  let checks = 0;
  await assert.rejects(service.save("alice", { ...input, revision: 1, items: [] }, [], async () => { if (++checks === 3) throw Object.assign(Error("Revoked after SQL write"), { statusCode: 409 }); }), { statusCode: 409 });
  assert.equal((await service.get("alice", [])).revision, 1);
  await records.pool.query(`CREATE FUNCTION fixture_prompt_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='saved-prompts' THEN RAISE EXCEPTION 'PRIVATE STORAGE DETAILS'; END IF; RETURN NEW; END $$`);
  await records.pool.query(`CREATE CONSTRAINT TRIGGER fixture_prompt_commit AFTER INSERT OR UPDATE ON relay_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_prompt_commit_failure()`);
  try { await assert.rejects(service.save("alice", { ...input, revision: 1, items: [] }, []), error => error.statusCode === 503 && !error.message.includes("PRIVATE")); assert.deepEqual((await service.get("alice", [])).items, [item]); }
  finally { await records.pool.query("DROP TRIGGER fixture_prompt_commit ON relay_records"); await records.pool.query("DROP FUNCTION fixture_prompt_commit_failure()"); }
  } finally { await records.close(); }
});
