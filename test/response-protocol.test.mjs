import assert from "node:assert/strict";
import test from "node:test";
import { extractResponse, ResponseStream } from "../src/response-protocol.mjs";
import { extractTitle, TitleStream } from "../src/title-protocol.mjs";

const streamedText = events => events.filter(event => event.type === "assistant_delta").map(event => event.delta).join("");

test("relay titles appended to ordinary text stay out of every streamed chunk", () => {
  const source = "The answer.<relay-title>Fix billing flow</relay-title> More detail.";
  for (let split = 0; split <= source.length; split++) {
    const events = [];
    const stream = new TitleStream(event => events.push(event));
    stream.delta(source.slice(0, split)); stream.delta(source.slice(split)); stream.flush();
    assert.equal(streamedText(events), "The answer. More detail.");
    assert.deepEqual(events.filter(event => event.type === "title").map(event => event.title), ["Fix billing flow"]);
  }

  const events = [];
  const stream = new TitleStream(event => events.push(event));
  for (const character of source) stream.delta(character);
  stream.flush();
  assert.equal(streamedText(events), "The answer. More detail.");

  assert.equal(extractTitle("<relay-title>Fix billing flow</relay-title>\nThe answer.").text, "The answer.");
});

test("response parsing strips appended titles from live and saved text without changing other content", () => {
  const source = "First line.<relay-title>Choose a branch</relay-title>\nKeep this detail.\n<relay-waiting>yes</relay-waiting>";
  for (const automaticTitle of [true, false]) {
    for (let split = 0; split <= source.length; split++) {
      const events = [];
      const stream = new ResponseStream(event => events.push(event), automaticTitle);
      stream.delta(source.slice(0, split)); stream.delta(source.slice(split)); stream.flush();
      assert.equal(streamedText(events), "First line.\nKeep this detail.\n");
      assert.equal(events.filter(event => event.type === "title").length, automaticTitle ? 1 : 0);
    }
    const saved = extractResponse(source, automaticTitle);
    assert.equal(saved.text, "First line.\nKeep this detail.");
    assert.equal(saved.awaitingUser, true);
    assert.equal(saved.title, automaticTitle ? "Choose a branch" : null);
  }
});

test("unfinished title-like text remains ordinary response content", () => {
  const source = "Keep <relay-title>an unfinished title";
  assert.equal(extractTitle(source).text, source);
});
