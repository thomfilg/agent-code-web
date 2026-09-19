import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import { createAgentWebServer } from "../src/server.mjs";
import { ChatStore } from "../src/store.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

function bundle() {
  const id = randomUUID(), timestamp = new Date().toISOString();
  const data = [{ type: "session_meta", payload: { id, timestamp, history_mode: "legacy" } }, { type: "response_item", payload: { content: "private native reasoning fixture" } }].map(item => JSON.stringify(item) + "\n").join("");
  return { version: 1, threadId: id, files: [{ id, data: Buffer.from(data).toString("base64") }], goal: { threadId: id, objective: "Original goal", status: "active", tokenBudget: 10000, tokensUsed: 0, timeUsedSeconds: 0 } };
}

async function fixture(t) {
  const root = await temporaryDirectory(t), calls = { forks: 0, starts: [], inputs: [], discards: [], stops: [], goalActions: [] };
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000", AGENT_WEB_AUTH_TOKEN: "fork-fixture" }),
    models: { creationSettings: async () => ({ model: "fixture", effort: "high" }), turnSettings: async () => ({ model: "fixture", effort: "high" }) },
    adapterFactory: ({ chat, hooks, restoreFork }) => {
      let finish;
      return {
        start: async () => {
          calls.starts.push({ id: chat.id, restoreFork });
          if (restoreFork) { await hooks.onEvent({ type: "goal", goal: { ...restoreFork.goal, status: "paused" } }); await hooks.onForkRestored(); }
        },
        send: async (text, settings) => {
          calls.inputs.push({ id: chat.id, text, settings });
          await hooks.onInputStarted({ forkGoal: Boolean(settings.goalDirective?.fork) });
          if (calls.hold === chat.id) return new Promise(resolve => { finish = resolve; });
          return { text: "Fixture fork response" };
        },
        forkSession: async () => { calls.forks++; await calls.gate; const result = bundle(); calls.lastBundle = result; return result; },
        discardFork: async id => { calls.discards.push(id); }, releaseFork: () => {},
        compact: async () => ({}),
        goalAction: async action => { calls.goalActions.push(action); },
        stop: async () => { calls.stops.push(chat.id); finish?.({ text: "Main stopped" }); },
      };
    },
  });
  const { url } = await app.start(); t.after(() => app.stop());
  const source = await app.manager.createChat({ agent: "codex", title: "Original conversation" });
  await app.store.update(source.id, { agentSessionId: randomUUID() });
  const headers = { authorization: "Bearer fork-fixture", "content-type": "application/json" };
  const request = (id, tail, method = "GET", input) => fetch(`${url}/api/chats/${id}/${tail}`, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) });
  return { app, source, calls, request, url, root };
}

