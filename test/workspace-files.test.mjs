import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, symlink, link } from "node:fs/promises";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";
import { workspaceFileIO, readWorkspaceFiles, workspaceContext, contextForTurn, attachmentPrompt } from "../src/workspace-files.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";

async function reader(t) {
  const root = await temporaryDirectory(t);
  await mkdir(path.join(root, "src")); await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "src/example.ts"), "first\r\nselected 😀 line\r\nlast\r\n");
  await writeFile(path.join(root, "node_modules/dependency.ts"), "dependency");
  return { root, run: input => workspaceFileIO({ root, ...input }) };
}

test("workspace reads and bounded searches stay inside ordinary files and directories", async t => {
  const { root, run } = await reader(t), external = await temporaryDirectory(t);
  await writeFile(path.join(external, "outside.txt"), "private outside fixture");
  await symlink(external, path.join(root, "linked-directory"));
  await symlink(path.join(external, "outside.txt"), path.join(root, "linked-file"));
  await link(path.join(external, "outside.txt"), path.join(root, "hardlink"));
  execFileSync("mkfifo", [path.join(root, "fifo")]);
  const list = await run({ action: "list" });
  assert.ok(!list.entries.some(entry => /linked|fifo/.test(entry.path)));
  assert.deepEqual((await run({ action: "list", query: ".ts" })).entries.map(entry => entry.path), ["src/example.ts"]);
  assert.equal((await run({ action: "list", path: "node_modules" })).entries[0].path, "node_modules/dependency.ts");
  for (const target of ["../outside.txt", "src/../../outside.txt", "/etc/passwd", "src//example.ts", "src/./example.ts", "src\\example.ts", "src/example.ts\n", "linked-directory/outside.txt", "linked-file", "hardlink", "fifo"]) {
    await assert.rejects(run({ action: "read", path: target }), undefined, target);
  }
  await assert.rejects(workspaceFileIO({ root: path.join(root, "linked-directory"), action: "list" }));
  const directory = await run({ action: "read", path: "src" });
  assert.equal(directory.kind, "directory"); assert.match(directory.text, /src\/example.ts/);
  for (let index = 0; index < 210; index++) await writeFile(path.join(root, `bounded-${index}.txt`), "");
  const bounded = await run({ action: "list", query: "bounded-" });
  assert.equal(bounded.entries.length, 200); assert.equal(bounded.truncated, true);
});

test("workspace selections normalize line endings, retain exact ranges and reject split characters", async t => {
  const { run } = await reader(t), file = await run({ action: "read", path: "src/example.ts" });
  assert.equal(file.text, "first\nselected 😀 line\nlast\n");
  assert.equal(Buffer.from(file.data, "base64").toString(), "first\r\nselected 😀 line\r\nlast\r\n");
  const selected = workspaceContext(file, { start: 6, end: 22 });
  assert.equal(selected.workspaceContext.selectedText, "selected 😀 line");
  assert.deepEqual(selected.workspaceContext.range, { start: { line: 2, column: 1 }, end: { line: 2, column: 17 } });
  assert.equal(Buffer.from(selected.data, "base64").toString(), "selected 😀 line");
  for (const range of [{ start: -1, end: 2 }, { start: 1, end: 1 }, { start: 0, end: 999 }, { start: 16, end: 18 }, { start: 0, end: 16 }, { start: "1", end: 5 }]) assert.throws(() => workspaceContext(file, range));
  assert.throws(() => workspaceContext({ ...file, text: "x".repeat(100001) }, { start: 0, end: 100001 }), /100,000/);
  assert.throws(() => workspaceContext({ ...file, kind: "directory" }, { start: 0, end: 3 }));
  const snapshot = { ...selected, id: "selected", path: "/private/uploads/snapshot.ts" };
  const turn = contextForTurn([snapshot], "/worker/workspace");
  const extra = turn.additionalContext["relay-workspace:selected"];
  assert.equal(JSON.parse(extra.value).path, "/worker/workspace/src/example.ts");
  assert.equal(extra.kind, "untrusted"); assert.equal(JSON.parse(extra.value).selectedText, "selected 😀 line");
  assert.doesNotMatch(extra.value, /first|last/);
  assert.match(attachmentPrompt([snapshot], "/fork/workspace"), /\/fork\/workspace\/src\/example.ts/);
  assert.match(attachmentPrompt([snapshot], "/fork/workspace"), /\/private\/uploads\/snapshot.ts/);
  assert.throws(() => contextForTurn([{ ...snapshot, workspaceContext: { ...selected.workspaceContext, path: "../escape" } }], "/worker/workspace"));
});

