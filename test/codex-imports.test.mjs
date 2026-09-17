import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CodexImports } from "../src/codex-imports.mjs";

const workspace = "/fixture/project", home = "/fixture/private-home";
const detail = values => ({ plugins: [], skills: [], sessions: [], mcpServers: [], hooks: [], subagents: [], commands: [], ...values });
const session = { path: `${home}/.claude/projects/fixture/source.jsonl`, cwd: workspace, title: "Imported fixture conversation" };
const catalog = () => ({ items: [
  { itemType: "AGENTS_MD", description: "Private fixture instructions", cwd: null, details: null },
  { itemType: "AGENTS_MD", description: "Project fixture instructions", cwd: workspace, details: null },
  { itemType: "SESSIONS", description: "Fixture history", cwd: null, details: detail({ sessions: [session] }) },
], connectors: [] });
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(overrides = {}) {
  const f = { calls: [], imports: [], histories: [], saved: null, revision: "a".repeat(64), root: "root-thread", busy: false, reconciles: 0, inspectCount: 0, failSave: false };
  const args = {
    workspace, home, binding: "chat-1:user-1:company-1:private-profile", workerId: "worker-a", mutable: true,
    thread: () => f.root, busy: () => f.busy,
    inspect: async () => { f.inspectCount++; return f.revision; },
    save: async saved => { if (f.failSave) throw new Error("sensitive-storage-value"); f.saved = structuredClone(saved); },
    reconcile: async () => { f.reconciles++; },
    request: async (method, params) => {
      f.calls.push({ method, params: structuredClone(params) });
      if (method === "externalAgentConfig/detect") return catalog();
      if (method === "externalAgentConfig/import/readHistories") return { data: structuredClone(f.histories), connectors: [] };
      if (method === "externalAgentConfig/import") {
        f.imports.push(structuredClone(params)); f.importId = randomUUID();
        assert.ok(f.saved?.jobs.some(job => job.providerId === params.providerId), "Import intent must already be persisted");
        if (f.onImport) return f.onImport(params);
        return { importId: f.importId };
      }
      assert.fail(`Unexpected native operation ${method}`);
    },
    ...overrides,
  };
  f.service = new CodexImports(args);
  f.reopen = () => { f.service = new CodexImports({ ...args, workerId: "worker-b", saved: f.saved }); return f.service; };
  f.input = async () => {
    const review = await f.service.list();
    return { requestId: randomUUID(), source: review.source, revision: review.revision, threadId: review.threadId, ids: review.items.map(item => item.id), confirm: true };
  };
  f.results = () => {
    const imported = f.imports.at(-1);
    return imported.migrationItems.map(item => ({ itemType: item.itemType, successes: item.itemType === "SESSIONS" ? item.details.sessions.map(entry => ({ itemType: "SESSIONS", cwd: entry.cwd, source: entry.path, target: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: entry.title })) : [{ itemType: item.itemType, cwd: item.cwd, source: `${item.cwd || home}/CLAUDE.md`, target: `${item.cwd || home}/AGENTS.md`, title: null }], failures: [] }));
  };
  f.notify = (results, completed = false, importId = f.importId) => f.service.notification({ method: `externalAgentConfig/import/${completed ? "completed" : "progress"}`, params: { importId, itemTypeResults: results } });
  f.complete = (results = f.results(), notify = true) => {
    const history = { importId: f.importId, providerId: f.imports.at(-1).providerId, completedAtMs: Date.now(), successes: results.flatMap(item => item.successes), failures: results.flatMap(item => item.failures) };
    f.histories.push(history); if (notify) f.notify(results, true); return history;
  };
  return f;
}

