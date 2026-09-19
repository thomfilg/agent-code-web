import assert from "node:assert/strict";
import test from "node:test";
import { provisionalTitle, provisionalTitlePatch, TitleStream } from "../src/title-protocol.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("provisional titles normalize text, preserve language and cap words/characters", () => {
  assert.equal(provisionalTitle("  **Corrigir**\n o painel   de configurações  "), "Corrigir o painel de configurações");
  assert.equal(provisionalTitle("one two three four five six seven eight nine"), "one two three four five six seven eight");
  assert.equal(Array.from(provisionalTitle("é".repeat(100))).length, 80);
  for (const text of ["", "...", "/goal", "/goal finish the private project", "/review --base confidential"]) assert.equal(provisionalTitle(text), null);
  assert.equal(provisionalTitle("New conversation"), "New task");
});

test("sensitive-looking text is checked before truncation and attachments are never expanded", () => {
  for (const text of ["password is hunter2", "my_password is hunter2", "a b c d e f g h i token=private", "senha\u200b: privada", "Use sk-protected-test-value", "ghp_protected_test_value", "Use https://user:private@example.test/path?secret=x", "Contact user@example.test", "```env\nAUTH=private\n```", "DATABASE_URL=private", "$ export KEY=private", "012345678901234567890123456789", "Use code 123456", "<private>value</private>"]) {
    assert.equal(provisionalTitle(text), "New task", text);
  }
  assert.equal(provisionalTitle("Please inspect the attached files.", { hasAttachments: true }), "Review attached files");
});

test("task-bearing goal/plan use only raw objectives while command controls stay unnamed", () => {
  assert.equal(provisionalTitle("/goal Fix checkout totals", { agent: "codex" }), "Fix checkout totals");
  assert.equal(provisionalTitle("/goal edit Review the checkout flow", { agent: "codex" }), "Review the checkout flow");
  for (const agent of ["codex", "claude"]) {
    assert.equal(provisionalTitle("/plan Design a new checkout", { agent }), "Design a new checkout");
    assert.equal(provisionalTitle("/plan password is private", { agent }), "New task");
  }
  assert.equal(provisionalTitle("/goal token=private", { agent: "codex" }), "New task");
  for (const input of ["/goal", "/goal pause", "/goal resume", "/goal clear", "/goal edit", "/plan", "/init", "/review --base private", "/model private", "/permissions auto"]) {
    assert.equal(provisionalTitle(input, { agent: "codex" }), null, input);
  }
  assert.equal(provisionalTitle("/goal Fix checkout", { agent: "claude" }), null);
  assert.equal(provisionalTitlePatch({ agent: "codex", autoTitle: true, title: "New conversation", messages: [{ role: "user", text: "/goal Fix checkout totals" }] }, "continue").title, "Fix checkout totals");
});

test("only untouched automatic placeholders get the first original substantive request", () => {
  const chat = { autoTitle: true, title: "New conversation", messages: [
    { role: "system", text: "private injected instructions" }, { role: "user", text: "/model private" },
    { role: "assistant", text: "assistant text" }, { role: "user", kind: "message", text: "Fix the checkout totals" },
    { role: "user", kind: "message", text: "continue" },
  ] };
  const patch = provisionalTitlePatch(chat, "latest request");
  assert.deepEqual(patch, { title: "Fix the checkout totals", provisionalTitleSet: true });
  for (const override of [{ autoTitle: false }, { title: "Model chosen title" }, { provisionalTitleSet: true }]) assert.deepEqual(provisionalTitlePatch({ ...chat, ...override }, "different"), {});
  assert.deepEqual(provisionalTitlePatch(null, "different"), {});
});

test("case-insensitive model metadata stays hidden across all streaming splits", () => {
  const source = "<RELAY-TITLE>Model-selected name</RELAY-TITLE>\nAnswer";
  for (let split = 1; split < source.length; split++) {
    const events = [], stream = new TitleStream(event => events.push(event));
    stream.delta(source.slice(0, split)); stream.delta(source.slice(split)); stream.flush();
    assert.deepEqual(events.filter(event => event.type === "title").map(event => event.title), ["Model-selected name"]);
    assert.equal(events.filter(event => event.type === "assistant_delta").map(event => event.delta).join("").trim(), "Answer");
  }
});