test("fork API preserves company/settings/files, rebinds attachments, deduplicates and leaves the working source alone", async t => {
  const { app, source, calls, request } = await fixture(t);
  app.manager.environments.runtime = async (id, chat) => { assert.equal(id, "env_fixture"); assert.equal(chat.repositories[0].fullName, "12-apps/future-pay"); return { id, backend: "local", software: [], mcpIds: [], variables: {} }; };
  await app.manager.github.companies.save({ id: "fixture-company", name: "Fixture company" });
  await app.records.put("connection", "github", { id: "github", token: "synthetic-fork-github", revision: 1, companyId: "fixture-company" });
  app.manager.github.fetch = async () => { throw new Error("Unexpected external GitHub request in fork fixture"); };
  await app.store.update(source.id, { environmentId: "env_fixture", environmentName: "Fixture company", repositories: [{ id: 31, githubConnectionId: "github", companyId: "fixture-company", fullName: "12-apps/future-pay", directory: "12-apps--future-pay" }], mode: "auto", serviceTier: "fast", personality: "friendly", pinned: true, customGroupId: "not-inherited" });
  const originalFile = await app.manager.attachments.upload(source.id, { name: "image.png", mime: "image/png", data: Buffer.from("fixture image").toString("base64") });
  await app.store.appendMessage(source.id, { role: "user", text: "Original user message", attachments: [{ ...originalFile, path: "/original-worker/uploads/image.png" }] });
  await app.store.appendMessage(source.id, { role: "user", text: "Never inherit a synthetic sample", meta: { renderingSample: true } });
  await writeFile(path.join(source.workspace, "untracked.txt"), "source work");
  calls.hold = source.id; await app.manager.submit(source.id, "Keep the main turn working");
  await waitFor(() => calls.inputs.length === 1);
  await app.store.update(source.id, { queuedMessages: [{ id: "original-queue", text: "later" }], pendingRequest: { requestId: "original-approval" }, pullRequests: [{ number: 1 }] });
  const before = app.store.get(source.id);
  const input = { requestId: "same-fork-request", title: "New approach" };
  const [a, b] = await Promise.all([request(source.id, "fork", "POST", input), request(source.id, "fork", "POST", input)]);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const { chat } = await a.json(); assert.equal((await b.json()).chat.id, chat.id); assert.equal(calls.forks, 1);
  assert.equal(chat.title, "New approach"); assert.equal(chat.environmentId, before.environmentId); assert.deepEqual(chat.repositories, before.repositories);
  assert.equal(chat.mode, "auto"); assert.equal(chat.serviceTier, "fast"); assert.equal(chat.personality, "friendly");
  assert.equal(chat.pinned, false); assert.equal(chat.customGroupId, null); assert.equal(chat.pendingRequest, null); assert.deepEqual(chat.pullRequests, []); assert.ok(!chat.queuedMessages?.length);
  assert.equal(chat.status, "stopped"); assert.equal(chat.goal.status, "paused"); assert.equal(chat.forkGoalPending, true);
  assert.equal(calls.starts.length, 1); assert.equal(calls.stops.length, 0);
  assert.deepEqual(app.store.get(source.id).messages, before.messages); assert.deepEqual(app.store.get(source.id).queuedMessages, before.queuedMessages); assert.equal(app.store.get(source.id).pendingRequest.requestId, "original-approval");
  assert.equal(app.store.get(source.id).status, "running");
  assert.ok(!chat.messages.some(message => message.meta?.renderingSample));
  const copied = chat.messages[0].attachments[0]; assert.notEqual(copied.id, originalFile.id); assert.equal(copied.chatId, chat.id); assert.equal(copied.path, undefined);
  assert.equal(Buffer.from((await (await request(chat.id, `attachments/${copied.id}`)).json()).attachment.data, "base64").toString(), "fixture image");
  assert.equal((await request(source.id, `attachments/${copied.id}`)).status, 400);
  assert.equal(await readFile(path.join(chat.workspace, "untracked.txt"), "utf8"), "source work");
  await writeFile(path.join(chat.workspace, "untracked.txt"), "fork edit"); assert.equal(await readFile(path.join(source.workspace, "untracked.txt"), "utf8"), "source work");
  const saved = await app.records.get("native-fork", chat.id); assert.equal(saved.initialized, false); assert.equal(saved.bundle.threadId, chat.agentSessionId);
  assert.doesNotMatch(JSON.stringify(chat), /private native reasoning|"bundle"|"data"/);
  assert.equal((await (await request(source.id, "fork", "POST", input)).json()).chat.id, chat.id); assert.equal(calls.forks, 1);
  await app.manager.remove(source.id);
  assert.equal(Buffer.from((await (await request(chat.id, `attachments/${copied.id}`)).json()).attachment.data, "base64").toString(), "fixture image");
  assert.ok(await app.records.get("native-fork", chat.id));
});

