import test from "node:test";
import assert from "node:assert/strict";
import { activeToolCount, elapsedLabel, workingStatus } from "../public/working-status.js";

test("working clock uses the persisted turn start, advances, and handles hours and future clocks", () => {
  const start = "2026-09-18T20:00:00Z", now = Date.parse(start) + 462000;
  const chat = { status: "running", workingStartedAt: start, messages: [] };
  assert.equal(workingStatus(chat, new Map(), now), "Working · 7m 42s · Esc to interrupt · 0 active tools");
  assert.match(workingStatus(chat, new Map(), now + 1000), /7m 43s/);
  assert.equal(elapsedLabel(start, Date.parse(start) + 3601000), "1h 0m 1s");
  assert.equal(elapsedLabel(start, Date.parse(start) - 1000), "0m 0s");
  assert.equal(workingStatus({ ...chat, status: "idle" }, new Map(), now), "");
});

test("active tools count current-turn running tools only, deduplicates live entries and respects completions", () => {
  const chat = { messages: [
    { id: "old", kind: "tool", meta: { itemId: "old", state: "running" } },
    { role: "user", id: "current-turn" },
    { id: "a", kind: "tool", meta: { itemId: "a", state: "running" } },
    { id: "b", kind: "tool", meta: { itemId: "b", state: "completed" } },
  ] };
  const tools = new Map([["a", { state: "running" }], ["b", { state: "running" }], ["c", { state: "running" }]]);
  assert.equal(activeToolCount(chat, tools), 2);
  tools.set("a", { state: "completed" }); assert.equal(activeToolCount(chat, tools), 1);
});
