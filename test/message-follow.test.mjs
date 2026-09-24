import assert from "node:assert/strict";
import test from "node:test";
import { MessageFollow } from "../public/message-follow.js";

function fixture(t) {
  const listeners = new Map(), frames = new Map(); let frameId = 0, top = 1400, time = 0, reading = false, latest = true, scrolls = 0;
  const scroller = {
    scrollHeight: 2000, clientHeight: 600, clientWidth: 900, children: [{}, {}],
    get scrollTop() { return top; }, set scrollTop(value) { top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value)); },
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
    getBoundingClientRect: () => ({ right: 900 }),
  };
  let observer;
  class Observer {
    constructor(callback) { this.callback = callback; this.observed = []; observer = this; }
    observe(element, options) { this.observed.push(element); this.box = options?.box; }
    disconnect() { this.observed = []; }
  }
  const follow = new MessageFollow({ scroller, atLatest: () => latest, reading: () => reading, setReading: value => { reading = value; },
    onScroll: () => { scrolls++; }, frame: callback => { frames.set(++frameId, callback); return frameId; }, cancelFrame: id => frames.delete(id), Observer, now: () => time,
    scrollable: element => element.overflowY !== "hidden" && element.overflowY !== "clip" });
  t.after(() => follow.close());
  return { follow, scroller, frames, observer, listeners, get reading() { return reading; }, get scrolls() { return scrolls; },
    history(value = true) { reading = value; }, latest(value) { latest = value; }, tick(value = 501) { time += value; },
    event(name, data = {}) { listeners.get(name)?.({ target: scroller, ...data }); },
    flush() { for (let count = 0; frames.size && count < 10; count++) { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); } },
  };
}

test("a resize scroll event retains following and catches delayed content growth", t => {
  const f = fixture(t);
  f.scroller.clientHeight = 300; f.scroller.scrollHeight = 2600;
  f.event("scroll"); assert.equal(f.reading, false); assert.equal(f.scroller.scrollTop, 2300);
  f.scroller.scrollHeight = 3100; f.observer.callback();
  assert.equal(f.scroller.scrollTop, 2800); assert.equal(f.reading, false);
});

test("after-layout pin respects an upward wheel even during continuous render guards", t => {
  const f = fixture(t), render = f.follow.begin();
  f.scroller.scrollHeight += 200; f.follow.end(render);
  f.event("wheel", { deltaY: -300 }); f.scroller.scrollTop -= 300; f.event("scroll");
  assert.equal(f.reading, true); const top = f.scroller.scrollTop;
  for (let index = 0; index < 5; index++) { const next = f.follow.begin(); f.scroller.scrollHeight += 100; f.follow.end(next); }
  f.flush(); f.observer.callback(); assert.equal(f.scroller.scrollTop, top); assert.equal(f.reading, true);
});

test("sibling composer layout is pinned after render without resetting manual history", t => {
  const f = fixture(t), render = f.follow.begin(); f.follow.end(render);
  f.scroller.clientHeight -= 170; f.flush(); assert.equal(f.scroller.scrollTop, 1570);
  f.history(); f.scroller.scrollTop = 500; const history = f.follow.begin(); f.follow.end(history);
  f.scroller.clientHeight -= 100; f.flush(); f.observer.callback(); assert.equal(f.scroller.scrollTop, 500);
});

test("touch and keyboard history intent are honored without intercepting editable controls", t => {
  const f = fixture(t), render = f.follow.begin(); f.follow.end(render);
  f.event("keydown", { key: "ArrowUp", target: { closest: () => ({}) } }); assert.equal(f.reading, false);
  f.event("keydown", { key: "PageUp" }); assert.equal(f.reading, true);
  f.follow.resume(); f.event("touchstart", { touches: [{ clientY: 100 }] });
  f.event("touchmove", { touches: [{ clientY: 180 }] }); assert.equal(f.reading, true);
  f.flush(); assert.equal(f.reading, true);
});

test("a nested scrollable code block does not detach its transcript", t => {
  const f = fixture(t), code = { scrollHeight: 1000, clientHeight: 100, scrollTop: 50, parentElement: f.scroller };
  f.event("wheel", { deltaY: -100, target: code }); assert.equal(f.reading, false);
  code.scrollTop = 0; f.event("wheel", { deltaY: -100, target: code }); assert.equal(f.reading, true);
  f.follow.resume(); code.scrollTop = 50; code.overflowY = "hidden";
  f.event("wheel", { deltaY: -100, target: code }); assert.equal(f.reading, true);
});

test("shrinking history to the viewport cannot silently reattach future streaming output", t => {
  const f = fixture(t); f.history(); f.scroller.scrollTop = 500;
  f.scroller.scrollHeight = 900; f.scroller.scrollTop = 300;
  f.observer.callback(); f.event("scroll"); assert.equal(f.reading, true);
  f.scroller.scrollHeight = 1500; f.observer.callback(); assert.equal(f.scroller.scrollTop, 300);
});

