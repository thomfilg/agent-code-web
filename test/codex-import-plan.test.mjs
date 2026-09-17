import assert from "node:assert/strict";
import test from "node:test";
import { planCodexImport } from "../src/codex-import-plan.mjs";

const options = { source: "claude-code", workspace: "/fixture/project", home: "/fixture/private-home", includeHome: true };
const details = values => ({ plugins: [], skills: [], sessions: [], mcpServers: [], hooks: [], subagents: [], commands: [], ...values });
const group = (itemType, cwd, value = null) => ({ itemType, cwd, description: "Native source/target paths must not leak into the public review", details: value });
const session = (id, cwd = options.workspace) => ({ path: `${options.home}/.claude/projects/fixture/${id}.jsonl`, cwd, title: `Conversation ${id}` });
const fixture = () => ({ items: [
  group("CONFIG", null),
  group("MCP_SERVER_CONFIG", options.workspace, details({ mcpServers: [{ name: "work-connection" }, { name: "another-connection" }] })),
  group("SESSIONS", null, details({ sessions: [session("a"), session("b"), session("excluded", "/fixture/other-company")] })),
], connectors: [] });
const byType = (plan, itemType) => plan.catalog.items.filter(item => item.itemType === itemType);

test("native imports select whole non-session groups using opaque review IDs", () => {
  const input = fixture(), plan = planCodexImport(input, options), connection = byType(plan, "MCP_SERVER_CONFIG")[0];
  assert.equal(connection.count, 2);
  assert.deepEqual(connection.entries, ["another-connection", "work-connection"]);
  assert.match(connection.warning, /whole detected connection group/);
  const result = plan.select([connection.id]);
  assert.equal(result.migrationSource, "claude-code");
  assert.equal(result.migrationItems.length, 1);
  assert.deepEqual(result.migrationItems[0].details.mcpServers, [{ name: "another-connection" }, { name: "work-connection" }]);
  assert.throws(() => plan.select(["work-connection"]), /current review/);
  assert.deepEqual(input, fixture(), "Review must not mutate the native detection response");
});

test("conversation choices are project-scoped and merge only selected sessions", () => {
  const plan = planCodexImport(fixture(), options), conversations = byType(plan, "SESSIONS");
  assert.deepEqual(conversations.map(item => item.name).sort(), ["Conversation a", "Conversation b"]);
  assert.equal(plan.catalog.excludedSessions, 1);
  const one = plan.select([conversations.find(item => item.name === "Conversation b").id]);
  assert.deepEqual(one.migrationItems[0].details.sessions, [session("b")]);
  const two = plan.select(conversations.map(item => item.id));
  assert.equal(two.migrationItems.length, 1); assert.equal(two.migrationItems[0].details.sessions.length, 2);
  assert.ok(two.migrationItems[0].details.sessions.every(item => item.cwd === options.workspace));
});

test("public reviews do not disclose native paths, raw descriptions or other projects", () => {
  const input = fixture();
  input.items.push(group("AGENTS_MD", "/fixture/other-company"));
  const plan = planCodexImport(input, options);
  assert.equal(plan.catalog.excludedGroups, 1);
  const output = JSON.stringify(plan.catalog);
  assert.doesNotMatch(output, /\/fixture|Native source\/target|Conversation excluded|other-company|jsonl/);
  assert.ok(plan.catalog.items.every(item => /^[a-f0-9]{64}$/.test(item.id)));
  const selected = plan.select(plan.catalog.items.map(item => item.id));
  assert.ok(selected.migrationItems.every(item => item.cwd === null || item.cwd === options.workspace));
});

test("home discovery is opt-in and empty session groups can never be submitted", () => {
  const plan = planCodexImport(fixture(), { ...options, includeHome: false });
  assert.deepEqual(plan.catalog.items.map(item => item.itemType), ["MCP_SERVER_CONFIG"]);
  assert.equal(plan.catalog.excludedGroups, 2);
  const onlyOther = { items: [group("SESSIONS", null, details({ sessions: [session("excluded", "/fixture/other-company")] }))] };
  const empty = planCodexImport(onlyOther, options);
  assert.deepEqual(empty.catalog.items, []);
  assert.throws(() => empty.select([]), /current review/);
  assert.throws(() => empty.select(["SESSIONS"]), /current review/);
});

test("only known source providers and source-profile session paths are accepted", () => {
  assert.throws(() => planCodexImport(fixture(), { ...options, source: "unknown" }), /explicitly/);
  assert.throws(() => planCodexImport(fixture(), { ...options, source: "cursor" }), /outside/);
  for (const file of ["/outside/conversation.jsonl", `${options.home}/.claude-other/log.jsonl`, `${options.home}/.claude/../log.jsonl`, "/fixture/private-home/.claude/line\nbreak"]) {
    const input = fixture(); input.items[2].details.sessions[0].path = file;
    assert.throws(() => planCodexImport(input, options), /outside|invalid conversation/);
  }
  const cursor = fixture(); cursor.items[2].details.sessions.forEach(item => { item.path = item.path.replace("/.claude/", "/.cursor/"); });
  assert.equal(planCodexImport(cursor, { ...options, source: "cursor" }).catalog.source, "cursor");
  for (const scope of [{ home: "/" }, { workspace: "relative" }, { workspace: "/fixture/../project" }, { includeHome: "true" }]) {
    assert.throws(() => planCodexImport(fixture(), { ...options, ...scope }), /worker scope/);
  }
});