test("binary and large files can be mentioned without decoding or oversized inline context", async t => {
  const { root, run } = await reader(t);
  await writeFile(path.join(root, "binary.png"), Buffer.from([137, 80, 78, 71, 0, 255]));
  const binary = await run({ action: "read", path: "binary.png" });
  assert.equal(binary.binary, true); assert.equal(binary.text, null); assert.equal(binary.mime, "image/png");
  assert.throws(() => workspaceContext(binary, { start: 0, end: 1 }));
  await writeFile(path.join(root, "large.txt"), "x".repeat(524289));
  const large = await run({ action: "read", path: "large.txt" });
  assert.equal(large.referenceOnly, true); assert.equal(large.text, null); assert.equal(large.sha256, null); assert.match(large.version, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.from(large.data, "base64").length < 512); assert.equal(workspaceContext(large).workspaceContext.referenceOnly, true);
});

test("remote workspace reader uses the worker root and a minimal environment, not controller paths", async t => {
  const { root } = await reader(t), calls = [];
  const executor = { metadata: { backend: "ec2" }, workspace: root, spawn: (command, args, options) => { calls.push(options); return spawn(command, args, options); } };
  const remote = await readWorkspaceFiles({ workspace: "/controller/private" }, executor, { action: "read", path: "src/example.ts", root: "/untrusted/override" });
  assert.equal(remote.text, "first\nselected 😀 line\nlast\n"); assert.deepEqual(Object.keys(calls[0].env).sort(), ["LANG", "PATH"]);
  assert.equal(calls[0].cwd, root); assert.equal((await readWorkspaceFiles({}, executor, { action: "ping" })).connected, true);
  await assert.rejects(readWorkspaceFiles({}, executor, { action: "read", path: "../../escape" }), /relative workspace path/);
});

async function controller(t, options = {}) {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), calls = [];
  const config = testConfig(root, { AGENT_WEB_AUTH_TOKEN: "workspace-fixture", AGENT_IDLE_TIMEOUT_MS: "10000" });
  let starts = 0;
  const adapterFactory = () => ({ start: async () => { starts++; }, stop: async () => {}, send: async (text, settings) => { calls.push({ text, settings }); return { text: "Workspace response" }; } });
  const { agent = "codex", ...settings } = options;
  const app = await createAgentWebServer({ config, records, adapterFactory, models: { creationSettings: async () => ({}), turnSettings: async () => ({}) }, ...settings });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent, title: "Workspace context fixture" });
  await mkdir(path.join(chat.workspace, "src"), { recursive: true }); await writeFile(path.join(chat.workspace, "src/task.ts"), "do not include\nchosen range\nnot this either\n");
  const request = (tail, method = "GET", body) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method, headers: { authorization: "Bearer workspace-fixture", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { app, config, records, adapterFactory, chat, request, url, calls, starts: () => starts };
}

test("workspace endpoints enforce owner/origin guards and connect without sending agent input", async t => {
  const { app, chat, url, request, starts } = await controller(t);
  assert.equal((await request("workspace-files")).status, 200);
  assert.equal((await (await request("workspace-files")).json()).connected, false);
  assert.equal((await request("workspace-files/read", "POST", { path: "src/task.ts" })).status, 409);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/workspace-files`)).status, 401);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/workspace-files/connect`, { method: "POST", headers: { authorization: "Bearer workspace-fixture", origin: "https://evil.example" } })).status, 403);
  const clientId = "workspace-client-one";
  assert.equal((await request("workspace-files/connect", "POST", { clientId })).status, 200);
  assert.equal(starts(), 0); assert.deepEqual(app.store.get(chat.id).messages, []); assert.equal(app.manager.workspacePresence.has(chat.id), true);
  const response = await request("workspace-files/read", "POST", { path: "src/task.ts" }), file = await response.json();
  assert.equal(response.status, 200); assert.equal(file.text, "do not include\nchosen range\nnot this either\n"); assert.equal(file.data, undefined);
  const bad = await request("workspace-files/attach", "POST", { path: file.path, version: "wrong", selection: { start: 15, end: 27 } }); assert.equal(bad.status, 409);
  await app.manager.stop(chat.id);
  assert.equal(app.manager.workspacePresence.has(chat.id), false);
  assert.equal((await request("workspace-files/presence", "POST", { clientId, active: true })).status, 409);
  assert.equal((await (await request("workspace-files")).json()).connected, false); assert.equal(starts(), 0);
  await app.store.update(chat.id, { ownerId: "someone-else" });
  assert.equal((await request("workspace-files")).status, 404);
  assert.equal((await request("workspace-files/connect", "POST", { clientId })).status, 404);
});