test("pinch zoom and upward gestures in a transcript that cannot scroll stay attached", t => {
  const f = fixture(t); f.event("wheel", { deltaY: -100, ctrlKey: true }); assert.equal(f.reading, false);
  f.scroller.clientWidth = 700; f.observer.callback(); assert.equal(f.reading, false);
  f.scroller.scrollHeight = 100; f.event("wheel", { deltaY: -100 }); assert.equal(f.reading, false);
});

test("downward scrolling resumes only at the actual tail, while explicit latest resets stale input", t => {
  const f = fixture(t); f.history(); f.latest(false); f.event("wheel", { deltaY: 100 }); f.event("scroll");
  assert.equal(f.reading, true);
  f.latest(true); f.event("scroll"); assert.equal(f.reading, false);
  f.event("wheel", { deltaY: -100 }); f.follow.resume();
  const render = f.follow.begin(); f.scroller.scrollHeight += 500; f.follow.end(render); f.flush();
  assert.equal(f.scroller.scrollTop, 1900); assert.equal(f.reading, false);
});

test("scrollbar and ordinary upward scroll detach; render-generated scroll does not paginate", t => {
  const f = fixture(t), render = f.follow.begin(); f.follow.end(render);
  f.event("scroll"); assert.equal(f.scrolls, 0);
  f.event("pointerdown", { button: 0, clientX: 895 }); assert.equal(f.reading, true);
  f.follow.resume(); f.flush(); f.tick(); f.scroller.scrollTop -= 300; f.event("scroll");
  assert.equal(f.reading, true); assert.equal(f.scrolls, 1);
});

test("dragging the scrollbar down to the tail reattaches before the next streamed render", t => {
  const f = fixture(t); f.history(); f.scroller.scrollTop = 700;
  f.event("pointerdown", { button: 0, clientX: 895 });
  f.scroller.scrollTop = f.scroller.scrollHeight; f.event("scroll");
  assert.equal(f.reading, false); const render = f.follow.begin(); assert.equal(render.follow, true);
  f.scroller.scrollHeight += 200; f.follow.end(render); f.flush(); assert.equal(f.scroller.scrollTop, 1600);
});

test("a long exact scrollbar gesture survives render guards until matching release or lifecycle reset", t => {
  const f = fixture(t); f.history(); f.scroller.scrollTop = 700;
  f.event("pointerdown", { button: 0, clientX: 895, pointerId: 12 }); f.tick(1000);
  const render = f.follow.begin(); f.follow.end(render);
  f.event("pointerup", { pointerId: 13 }); assert.equal(f.follow.dragging, true);
  f.scroller.scrollTop = f.scroller.scrollHeight; f.event("scroll"); assert.equal(f.reading, false);
  f.event("pointerup", { pointerId: 12 }); assert.equal(f.follow.dragging, false);
  for (const clear of [() => f.follow.resume(), () => f.follow.begin({ reset: true }), () => f.follow.close()]) {
    f.event("pointerdown", { button: 0, clientX: 895, pointerId: 12 }); assert.equal(f.follow.dragging, true);
    clear(); assert.equal(f.follow.dragging, false);
  }
});

test("chat reset restores following and teardown removes every observer/listener/frame", t => {
  const f = fixture(t); f.history(); f.latest(false);
  const render = f.follow.begin({ reset: true }); f.latest(true); f.follow.end(render);
  assert.equal(f.reading, false); assert.equal(f.observer.observed.length, 3);
  assert.equal(f.observer.box, "border-box");
  f.follow.close(); assert.equal(f.frames.size, 0); assert.equal(f.listeners.size, 0); assert.equal(f.observer.observed.length, 0);
  const top = f.scroller.scrollTop; f.scroller.scrollHeight += 500; f.observer.callback(); assert.equal(f.scroller.scrollTop, top);
});

test("default animation callbacks never invoke native Window APIs with the controller as receiver", t => {
  const oldFrame = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  let scheduled = 0, cancelled = 0;
  globalThis.requestAnimationFrame = function () { assert(!(this instanceof MessageFollow)); scheduled++; return 1; };
  globalThis.cancelAnimationFrame = function () { assert(!(this instanceof MessageFollow)); cancelled++; };
  t.after(() => {
    if (oldFrame === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = oldFrame;
    if (oldCancel === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = oldCancel;
  });
  const f = fixture(t), follow = new MessageFollow({ scroller: f.scroller, atLatest: () => true, reading: () => false,
    setReading() {}, Observer: class { observe() {} disconnect() {} } });
  follow.end(follow.begin()); follow.close(); assert.equal(scheduled, 1); assert.equal(cancelled, 2);
});
