import assert from "node:assert/strict";
import test from "node:test";
import { ChromeBrowser } from "../src/browser-worker.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const browser = new ChromeBrowser(), calls = [], frames = [];
  browser.sessionId = "fixture-session";
  browser.call = async (method, params) => { calls.push({ method, params }); return {}; };
  browser.tabs = async () => [];
  browser.on("frame", frame => frames.push(frame));
  await browser.watch(true);
  t.after(() => browser.stop());
  const frame = (overrides = {}) => browser.receive({ method: "Page.screencastFrame", sessionId: browser.sessionId, params: {
    sessionId: 1, data: `jpeg-fixture-${Date.now()}`, metadata: { deviceWidth: 1280, deviceHeight: 800, timestamp: Date.now() / 1000, ...overrides },
  } });
  return { browser, calls, frames, frame };
}

test("native compressed frames reach viewers without a full-resolution capture for each repaint", async t => {
  const { calls, frames, frame } = await fixture(t);
  assert.equal(calls.find(c => c.method === "Page.startScreencast").params.format, "jpeg");
  frame(); assert.equal(frames.length, 1); assert.equal(frames[0].mimeType, "image/jpeg");
  for (let i = 0; i < 30; i++) { t.mock.timers.tick(34); frame(); await tick(); }
  assert.equal(frames.length, 31);
  assert.equal(calls.filter(c => c.method === "Page.captureScreenshot").length, 0);
  assert.equal(calls.filter(c => c.method === "Page.screencastFrameAck").length, 31);
});

test("stale or temporary capture-size frames are acknowledged but never mislabeled", async t => {
  const { calls, frames, frame } = await fixture(t);
  frame({ timestamp: 999 }); frame({ deviceWidth: 2560, deviceHeight: 1600 });
  assert.equal(frames.length, 0);
  assert.equal(calls.filter(c => c.method === "Page.screencastFrameAck").length, 2);
});

test("duplicate native frames do not postpone the idle high-resolution refinement", async t => {
  const { browser, calls } = await fixture(t);
  const frame = () => browser.receive({ method: "Page.screencastFrame", sessionId: browser.sessionId, params: { sessionId: 1, data: "unchanged", metadata: { deviceWidth: 1280, deviceHeight: 800, timestamp: Date.now() / 1000 } } });
  frame();
  for (let index = 0; index < 4; index++) { t.mock.timers.tick(100); frame(); await tick(); }
  assert.equal(calls.filter(c => c.method === "Page.captureScreenshot").length, 1);
});

test("frame throttling delivers the trailing update without waiting for the idle PNG", async t => {
  const { frames, frame } = await fixture(t);
  frame(); t.mock.timers.tick(5); frame(); t.mock.timers.tick(5); frame();
  assert.equal(frames.length, 1);
  t.mock.timers.tick(22); await tick();
  assert.equal(frames.length, 2); assert.equal(frames.at(-1).data, "jpeg-fixture-1000010");
});

test("idle PNG refines once; pending input suppresses expensive capture until its response", async t => {
  const { browser, calls, frames } = await fixture(t);
  const input = Promise.withResolvers(), original = browser.call;
  browser.call = (method, params) => method === "Input.insertText" ? input.promise : original(method, params);
  const typing = browser.command("text", { text: "fixture" });
  t.mock.timers.tick(500); await tick();
  assert.equal(calls.filter(c => c.method === "Page.captureScreenshot").length, 0);
  input.resolve({}); await typing;
  t.mock.timers.tick(349); await tick(); assert.equal(frames.length, 0);
  t.mock.timers.tick(1); await tick();
  assert.equal(calls.filter(c => c.method === "Page.captureScreenshot").length, 1);
  assert.equal(frames[0].mimeType, "image/png");
});

test("closing the viewer discards a pending idle refinement", async t => {
  const { browser, calls } = await fixture(t);
  await browser.watch(false); t.mock.timers.tick(1000); await tick();
  assert.equal(calls.filter(c => c.method === "Page.captureScreenshot").length, 0);
});
