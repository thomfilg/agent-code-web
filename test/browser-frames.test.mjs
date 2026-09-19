import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { sendBrowserFrame } from "../src/browser-frames.mjs";

function socket() {
  const value = new EventEmitter(); value.readyState = 1; value.writes = [];
  value.send = (json, done) => value.writes.push({ frame: JSON.parse(json).value, done });
  return value;
}
test("slow viewers keep only the newest waiting frame and deliver the final refine when drained", () => {
  const viewer = socket(); sendBrowserFrame(viewer, { data: "first" });
  for (let index = 0; index < 100; index++) sendBrowserFrame(viewer, { data: `obsolete-${index}` });
  sendBrowserFrame(viewer, { data: "final PNG" });
  assert.equal(viewer.writes.length, 1);
  viewer.writes[0].done(); assert.equal(viewer.writes.length, 2);
  assert.equal(viewer.writes[1].frame.data, "final PNG");
  viewer.writes[1].done(); assert.equal(viewer.writes.length, 2);
});
test("closed or failed viewer streams discard pending page data without affecting another viewer", () => {
  const first = socket(), second = socket();
  sendBrowserFrame(first, { data: "first" }); sendBrowserFrame(first, { data: "do not deliver after revoke" });
  sendBrowserFrame(second, { data: "separate" });
  first.readyState = 3; first.emit("close"); first.writes[0].done();
  assert.equal(first.writes.length, 1); assert.equal(second.writes[0].frame.data, "separate");
  sendBrowserFrame(second, { data: "do not deliver after error" }); second.writes[0].done(Error("closed"));
  assert.equal(second.writes.length, 1);
});
