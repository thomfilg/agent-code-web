import test from "node:test";
import assert from "node:assert/strict";
import { ChatStore } from "../src/store.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";
import { groupTools } from "../public/tool-activity.js";

test("commentary and tools persist in execution order, late completion updates in place, and the final reply is not duplicated", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "10000" }), broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: ({ hooks }) => ({
    start: async () => {}, stop: async () => {}, send: async () => {
      await hooks.onEvent({ type: "assistant_delta", delta: "I'll check the types." });
      await hooks.onEvent({ type: "tool", itemId: "typecheck", tool: "command", title: "pnpm check-types", state: "running" });
      await hooks.onEvent({ type: "assistant_delta", delta: "\n\nNow I'll test the build." });
      await hooks.onEvent({ type: "tool", itemId: "build", tool: "command", title: "pnpm build", state: "running" });
      await hooks.onEvent({ type: "tool", itemId: "typecheck", tool: "command", title: "pnpm check-types", state: "completed", output: "Type error", exitCode: 2 });
      await hooks.onEvent({ type: "tool", itemId: "build", tool: "command", title: "pnpm build", state: "completed", output: "Build OK", exitCode: 0 });
      await hooks.onEvent({ type: "assistant_delta", delta: "\n\nBuild passed; types need a fix." });
      return { text: "I'll check the types.\n\nNow I'll test the build.\n\nBuild passed; types need a fix." };
    },
  }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "mock" }); await manager.send(chat.id, "Check it");
  const messages = store.get(chat.id).messages;
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  assert.deepEqual(messages.filter(message => message.role === "assistant").map(message => message.text), ["I'll check the types.", "Now I'll test the build.", "Build passed; types need a fix."]);
  assert.equal(messages[2].meta.exitCode, 2); assert.equal(messages[4].meta.output, "Build OK");
  const { rows, groups } = groupTools(messages);
  assert.deepEqual(rows.map(row => row.kind === "tool_group" ? "actions" : row.role), ["user", "assistant", "actions", "assistant", "actions", "assistant"]);
  assert.equal(groups.size, 2);
  const reloaded = new ChatStore(root); await reloaded.initialize(); assert.deepEqual(reloaded.get(chat.id).messages, messages);
});

test("live tool updates reuse the original group and never merge tools across commentary", () => {
  const messages = [
    { id: "u", role: "user" }, { id: "a", role: "assistant", text: "First" },
    { id: "t1", kind: "tool", meta: { itemId: "one", state: "completed", output: "done" } },
    { id: "b", role: "assistant", text: "Second" },
    { id: "t2", kind: "tool", meta: { itemId: "two", state: "running" } },
  ];
  const { rows, groups } = groupTools(messages, [{ itemId: "one", state: "running" }, { itemId: "two", state: "completed", output: "OK" }]);
  assert.equal(rows.length, 5); assert.equal(groups.size, 2);
  assert.equal(groups.get("tools-t1").get("one").meta.state, "completed");
  assert.equal(groups.get("tools-t2").get("two").meta.output, "OK");
});
