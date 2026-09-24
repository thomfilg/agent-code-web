import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgentThreads } from "../src/claude-agent-threads.mjs";

const root = "native-root";
const call = (id = "call-a", parent = null, name = "Same agent") => ({ type: "assistant", session_id: root, parent_tool_use_id: parent, uuid: `message-${id}`, message: { content: [{ type: "tool_use", id, name: "Agent", input: { name, description: "Task", prompt: "Public delegated task", subagent_type: "general-purpose" } }] } });
const start = (id = "child-a", tool = "call-a") => ({ type: "system", subtype: "task_started", session_id: root, task_type: "local_agent", task_id: id, tool_use_id: tool });
const end = (id = "child-a", status = "stopped") => ({ type: "system", subtype: "task_notification", session_id: root, task_id: id, status });
function fixture(options = {}) {
  let live = true; const requests = [], snapshots = [];
  const observer = new ClaudeAgentThreads({ root: () => root, current: () => live, publish: value => snapshots.push(value), stopTimeoutMs: 30,
    control: { request: async (...args) => { requests.push(args); } }, ...options });
  return { observer, requests, snapshots, revoke: () => { live = false; } };
}

test("only native Agent invocation plus native child identity establishes membership", () => {
  const { observer } = fixture();
  observer.observe(start()); observer.observe({ ...call(), session_id: "foreign" }); observer.observe(start());
  assert.equal(observer.snapshot().threads.length, 0);
  observer.observe(call()); observer.observe({ ...start(), task_type: "local_bash" });
  observer.observe({ ...start(), session_id: "foreign" }); assert.equal(observer.snapshot().threads.length, 0);
  observer.observe(start()); assert.equal(observer.snapshot().threads[0].id, "child-a");
  observer.observe({ type: "system", subtype: "background_tasks_changed", session_id: root, tasks: [{ task_id: "foreign", task_type: "local_agent" }] });
  assert.equal(observer.snapshot().threads.length, 1);
});
test("public child text and summaries exclude thinking, raw credentials and foreign descendants", () => {
  const { observer } = fixture({ secrets: new Set(["test-private-credential"]) }); observer.observe(call()); observer.observe(start());
  observer.observe({ type: "assistant", session_id: root, parent_tool_use_id: "call-a", uuid: "child-message", message: { content: [
    { type: "thinking", thinking: "PRIVATE THOUGHT" }, { type: "text", text: "Answer test-private-credential sk-ant-abcdefghij" },
    { type: "tool_use", id: "read-call", name: "Read", input: { file_path: "PRIVATE PATH" } },
  ] } });
  observer.observe({ type: "assistant", session_id: root, parent_tool_use_id: "unknown", uuid: "foreign", message: { content: [{ type: "text", text: "FOREIGN TEXT" }] } });
  const serialized = JSON.stringify(observer.snapshot()); assert.match(serialized, /Answer \[redacted\] \[redacted\]/); assert.match(serialized, /Tool: Read/);
  assert.doesNotMatch(serialized, /PRIVATE|FOREIGN|test-private-credential|sk-ant-/);
});
test("two simultaneously active same-name native children remain distinct; Stop acknowledges only the selected ID", async () => {
  const f = fixture(), a = f.observer; a.observe(call()); a.observe(start()); a.observe(call("call-b")); a.observe(start("child-b", "call-b"));
  const stopping = a.interrupt("child-b"); await Promise.resolve();
  assert.deepEqual(f.requests, [["stop_task", { task_id: "child-b" }]]);
  assert.equal(a.snapshot().threads.find(item => item.id === "child-b").status, "active", "ACK is not terminal");
  assert.equal(a.snapshot().threads.find(item => item.id === "child-a").canStop, true);
  a.observe(end("foreign")); a.observe(end("child-a", "completed"));
  assert.equal(a.snapshot().threads.find(item => item.id === "child-b").status, "active");
  a.observe(end("child-b")); await stopping;
  assert.deepEqual(a.snapshot().threads.map(item => [item.id, item.status]), [["child-a", "idle"], ["child-b", "stopped"]]);
});
test("missing terminal retains native active status and does not replay an uncertain child Stop", async () => {
  const f = fixture(); f.observer.observe(call()); f.observer.observe(start());
  await assert.rejects(f.observer.interrupt("child-a"), /Waiting for native confirmation/);
  await assert.rejects(f.observer.interrupt("child-a"), /Waiting for native confirmation/);
  assert.equal(f.requests.length, 1); assert.equal(f.observer.snapshot().threads[0].status, "active");
  f.observer.observe(end()); assert.equal(f.observer.snapshot().threads[0].status, "stopped");
});
test("revocation during Stop acknowledgement fences results and all later actions", async () => {
  const gate = Promise.withResolvers(), f = fixture({ control: { request: () => gate.promise } }); f.observer.observe(call()); f.observer.observe(start());
  const stopping = f.observer.interrupt("child-a"); f.revoke(); gate.resolve(); await assert.rejects(stopping, /unavailable/);
  f.observer.observe(end()); assert.equal(f.observer.snapshot().threads[0].status, "active");
  await assert.rejects(f.observer.refresh(), /unavailable/); await assert.rejects(f.observer.select("child-a"), /unavailable/);
});
test("nested membership needs proven ancestry and duplicate ID results cannot replace another child", () => {
  const { observer: a } = fixture(); a.observe(call()); a.observe(start()); a.observe(call("nested", "call-a")); a.observe(start("child-nested", "nested"));
  a.observe(call("foreign-parent-call", "missing")); a.observe(start("foreign", "foreign-parent-call"));
  a.observe(call("call-b")); a.observe(start("child-a", "call-b"));
  assert.deepEqual(a.snapshot().threads.map(item => [item.id, item.parentThreadId]), [["child-a", root], ["child-nested", "child-a"]]);
});
test("completed structured Agent output proves identity without parsing report prose; foreign status cannot change it", () => {
  const { observer: a } = fixture(); a.observe(call());
  a.observe({ type: "user", session_id: root, message: { content: [{ type: "tool_result", tool_use_id: "call-a", content: "not interpreted" }] }, tool_use_result: { status: "completed", agentId: "child-real", content: [{ type: "text", text: "Actual final child text" }] } });
  a.observe({ ...end("child-real"), tool_use_id: "wrong-call" });
  assert.equal(a.snapshot().threads[0].status, "idle"); assert.match(JSON.stringify(a.snapshot()), /Actual final child text/);
  assert.doesNotMatch(JSON.stringify(a.snapshot()), /not interpreted/);
});
test("close publishes an offline display snapshot and no parent input/direct-send fallback exists", async () => {
  const f = fixture(); f.observer.observe(call()); f.observer.observe(start());
  await assert.rejects(f.observer.send("child-a", { text: "Prompt" }), /not supported/); await assert.rejects(f.observer.respond(), /main conversation/);
  assert.deepEqual(f.requests, []); f.observer.close();
  assert.equal(f.snapshots.at(-1).awake, false); assert.equal(f.snapshots.at(-1).threads[0].canStop, false);
  await assert.rejects(f.observer.interrupt("child-a"), /unavailable/);
});

test("snapshots own their messages and usage and explicitly identify globally omitted history", () => {
  const { observer: a } = fixture(); a.observe(call()); a.observe(start());
  a.observe({ type: "system", subtype: "task_progress", session_id: root, task_id: "child-a", usage: { total_tokens: 4 } });
  const snapshot = a.snapshot(); snapshot.threads[0].messages[0].text = "changed"; snapshot.threads[0].usage.total_tokens = 99;
  assert.equal(a.snapshot().threads[0].messages[0].text, "Public delegated task"); assert.equal(a.snapshot().threads[0].usage.total_tokens, 4);
  for (let i = 0; i < 22; i++) {
    a.observe(call(`large-${i}`)); a.observe(start(`child-large-${i}`, `large-${i}`));
    for (let j = 0; j < 3; j++) a.observe({ type: "assistant", session_id: root, parent_tool_use_id: `large-${i}`, uuid: `text-${i}-${j}`, message: { content: [{ type: "text", text: "x".repeat(16000) }] } });
  }
  const limited = a.snapshot(); assert.equal(limited.truncated, true);
  assert.ok(limited.threads.some(entry => entry.historyLimited && entry.messages.length === 0));
});
