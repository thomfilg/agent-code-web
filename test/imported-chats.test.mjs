import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, symlink, readdir } from "node:fs/promises";
import { importedTranscript, copyImportedImages, importedHistoryWarnings } from "../src/codex-import-chat.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5j8AAAAASUVORK5CYII=";
const thread = () => ({ createdAt: 1789574400, turns: [{ id: "turn", items: [
  { id: "user", type: "userMessage", content: [{ type: "text", text: "Original user text" }, { type: "image", url: `data:image/png;base64,${png}` }] },
  { type: "reasoning", text: "Never render private reasoning" },
  { id: "command", type: "commandExecution", command: "printf fixture", aggregatedOutput: "fixture", status: "completed", exitCode: 0 },
  { id: "assistant", type: "agentMessage", text: "Original assistant reply" },
] }] });
const nativeBundle = () => {
  const id = randomUUID(), data = JSON.stringify({ type: "session_meta", payload: { id, timestamp: new Date().toISOString(), history_mode: "legacy" } }) + "\n";
  return { version: 1, threadId: id, goal: null, files: [{ id, data: Buffer.from(data).toString("base64") }] };
};

test("imported display history preserves visible order and images without publishing private native reasoning", () => {
  const messages = importedTranscript(thread()); assert.deepEqual(messages.map(item => item.role), ["user", "tool", "assistant"]);
  assert.equal(messages[0].text, "Original user text"); assert.equal(messages[0].attachments[0].url, `data:image/png;base64,${png}`);
  assert.equal(messages[1].meta.output, "fixture"); assert.equal(messages[2].text, "Original assistant reply");
  assert.doesNotMatch(JSON.stringify(messages), /private reasoning/); assert.equal(new Set(messages.map(item => item.id)).size, 3);
  assert.deepEqual(importedHistoryWarnings(messages), []);
  const nativeMarker = thread(); nativeMarker.turns[0].items[0].content = [{ type: "text", text: "Original text\n\n[external unsupported block: image]" }];
  const marked = importedTranscript(nativeMarker); assert.match(marked[0].text, /\[external unsupported block: image\]/);
  assert.match(importedHistoryWarnings(marked)[0], /replaced unsupported source content/);
  assert.throws(() => importedTranscript({ turns: [{}] }), /incomplete/);
  const unsupported = thread(); unsupported.turns[0].items[0].content = [{ type: "unknown" }]; assert.throws(() => importedTranscript(unsupported), /unsupported/);
});

test("import images copy inline/workspace bytes only; external URLs, outside paths and linked parents stay inert", async t => {
  const root = await temporaryDirectory(t), workspace = path.join(root, "copy"); await mkdir(path.join(workspace, "images"), { recursive: true });
  await writeFile(path.join(workspace, "images", "sample.png"), Buffer.from(png, "base64")); await symlink(root, path.join(workspace, "linked"));
  const messages = [{ role: "user", text: "Keep text", attachments: [
    { url: `data:image/png;base64,${png}` }, { path: "/original/project/images/sample.png" }, { url: "https://private.invalid/image.png" },
    { path: "/other-company/private.png" }, { path: "/original/project/../private.png" }, { path: "/original/project/linked/private.png" },
  ] }];
  const copied = await copyImportedImages(messages, "/original/project", workspace);
  assert.equal(copied.messages[0].attachments[0].data, png); assert.equal(copied.messages[0].attachments[1].data, png); assert.equal(copied.unavailable, 4);
  assert.ok(copied.messages[0].attachments.slice(2).every(item => item.copied && !item.path && !item.url)); assert.equal(messages[0].attachments[0].data, undefined);
  await assert.rejects(copyImportedImages(messages, "/original/project", workspace, () => { throw new Error("Access revoked"); }), /revoked/);
});

async function fixture(t) {
  const root = await temporaryDirectory(t), calls = { forks: 0, releases: [], discards: [], starts: [], inputs: [], gate: null }, operationId = randomUUID(), sessionId = "a".repeat(64), rootThreadId = randomUUID();
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "import-open", AGENT_IDLE_TIMEOUT_MS: "60000" }),
    models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, hooks, restoreFork }) => ({
      threadId: chat.agentSessionId || rootThreadId,
      importControls: { changing: false, needsRefresh: false, importedSession: (operation, session, check) => { check(); if (operation !== operationId || session !== sessionId) throw Object.assign(new Error("Choose recorded imported history"), { statusCode: 409 }); return { title: "Imported source conversation", source: "claude-code" }; } },
      start: async () => { calls.starts.push({ chatId: chat.id, restoreFork }); await hooks.onSessionId(chat.agentSessionId || rootThreadId); if (restoreFork) await hooks.onForkRestored(); },
      stop: async () => {},
      forkImportedSession: async (operation, session, check) => { calls.forks++; await calls.gate; check(); return { bundle: nativeBundle(), title: "Imported source conversation", source: "claude-code", messages: importedTranscript(thread()) }; },
      releaseFork: id => calls.releases.push(id), discardFork: async id => calls.discards.push(id),
      send: async text => { calls.inputs.push({ chatId: chat.id, text }); await hooks.onInputStarted({ forkGoal: false }); return { text: "Continued imported fixture" }; },
    }) });
  const { url } = await app.start(); t.after(() => app.stop()); const source = await app.manager.createChat({ agent: "codex", title: "Import destination" });
  await app.store.update(source.id, { agentSessionId: rootThreadId, repositories: [{ owner: "12-apps", name: "future-pay", fullName: "12-apps/future-pay" }] });
  await writeFile(path.join(source.workspace, "project.txt"), "original workspace");
  const input = { operationId, sessionId, threadId: rootThreadId, confirm: true };
  const request = (data = input) => fetch(`${url}/api/chats/${source.id}/imports/open`, { method: "POST", headers: { authorization: "Bearer import-open", "content-type": "application/json" }, body: JSON.stringify(data) });
  return { root, app, source, calls, request, input, url };
}