test("fork initialization survives controller reload; only an explicit main input consumes deferred context and goal", async t => {
  const { app, source, calls, request, root } = await fixture(t);
  const file = await app.manager.attachments.upload(source.id, { name: "notes.txt", mime: "text/plain", data: Buffer.from("historical attachment").toString("base64") });
  await app.store.appendMessage(source.id, { role: "user", text: "Read notes", attachments: [{ ...file, path: "/old/uploads/notes.txt" }] });
  const { chat } = await (await request(source.id, "fork", "POST", { requestId: "deferred-fork" })).json();
  const reloaded = new ChatStore(path.join(root, "reloaded-controller"), app.records); await reloaded.initialize();
  assert.equal(reloaded.get(chat.id).nativeForkSessionId, chat.agentSessionId); assert.equal(reloaded.get(chat.id).forkGoalPending, true);
  await app.manager.compact(chat.id);
  assert.equal(app.store.get(chat.id).forkGoalPending, true); assert.equal(app.store.get(chat.id).forkContextPending, true);
  assert.equal((await app.records.get("native-fork", chat.id)).initialized, true);
  assert.equal(calls.inputs.length, 0);
  await app.manager.stop(chat.id, "idle-timeout");
  await app.manager.send(chat.id, "Continue here");
  const input = calls.inputs.find(entry => entry.id === chat.id);
  assert.deepEqual(input.settings.goalDirective, { action: "resume", fork: true });
  assert.match(input.text, /independent workspace/); assert.match(input.text, /old\/uploads\/notes/); assert.ok(input.text.includes(app.store.runtimeHome(chat.id)));
  assert.equal(app.store.get(chat.id).forkGoalPending, false); assert.equal(app.store.get(chat.id).forkContextPending, false);
  assert.deepEqual(calls.starts.filter(entry => entry.id === chat.id).map(entry => Boolean(entry.restoreFork)), [true, false]);
  await app.manager.send(chat.id, "Next message"); assert.equal(calls.inputs.at(-1).settings.goalDirective, undefined); assert.doesNotMatch(calls.inputs.at(-1).text, /independent workspace/);
  await app.manager.remove(chat.id); assert.equal(await app.records.get("native-fork", chat.id), null); assert.equal((await app.records.list("attachment")).length, 1);
});

test("Stop cancels an unpublished fork and cleans its own history, files and attachments", async t => {
  const { app, source, calls } = await fixture(t), gate = Promise.withResolvers(); calls.gate = gate.promise;
  const pending = app.manager.forkChat(source.id, { requestId: "cancel-fork" }); const rejected = assert.rejects(pending, /cancelled/);
  await waitFor(() => calls.forks === 1);
  assert.equal(app.store.list().length, 1);
  await app.manager.stop(source.id);
  gate.resolve(); await rejected;
  assert.deepEqual(await readdir(app.store.chatsDir), [source.id]);
  assert.deepEqual(await app.records.list("native-fork"), []); assert.equal(calls.discards.length, 1);
});

test("unsafe workspace failures are visible and a retry does not publish a partial fork", async t => {
  const { app, source, calls, root } = await fixture(t);
  await symlink(root, path.join(source.workspace, "outside-link"));
  await assert.rejects(app.manager.forkChat(source.id, { requestId: "unsafe-fork" }), /links must stay inside/);
  assert.equal(app.store.list().length, 1); assert.equal(calls.discards.length, 1);
  assert.deepEqual(await readdir(app.store.chatsDir), [source.id]); assert.deepEqual(await app.records.list("native-fork"), []);
});

test("fork endpoints enforce authentication, origin, ownership and request identity before native operations", async t => {
  const { app, source, calls, request, url } = await fixture(t);
  const route = `${url}/api/chats/${source.id}/fork`;
  assert.equal((await fetch(route, { method: "POST" })).status, 401);
  assert.equal((await fetch(route, { method: "POST", headers: { authorization: "Bearer fork-fixture", origin: "https://evil.example" } })).status, 403);
  assert.equal((await request(source.id, "fork", "POST", {})).status, 400);
  await app.store.update(source.id, { ownerId: "another-user" });
  assert.equal((await request(source.id, "fork", "POST", { requestId: "private-fork" })).status, 404);
  assert.equal(calls.forks, 0);
});

