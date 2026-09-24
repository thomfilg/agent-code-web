import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeTextStream } from "../src/claude-text-stream.mjs";
import { SecretTextStream } from "../src/secret-text-stream.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";

const delta = text => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const secret = "fixture-private-native-token";

test("every credential split is redacted before live output and the saved text cache", () => {
  for (let split = 1; split < secret.length; split++) {
    const deltas = [], stream = new ClaudeTextStream(text => deltas.push(text), { secrets: new Set([secret]) });
    stream.accept(delta(`before ${secret.slice(0, split)}`));
    assert.equal(deltas.join(""), "before ", `unverified credential prefix escaped at ${split}`);
    stream.accept(delta(`${secret.slice(split)} after`));
    stream.accept({ type: "result", result: `before ${secret} after` });
    assert.equal(deltas.join(""), "before [redacted] after");
    assert.equal(stream.text, deltas.join(""));
  }
});

test("single-character chunks, overlapping credentials and refresh retain one safe output", () => {
  const secrets = new Set([secret]), stream = new SecretTextStream(secrets);
  let output = "";
  for (const character of `A ${secret} B `) output += stream.push(character);
  const rotated = "rotated-private-native-token"; secrets.add(rotated);
  for (const character of `${rotated} C ${secret} D`) output += stream.push(character);
  output += stream.finish();
  assert.equal(output, "A [redacted] B [redacted] C [redacted] D");
  assert.equal(stream.push(secret), ""); assert.equal(stream.finish(), "");
  const overlap = new SecretTextStream(new Set(["private", "private-long-value"]));
  assert.equal(overlap.push("private-long-value private ") + overlap.finish(), "[redacted] [redacted] ");
  for (let split = 1; split < "private-long-value".length; split++) {
    const overlapping = new SecretTextStream(new Set(["private", "private-long-value"]));
    assert.equal(overlapping.push("private-long-value".slice(0, split)), "");
    assert.equal(overlapping.push("private-long-value".slice(split) + " ") + overlapping.finish(), "[redacted] ");
  }
});

test("provider-shaped historical tokens are also masked consistently in live and saved output at every split", () => {
  const unknown = "sk-ant-other-private-token-value";
  for (let split = 1; split < unknown.length; split++) {
    const deltas = [], stream = new ClaudeTextStream(text => deltas.push(text), { secrets: new Set([secret]) });
    stream.accept(delta(unknown.slice(0, split))); stream.accept(delta(unknown.slice(split) + " done")); stream.finish();
    assert.equal(deltas.join(""), "[redacted] done"); assert.equal(stream.text, deltas.join(""));
  }
  const long = new SecretTextStream(new Set(), { tokenPrefix: "sk-ant-" });
  assert.equal(long.push("sk-ant-" + "x".repeat(2_000_000)), "[redacted]");
  assert.equal(long.push("y".repeat(2_000_000) + " end") + long.finish(), " end");
  for (let split = 1; split < unknown.length; split++) {
    const overlapping = new SecretTextStream(new Set(["sk-ant-other-private"]), { tokenPrefix: "sk-ant-" });
    assert.equal(overlapping.push(unknown.slice(0, split)) + overlapping.push(unknown.slice(split) + " done") + overlapping.finish(), "[redacted] done");
  }
});

test("success, failed result, explicit shutdown and new message never flush a pending credential prefix", () => {
  const start = id => ({ type: "stream_event", event: { type: "message_start", message: { id } } });
  for (const ending of ["success", "error", "finish", "message_stop", "message_start"]) {
    for (let split = 1; split < secret.length; split++) {
      const deltas = [], stream = new ClaudeTextStream(text => deltas.push(text), { secrets: new Set([secret]) });
      stream.accept(start("first")); stream.accept(delta(`prefix ${secret.slice(0, split)}`));
      assert.equal(stream.text, "prefix ");
      if (ending === "success") stream.accept({ type: "result", result: "done" });
      if (ending === "error") stream.accept({ type: "result", is_error: true, result: "failed" });
      if (ending === "message_stop") stream.accept({ type: "stream_event", event: { type: "message_stop" } });
      if (ending === "message_start") stream.accept(start("next"));
      stream.finish(); assert.equal(stream.text, "prefix [redacted]");
      assert.equal(deltas.join(""), stream.text);
      stream.accept(delta(secret.slice(split))); assert.equal(stream.text, "prefix [redacted]");
    }
  }
});

test("content-block boundaries and complete native replay deduplicate raw text without caching credentials publicly", () => {
  const deltas = [], stream = new ClaudeTextStream(text => deltas.push(text), { secrets: new Set([secret]) });
  const assistant = (uuid, text) => ({ type: "assistant", uuid, message: { id: "message", content: [{ type: "text", text }] } });
  const split = 13;
  stream.accept({ type: "stream_event", event: { type: "message_start", message: { id: "message" } } });
  stream.accept(delta(secret.slice(0, split)));
  stream.accept(assistant("first", secret.slice(0, split)));
  stream.accept({ type: "stream_event", event: { type: "content_block_start", index: 1 } });
  stream.accept(delta(secret.slice(split)));
  stream.accept(assistant("second", secret.slice(split)));
  stream.accept(assistant("all", secret)); stream.accept(assistant("all", secret));
  stream.accept({ type: "result", result: secret });
  assert.equal(stream.text, "[redacted]"); assert.equal(deltas.join(""), "[redacted]");
  assert.doesNotMatch(JSON.stringify(stream), new RegExp(secret));
  const empty = new ClaudeTextStream(() => {}, { secrets: new Set([secret]) });
  empty.accept({ type: "result", result: "" }); empty.accept(delta(secret)); empty.finish();
  assert.equal(empty.text, "[redacted]");
});

test("large streams release unrelated bytes immediately and retain only the matching suffix", () => {
  const stream = new SecretTextStream(new Set([secret]));
  assert.equal(stream.push("x".repeat(2_000_000) + secret.slice(0, 20)), "x".repeat(2_000_000));
  assert.equal(stream.push(secret.slice(20)) + stream.finish(), "[redacted]");
});

test("background responses and renewed credential events share the same safe cache", () => {
  const adapter = Object.create(ClaudeAdapter.prototype), events = [];
  adapter.nativeAuthMode = "account"; adapter.accountSecrets = new Set([secret]); adapter.hooks = { onEvent: event => events.push(event) };
  adapter.backgroundEvent(delta(secret.slice(0, 15))); assert.equal(adapter.backgroundOutput.text, "");
  adapter.backgroundEvent(delta(secret.slice(15)));
  const rotated = "next-private-native-token"; adapter.accountSecrets.add(rotated);
  adapter.backgroundEvent(delta(" ")); for (const part of rotated) adapter.backgroundEvent(delta(part));
  adapter.backgroundEvent({ type: "result", result: `${secret} ${rotated}` });
  assert.equal(events.find(event => event.type === "background_response").text, "[redacted] [redacted]");
  assert.equal(adapter.backgroundOutput, null);
  assert.doesNotMatch(JSON.stringify(events), /fixture-private-native-token|next-private-native-token/);
  assert.equal(adapter.redactAccount({ nested: { command: JSON.stringify({ value: secret }) } }).nested.command, '{"value":"[redacted]"}');
});
