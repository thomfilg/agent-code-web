import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function fixture(t, agent = "mock") {
  const root = await temporaryDirectory(t), store = new ChatStore(root);
  await store.initialize();
  const adapters = [], events = [];
  const broker = new CapabilityBroker({ ttlMs: 60000 });
  const manager = new RuntimeManager({ store, broker, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }), gatewayOrigin: "http://localhost",
    adapterFactory: ({ hooks }) => {
      const adapter = { hooks, stops: 0, start: async () => {},
        send: () => { adapter.turn = Promise.withResolvers(); return adapter.turn.promise; },
        stop: async () => { adapter.stops++; adapter.turn?.reject(Error("worker exited")); },
      };
      adapters.push(adapter); return adapter;
    },
  });
  manager.on("event", event => events.push(event));
  const chat = await manager.createChat({ agent });
  const start = async (id = chat.id) => {
    const turn = await manager.submit(id, "Continue the fixture task");
    const adapter = await waitFor(() => adapters.findLast(adapter => adapter.turn && !adapter.stops));
    return { turn, adapter };
  };
  const reload = async () => { const restored = new ChatStore(root); await restored.initialize(); return restored; };
  return { root, store, manager, broker, chat, adapters, events, start, reload };
}

test("fatal worker exit drains accepted deltas, retains commentary once, and persists the interrupted tail on reload", async t => {
  const f = await fixture(t);
  try {
    const { adapter, turn } = await f.start();
    await adapter.hooks.onEvent({ type: "assistant_delta", delta: "First explanation.\n\n" });
    await adapter.hooks.onEvent({ type: "tool", itemId: "tool-1", title: "Read fixture", status: "completed" });
    await f.manager.enqueue(f.chat.id, "Keep queued after failure");
    // Do not await: a worker can exit in the same turn that emits its final
    // visible chunk. These accepted events must not depend on a surviving PID.
    const delta = adapter.hooks.onEvent({ type: "assistant_delta", delta: "Unfinished answer" });
    const usage = adapter.hooks.onEvent({ type: "usage", usage: { inputTokens: 17, outputTokens: 4 } });
    await adapter.hooks.onFatal(Error("fixture worker disappeared"));
    await Promise.all([delta, usage, turn.completion]);
    assert.equal(f.store.get(f.chat.id).status, "error");
    const restored = (await f.reload()).get(f.chat.id);
    assert.deepEqual(restored.messages.filter(message => message.role === "assistant").map(message => [message.text, message.meta]), [
      ["First explanation.", { commentary: true, streamId: restored.messages.at(-1).id }],
      ["Unfinished answer", { interrupted: true }],
    ]);
    assert.equal(restored.messages.filter(message => message.role === "tool").length, 1);
    assert.equal(restored.usage.inputTokens, 17);
    assert.equal(restored.queuePaused, true);
    assert.deepEqual(restored.queuedMessages.map(message => message.text), ["Keep queued after failure"]);
    assert.equal(f.adapters.length, 1);
    assert.equal(restored.status, "stopped", "controller initialization marks disconnected chats stopped");
    assert.equal(adapter.stops, 1);
  } finally { await f.manager.shutdown(); }
});

test("failure flushes native response metadata without exposing it or saving a late final result", async t => {
  const f = await fixture(t, "codex");
  try {
    const { adapter, turn } = await f.start();
    await adapter.hooks.onEvent({ type: "assistant_delta", delta: "<relay-title>Fixture summary</relay-title>\nVisible answer" });
    const pending = adapter.hooks.onEvent({ type: "assistant_delta", delta: " <relay-waiting>no</relay-waiting>" });
    const failed = adapter.hooks.onFatal(Error("native fixture exit"));
    adapter.turn.resolve({ text: "LATE FINAL RESULT" });
    await Promise.all([failed, pending, turn.completion]);
    const restored = (await f.reload()).get(f.chat.id);
    assert.equal(restored.title, "Fixture summary");
    const answer = restored.messages.filter(message => message.role === "assistant");
    assert.equal(answer.length, 1);
    assert.equal(answer[0].text.trim(), "Visible answer");
    assert.equal(answer[0].meta.interrupted, true);
    assert.equal(restored.messages.some(message => /relay-title|relay-waiting|LATE FINAL/.test(message.text)), false);
  } finally { await f.manager.shutdown(); }
});

