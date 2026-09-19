import assert from "node:assert/strict";
import test from "node:test";
import { SharedBrowserPanel } from "../public/shared-browser.js";

function panel(version = 1) {
  const calls = [], errors = [];
  const view = Object.assign(Object.create(SharedBrowserPanel.prototype), {
    socket: {}, mode: "guest", captureVersion: version, tabId: "current-tab", resizeQueue: Promise.resolve(), resizeVersion: 0,
    request: async (action, params) => { calls.push({ action, params }); }, status: message => errors.push(message),
  });
  view.input = { push: (...args) => view.request(...args) };
  return { view, calls, errors };
}

test("resizing a pre-upgrade worker refreshes capture on the same tab, without navigation or a new tab", async () => {
  const { view, calls } = panel();
  for (const [width, height] of [[390, 844], [640, 960], [834, 1112], [1280, 800], [1920, 1080]]) await view.resize(width, height);
  assert.equal(calls.length, 10);
  for (let i = 0; i < calls.length; i += 2) {
    assert.equal(calls[i].action, "resize");
    assert.deepEqual(calls[i + 1], { action: "selectTab", params: { id: "current-tab" } });
  }
});

test("upgraded workers refresh capture themselves and need no redundant tab reattachment", async () => {
  const { view, calls } = panel(2); await view.resize(834, 1112);
  assert.deepEqual(calls, [{ action: "resize", params: { width: 834, height: 1112 } }]);
});

test("rapid resize selections only apply the latest pending viewport and never affect another connection", async () => {
  const { view, calls } = panel();
  await Promise.all([view.resize(640, 960), view.resize(834, 1112), view.resize(1920, 1080)]);
  assert.deepEqual(calls, [{ action: "resize", params: { width: 1920, height: 1080 } }, { action: "selectTab", params: { id: "current-tab" } }]);
  calls.length = 0;
  const pending = view.resize(390, 844); view.socket = {}; await pending;
  assert.deepEqual(calls, []);
});

test("a failed resize reports the error without navigating or recreating the user's tab", async () => {
  const { view, calls, errors } = panel(); view.request = async () => { throw Error("Fixture resize failed"); };
  await view.resize(640, 960); assert.deepEqual(errors, ["Fixture resize failed"]); assert.deepEqual(calls, []);
});

test("JPEG/PNG transitions keep canvas geometry stable, and a mismatched old surface is discarded", async t => {
  const previous = globalThis.Image, images = [], draws = [];
  globalThis.Image = class { constructor() { images.push(this); } };
  t.after(() => { globalThis.Image = previous; });
  const view = Object.assign(Object.create(SharedBrowserPanel.prototype), { connected: true, captureVersion: 3, frameVersion: 1,
    canvas: { width: 0, height: 0, dataset: {}, style: {} }, context: { drawImage: (...args) => draws.push(args) } });
  const deliver = (mimeType, width, height) => {
    view.paint({ data: "fixture", mimeType, width: 390, height: 844 });
    const current = images.at(-1); current.naturalWidth = width; current.naturalHeight = height; current.onload();
  };
  deliver("image/jpeg", 390, 844);
  assert.deepEqual([view.canvas.width, view.canvas.height], [780, 1688]);
  deliver("image/png", 780, 1688);
  assert.deepEqual([view.canvas.width, view.canvas.height], [780, 1688]);
  deliver("image/jpeg", 390, 244);
  assert.equal(draws.length, 2); assert.equal(view.canvas.dataset.frameFormat, "image/png");
  assert.deepEqual(view.frameViewport, { width: 390, height: 844 });
  assert.deepEqual(draws.at(-1).slice(1), [0, 0, 780, 1688]);
});