async function fixture(t, { start, send } = {}) {
  const root = await temporaryDirectory(t), config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" });
  const store = new ChatStore(root); await store.initialize();
  let hooks, calls = 0;
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin: "http://localhost",
    adapterFactory: params => { hooks = params.hooks; return {
      start: start || (async () => {}), stop: async () => {},
      send: async text => { calls++; return send ? send(text, hooks) : { text: "I will work on it." }; },
    }; },
  });
  t.after(() => manager.shutdown());
  return { root, store, manager, hooks: () => hooks, calls: () => calls };
}

test("accepted request gets a durable title before startup and needs no extra model call", async t => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const f = await fixture(t, { start: () => gate.promise });
  const chat = await f.manager.createChat({ agent: "codex" });
  assert.equal(chat.title, "New conversation");
  const events = []; f.manager.on("event", event => events.push(event));
  const turn = await f.manager.submit(chat.id, "Fix checkout totals");
  assert.equal(f.store.get(chat.id).title, "Fix checkout totals");
  assert.equal(f.store.get(chat.id).autoTitle, true);
  assert.equal(f.calls(), 0);
  assert.ok(events.some(event => event.type === "chat_updated" && event.chat.title === "Fix checkout totals"));
  gate.resolve(); await turn.completion;
  assert.equal(f.calls(), 1);
  await f.manager.send(chat.id, "continue");
  assert.equal(f.store.get(chat.id).title, "Fix checkout totals");
  const reloaded = new ChatStore(f.root); await reloaded.initialize();
  assert.equal(reloaded.get(chat.id).title, "Fix checkout totals");
  assert.equal(reloaded.get(chat.id).provisionalTitleSet, true);
});

test("model title replaces provisional title; manual names survive both later turns and background titles", async t => {
  const f = await fixture(t, { send: async (_text, hooks) => {
    const text = "<relay-title>Checkout total corrections</relay-title>\nDone";
    await hooks.onEvent({ type: "assistant_delta", delta: text }); return { text };
  } });
  const chat = await f.manager.createChat({ agent: "codex" });
  await f.manager.send(chat.id, "Fix checkout totals");
  assert.equal(f.store.get(chat.id).title, "Checkout total corrections");
  assert.equal(f.store.get(chat.id).messages.at(-1).text, "Done");
  await f.store.update(chat.id, { title: "My chosen name", autoTitle: false });
  await f.manager.send(chat.id, "another request");
  await f.hooks().onEvent({ type: "background_response", text: "<relay-title>Must not replace</relay-title>\nBackground done" });
  assert.equal(f.store.get(chat.id).title, "My chosen name");
});

test("completed-only background metadata updates an automatic title without leaking the tag", async t => {
  const f = await fixture(t);
  const chat = await f.manager.createChat({ agent: "claude" });
  await f.manager.send(chat.id, "Check the build");
  await f.hooks().onEvent({ type: "background_response", text: "<relay-title>Build verified</relay-title>\nChecks passed" });
  assert.equal(f.store.get(chat.id).title, "Build verified");
  assert.equal(f.store.get(chat.id).messages.at(-1).text, "Checks passed");
});

test("existing placeholder recovers its original request on next admitted turn, never the latest continue", async t => {
  const f = await fixture(t), chat = await f.manager.createChat({ agent: "codex" });
  await f.store.appendMessage(chat.id, { role: "user", text: "/model default" });
  await f.store.appendMessage(chat.id, { role: "user", text: "Review repository architecture" });
  await f.store.appendMessage(chat.id, { role: "assistant", text: "I am reviewing it" });
  await f.manager.send(chat.id, "continue");
  assert.equal(f.store.get(chat.id).title, "Review repository architecture");
});

test("accepted plan task gets its objective title and later controls cannot replace it", async t => {
  const f = await fixture(t), chat = await f.manager.createChat({ agent: "codex" });
  await f.manager.send(chat.id, "/plan Fix checkout totals");
  assert.equal(f.store.get(chat.id).title, "Fix checkout totals");
  await f.manager.send(chat.id, "/plan");
  assert.equal(f.store.get(chat.id).title, "Fix checkout totals");
});

test("rejected messages do not rename and a concurrent manual rename beats the fallback", async t => {
  const f = await fixture(t), chat = await f.manager.createChat({ agent: "codex" });
  await assert.rejects(f.manager.submit(chat.id, "/title"), /web control|web composer|browser tab/);
  assert.equal(f.store.get(chat.id).title, "New conversation");
  f.manager.on("event", event => { if (event.type === "message" && event.message.role === "user") void f.store.update(chat.id, { title: "Manually named", autoTitle: false }); });
  await f.manager.send(chat.id, "Fix a bug");
  assert.equal(f.store.get(chat.id).title, "Manually named");
});