test("a failed transcript checkpoint still tears down and reports the lost save without replaying queued work", async t => {
  const f = await fixture(t), original = f.store.appendMessage.bind(f.store);
  try {
    const { adapter, turn } = await f.start();
    await adapter.hooks.onEvent({ type: "assistant_delta", delta: "Unsaved fixture partial" });
    await f.manager.enqueue(f.chat.id, "Must not replay");
    f.store.appendMessage = async (id, message) => {
      if (message.meta?.interrupted) throw Error("synthetic checkpoint failure");
      return original(id, message);
    };
    await adapter.hooks.onFatal(Error("worker death")); await turn.completion;
    assert.equal(adapter.stops, 1);
    assert.equal(f.manager.isBusy(f.chat.id), false);
    assert.equal(f.store.get(f.chat.id).queuePaused, true);
    assert.match(f.store.get(f.chat.id).statusDetail, /response could not be saved/);
    assert.equal(f.events.some(event => event.type === "runtime_error" && /could not be saved/.test(event.text)), true);
    assert.equal(f.store.get(f.chat.id).messages.some(message => message.meta?.interrupted), false, "never claim a successful checkpoint");
    assert.deepEqual(f.store.get(f.chat.id).queuedMessages.map(message => message.text), ["Must not replay"]);
  } finally { f.store.appendMessage = original; await f.manager.shutdown(); }
});

test("failure fences late native events and cannot append the previous answer a second time", async t => {
  const f = await fixture(t);
  try {
    const { adapter, turn } = await f.start();
    await adapter.hooks.onEvent({ type: "assistant_delta", delta: "Completed answer" });
    adapter.turn.resolve({ text: "Completed answer" }); await turn.completion;
    await adapter.hooks.onFatal(Error("idle worker exited"));
    const resumed = await f.start();
    let snapshots = 0;
    f.manager.agentThreads.update = () => { snapshots++; return Promise.resolve(); };
    adapter.hooks.onAgentThreads({ rootThreadId: "same-thread", threads: [] });
    resumed.adapter.hooks.onAgentThreads({ rootThreadId: "same-thread", threads: [] });
    assert.equal(snapshots, 1, "only the new exact runtime may replace its native-agent snapshot");
    await adapter.hooks.onEvent({ type: "assistant_delta", delta: "OLD OUTPUT" });
    await adapter.hooks.onEvent({ type: "tool", title: "OLD TOOL", itemId: "old" });
    await adapter.hooks.onRequest({ requestId: "old", type: "approval" });
    await adapter.hooks.onFatal(Error("duplicate old exit"));
    await resumed.adapter.hooks.onEvent({ type: "assistant_delta", delta: "New answer" });
    resumed.adapter.turn.resolve({ text: "New answer" }); await resumed.turn.completion;
    const restored = (await f.reload()).get(f.chat.id);
    assert.deepEqual(restored.messages.filter(message => message.role === "assistant").map(message => message.text), ["Completed answer", "New answer"]);
    assert.equal(restored.pendingRequest, null);
    assert.equal(restored.messages.some(message => message.text.includes("OLD")), false);
  } finally { await f.manager.shutdown(); }
});

