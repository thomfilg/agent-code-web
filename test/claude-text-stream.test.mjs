import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeTextStream } from "../src/claude-text-stream.mjs";

const start = id => ({ type: "stream_event", event: { type: "message_start", message: { id } } });
const delta = text => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const final = (id, text) => ({ type: "assistant", message: { id, content: [{ type: "text", text }] } });
function collect(events) {
  const deltas = [], stream = new ClaudeTextStream(text => deltas.push(text));
  for (const event of events) stream.accept(event);
  assert.equal(deltas.join(""), stream.text, "Live and saved text must agree");
  return stream.text;
}

test("native goal continuations have paragraph boundaries and complete-message events do not duplicate deltas", () => {
  assert.equal(collect([start("one"), delta("First "), delta("step."), final("one", "First step."), start("two"), delta("Goal "), final("two", "Goal complete."), { type: "result", result: "Goal complete." }]), "First step.\n\nGoal complete.");
});

test("complete-only messages retain every main-agent step and duplicate native events are ignored", () => {
  assert.equal(collect([final("one", "First step."), final("one", "First step."), final("two", "Final answer."), { type: "result", result: "Final answer." }]), "First step.\n\nFinal answer.");
});

test("per-block native assistant events do not end a message or drop subsequent blocks", () => {
  const block = index => ({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
  const first = { ...final("one", "First. "), uuid: "first-block" }, second = { ...final("one", "Second."), uuid: "second-block" };
  const stop = { type: "stream_event", event: { type: "message_stop" } };
  assert.equal(collect([start("one"), block(0), delta("First. "), first, block(1), delta("Second."), second, stop, first, second, start("two"), delta("Next turn."), final("two", "Next turn.")]), "First. Second.\n\nNext turn.");
  assert.equal(collect([first, second, first, second, final("two", "Next turn.")]), "First. Second.\n\nNext turn.");
  assert.equal(collect([{ ...first, message: { ...first.message, content: [{ type: "text", text: "Repeat." }] } }, { ...second, message: { ...second.message, content: [{ type: "text", text: "Repeat." }] } }]), "Repeat.Repeat.");
});

test("nested subagents and thinking cannot contaminate the parent response or its boundaries", () => {
  assert.equal(collect([start("one"), delta("Parent"), { ...start("nested"), parent_tool_use_id: "agent-tool" }, { ...delta("PRIVATE CHILD"), parent_tool_use_id: "agent-tool" },
    { ...final("nested", "PRIVATE CHILD"), parent_tool_use_id: "agent-tool" }, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "PRIVATE REASONING", text: "ALSO NOT PUBLIC" } } },
    delta(" answer."), final("one", "Parent answer."), { type: "assistant", message: { id: "thought", content: [{ type: "thinking", thinking: "PRIVATE REASONING" }] } }]), "Parent answer.");
});

test("tool-only messages do not add empty paragraphs; local command results and legacy deltas still render", () => {
  const tool = { type: "assistant", message: { id: "tool", content: [{ type: "tool_use", id: "read", name: "Read", input: {} }] } };
  assert.equal(collect([start("one"), delta("First."), final("one", "First."), start("tool"), tool, start("two"), delta("Second."), final("two", "Second.")]), "First.\n\nSecond.");
  assert.equal(collect([{ type: "result", result: "No goal set." }]), "No goal set.");
  assert.equal(collect([tool, delta("legacy "), delta("reply"), { type: "result", result: "legacy reply" }]), "legacy reply");
  assert.equal(collect([{ type: "result", is_error: true, subtype: "error_during_execution", result: "Failure is not an assistant answer" }]), "");
});
