#!/usr/bin/env node
// Native-shaped journal fixture; no model, network, credential files or host profile.
import readline from "node:readline";
import path from "node:path";
import { mkdir, appendFile, readFile, readdir } from "node:fs/promises";
import { nativeId, nativeBundle, nativeRow } from "./native-session.mjs";
const home = process.env.CODEX_HOME, calls = [], turnId = "22222222-2222-4222-8222-222222222222";
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
let filename, goal = null;
async function locate(directory) {
  for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) { const match = await locate(file); if (match) return match; }
    else if (item.name.endsWith(".jsonl") && (await readFile(file, "utf8")).includes(nativeId)) return file;
  }
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
rl.on("line", line => { queue = queue.then(async () => {
  const request = JSON.parse(line), method = request.method;
  if (!method || request.id == null) return;
  calls.push(method);
  const reply = result => send({ id: request.id, result });
  if (method === "initialize") return reply({ userAgent: "journal-fixture/0.154.0" });
  if (method === "thread/start") {
    filename = path.join(home, "sessions", `rollout-${nativeId}.jsonl`);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await appendFile(filename, Buffer.from(nativeBundle().files[0].data, "base64"), { mode: 0o600 });
    return reply({ thread: { id: nativeId, path: filename }, model: "fixture" });
  }
  if (method === "thread/resume" || method === "thread/read") {
    filename = await locate(path.join(home, "sessions"));
    if (!filename || request.params.threadId !== nativeId) return send({ id: request.id, error: { code: -32602, message: "Native history missing" } });
    return reply({ thread: { id: nativeId, path: filename }, model: "fixture" });
  }
  if (method === "thread/list" || method === "skills/list") return reply({ data: [], nextCursor: null });
  if (method === "thread/goal/get") return reply({ goal });
  if (method === "thread/goal/set") { goal = { ...request.params, tokensUsed: 0 }; return reply({ goal }); }
  if (method === "fixture/history") return reply({ calls, data: await readFile(filename, "utf8") });
  if (method === "turn/start") {
    await appendFile(filename, nativeRow("response_item", { type: "message", role: "user", content: request.params.input })
      + nativeRow("response_item", { type: "reasoning", encrypted_content: "second-private-native-record", summary: [] })
      + nativeRow("event_msg", { type: "task_complete", turn_id: turnId }));
    reply({ turn: { id: turnId, status: "inProgress" } });
    send({ method: "turn/started", params: { threadId: nativeId, turn: { id: turnId, status: "inProgress" } } });
    send({ method: "item/agentMessage/delta", params: { threadId: nativeId, turnId, itemId: "answer", delta: "Native fixture completed" } });
    send({ method: "turn/completed", params: { threadId: nativeId, turn: { id: turnId, status: "completed" } } }); return;
  }
  reply({});
}).catch(() => process.exit(2)); });
