import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { handoffPrompt } from "../src/agent-handoff.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

test("switching providers retains chat/workspace and hands off history without reusing session IDs", async t => {
  const root = await temporaryDirectory(t); const store = new ChatStore(root, new MemoryRecords()); await store.initialize();
  const calls = []; let hooks, finish;
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    adapterFactory: ({ chat, hooks: callbacks }) => {
      hooks = callbacks; calls.push({ agent: chat.agent, session: chat.agentSessionId });
      return { start: async () => callbacks.onSessionId(`${chat.agent}-session`), send: (prompt, options) => { calls.push({ prompt, options }); return new Promise(resolve => { finish = resolve; }); }, stop: async () => { finish?.({ text: "stopped" }); } };
    },
  }); t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex", title: "Keep this title" });
  const turn = await manager.submit(chat.id, "Remember: use the staging branch"); await waitFor(() => finish);
  await assert.rejects(manager.switchAgent(chat.id, "claude"), /Stop the working/);
  finish({ text: "Staging selected. <relay-waiting>no</relay-waiting>" }); await turn.completion;
  const switched = await manager.switchAgent(chat.id, "claude");
  assert.equal(switched.agent, "claude"); assert.equal(switched.agentSessionId, null);
  assert.equal(switched.model, "opus"); assert.equal(switched.effort, "high");
  assert.equal(switched.workspace, chat.workspace); assert.equal(switched.messages.length, 2); assert.equal(switched.title, chat.title);
  finish = null; const followup = await manager.submit(chat.id, "continue"); await waitFor(() => finish);
  assert.match(calls.at(-1).options.systemPrompt, /staging branch/); assert.equal(calls.at(-1).prompt, "continue");
  assert.equal(calls.filter(call => call.agent).at(-1).session, null);
  await hooks.onEvent({ type: "assistant_delta", delta: "Continuing" });
  finish({ text: "Continuing <relay-waiting>no</relay-waiting>" }); await followup.completion;
  assert.equal(store.get(chat.id).needsAgentHandoff, false);
  const back = await manager.switchAgent(chat.id, "codex");
  assert.equal(back.model, "gpt-5.6-sol"); assert.equal(back.agentSessionId, null); assert.equal(back.messages.length, 4);
  const restarted = new ChatStore(root, store.records); await restarted.initialize(); assert.equal(restarted.get(chat.id).needsAgentHandoff, true);
  await assert.rejects(manager.switchAgent(chat.id, "invalid"), /enabled agent/);
});
test("handoff history is bounded, includes prior tool output, and excludes the current user message duplicate", () => {
  const messages = [{ role: "assistant", text: "a".repeat(100000) }, { role: "tool", text: "test", meta: { output: "PASSED" } }, { role: "user", text: "See attachment", attachments: [{ name: "note.txt", path: "/chat/uploads/note.txt" }] }, { role: "user", text: "NEXT" }];
  const prompt = handoffPrompt({ needsAgentHandoff: true, messages }, "NEXT");
  assert.ok(prompt.length < 82000); assert.match(prompt, /PASSED/); assert.equal(prompt.split("NEXT").length, 2);
  assert.match(prompt, /\/chat\/uploads\/note.txt/);
  assert.equal(handoffPrompt({ needsAgentHandoff: false }, "hello"), "hello");
});