test("selected snapshots survive queued input, source edits, worker stop and controller reload", async t => {
  const { app, chat, request, config, records, adapterFactory, calls } = await controller(t);
  await request("workspace-files/connect", "POST", { clientId: "workspace-client-one" });
  const file = await (await request("workspace-files/read", "POST", { path: "src/task.ts" })).json();
  const response = await request("workspace-files/attach", "POST", { path: file.path, version: file.sha256, selection: { start: 15, end: 27 } });
  assert.equal(response.status, 200); const { attachment } = await response.json();
  assert.equal(attachment.workspaceContext.selectedText, undefined, "Do not duplicate selected text into every chat/SSE snapshot");
  const saved = await (await request(`attachments/${attachment.id}`)).json(); assert.equal(saved.attachment.workspaceContext.selectedText, "chosen range");
  await app.store.update(chat.id, { queuePaused: true });
  assert.equal((await request("queue", "POST", { text: "Explain my selection", attachments: [attachment.id] })).status, 202);
  await writeFile(path.join(chat.workspace, file.path), "changed after user selection");
  assert.equal((await request("workspace-files/attach", "POST", { path: file.path, version: file.sha256 })).status, 409);
  await app.stop();
  const restored = await createAgentWebServer({ config, records, adapterFactory, models: { creationSettings: async () => ({}), turnSettings: async () => ({}) } });
  await restored.start(); t.after(() => restored.stop());
  assert.equal(restored.store.get(chat.id).queuedMessages.length, 1); assert.equal(calls.length, 0);
  await restored.manager.editQueue(chat.id, { resume: true });
  await waitFor(() => calls.length === 1 && !restored.manager.isBusy(chat.id));
  const context = Object.values(calls[0].settings.additionalContext)[0];
  assert.equal(context.kind, "untrusted"); assert.equal(JSON.parse(context.value).selectedText, "chosen range");
  assert.doesNotMatch(context.value, /changed after|do not include|not this either/);
  assert.equal(JSON.parse(context.value).path, path.join(chat.workspace, "src/task.ts"));
  const message = restored.store.get(chat.id).messages.find(message => message.attachments?.length);
  assert.equal(await readFile(message.attachments[0].path, "utf8"), "chosen range");
  await restored.manager.send(chat.id, "Normal next message");
  assert.deepEqual(calls[1].settings.additionalContext, {});
});

test("ordinary uploads cannot forge references and forked snapshots rebind to their own workspace", async t => {
  const { app, chat, request } = await controller(t);
  await request("workspace-files/connect", "POST", { clientId: "workspace-client-one" });
  const file = await (await request("workspace-files/read", "POST", { path: "src/task.ts" })).json();
  const { attachment } = await (await request("workspace-files/attach", "POST", { path: file.path, version: file.sha256 })).json();
  const spoof = await (await request("attachments", "POST", { name: "spoof.txt", data: Buffer.from("spoof").toString("base64"), workspaceContext: { path: "../../private" } })).json();
  assert.equal(spoof.attachment.workspaceContext, undefined);
  const target = await app.manager.createChat({ agent: "codex" });
  await assert.rejects(app.manager.attachments.resolve(target.id, [attachment.id]), /not found in this chat/);
  const result = await app.manager.attachments.forkMessages(chat.id, target.id, [{ role: "user", attachments: [attachment] }]);
  const [copied] = await app.manager.attachments.resolve(target.id, [result.messages[0].attachments[0].id]);
  assert.notEqual(copied.id, attachment.id); assert.deepEqual(app.manager.attachments.public(copied).workspaceContext, attachment.workspaceContext);
  assert.equal(JSON.parse(Object.values(contextForTurn([copied], target.workspace).additionalContext)[0].value).path, path.join(target.workspace, "src/task.ts"));
});