test("manual goal pause and manual Stop cancel deferred goal continuation", async t => {
  const { app, source, calls } = await fixture(t);
  const first = await app.manager.forkChat(source.id, { requestId: "pause-fork" });
  await app.manager.goalAction(first.id, "pause"); await app.manager.send(first.id, "Ordinary input");
  assert.equal(calls.inputs.at(-1).settings.goalDirective, undefined);
  const second = await app.manager.forkChat(source.id, { requestId: "stop-fork" });
  await app.manager.stop(second.id); await app.manager.send(second.id, "Do not restart the inherited goal");
  assert.equal(calls.inputs.at(-1).settings.goalDirective, undefined);
});

test("fork cannot race a source submission into starting a second native worker", async t => {
  const { app, source, calls } = await fixture(t), gate = Promise.withResolvers();
  const resolve = app.manager.attachments.resolve.bind(app.manager.attachments);
  app.manager.attachments.resolve = async (...args) => { await gate.promise; return resolve(...args); };
  const sending = app.manager.submit(source.id, "Start the first worker");
  assert.throws(() => app.manager.forkChat(source.id, { requestId: "startup-race" }), /worker change/);
  gate.resolve(); await (await sending).completion;
  assert.equal(calls.starts.length, 1); assert.equal(calls.forks, 0);
});

test("forking a fresh chat copies its workspace without a native turn or a fabricated message", async t => {
  const { app, calls } = await fixture(t);
  const empty = await app.manager.createChat({ agent: "codex", title: "Empty conversation" });
  await writeFile(path.join(empty.workspace, "draft.txt"), "not sent to any agent");
  const copy = await app.manager.forkChat(empty.id, { requestId: "empty-fork" });
  assert.equal(calls.starts.length, 0); assert.equal(calls.forks, 0); assert.deepEqual(copy.messages, []); assert.equal(copy.nativeForkSessionId, null);
  assert.equal(await readFile(path.join(copy.workspace, "draft.txt"), "utf8"), "not sent to any agent");
  await app.manager.send(copy.id, "First actual user input"); assert.equal(calls.inputs.length, 1); assert.match(calls.inputs[0].text, /independent workspace/);
});

test("Plan keeps the inherited goal paused until a later non-Plan input", async t => {
  const { app, source, calls } = await fixture(t);
  await app.store.update(source.id, { mode: "plan" });
  const copy = await app.manager.forkChat(source.id, { requestId: "plan-fork" });
  await app.manager.send(copy.id, "Plan only");
  assert.equal(calls.inputs.at(-1).settings.goalDirective, undefined); assert.equal(app.store.get(copy.id).forkGoalPending, true);
  await app.manager.setMode(copy.id, "auto"); await app.manager.send(copy.id, "Continue the goal");
  assert.deepEqual(calls.inputs.at(-1).settings.goalDirective, { action: "resume", fork: true }); assert.equal(app.store.get(copy.id).forkGoalPending, false);
});

test("switching a fork to a different agent clears native-only restore and goal state", async t => {
  const { app, source, calls } = await fixture(t);
  const copy = await app.manager.forkChat(source.id, { requestId: "switch-fork" });
  await app.manager.switchAgent(copy.id, "claude");
  const switched = app.store.get(copy.id);
  assert.equal(switched.nativeForkSessionId, null); assert.equal(switched.forkGoalPending, false); assert.equal(switched.goal, null);
  await app.manager.send(copy.id, "Continue with Claude");
  assert.equal(calls.starts.at(-1).restoreFork, null); assert.equal(calls.inputs.at(-1).settings.goalDirective, undefined);
  assert.equal(app.store.get(copy.id).forkedFromChatId, source.id);
});