for (const boundary of ["event queue", "final metadata", "final title"]) test(`fatal after native result while ${boundary} is pending cannot publish a late final or duplicate the tail`, async t => {
  const f = await fixture(t, boundary === "final title" ? "codex" : "mock"), gate = Promise.withResolvers(), original = f.store.update.bind(f.store);
  try {
    const { adapter, turn } = await f.start();
    await adapter.hooks.onEvent({ type: "assistant_delta", delta: "Visible partial before exit" });
    let waiting = false, held = false;
    f.store.update = async (id, patch) => {
      if (!held && (boundary === "event queue" ? typeof patch === "function" : Object.hasOwn(patch, boundary === "final title" ? "title" : "needsAgentHandoff"))) {
        held = true; waiting = true; await gate.promise;
      }
      return original(id, patch);
    };
    if (boundary === "event queue") void adapter.hooks.onEvent({ type: "usage", usage: { inputTokens: 1 } });
    adapter.turn.resolve({ text: (boundary === "final title" ? "<relay-title>Updated fixture title</relay-title>\n" : "") + "LATE FINAL THAT MUST NOT BE APPENDED" });
    await waitFor(() => waiting);
    const fatal = adapter.hooks.onFatal(Error("exit while persisting"));
    if (boundary === "final title") {
      await fatal;
      await f.store.update(f.chat.id, { needsAgentHandoff: true, awaitingUser: true });
    }
    gate.resolve(); await Promise.all([fatal, turn.completion]);
    const messages = f.store.get(f.chat.id).messages.filter(message => message.role === "assistant");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "Visible partial before exit");
    assert.equal(messages[0].meta.interrupted, true);
    assert.equal(f.events.some(event => event.type === "turn_completed"), false);
    if (boundary === "final title") {
      assert.equal(f.store.get(f.chat.id).needsAgentHandoff, true);
      assert.equal(f.store.get(f.chat.id).awaitingUser, true);
    }
  } finally { gate.resolve(); f.store.update = original; await f.manager.shutdown(); }
});

test("background goal partial is preserved even without a foreground send in flight", async t => {
  const f = await fixture(t, "codex");
  try {
    const { adapter, turn } = await f.start();
    adapter.turn.resolve({ text: "First completed response" }); await turn.completion;
    await adapter.hooks.onEvent({ type: "goal_turn_started" });
    await adapter.hooks.onEvent({ type: "assistant_delta", delta: "Autonomous goal partial" });
    await adapter.hooks.onFatal(Error("background worker exit"));
    const restored = (await f.reload()).get(f.chat.id);
    assert.deepEqual(restored.messages.filter(message => message.role === "assistant").map(message => message.text), ["First completed response", "Autonomous goal partial"]);
    assert.equal(restored.messages.at(-1).meta.interrupted, true);
  } finally { await f.manager.shutdown(); }
});

for (const boundary of ["browser", "worker"]) test(`failed ${boundary} cleanup retains old ownership and fences resumption until explicit Stop retry succeeds`, async t => {
  const f = await fixture(t, "codex");
  let failing = true, browserStops = 0, workerSleeps = 0;
  try {
    const { adapter, turn } = await f.start();
    await adapter.hooks.onEvent({ type: "assistant_delta", delta: "Preserved despite cleanup failure" });
    f.manager.browsers = { stop: async () => { browserStops++; if (boundary === "browser" && failing) throw Error("browser cleanup unavailable"); }, hasViewers: () => false, shutdown: async () => {} };
    f.manager.workerBackend.sleep = async () => { workerSleeps++; if (boundary === "worker" && failing) throw Error("worker cleanup unavailable"); };
    await adapter.hooks.onFatal(Error("fixture exit")); await turn.completion;
    assert.equal(browserStops, 1); assert.equal(workerSleeps, 1, "attempt worker cleanup even if browser stop failed");
    await assert.rejects(f.manager.submit(f.chat.id, "Unsafe new turn"), /cleanup is incomplete/);
    await assert.rejects(f.manager.browserExecutor(f.chat.id), /cleanup is incomplete/);
    assert.equal(f.manager.previewGeneration(f.chat.id), null);
    await assert.rejects(f.manager.stop(f.chat.id), /cleanup is incomplete/);
    assert.equal(f.adapters.length, 1);
    failing = false;
    await f.manager.stop(f.chat.id);
    assert.equal(f.store.get(f.chat.id).status, "stopped");
    const resumed = await f.start();
    resumed.adapter.turn.resolve({ text: "Resumed safely" }); await resumed.turn.completion;
    assert.equal(f.adapters.length, 2);
    const answers = f.store.get(f.chat.id).messages.filter(message => message.role === "assistant");
    assert.deepEqual(answers.map(message => message.text), ["Preserved despite cleanup failure", "Resumed safely"]);
  } finally { failing = false; await f.manager.shutdown(); }
});

