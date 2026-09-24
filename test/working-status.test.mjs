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

test("a pending question or approval is not described as active agent work", () => {
  const createdAt = "2026-09-24T20:32:34Z", now = Date.parse(createdAt) + 12 * 60_000;
  const chat = { status: "running", workingStartedAt: "2026-09-24T20:00:00Z", pendingRequest: {
    requestId: "fixture", method: "claude/tool/requestUserInput", createdAt,
  }, messages: [{ role: "user", createdAt: "2026-09-24T20:00:00Z" },
    { role: "tool", kind: "tool", meta: { itemId: "question", state: "running", tool: "AskUserQuestion" } }] };
  assert.equal(workingStatus(chat, new Map(), now), "Waiting for your answer · 12m 0s · Worker running");
  assert.equal(workingStatus({ ...chat, pendingRequest: { ...chat.pendingRequest, method: "claude/tool/requestApproval" } }, new Map(), now),
    "Waiting for your approval · 12m 0s · Worker running");
  assert.match(workingStatus({ ...chat, pendingRequest: null }, new Map(), now), /^Working · 44m 34s/);
});

test("startup uses its persisted start on cold wake/reload without changing later working-turn timing", () => {
  const start = "2026-09-19T12:00:00Z", now = Date.parse(start) + 20000;
  const chat = { status: "starting", startupProgress: { startedAt: start }, workingStartedAt: "2026-09-19T11:00:00Z", messages: [] };
  assert.match(workingStatus(chat, new Map(), now), /^Starting · 0m 20s/);
  assert.match(workingStatus({ ...chat, status: "running" }, new Map(), now), /^Working · 1h 0m 20s/);
  assert.match(workingStatus({ ...chat, startupProgress: { startedAt: "invalid" } }, new Map(), now), /^Starting · 1h 0m 20s/);
  delete chat.workingStartedAt;
  assert.match(workingStatus(chat, new Map(), now), /^Starting · 0m 20s/);
});
