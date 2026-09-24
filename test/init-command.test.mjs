import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createAgentWebServer } from "../src/server.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function fixture(t) {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000", AGENT_WEB_AUTH_TOKEN: "init-fixture" });
  const models = new ModelCatalog(config); models.codex = async () => ({ models: [{ id: "gpt-5.6-sol", efforts: ["high"], defaultEffort: "high" }] });
  const calls = { starts: 0, inputs: [], stops: 0 };
  const app = await createAgentWebServer({ config, records, models, commands: { list: async () => ({ commands: [] }) }, adapterFactory: ({ chat, hooks }) => ({
    start: async () => { calls.starts++; await hooks.onSessionId(`init-${chat.id}`); },
    send: async (text, options) => { calls.inputs.push({ chatId: chat.id, text, options }); await calls.gate?.promise; if (calls.error) throw Error(calls.error); return { text: "Fixture task completed; no document-quality claim." }; },
    stop: async () => { calls.stops++; calls.gate?.resolve(); },
  }) });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "codex", title: "Init dispatch" });
  const request = (tail, body, headers = {}) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method: "POST", headers: { authorization: "Bearer init-fixture", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { root, app, records, chat, calls, request };
}

test("/init preserves multiline user instructions, requests repository evidence, and leaves Claude native input alone", () => {
  const bare = messageCommand("codex", "/init"); assert.equal(bare.type, "init"); assert.match(bare.prompt, /AGENTS\.md/);
  assert.match(bare.prompt, /Preserve existing instructions and user edits/); assert.match(bare.prompt, /actually verify/); assert.match(bare.prompt, /Do not overwrite unrelated files/);
  const additional = "Keep our release rules.\nUse npm test; não inventar scripts.";
  assert.equal(messageCommand("codex", `/init ${additional}`).prompt, `${bare.prompt}\n\nAdditional instructions:\n${additional}`);
  assert.equal(messageCommand("codex", "/initialize"), null); assert.equal(messageCommand("claude", "/init"), null);
});

test("HTTP /init is dispatched in its original chat and records the user's actual command", async t => {
  const f = await fixture(t), text = "/init Preserve the release rules\nand inspect the existing tests";
  const response = await f.request("messages", { text }); assert.equal(response.status, 202);
  await waitFor(() => !f.app.manager.isBusy(f.chat.id));
  assert.equal(f.calls.inputs.length, 1); assert.equal(f.calls.inputs[0].chatId, f.chat.id);
  assert.match(f.calls.inputs[0].text, /Inspect this repository and create or improve its AGENTS\.md/);
  assert.match(f.calls.inputs[0].text, /Preserve the release rules\nand inspect the existing tests/);
  assert.equal(f.calls.inputs[0].options.mode, "auto");
  assert.equal(f.app.store.get(f.chat.id).messages.find(message => message.role === "user").text, text);
  assert.equal(f.app.store.list().length, 1, "Initialization must not create a copied/replacement chat");
  assert(!f.app.store.get(f.chat.id).messages.some(message => message.kind === "error"));
});

test("busy /init keeps FIFO order and materializes only its own queued attachments", async t => {
  const f = await fixture(t); f.calls.gate = Promise.withResolvers();
  const running = f.app.manager.send(f.chat.id, "Existing task"); await waitFor(() => f.calls.inputs.length === 1);
  const file = await f.app.manager.attachments.upload(f.chat.id, { name: "conventions.txt", mime: "text/plain", data: Buffer.from("INIT_ATTACHMENT_POLICY").toString("base64") });
  const text = "/init use the attached conventions\nKeep existing policies";
  const queued = await f.request("queue", { text, attachments: [file.id] }); assert.equal(queued.status, 202);
  await f.app.manager.enqueue(f.chat.id, "Following task"); assert.equal(f.calls.inputs.length, 1);
  f.calls.gate.resolve(); await running; await waitFor(() => !f.app.manager.isBusy(f.chat.id) && !f.app.store.get(f.chat.id).queuedMessages.length);
  assert.equal(f.calls.inputs.length, 3); assert.match(f.calls.inputs[1].text, /AGENTS\.md.*Additional instructions:/s);
  const message = f.app.store.get(f.chat.id).messages.find(message => message.role === "user" && message.text === text);
  assert.equal(message.attachments[0].id, file.id); assert.equal(message.attachments[0].chatId, f.chat.id);
  assert.equal(await readFile(message.attachments[0].path, "utf8"), "INIT_ATTACHMENT_POLICY");
  assert(f.calls.inputs[1].text.includes(message.attachments[0].path)); assert.doesNotMatch(f.calls.inputs[2].text, /conventions\.txt/);
});

test("stopping leaves queued initialization paused and persisted until explicit resume", async t => {
  const f = await fixture(t); f.calls.gate = Promise.withResolvers();
  const running = f.app.manager.send(f.chat.id, "Working task"); await waitFor(() => f.calls.inputs.length === 1);
  await f.app.manager.enqueue(f.chat.id, "/init after the current work"); await f.app.manager.stop(f.chat.id); await running;
  assert.equal(f.calls.inputs.length, 1); assert.equal(f.app.store.get(f.chat.id).queuePaused, true);
  const restored = new ChatStore(f.root, f.records); await restored.initialize();
  assert.equal(restored.get(f.chat.id).queuedMessages[0].text, "/init after the current work"); assert.equal(restored.get(f.chat.id).queuePaused, true);
  await f.app.manager.editQueue(f.chat.id, { resume: true }); await waitFor(() => !f.app.manager.isBusy(f.chat.id) && !f.app.store.get(f.chat.id).queuedMessages.length);
  assert.equal(f.calls.inputs.length, 2); assert.equal(f.calls.starts, 2); assert.match(f.calls.inputs[1].text, /AGENTS\.md/);
});

test("/init retains Plan mode and reports native failure instead of claiming a document was created", async t => {
  const f = await fixture(t); await f.app.manager.setMode(f.chat.id, "plan");
  f.calls.error = "Fixture repository inspection failed";
  await f.app.manager.send(f.chat.id, "/init");
  assert.equal(f.calls.inputs[0].options.mode, "plan"); assert.equal(f.app.store.get(f.chat.id).mode, "plan");
  assert(f.app.store.get(f.chat.id).messages.some(message => message.kind === "error" && message.text === f.calls.error));
  assert.equal(f.app.store.get(f.chat.id).messages.filter(message => message.role === "assistant").length, 0);
  assert.equal(f.app.store.get(f.chat.id).queuePaused, true);
});

test("initialization cannot bypass HTTP authentication, chat ownership, origin or attachment ownership", async t => {
  const f = await fixture(t), body = { text: "/init" };
  assert.equal((await f.request("messages", body, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await f.request("messages", body, { origin: "https://foreign.invalid" })).status, 403);
  const other = await f.app.manager.createChat({ agent: "codex", title: "Foreign fixture" });
  const foreignFile = await f.app.manager.attachments.upload(other.id, { name: "private.txt", mime: "text/plain", data: Buffer.from("FOREIGN_FILE").toString("base64") });
  assert.equal((await f.request("messages", { ...body, attachments: [foreignFile.id] })).status, 400);
  await f.app.store.update(f.chat.id, { ownerId: "another-user" });
  assert.equal((await f.request("messages", body)).status, 404);
  assert.equal(f.calls.inputs.length, 0); assert.equal(f.calls.starts, 0);
  assert.equal(f.app.store.get(f.chat.id).messages.length, 0);
});