test("native import persists intent, sends only reviewed artifacts and reconciles completed results", async () => {
  const f = fixture(), input = await f.input();
  const result = await f.service.start(input);
  assert.equal(result.operation.phase, "running"); assert.equal(result.changing, true);
  assert.equal(f.imports.length, 1); assert.equal(f.imports[0].migrationSource, "claude-code");
  assert.deepEqual(f.imports[0].migrationItems.map(item => item.itemType).sort(), ["AGENTS_MD", "AGENTS_MD", "SESSIONS"]);
  f.complete(); const refreshed = await f.service.refresh();
  assert.equal(refreshed.needsRefresh, false); assert.equal(refreshed.changing, false); assert.equal(f.reconciles, 1);
  const operation = refreshed.operations[0]; assert.equal(operation.phase, "completed");
  assert.deepEqual(operation.results.map(item => [item.itemType, item.imported, item.notReported]).sort(), [["AGENTS_MD", 2, 0], ["SESSIONS", 1, 0]]);
  assert.equal(operation.sessions.length, 1);
  assert.deepEqual(f.service.importedSession(operation.id, operation.sessions[0].id), { threadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", cwd: workspace, source: "claude-code", title: session.title });
  assert.doesNotMatch(JSON.stringify(refreshed), /\/fixture|CLAUDE\.md|source\.jsonl|relay-import:/);
  assert.ok(f.calls.every(call => call.method.startsWith("externalAgentConfig/")), "No ordinary agent input or approval RPC");
});

test("completion before the RPC response is retained and acknowledgement is not mistaken for completion", async () => {
  const f = fixture(); f.onImport = async () => { f.complete(); return { importId: f.importId }; };
  const completed = await f.service.start(await f.input());
  assert.equal(completed.operation.phase, "completed"); assert.equal(completed.changing, false);
  assert.equal(completed.needsRefresh, true); assert.equal(f.reconciles, 0);
  await f.service.refresh(); assert.equal(f.reconciles, 1);
  const pending = fixture(); await pending.service.start(await pending.input());
  const observed = await pending.service.refresh();
  assert.equal(observed.operations[0].phase, "running"); assert.equal(observed.changing, true); assert.equal(pending.reconciles, 0);
});

test("incremental and cumulative progress retain both scopes without double-counting", async () => {
  const f = fixture();
  f.onImport = async () => {
    const results = f.results().filter(item => item.itemType === "AGENTS_MD"); f.notify([results[0]]); f.notify([results[1]]); f.notify([results[0], results[1]]);
    return { importId: f.importId };
  };
  const started = await f.service.start(await f.input());
  assert.equal(started.operation.results.find(item => item.itemType === "AGENTS_MD").imported, 2);
  f.notify(f.results()); f.notify(f.results());
  assert.equal(f.service.status().operations[0].results.find(item => item.itemType === "AGENTS_MD").imported, 2);
  f.complete(); await f.service.refresh();
  f.notify([{ itemType: "AGENTS_MD", successes: [], failures: [] }]);
  assert.equal(f.service.status().operations[0].results.find(item => item.itemType === "AGENTS_MD").imported, 2);
});

test("same confirmation is idempotent before and after completion, conflicting reuse fails", async () => {
  const f = fixture(), input = await f.input();
  await f.service.start(input); assert.equal((await f.service.start(input)).reused, true);
  await assert.rejects(f.service.start({ ...input, ids: input.ids.slice(1) }), /different selection/);
  f.complete(); await f.service.refresh();
  assert.equal((await f.service.start(input)).operation.phase, "completed"); assert.equal(f.imports.length, 1);
  f.reopen(); assert.equal((await f.service.start(input)).reused, true); assert.equal(f.imports.length, 1);
});

test("transport loss closes an import connection without claiming its remote worker stopped", async () => {
  const f = fixture(), input = await f.input(); await f.service.start(input);
  await f.service.workerStopped("worker-a", false);
  assert.equal(f.saved.jobs[0].phase, "uncertain"); assert.equal(f.saved.jobs[0].workerStopped, false);
  f.reopen(); await assert.rejects(f.service.acknowledge({ id: input.requestId, threadId: f.root, confirm: true }), /confirmed stopped/);
  // A later authoritative stop of that exact worker, not its replacement,
  // permits acknowledgement without issuing another import.
  await f.service.workerStopped("worker-a", true);
  const result = await f.service.acknowledge({ id: input.requestId, threadId: f.root, confirm: true });
  assert.equal(result.operations[0].phase, "acknowledged"); assert.equal(f.imports.length, 1);
});

test("timeout and controller restoration recover the matching persisted result without retrying import", async () => {
  const f = fixture(); f.onImport = async () => { f.complete(f.results(), false); throw new Error("secret=native-credential-value"); };
  const input = await f.input();
  await assert.rejects(f.service.start(input), error => /not been retried/.test(error.message) && !/credential/.test(error.message));
  assert.equal(f.service.status().operations[0].phase, "uncertain");
  f.reopen(); const recovered = await f.service.refresh();
  assert.equal(recovered.operations[0].phase, "completed"); assert.equal(recovered.needsRefresh, false);
  assert.equal(f.imports.length, 1); assert.equal((await f.service.start(input)).reused, true);
});

test("a consumed or expired review cannot trigger a second import with a different request ID", async () => {
  const f = fixture(), input = await f.input(); await f.service.start(input); f.complete(); await f.service.refresh();
  await assert.rejects(f.service.start({ ...input, requestId: randomUUID() }), /already used/);
  assert.equal(f.imports.length, 1);
  const expired = await f.input(); f.service.reviews.get(expired.revision).createdAt -= 600001;
  await assert.rejects(f.service.start(expired), /expired/);
  for (let index = 0; index < 10; index++) { await f.service.start(await f.input()); f.complete(); await f.service.refresh(); }
  assert.equal(f.service.jobs.length, 10);
  await assert.rejects(f.service.start(input), /expired or was already used/);
  assert.equal(f.imports.length, 11);
});

test("missing history or a transient history error never proves a live operation stopped", async () => {
  const f = fixture(); await f.service.start(await f.input());
  let state = await f.service.refresh(); assert.equal(state.operations[0].phase, "running");
  f.reopen(); state = await f.service.refresh();
  assert.equal(state.operations[0].phase, "uncertain"); assert.equal(state.operations[0].canAcknowledge, false);
  await assert.rejects(f.service.acknowledge({ id: state.operations[0].id, threadId: f.root, confirm: true }), /confirmed stopped/);
  const previous = f.service.request;
  f.service.request = async () => { throw new Error("Temporary transport error"); };
  await assert.rejects(f.service.refresh(), /Temporary transport/);
  assert.equal(f.service.status().operations[0].canAcknowledge, false);
  f.service.request = previous; assert.equal(f.imports.length, 1);
});

test("remote clock skew does not replace the persisted import identity as the recovery key", async () => {
  const f = fixture(); await f.service.start(await f.input());
  const history = f.complete(f.results(), false); history.completedAtMs -= 86400000;
  const state = await f.service.refresh();
  assert.equal(state.operations[0].phase, "completed"); assert.equal(state.operations[0].completedAt, history.completedAtMs);
  assert.equal(f.imports.length, 1);
});

test("incomplete results require an observed original-worker stop and explicit acknowledgement", async () => {
  const f = fixture(); const input = await f.input(); await f.service.start(input);
  await f.service.workerStopped("worker-a");
  await assert.rejects(f.service.list(), /connection stopped/);
  f.reopen(); const state = await f.service.refresh(); assert.equal(state.operations[0].canAcknowledge, true);
  await assert.rejects(f.service.acknowledge({ id: input.requestId, threadId: f.root }), /Confirm/);
  const acknowledged = await f.service.acknowledge({ id: input.requestId, threadId: f.root, confirm: true });
  assert.equal(acknowledged.operations[0].phase, "acknowledged"); assert.equal(acknowledged.needsRefresh, false); assert.equal(acknowledged.changing, false);
  assert.equal(f.imports.length, 1); assert.equal(f.reconciles, 1);
  const other = fixture(); await other.service.start(await other.input()); other.reopen();
  await other.service.workerStopped("unrelated-worker");
  assert.equal(other.service.status().operations[0].canAcknowledge, false);
});

test("busy, shared-profile, stale-file and replaced-thread reviews cannot start imports", async () => {
  const f = fixture(), input = await f.input();
  f.busy = true; await assert.rejects(f.service.start(input), /Wait/); f.busy = false;
  f.revision = "b".repeat(64); await assert.rejects(f.service.start(input), /reviewed import changed/);
  f.revision = "a".repeat(64); f.root = "replacement-thread"; await assert.rejects(f.service.start(input), /current import review/);
  f.root = "root-thread"; await assert.rejects(f.service.start({ ...input, confirm: false }), /confirm/);
  assert.equal(f.imports.length, 0);
  const host = fixture({ mutable: false }); const reviewed = await host.service.list();
  assert.ok(host.calls[0].params.includeHome === false); assert.equal(reviewed.items.length, 1);
  await assert.rejects(host.service.start(await host.input()), /Shared host/); assert.equal(host.imports.length, 0);
});

test("review races and revoked guards fail before dispatch, including a delayed durable save", async () => {
  const f = fixture(); let count = 0;
  f.service.inspect = async () => ++count === 1 ? "a".repeat(64) : "b".repeat(64);
  await assert.rejects(f.service.list(), /changed during review/);
  const g = fixture(), input = await g.input(), saved = defer(); let allowed = true;
  const previousSave = g.service.save;
  g.service.save = async value => { await previousSave(value); await saved.promise; };
  const check = () => { if (!allowed) throw new Error("Chat ownership changed"); };
  const action = g.service.start(input, check);
  while (!g.saved) await new Promise(resolve => setImmediate(resolve));
  allowed = false; saved.resolve();
  await assert.rejects(action, /ownership changed/);
  assert.equal(g.imports.length, 0); assert.equal(g.service.status().operations[0].phase, "cancelled");
});

test("persistence failure cannot issue an untracked native import", async () => {
  const f = fixture(), input = await f.input(); f.failSave = true;
  await assert.rejects(f.service.start(input), error => /tracking could not be saved/.test(error.message) && !/sensitive/.test(error.message));
  assert.equal(f.imports.length, 0); assert.equal(f.service.needsRefresh, true);
  f.failSave = false; await f.service.refresh();
  assert.equal(f.service.needsRefresh, false); assert.equal(f.imports.length, 0);
});

test("source or destination changes during the durable confirmation abort before native import", async () => {
  const f = fixture(), input = await f.input(), previous = f.service.save;
  f.service.save = async value => { await previous(value); f.revision = "b".repeat(64); };
  await assert.rejects(f.service.start(input), /files changed while saving/);
  assert.equal(f.imports.length, 0); assert.equal(f.service.status().operations[0].phase, "cancelled");
});

test("partial failures and unreported selections are distinct; native error secrets never reach saved or public state", async () => {
  const f = fixture(); await f.service.start(await f.input());
  const results = f.results(), failed = results.find(item => item.itemType === "SESSIONS");
  failed.failures = [{ itemType: "SESSIONS", cwd: workspace, source: session.path, failureStage: "convert", message: "Authorization: bearer private-token-do-not-expose", errorType: "secret=config" }]; failed.successes = [];
  // Native can skip a selected group if its target appeared after detection.
  results.splice(results.findIndex(item => item.itemType === "AGENTS_MD" && item.successes[0].cwd === workspace), 1);
  f.complete(results); const status = await f.service.refresh();
  assert.equal(status.operations[0].results.find(item => item.itemType === "AGENTS_MD").notReported, 1);
  assert.equal(status.operations[0].results.find(item => item.itemType === "SESSIONS").failed, 1);
  assert.equal(status.operations[0].sessions.length, 0);
  assert.doesNotMatch(JSON.stringify(f.saved) + JSON.stringify(status), /private-token|Authorization|secret=config/);
});

test("foreign notifications, cross-scope results and mismatched saved bindings cannot authorize imported-session access", async () => {
  const f = fixture(); await f.service.start(await f.input());
  f.notify(f.results(), true, randomUUID()); assert.equal(f.service.status().operations[0].phase, "running");
  const bad = f.results(); bad.find(item => item.itemType === "SESSIONS").successes[0].cwd = "/another-company";
  f.notify(bad, true); assert.equal(f.service.status().operations[0].phase, "uncertain");
  assert.throws(() => f.service.importedSession(f.service.status().operations[0].id, "forged"), /Choose an imported/);
  await f.service.writes;
  assert.throws(() => new CodexImports({ request: async () => {}, inspect: async () => "a".repeat(64), save: async () => {}, reconcile: async () => {}, thread: () => f.root, workspace, home, binding: "another-owner-or-company", workerId: "worker-b", mutable: true, saved: f.saved }), /another scope/);
});

test("reconciliation errors retain recovery flags and do not replay imports", async () => {
  const f = fixture(); await f.service.start(await f.input()); f.complete();
  f.service.reconcile = async () => { throw new Error("Saved configuration cannot be reconciled yet"); };
  await assert.rejects(f.service.refresh(), /cannot be reconciled/);
  assert.equal(f.service.needsRefresh, true); assert.equal(f.service.changing, false);
  f.service.reconcile = async () => { f.reconciles++; };
  const resolved = await f.service.refresh(); assert.equal(resolved.needsRefresh, false); assert.equal(f.imports.length, 1);
});
