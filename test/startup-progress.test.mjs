import test from "node:test";
import assert from "node:assert/strict";
import { startupProgressView } from "../public/startup-progress.js";

const at = seconds => new Date(Date.UTC(2026, 8, 19, 12) + seconds * 1000).toISOString();
const stage = (id, started, finished, status = finished === undefined ? "running" : "completed") => ({
  id, label: id === "repository" ? "Preparing repositories" : "Starting machine", status, startedAt: at(started),
  ...(finished === undefined ? {} : { finishedAt: at(finished) }),
});
const chat = (stages, status = "starting", extra = {}) => ({ id: "a", status, startupProgress: { startedAt: at(0), stages, ...extra } });

test("concurrent startup stages use persisted wall time, not summed durations or page age", () => {
  const input = chat([stage("repository", 0), stage("machine", 2)]);
  const first = startupProgressView(input, Date.parse(at(20)));
  assert.equal(first.summary, "Preparing repositories + Starting machine · 0m 20s");
  assert.equal(first.active, true);
  assert.deepEqual(first.rows.map(row => row.elapsed), ["0m 20s", "0m 18s"]);
  assert.equal(startupProgressView(input, Date.parse(at(22))).summary, "Preparing repositories + Starting machine · 0m 22s");
  assert.equal(startupProgressView(structuredClone(input), Date.parse(at(22))).summary, "Preparing repositories + Starting machine · 0m 22s");
});

test("completed stages freeze independently while remaining stages continue", () => {
  const input = chat([stage("repository", 0, 8), stage("machine", 2)]);
  const view = startupProgressView(input, Date.parse(at(20)));
  assert.equal(view.summary, "Starting machine · 0m 20s");
  assert.deepEqual(view.rows.map(row => row.elapsed), ["0m 8s", "0m 18s"]);
});

test("completed total stays inspectable and frozen during later agent turns and after reload", () => {
  const input = chat([stage("repository", 0, 8), stage("machine", 2, 20)], "running", { finishedAt: at(21) });
  const first = startupProgressView(input, Date.parse(at(50)));
  assert.equal(first.summary, "Startup completed · 0m 21s");
  assert.equal(first.active, false);
  assert.deepEqual(startupProgressView(input, Date.parse(at(5000))), first);
  assert.deepEqual(first.rows.map(row => row.elapsed), ["0m 8s", "0m 18s"]);
});

test("failure and stopping snapshots cannot keep the startup clock running", () => {
  for (const status of ["stopping", "stopped", "idle", "error"]) {
    const input = chat([stage("repository", 0, 8), stage("machine", 2)], status);
    const view = startupProgressView(input, Date.parse(at(20)));
    assert.equal(view.summary, "Startup interrupted · 0m 8s");
    assert.deepEqual(startupProgressView(input, Date.parse(at(9000))), view);
  }
  const failed = chat([stage("repository", 0, 8), stage("machine", 2, 12, "failed")]);
  assert.equal(startupProgressView(failed, Date.parse(at(9000))).summary, "Startup failed · 0m 12s");
  const interrupted = chat([stage("machine", 2)], "starting", { finishedAt: at(15) });
  assert.equal(startupProgressView(interrupted, Date.parse(at(9000))).summary, "Startup interrupted · 0m 15s");
});

test("missing, malformed and legacy progress is hidden; changed chat or startup gets its own identity", () => {
  for (const input of [null, {}, { startupProgress: {} }, chat([]), chat([null]), chat([{ id: "unknown", status: "running" }]),
    chat([stage("machine", 2)], "starting", { startedAt: "invalid" }), chat([stage("machine", 2)], "starting", { stages: "bad" })]) {
    assert.equal(startupProgressView(input), null);
  }
  const input = chat([stage("machine", 2)]), first = startupProgressView(input);
  assert.notEqual(startupProgressView({ ...input, id: "b" }).key, first.key);
  assert.notEqual(startupProgressView(chat([stage("machine", 2)], "starting", { startedAt: at(1) })).key, first.key);
});

test("invalid or future stage clocks do not produce NaN or negative durations", () => {
  const input = chat([{ id: "software", status: "running", startedAt: "bad" }, { id: "agent", status: "running", startedAt: at(20) }]);
  const view = startupProgressView(input, Date.parse(at(-10)));
  assert.equal(view.summary, "Software + Agent · 0m 0s");
  assert.deepEqual(view.rows.map(row => row.elapsed), ["—", "0m 0s"]);
});