test("metadata revisions ignore ordering but detect reviewed metadata changes", () => {
  const original = planCodexImport(fixture(), options), reordered = fixture();
  reordered.items.reverse();
  reordered.items.forEach(item => { for (const values of Object.values(item.details || {})) if (Array.isArray(values)) values.reverse(); });
  const stable = planCodexImport(reordered, options);
  assert.equal(stable.catalog.revision, original.catalog.revision);
  assert.deepEqual(stable.catalog.items, original.catalog.items);
  const changed = fixture(); changed.items[1].details.mcpServers[0].name = "Changed connection";
  assert.notEqual(planCodexImport(changed, options).catalog.revision, original.catalog.revision);
  const otherProjectTitle = fixture(); otherProjectTitle.items[2].details.sessions[2].title = "A private change outside this project";
  assert.equal(planCodexImport(otherProjectTitle, options).catalog.revision, original.catalog.revision);
});

test("reviews and selected payloads are defensive copies with no client-supplied paths", () => {
  const input = fixture(), plan = planCodexImport(input, options), connection = byType(plan, "MCP_SERVER_CONFIG")[0];
  const id = connection.id;
  input.items[1].details.mcpServers.length = 0;
  connection.entries.length = 0; connection.name = "Forged client name";
  const first = plan.select([id]); first.migrationItems[0].cwd = "/forged"; first.migrationItems[0].details.mcpServers.length = 0;
  const second = plan.select([id]);
  assert.equal(second.migrationItems[0].cwd, options.workspace); assert.equal(second.migrationItems[0].details.mcpServers.length, 2);
  for (const ids of [null, {}, [], [id, id], ["/forged"], [id, null], [{ id }]]) assert.throws(() => plan.select(ids), /current review/);
});

test("unknown, incomplete, duplicate and overlarge native catalogs fail closed", () => {
  const invalid = [];
  invalid.push({ items: [group("FUTURE_TYPE", null)] });
  invalid.push({ items: [group("CONFIG", null), group("CONFIG", null)] });
  invalid.push({ items: [group("SKILLS", null, details({ skills: [] }))] });
  invalid.push({ items: [group("CONFIG", null, { surprises: [] })] });
  invalid.push({ items: [group("SKILLS", null, details({ skills: [{ name: "same" }, { name: "same" }] }))] });
  invalid.push({ items: [group("SESSIONS", null, details({ sessions: [session("same"), session("same")] }))] });
  invalid.push({ items: [group("SESSIONS", null, details({ sessions: [session("same")] })), group("SESSIONS", options.workspace, details({ sessions: [session("same")] }))] });
  invalid.push({ items: [group("CONFIG", null, details({ sessions: [session("unexpected")] }))] });
  invalid.push({ items: [group("PLUGINS", null, details({ plugins: [{ marketplaceName: "fixture", pluginNames: [] }] }))] });
  invalid.push({ items: [group("MEMORY", null, details({ memory: [""] }))] });
  invalid.push({ items: [group("SESSIONS", null, details({ sessions: Array.from({ length: 51 }, (_, index) => session(String(index))) }))] });
  invalid.push({ items: Array.from({ length: 41 }, () => group("CONFIG", null)) });
  invalid.push({ items: [], connectors: [{ name: "x".repeat(512001) }] });
  for (const input of invalid) assert.throws(() => planCodexImport(input, options), /Cannot review native import/);
});

test("plugin and memory groups have bounded human-readable whole-group summaries", () => {
  const plan = planCodexImport({ items: [
    group("PLUGINS", null, details({ plugins: [{ marketplaceName: "fixture", pluginNames: ["b", "a"] }] })),
    group("MEMORY", options.workspace, details({ memory: ["/private/source/notes.md"] })),
  ] }, options);
  assert.deepEqual(byType(plan, "PLUGINS")[0].entries, ["fixture / a", "fixture / b"]);
  assert.deepEqual(byType(plan, "MEMORY")[0].entries, ["notes.md"]);
  assert.doesNotMatch(JSON.stringify(plan.catalog), /\/private\/source/);
  const hugePlugins = { items: [group("PLUGINS", null, details({ plugins: [{ marketplaceName: "a", pluginNames: Array.from({ length: 200 }, (_, index) => String(index)) }, { marketplaceName: "b", pluginNames: ["one-more"] }] }))] };
  assert.throws(() => planCodexImport(hugePlugins, options), /too many entries/);
});
