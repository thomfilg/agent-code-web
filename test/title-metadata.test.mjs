import test from "node:test";
import assert from "node:assert/strict";
import { extractTitle, TitleStream } from "../src/title-protocol.mjs";
import { extractResponse, ResponseStream } from "../src/response-protocol.mjs";

const tag = "<relay-title>Private metadata title</relay-title>";
const streamed = (source, split, automaticTitle) => {
  const events = [], stream = new ResponseStream(event => events.push(event), automaticTitle);
  stream.delta(source.slice(0, split)); stream.delta(source.slice(split)); stream.flush();
  return { text: events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), titles: events.filter(event => event.type === "title").map(event => event.title) };
};

test("standalone metadata stays hidden after commentary and with manual titles across every chunk split", () => {
  for (const source of [`${tag}\nAnswer`, `Checking the implementation.\n\n${tag}\nAnswer`, `Checking.\n${tag.toUpperCase()}\r\nAnswer`, `Answer\n${tag}`]) {
    const parsed = extractTitle(source);
    assert.doesNotMatch(parsed.text, /relay-title/i);
    for (const automaticTitle of [true, false]) {
      const complete = extractResponse(source, automaticTitle);
      assert.equal(complete.text, parsed.text.trimEnd());
      assert.equal(complete.title, automaticTitle ? parsed.title : null);
      for (let split = 0; split <= source.length; split++) {
        const result = streamed(source, split, automaticTitle);
        assert.equal(result.text, parsed.text, `${automaticTitle}:${split}`);
        assert.deepEqual(result.titles, automaticTitle ? [parsed.title] : []);
      }
    }
  }
});

test("quoted, inline and fenced examples remain literal and never provide title authority", () => {
  for (const source of [
    `The protocol uses ${tag} in its output.`, `\`${tag}\``, `> ${tag}\nQuoted example`, `    ${tag}\nIndented code`,
    `\\${tag}`, `${tag} is an example, not metadata.`,
    `\`\`\`xml\n${tag}\n\`\`\`\nAnswer`, `~~~xml\n${tag}\n~~~\nAnswer`,
    `\`\`\`\`xml\n\`\`\`\n${tag}\n\`\`\`\`\nAnswer`,
    `An inline code span: \`first line\n${tag}\nlast line\`.`,
  ]) {
    assert.deepEqual(extractTitle(source), { text: source, title: null });
    for (let split = 0; split <= source.length; split++) {
      assert.deepEqual(streamed(source, split, true), { text: source, titles: [] }, `${source}:${split}`);
    }
  }
});

test("parser keeps fence context across tool flushes and resumes metadata recognition after the fence", () => {
  const events = [], stream = new TitleStream(event => events.push(event));
  stream.delta("Example:\n```xml\n"); stream.flush();
  stream.delta(`${tag}\n`); stream.flush();
  stream.delta(`\`\`\`\n${tag}\nDone`); stream.flush();
  assert.equal(events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), `Example:\n\`\`\`xml\n${tag}\n\`\`\`\nDone`);
  assert.deepEqual(events.filter(event => event.type === "title").map(event => event.title), ["Private metadata title"]);
});

test("ordinary text streams immediately and malformed or oversized metadata is bounded and literal", () => {
  const events = [], stream = new TitleStream(event => events.push(event));
  stream.delta("Ordinary text without newline");
  assert.equal(events[0].delta, "Ordinary text without newline");
  for (const source of ["<relay-title>unfinished", "<relay-title>\nmultiline</relay-title>", `<relay-title>${"x".repeat(1500)}</relay-title>\nAnswer`, "<relay-title><nested>literal</nested></relay-title>\nAnswer"]) {
    const chunks = [], parser = new TitleStream(event => chunks.push(event));
    for (const char of source) { parser.delta(char); assert(parser.buffer.length <= 1000); }
    parser.flush();
    assert.equal(chunks.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), source);
    assert.equal(chunks.filter(event => event.type === "title").length, 0);
    assert.deepEqual(extractTitle(source), { text: source, title: null });
  }
});

test("long fence info lines remain code, without buffering the whole response", () => {
  const source = `\`\`\`xml ${"x".repeat(2000)}\n${tag}\n\`\`\`\nAnswer`;
  const events = [], stream = new TitleStream(event => events.push(event));
  for (const char of source) { stream.delta(char); assert(stream.line.length <= 1000); }
  stream.flush();
  assert.equal(events.map(event => event.delta).join(""), source);
  assert.deepEqual(extractTitle(source), { text: source, title: null });
});
