import test from "node:test";
import assert from "node:assert/strict";
import { completedAnswerText, latestCompletedAnswer } from "../public/completed-answer.js";
import { searchableText } from "../src/message-search.mjs";

const answer = (text, agent = "codex", source = "codex-final-answer", meta = {}) => ({
  role: "assistant", kind: "message", agent, text: "Display text must not be copied",
  meta: { finalAnswer: { version: 1, source, text }, ...meta },
});
test("copy and search share explicit final provenance for every supported provider", () => {
  for (const [agent, source] of [["codex", "codex-final-answer"], ["claude", "claude-success-result"], ["mock", "mock-final-answer"]]) {
    const message = answer("Exact final\n\n```js\n42\n```", agent, source);
    assert.equal(completedAnswerText(message), message.meta.finalAnswer.text);
    assert.equal(searchableText(message), completedAnswerText(message));
  }
});
test("latest completed projection survives empty segmented markers and later intermediate output", () => {
  const final = { ...answer("Newest final"), text: "", meta: { ...answer("Newest final").meta, segmentedTurn: true } };
  const messages = [answer("Older final"), final, answer("Commentary", "codex", "codex-final-answer", { commentary: true }),
    answer("Interrupted", "codex", "codex-final-answer", { interrupted: true }), { role: "assistant", kind: "message", text: "Unknown legacy output" }];
  assert.equal(latestCompletedAnswer(messages), "Newest final");
  assert.equal(latestCompletedAnswer(messages.slice(2)), null);
  assert.equal(latestCompletedAnswer([]), null);
});
test("copy rejects the same malformed, generated and non-final assistant rows as search", () => {
  const invalid = [
    ...["renderingSample", "githubEventId", "generated", "interrupted", "commentary"].map(key => answer("x", "codex", "codex-final-answer", { [key]: true })),
    answer("x", "codex", "codex-final-answer", { source: "github" }),
    answer("x", "claude"), { ...answer("x", "codex", "unknown"), agent: undefined },
    answer("x", "codex", "codex-final-answer", { finalAnswer: { version: 2, source: "codex-final-answer", text: "x" } }),
    answer(""), answer("   "), answer(null), answer("x".repeat(100001)),
    { ...answer("x"), kind: "tool" }, { ...answer("x"), role: "system" },
  ];
  for (const message of invalid) { assert.equal(completedAnswerText(message), null); assert.equal(searchableText(message), null); }
});
