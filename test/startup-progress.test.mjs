import test from "node:test";
import assert from "node:assert/strict";
import { startupProgressPlacement, startupProgressView } from "../public/startup-progress.js";

const progress = {
  startedAt: "2026-09-23T12:00:00.000Z",
  finishedAt: "2026-09-23T12:01:00.000Z",
  stages: [{ id: "machine", status: "completed", startedAt: "2026-09-23T12:00:00.000Z", finishedAt: "2026-09-23T12:01:00.000Z" }],
};

test("completed startup moves to settings while live machine health owns the compact header", () => {
  const chat = { id: "live", status: "running", startupProgress: progress };
  const view = startupProgressView(chat, Date.parse(progress.finishedAt));
  assert.deepEqual(startupProgressPlacement(chat, view), { banner: false, settings: true, health: true, detail: false });
});

test("stopped machines show startup history in the banner and hide machine health", () => {
  const chat = { id: "stopped", status: "stopped", startupProgress: progress };
  const view = startupProgressView(chat, Date.parse(progress.finishedAt));
  assert.deepEqual(startupProgressPlacement(chat, view), { banner: true, settings: false, health: false, detail: false });
});

test("active startup is the only operational subline", () => {
  const chat = { id: "starting", status: "starting", startupProgress: { ...progress, finishedAt: null,
    stages: [{ id: "machine", status: "running", startedAt: progress.startedAt }] } };
  const view = startupProgressView(chat, Date.parse("2026-09-23T12:00:10.000Z"));
  assert.deepEqual(startupProgressPlacement(chat, view), { banner: true, settings: false, health: false, detail: false });
});