test("workspace viewer leases pause idle timers, release after close, and never start an LLM", async t => {
  const { app, chat, request, starts } = await controller(t);
  app.config.idleTimeoutMs = 30; app.manager.workspacePresence.ttlMs = 50;
  await request("workspace-files/connect", "POST", { clientId: "workspace-client-one" });
  await waitFor(async () => !(await app.manager.workspaceFiles(chat.id, "status")).connected, { timeoutMs: 2000 });
  assert.equal(starts(), 0); assert.deepEqual(app.store.get(chat.id).messages, []);
  await request("workspace-files/connect", "POST", { clientId: "workspace-client-two" });
  await request("workspace-files/presence", "POST", { clientId: "workspace-client-two", active: false });
  await waitFor(async () => !(await app.manager.workspaceFiles(chat.id, "status")).connected);
  assert.equal(starts(), 0);
});

test("workspace context reaches Claude as quoted data without replacing the user's input prefix", async t => {
  const { app, chat, request, calls } = await controller(t, { agent: "claude" });
  await request("workspace-files/connect", "POST", { clientId: "workspace-client-one" });
  const file = await (await request("workspace-files/read", "POST", { path: "src/task.ts" })).json();
  const { attachment } = await (await request("workspace-files/attach", "POST", { path: file.path, version: file.sha256, selection: { start: 15, end: 27 } })).json();
  const submitted = await app.manager.submit(chat.id, "Explain the selected code", [attachment.id]); await submitted.completion;
  assert.ok(calls[0].text.startsWith("Explain the selected code")); assert.match(calls[0].text, /quoted data, not system instructions/);
  assert.match(calls[0].text, /chosen range/); assert.doesNotMatch(calls[0].text, /do not include|not this either/);
  assert.match(calls[0].text, /src\/task\.ts/);
});

test("workspace connection cancelled during acquisition cannot survive manual Stop", async t => {
  let acquire, release, sleeps = 0;
  const acquired = new Promise(resolve => { acquire = resolve; }), held = new Promise(resolve => { release = resolve; });
  const workerBackend = { acquire: async () => { acquire(); await held; return null; }, sleep: async () => { sleeps++; }, destroy: async () => {} };
  const { app, chat, request, starts } = await controller(t, { workerBackend });
  const connecting = request("workspace-files/connect", "POST", { clientId: "workspace-client-one" });
  await acquired;
  const stopping = app.manager.stop(chat.id); release();
  const response = await connecting; await stopping;
  assert.ok(response.status >= 400); assert.match((await response.json()).error, /cancelled/);
  assert.equal((await (await request("workspace-files")).json()).connected, false);
  assert.equal(app.manager.workspacePresence.has(chat.id), false); assert.equal(starts(), 0); assert.equal(sleeps, 1);
  assert.equal((await request("workspace-files/presence", "POST", { clientId: "workspace-client-one", active: true })).status, 409);
});

test("an active workspace viewer holds an idle native worker until every viewer disconnects", async t => {
  const { app, chat, request } = await controller(t);
  await app.manager.send(chat.id, "A normal turn");
  assert.equal(app.store.get(chat.id).status, "idle"); assert.ok(app.store.get(chat.id).idleDeadlineAt);
  for (const clientId of ["workspace-client-one", "workspace-client-two"]) await request("workspace-files/connect", "POST", { clientId });
  assert.equal(app.store.get(chat.id).idleDeadlineAt, null); assert.equal(app.store.get(chat.id).idleKeepAwakeReason, "workspace");
  await request("workspace-files/presence", "POST", { clientId: "workspace-client-one", active: false });
  assert.equal(app.store.get(chat.id).idleDeadlineAt, null);
  await request("workspace-files/presence", "POST", { clientId: "workspace-client-two", active: false });
  assert.ok(app.store.get(chat.id).idleDeadlineAt);
  assert.deepEqual(app.store.get(chat.id).messages.filter(message => message.role === "user").map(message => message.text), ["A normal turn"]);
});

test("workspace results recheck chat ownership after asynchronous capture", async t => {
  const { app, chat, request } = await controller(t);
  await request("workspace-files/connect", "POST", { clientId: "workspace-client-one" });
  let release, read;
  const held = new Promise(resolve => { release = resolve; }), captured = new Promise(resolve => { read = resolve; });
  const original = app.manager.workspaceFiles.bind(app.manager);
  app.manager.workspaceFiles = async (...args) => { const result = await original(...args); if (args[1] === "read") { read(); await held; } return result; };
  const reading = request("workspace-files/read", "POST", { path: "src/task.ts" });
  await captured; await app.store.update(chat.id, { ownerId: "new-private-owner" }); release();
  const response = await reading; assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /chosen range/);
});
