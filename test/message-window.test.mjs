import assert from "node:assert/strict";
import test from "node:test";
import { MessageWindow } from "../public/message-window.js";

test("long chat rendering stays bounded while allowing oldest, middle and latest navigation", () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ id: String(i) })), window = new MessageWindow(60);
  assert.equal(window.update("one", rows)[0].id, "540"); assert.equal(window.end, 600);
  assert.equal(window.show("0"), true); assert.equal(window.update("one", rows).length, 60); assert.equal(window.start, 0);
  window.show("250"); assert.ok(window.update("one", rows).some(r => r.id === "250"));
  const before = window.start; window.update("one", [...rows, { id: "new" }]); assert.equal(window.start, before);
  window.move(-1); assert.equal(window.update("one", rows).length, 60);
  window.latest(); assert.equal(window.update("one", rows).at(-1).id, "599");
  window.update("empty", []); assert.equal(window.start, 0); assert.equal(window.end, 0);
  assert.equal(window.show("missing"), false);
});
