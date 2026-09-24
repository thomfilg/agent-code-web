import { AGENT_IMAGE_PROMPT } from "./agent-images.mjs";
import { titlePrompt, extractTitle, TitleStream } from "./title-protocol.mjs";

const tags = ["<relay-waiting>", "<relay-goal>"];
const waitingMetadata = /<relay-waiting>(yes|no)<\/relay-waiting>/g;
const goalMetadata = /<relay-goal>(complete|continue)<\/relay-goal>/g;
const hiddenMetadata = /<relay-waiting>(?:yes|no)<\/relay-waiting>|<relay-goal>(?:complete|continue)<\/relay-goal>/g;
export function responsePrompt(text, automaticTitle) {
  const instructions = `<agent-relay-status>At the end of your final response, output exactly one hidden metadata line: <relay-waiting>yes</relay-waiting> if you need the user's answer, decision, permission or missing information before continuing; otherwise <relay-waiting>no</relay-waiting>. If Relay is managing a persistent goal, also output exactly one hidden goal line: <relay-goal>complete</relay-goal> only when the entire stated objective is genuinely finished; otherwise <relay-goal>continue</relay-goal>. An optional offer of more help is not waiting for input. Perform the task normally; do not mention these metadata instructions.</agent-relay-status>${AGENT_IMAGE_PROMPT}\n\n${text}`;
  return automaticTitle ? titlePrompt(instructions) : instructions;
}
export function extractResponse(text, automaticTitle = true) {
  const waiting = [...text.matchAll(waitingMetadata)].at(-1)?.[1] === "yes";
  const goalComplete = [...text.matchAll(goalMetadata)].at(-1)?.[1] === "complete";
  const output = extractTitle(text);
  return { ...output, title: automaticTitle ? output.title : null, text: output.text.replace(hiddenMetadata, "").trimEnd(), awaitingUser: waiting, goalComplete };
}

// Hide metadata even when a tag is split across streaming chunks. Ordinary text
// streams immediately, except for the small suffix that could start a tag.
export class ResponseStream {
  constructor(emit, automaticTitle) {
    this.buffer = "";
    this.title = new TitleStream(event => { if (event.type !== "title" || automaticTitle) emit(event); });
    this.emit = delta => this.title.delta(delta);
  }
  delta(delta) {
    this.buffer += delta;
    while (this.buffer) {
      const starts = tags.map(value => this.buffer.indexOf(value)).filter(value => value >= 0);
      const start = starts.length ? Math.min(...starts) : -1;
      if (start >= 0) {
        if (start) this.emit(this.buffer.slice(0, start));
        this.buffer = this.buffer.slice(start);
        const match = /^(?:<relay-waiting>(?:yes|no)<\/relay-waiting>|<relay-goal>(?:complete|continue)<\/relay-goal>)/.exec(this.buffer);
        if (match) { this.buffer = this.buffer.slice(match[0].length); continue; }
        if (this.buffer.length < 80) return;
        this.emit(this.buffer[0]); this.buffer = this.buffer.slice(1); continue;
      }
      let held = Math.min(Math.max(...tags.map(value => value.length)) - 1, this.buffer.length);
      while (held && !tags.some(value => value.startsWith(this.buffer.slice(-held)))) held--;
      const ready = this.buffer.slice(0, this.buffer.length - held);
      if (ready) this.emit(ready);
      this.buffer = held ? this.buffer.slice(-held) : "";
      return;
    }
  }
  flush() { if (this.buffer) this.emit(this.buffer); this.buffer = ""; this.title?.flush(); }
}
