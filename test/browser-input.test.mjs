import assert from "node:assert/strict";
import test from "node:test";
import { BrowserInputQueue } from "../public/browser-input.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(limit = 2) {
  const sent = [], frames = new Map(); let sequence = 0;
  const queue = new BrowserInputQueue((action, params) => {
    const result = Promise.withResolvers(); sent.push({ action, params, ...result }); return result.promise;
  }, { limit, schedule: callback => { frames.set(++sequence, callback); return sequence; }, cancel: id => frames.delete(id) });
  return { queue, sent, frame: () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); } };
}

test("input window bounds outstanding requests and preserves key/copy order without one RTT per key", async () => {
  const { queue, sent } = fixture();
  const results = [queue.push("key", { key: "a" }), queue.push("key", { key: "b" }), queue.push("copy")];
  assert.deepEqual(sent.map(s => s.action), ["key", "key"]);
  sent[0].resolve({}); await tick();
  assert.deepEqual(sent.map(s => s.action), ["key", "key"], "copy waits until earlier selection keys are acknowledged");
  sent[1].resolve({}); await tick();
  assert.deepEqual(sent.map(s => s.action), ["key", "key", "copy"]);
  sent[2].resolve({ text: "ab" });
  assert.deepEqual(await Promise.all(results), [{}, {}, { text: "ab" }]);
});

test("only adjacent unsent motion coalesces; final drag position precedes mouse release", async () => {
  const { queue, sent, frame } = fixture();
  const results = [];
  for (let x = 1; x <= 100; x++) results.push(queue.push("mouse", { type: "mouseMoved", x, y: 10, buttons: 1 }));
  assert.equal(sent.length, 0);
  results.push(queue.push("mouse", { type: "mouseReleased", x: 100, y: 10, buttons: 0 }));
  frame(); assert.equal(sent.length, 2);
  assert.equal(sent[0].params.x, 100); assert.equal(sent[1].params.type, "mouseReleased");
  for (const item of sent) item.resolve({}); await Promise.all(results);
});

test("wheel deltas accumulate without crossing modifiers, key barriers or backend size bounds", async () => {
  const { queue, sent, frame } = fixture(12), results = [];
  const wheel = (deltaY, modifiers = 0) => results.push(queue.push("mouse", { type: "mouseWheel", deltaX: 0, deltaY, modifiers }));
  wheel(10); wheel(20); wheel(1, 2); wheel(3000); wheel(1);
  results.push(queue.push("key", { key: "a" })); wheel(-1); frame();
  assert.deepEqual(sent.filter(s => s.action === "mouse").map(s => s.params.deltaY), [30, 1, 3000, 1, -1]);
  assert.equal(sent[4].action, "key");
  for (const item of sent) item.resolve({}); await Promise.all(results);
});

test("disconnect rejects pending input and late acknowledgements cannot replay it in another chat", async () => {
  const { queue, sent, frame } = fixture(1);
  const first = queue.push("key", { key: "a" }), second = queue.push("text", { text: "private fixture" });
  const rejected = [assert.rejects(first, /connection changed/), assert.rejects(second, /connection changed/)];
  queue.reset(); const next = queue.push("key", { key: "new chat" });
  sent[0].resolve({}); await tick(); frame();
  assert.equal(sent.length, 2); assert.equal(sent[1].params.key, "new chat");
  sent[1].resolve({}); await Promise.all([...rejected, next]);
});

test("one failed input does not stall subsequent commands", async () => {
  const { queue, sent } = fixture(1);
  const first = queue.push("key", {}), next = queue.push("key", { key: "next" });
  const rejected = assert.rejects(first, /fixture failure/); sent[0].reject(Error("fixture failure"));
  await tick(); assert.equal(sent.length, 2); sent[1].resolve({}); await Promise.all([rejected, next]);
});

test("tab/navigation/resize barriers prevent later input from overtaking a page change", async () => {
  const { queue, sent } = fixture(12);
  const actions = [queue.push("resize", { width: 390, height: 844 }), queue.push("mouse", { type: "mousePressed", x: 10, y: 20 })];
  assert.deepEqual(sent.map(item => item.action), ["resize"]);
  sent[0].resolve({}); await tick(); assert.deepEqual(sent.map(item => item.action), ["resize", "mouse"]);
  sent[1].resolve({}); await Promise.all(actions);
});

test("a slow connection retains the last wheel position and never exceeds its input window", async () => {
  const { queue, sent, frame } = fixture(12), results = [];
  for (let key = 0; key < 24; key++) results.push(queue.push("key", { key: String(key) }));
  for (let y = 0; y < 500; y++) results.push(queue.push("mouse", { type: "mouseWheel", x: 10, y, deltaY: 1, deltaX: 0 }));
  frame(); assert.equal(sent.length, 12);
  for (let completed = 0; completed < 25; completed++) { sent[completed].resolve({}); await tick(); assert.ok(queue.active <= 12); }
  await Promise.all(results);
  assert.equal(sent.length, 25); assert.equal(sent.at(-1).params.y, 499); assert.equal(sent.at(-1).params.deltaY, 500);
});
