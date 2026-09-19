import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { captureCodexFinal, codexFinalAnswer, claudeFinalAnswer, finalAnswerMeta, searchableText, searchMessages } from "../src/message-search.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { ChatStore } from "../src/store.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { importedTranscript } from "../src/codex-import-chat.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const user = (id, text, meta) => ({ id, text, meta, role: "user", kind: "message", createdAt: "2026-09-19T12:00:00Z" });
const assistant = (id, text, projection, meta = {}) => ({ id, text, role: "assistant", kind: "message", agent: "codex", meta: { ...finalAnswerMeta(projection ? { source: "codex-final-answer", text: projection } : null, "codex"), ...meta } });
const chat = messages => ({ id: "chat-fixture", title: "Project", updatedAt: "2026-09-19", repositories: [{ fullName: "acme/api", companyId: "acme" }], messages });

test("search includes authored users and exact final projections, never transcript guesses or generated messages", () => {
  const messages = [user("human", "needle user"), assistant("final", "PRIVATE commentary then needle final", "needle final"),
    assistant("unknown", "needle legacy"), assistant("commentary", "needle commentary", "needle marked", { commentary: true }),
    user("github", "needle webhook", { source: "github", authorship: "user" }), user("receipt", "needle webhook", { githubEventId: "receipt" }),
    user("sample", "needle sample", { renderingSample: true }), user("generated", "needle system", { generated: true }),
    { ...user("tool", "needle output"), kind: "tool" }, assistant("interrupted", "needle partial", "needle final", { interrupted: true })];
  const result = searchMessages([chat(messages)], { query: "NEEDLE" });
  assert.deepEqual(result.results.map(item => item.messageId), ["final", "human"]);
  assert(!JSON.stringify(result).includes("PRIVATE"));
  assert.deepEqual(searchMessages([chat(messages)], { query: "needle", role: "assistant" }).results.map(item => item.messageId), ["final"]);
  assert.equal(searchableText(assistant("wrong", "x", "x", { finalAnswer: { version: 1, source: "claude-success-result", text: "x" } })), null);
});
test("bounded scan cursors reach sparse old history and paginate without match-dependent cutoffs", () => {
  const messages = Array.from({ length: 10005 }, (_, i) => user(`m${i}`, i === 0 ? "oldest needle" : "unmatched"));
  const first = searchMessages([chat(messages)], { query: "needle" }); assert.equal(first.results.length, 0); assert.equal(first.nextOffset, 5000);
  const second = searchMessages([chat(messages)], { query: "needle", offset: first.nextOffset }); assert.equal(second.results.length, 0); assert.equal(second.nextOffset, 10000);
  const third = searchMessages([chat(messages)], { query: "needle", offset: second.nextOffset }); assert.deepEqual(third.results.map(item => item.messageId), ["m0"]); assert.equal(third.nextOffset, null);
  const many = chat(Array.from({ length: 85 }, (_, i) => user(`hit${i}`, "needle"))), found = []; let offset = 0;
  do { const page = searchMessages([many], { query: "needle", offset }); found.push(...page.results.map(item => item.messageId)); offset = page.nextOffset; } while (offset !== null);
  assert.equal(found.length, 85); assert.equal(new Set(found).size, 85);
  const oldChat = { ...chat([user("separate-old", "needle")]), id: "old", updatedAt: "2020" };
  assert.deepEqual(searchMessages([many, oldChat], { query: "needle", offset: 85 }).results.map(item => item.messageId), ["separate-old"]);
});
test("literal query and response bounds reject malformed input without regex or HTML evaluation", () => {
  for (const input of [null, [], {}, { query: " " }, { query: "x".repeat(201) }, { query: "x", role: "tool" }, { query: "x", offset: -1 }, { query: "x", offset: 1.5 }]) assert.throws(() => searchMessages([], input), { statusCode: 400 });
  const literal = "<script>window.injected=true</script>.*";
  assert.equal(searchMessages([chat([user("literal", literal)])], { query: literal }).results[0].excerpt, literal);
  assert.deepEqual(finalAnswerMeta({ source: "codex-final-answer", text: "x".repeat(100001) }, "codex"), {});
});
test("Codex final provenance requires authoritative item phase and exact successful thread/turn", () => {
  const current = { turnId: "turn" }, params = item => ({ threadId: "thread", turnId: "turn", item: { type: "agentMessage", id: "a", text: "final", ...item } });
  const capture = p => captureCodexFinal(current, p, "thread", text => text.replaceAll("CREDENTIAL", "[redacted]"));
  capture(params({ phase: "commentary", text: "private update" })); capture(params({ id: "unknown", phase: null, text: "unknown" }));
  capture({ ...params({ phase: "final_answer" }), threadId: "other" }); capture({ ...params({ phase: "final_answer" }), turnId: "late" });
  assert.equal(codexFinalAnswer(current, { threadId: "thread", turn: { id: "turn", status: "completed" } }, "thread"), null);
  capture(params({ phase: "final_answer", text: "Final CREDENTIAL" }));
  for (const status of ["failed", "interrupted", "inProgress"]) assert.equal(codexFinalAnswer(current, { threadId: "thread", turn: { id: "turn", status } }, "thread"), null);
  assert.deepEqual(codexFinalAnswer(current, { threadId: "thread", turn: { id: "turn", status: "completed" } }, "thread"), { source: "codex-final-answer", text: "Final [redacted]" });
  current.interruptRequested = true; assert.equal(codexFinalAnswer(current, { threadId: "thread", turn: { id: "turn", status: "completed" } }, "thread"), null); current.interruptRequested = false;
  capture(params({ phase: null })); assert.equal(current.searchAnswers.size, 0);
});
test("Claude uses successful root ResultMessage only and excludes unknown, failed, interrupted and background results", () => {
  const result = { type: "result", subtype: "success", is_error: false, session_id: "session", num_turns: 2, stop_reason: "end_turn", result: "Actual final" };
  assert.equal(claudeFinalAnswer(result, "session").text, "Actual final"); assert.equal(claudeFinalAnswer({ ...result, origin: { kind: "human" } }, "session").text, "Actual final");
  assert.equal(claudeFinalAnswer({ ...result, terminal_reason: "completed" }, "session").text, "Actual final");
  for (const terminal_reason of ["aborted_streaming", "aborted_tools", "hook_stopped", "background_requested", "max_turns", "unknown", null]) assert.equal(claudeFinalAnswer({ ...result, terminal_reason }, "session"), null);
  for (const patch of [{ session_id: "other" }, { subtype: "error_during_execution" }, { is_error: true }, { is_error: undefined }, { num_turns: 0 }, { stop_reason: null }, { stop_reason: "max_tokens" }, { parent_tool_use_id: "child" }, { relayWorkflowInterrupted: true }, { origin: { kind: "task-notification" } }, { origin: { kind: "unclassified" } }, { origin: { kind: "channel" } }]) assert.equal(claudeFinalAnswer({ ...result, ...patch }, "session"), null);
});
test("native imports preserve explicit final provenance only on completed turns and remove hidden Relay metadata", () => {
  const item = (id, phase) => ({ type: "agentMessage", id, phase, text: `needle ${id}<relay-waiting>no</relay-waiting>\n<relay-title>Private title marker</relay-title>` });
  const messages = importedTranscript({ turns: [{ status: "completed", items: [item("final", "final_answer"), item("update", "commentary"), item("old", null)] }, { status: "interrupted", items: [item("interrupted", "final_answer")] }] });
  assert.equal(messages.filter(message => searchableText(message)).length, 1);
  assert.equal(searchableText(messages[0]), "needle final");
  assert(!JSON.stringify(messages[0].meta.finalAnswer).includes("Private title"));
});
test("search API isolates owners, excludes generated output and never acquires a worker", async t => {
  const root = await temporaryDirectory(t); let workers = 0;
  const deny = () => { workers++; throw Error("Search must not start anything"); };
  const app = await createAgentWebServer({ records: new MemoryRecords(), config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "search-fixture" }), adapterFactory: deny, workerBackend: { acquire: deny, shutdown: async () => {} } });
  const { url } = await app.start(); t.after(() => app.stop());
  const call = (route, body, cookie) => fetch(`${url}${route}`, { method: "POST", headers: { authorization: "Bearer search-fixture", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const register = async username => { const response = await call("/api/browser-account/register", { username, password: "search-fixture-password" }); assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0]; };
  const alice = await register("search-alice"), bob = await register("search-bob");
  const scope = async cookie => (await (await call("/api/message-search", { query: "needle" }, cookie)).json()).scope;
  const ac = await app.store.create({ ownerId: await scope(alice), agent: "codex", title: "Alice" }), bc = await app.store.create({ ownerId: await scope(bob), agent: "codex", title: "Bob" });
  await app.store.appendMessage(ac.id, user("a", "needle alice")); await app.store.appendMessage(bc.id, user("b", "needle bob"));
  await app.store.appendMessage(ac.id, user("g", "needle webhook", { source: "github" }));
  assert.deepEqual((await (await call("/api/message-search", { query: "needle" }, alice)).json()).results.map(item => item.messageId), ["a"]);
  assert.deepEqual((await (await call("/api/message-search", { query: "needle" }, bob)).json()).results.map(item => item.messageId), ["b"]);
  assert.deepEqual((await (await call("/api/message-search", { query: "needle" })).json()).results, []);
  assert.equal((await fetch(`${url}/api/message-search`, { method: "POST" })).status, 401); assert.equal(workers, 0);
  const originalSession = app.browserUsers.session.bind(app.browserUsers);
  for (const variant of ["transfer", "same-owner-new-session"]) {
    const held = Promise.withResolvers(), release = Promise.withResolvers(); let checks = 0;
    app.browserUsers.session = async request => {
      const user = await originalSession(request);
      if (request.url === "/api/message-search" && ++checks === 3) { held.resolve(); await release.promise; return variant === "same-owner-new-session" ? { ...user, sessionId: "different-session" } : user; }
      return user;
    };
    try {
      const pending = call("/api/message-search", { query: "needle" }, alice); await held.promise;
      if (variant === "transfer") await app.store.update(ac.id, { ownerId: "new-owner" });
      release.resolve(); const response = await pending; assert.equal(response.status, 409); assert(!JSON.stringify(await response.json()).includes("needle alice"));
    } finally { release.resolve(); app.browserUsers.session = originalSession; await app.store.update(ac.id, { ownerId: await scope(alice) }); }
  }
  assert.equal(workers, 0);
});
test("actual Codex adapter mapping persists only explicit final text despite consecutive commentary without tools", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), AGENT_IDLE_TIMEOUT_MS: "10000" }), broker = new CapabilityBroker({ ttlMs: 10000 });
  const manager = new RuntimeManager({ store, config, broker, adapterFactory: args => {
    const adapter = new CodexAdapter({ ...args, store, config, broker }), start = adapter.start.bind(adapter);
    adapter.start = async () => { await start(); adapter.credentialSecrets.add("PRIVATE-FINAL-CREDENTIAL"); const request = adapter.rpc.request.bind(adapter.rpc);
      adapter.rpc.request = async (method, params, timeout) => {
        if (method !== "turn/start") return request(method, params, timeout);
        const turn = { id: "search-turn", status: "inProgress" }, event = (method, extra) => ({ method, params: { threadId: adapter.threadId, turnId: turn.id, ...extra } });
        await request("fixture/notifications", { notifications: [event("turn/started", { turn }),
          ...[{ id: "update1", phase: "commentary", text: "PRIVATE first update" }, { id: "update2", phase: "commentary", text: "PRIVATE second update" }, { id: "answer", phase: "final_answer", text: "needle final PRIVATE-FINAL-CREDENTIAL" }].map(item => event("item/completed", { item: { type: "agentMessage", ...item } })),
          event("turn/completed", { turn: { ...turn, status: "completed" } })] }); return { turn };
      };
    }; return adapter;
  } }); t.after(() => manager.shutdown());
  const current = await manager.createChat({ agent: "codex", title: "Search provenance" }); await manager.send(current.id, "Authored request");
  const persisted = store.get(current.id), final = persisted.messages.findLast(message => message.role === "assistant");
  assert.match(final.text, /PRIVATE first update/); assert.equal(final.meta.finalAnswer.text, "needle final [redacted]");
  assert.equal(searchMessages([persisted], { query: "first update" }).results.length, 0);
  assert.equal(searchMessages([persisted], { query: "needle" }).results[0].messageId, final.id);
  const reloaded = new ChatStore(root); await reloaded.initialize(); assert.deepEqual(reloaded.get(current.id).messages.at(-1).meta.finalAnswer, final.meta.finalAnswer);
});