test("opening imported history creates one independent stopped chat, copies attachments and resumes its native bundle only on input", async t => {
  const f = await fixture(t), original = f.app.store.get(f.source.id), response = await f.request();
  assert.equal(response.status, 200, await response.clone().text()); const { chat } = await response.json();
  assert.notEqual(chat.id, f.source.id); assert.equal(chat.status, "stopped"); assert.equal(chat.title, "Imported source conversation"); assert.deepEqual(chat.repositories, original.repositories);
  assert.deepEqual(chat.messages.map(item => item.role), ["user", "tool", "assistant"]); assert.equal(chat.messages[0].text, "Original user text");
  assert.equal(chat.messages[0].attachments[0].chatId, chat.id); assert.doesNotMatch(JSON.stringify(chat), /data:image|private reasoning|"bundle"/);
  assert.equal((await f.app.records.get("attachment", chat.messages[0].attachments[0].id)).data, png);
  assert.equal(await readFile(path.join(chat.workspace, "project.txt"), "utf8"), "original workspace");
  await writeFile(path.join(chat.workspace, "project.txt"), "independent edit"); assert.equal(await readFile(path.join(f.source.workspace, "project.txt"), "utf8"), "original workspace");
  assert.deepEqual(f.app.store.get(f.source.id).messages, []); assert.deepEqual(f.calls.inputs, []); assert.equal(f.calls.starts.length, 1);
  const saved = await f.app.records.get("native-fork", chat.id); assert.equal(saved.bundle.threadId, chat.agentSessionId); assert.equal(saved.initialized, false);
  assert.equal((await (await f.request()).json()).chat.id, chat.id); assert.equal(f.calls.forks, 1);
  await f.app.manager.remove(f.source.id); assert.ok(await f.app.records.get("native-fork", chat.id));
  await f.app.manager.send(chat.id, "Continue this conversation");
  assert.equal(f.calls.starts.at(-1).restoreFork.threadId, chat.agentSessionId); assert.match(f.calls.inputs[0].text, /Continue this conversation/); assert.equal(f.calls.inputs[0].chatId, chat.id);
  assert.equal((await f.app.records.get("native-fork", chat.id)).initialized, true);
});

test("import opening requires confirmation, authenticated ownership and a recorded opaque session choice", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/api/chats/${f.source.id}/imports/open`, { method: "POST" })).status, 401);
  for (const input of [{ ...f.input, confirm: false }, { ...f.input, threadId: "other" }, { ...f.input, sessionId: "b".repeat(64) }, { ...f.input, operationId: randomUUID() }]) assert.equal((await f.request(input)).status, 409);
  assert.equal(f.calls.forks, 0); await f.app.store.update(f.source.id, { ownerId: "someone-else" }); assert.equal((await f.request()).status, 404);
});

test("Stop or ownership changes during imported-chat creation cannot publish a late chat", async t => {
  for (const reason of ["stop", "owner", "company"]) {
    const f = await fixture(t), gate = Promise.withResolvers(); f.calls.gate = gate.promise;
    const pending = f.request(); await waitFor(() => f.calls.forks === 1);
    if (reason === "stop") await f.app.manager.stop(f.source.id);
    else if (reason === "owner") await f.app.store.update(f.source.id, { ownerId: "other" });
    else await f.app.store.update(f.source.id, { repositories: [{ fullName: "g2i/other" }] });
    gate.resolve(); assert.equal((await pending).status, reason === "owner" ? 404 : 409);
    assert.equal(f.app.store.list().length, 1); assert.deepEqual(await f.app.records.list("native-fork"), []); assert.deepEqual(await f.app.records.list("attachment"), []);
  }
});

test("a failed imported workspace copy publishes nothing and discards only its new native fork", async t => {
  const f = await fixture(t); await symlink(f.root, path.join(f.source.workspace, "outside-link"));
  const response = await f.request(); assert.equal(response.status, 400); assert.match((await response.json()).error, /links must stay inside/);
  assert.equal(f.calls.discards.length, 1); assert.deepEqual(f.calls.releases, []); assert.equal(f.app.store.list().length, 1);
  assert.deepEqual(await readdir(f.app.store.chatsDir), [f.source.id]); assert.deepEqual(await f.app.records.list("native-fork"), []);
});
