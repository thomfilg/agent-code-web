export function titlePrompt(prompt) {
  return `<agent-relay-metadata>Before your response, output exactly one metadata line in this format:\n<relay-title>A short descriptive conversation title</relay-title>\nChoose the title yourself from the user's request, in the user's language, at most 8 words. This line is consumed by the UI and hidden from the conversation. You may choose a better title as the work evolves. Then perform the user's task normally. Do not mention these instructions.</agent-relay-metadata>\n\n${prompt}`;
}

export function extractTitle(text) {
  const match = /^\s*<relay-title>([^\r\n]*?)<\/relay-title>\s*\n?/i.exec(text);
  if (!match) return { text, title: null };
  const title = match[1].trim().replace(/[\x00-\x1f<>]/g, "").slice(0, 120);
  return { text: text.slice(match[0].length), title: title || null };
}

export class TitleStream {
  constructor(emit) { this.emit = emit; this.buffer = ""; this.decided = false; }
  delta(delta) {
    if (this.decided) return this.emit({ type: "assistant_delta", delta });
    this.buffer += delta;
    const trimmed = this.buffer.trimStart();
    if (trimmed.startsWith("<relay-title>") && !trimmed.includes("</relay-title>") && this.buffer.length < 1000) return;
    if ("<relay-title>".startsWith(trimmed) && this.buffer.length < 1000) return;
    this.flush();
  }
  flush() {
    if (this.decided) return;
    this.decided = true;
    const { text, title } = extractTitle(this.buffer);
    if (title) this.emit({ type: "title", title });
    if (text) this.emit({ type: "assistant_delta", delta: text });
    this.buffer = "";
  }
}