test("slow failure checkpoint immediately revokes access and blocks new sends and concurrent Stop until saved", async t => {
  const f = await fixture(t), gate = Promise.withResolvers();
  const original = f.store.appendMessage.bind(f.store);
  try {
    const { adapter, turn } = await f.start();
    await adapter.hooks.onEvent({ type: "assistant_delta", delta: "Keep this partial" });
    const credential = f.broker.issue({ chatId: f.chat.id, provider: "anthropic", renewable: true, validWhile: () => true });
    let checkpoint = false;
    f.store.appendMessage = async (id, message) => {
      if (message.meta?.interrupted) { checkpoint = true; await gate.promise; }
      return original(id, message);
    };
    const fatal = adapter.hooks.onFatal(Error("fixture death"));
    assert.equal(f.broker.validate(credential, "anthropic"), null);
    await waitFor(() => checkpoint);
    adapter.turn.reject(Error("exit")); await turn.completion;
    await assert.rejects(f.manager.submit(f.chat.id, "Too early"), /failed worker/);
    const stopped = f.manager.stop(f.chat.id);
    assert.equal(adapter.stops, 0);
    gate.resolve(); await Promise.all([fatal, stopped]);
    assert.equal(adapter.stops, 1);
    const restored = (await f.reload()).get(f.chat.id);
    assert.equal(restored.messages.filter(message => message.text === "Keep this partial").length, 1);
    assert.equal(restored.messages.some(message => message.text === "Too early"), false);
    assert.equal(restored.status, "stopped");
  } finally { gate.resolve(); f.store.appendMessage = original; await f.manager.shutdown(); }
});

test("externally killed disposable worker process preserves both chats and the visible partial on controller reload", async t => {
  const f = await fixture(t);
  // This proves actual external process death, not container-volume recovery.
  // Only this test-owned child is signalled; no product worker is contacted.
  const child = spawn(process.execPath, ["-e", "process.stdout.write('Partial from child\\n'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = once(child, "exit");
  try {
    const other = await f.manager.createChat({ agent: "mock", title: "Unaffected" });
    await f.store.appendMessage(other.id, { role: "assistant", text: "Other saved answer" });
    const { adapter, turn } = await f.start();
    const received = Promise.withResolvers();
    child.stdout.once("data", data => { void adapter.hooks.onEvent({ type: "assistant_delta", delta: data.toString().trimEnd() }).then(received.resolve, received.reject); });
    await received.promise;
    const failed = new Promise((resolve, reject) => child.once("exit", () => {
      adapter.hooks.onFatal(Error("worker process was externally removed")).then(resolve, reject);
    }));
    assert.equal(child.kill("SIGKILL"), true);
    const [, signal] = await exited; assert.equal(signal, "SIGKILL");
    await failed;
    await turn.completion;
    const restored = await f.reload();
    assert.equal(restored.list().length, 2);
    assert.equal(restored.get(other.id).messages.at(-1).text, "Other saved answer");
    assert.equal(restored.get(f.chat.id).messages.at(-1).text, "Partial from child");
    assert.equal(restored.get(f.chat.id).messages.at(-1).meta.interrupted, true);
    assert.equal(f.adapters.length, 1, "read/reload must not start another worker");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; await f.manager.shutdown(); }
});
