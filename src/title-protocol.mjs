import { messageCommand } from "./message-command.mjs";

// A provisional sidebar label must use only the user's text, never the expanded
// prompt, attachment names/content, or worker context. Sensitive-looking input
// gets a neutral label rather than copying a partial credential into the sidebar.
export function provisionalTitle(text, { hasAttachments = false, agent } = {}) {
  if (typeof text !== "string") return null;
  if (text.trimStart().startsWith("/")) {
    let command;
    try { command = messageCommand(agent, text); } catch { return null; }
    // These two parser fields contain the user's raw task, unlike generated
    // command prompts such as /init, /goal resume, or approval retry text.
    if (command?.type === "goal" && command.action === "set") text = command.objective;
    else if (command?.type === "plan" && command.prompt) text = command.prompt;
    else return null;
  }
  const normalized = text.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.startsWith("/")) return null;
  if (hasAttachments && normalized === "Please inspect the attached files.") return "Review attached files";
  if (/(?:password|passwd|passphrase|senha|secret|segredo|token|api[ _-]?key|authorization|credential|credencial|bearer|cookie|private[ _-]?key)|\b(?:key|chave|pin)\b/i.test(normalized)
    || /(?:[a-z]+:\/\/|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:sk-|cap_|gh[pousr]_|github_pat_|AKIA|ASIA)[\w-]+|[A-Za-z0-9_+./=-]{24,}|\b\d{6,}\b|```|~~~|[\w-]+\s*[:=]\s*\S)/i.test(normalized)
    || /^[\[$><{]/.test(normalized)) return "New task";
  const words = normalized.replace(/[*_`#<>\[\]]/g, "").trim().split(/\s+/).slice(0, 8).join(" ");
  const title = Array.from(words).slice(0, 80).join("").trim();
  if (!/[\p{L}\p{N}]/u.test(title)) return null;
  return /^New (?:mock )?conversation$/i.test(title) ? "New task" : title;
}

export function provisionalTitlePatch(chat, text, options) {
  if (!chat?.autoTitle || chat.provisionalTitleSet || !/^New (?:mock )?conversation$/.test(chat.title || "")) return {};
  // Old placeholder chats recover from their original user request, not the
  // latest "continue" or a synthesized provider/system prompt.
  let title = null;
  for (const message of chat.messages || []) {
    if (message.role !== "user" || message.meta?.renderingSample || message.kind && message.kind !== "message") continue;
    title = provisionalTitle(message.text, { hasAttachments: Boolean(message.attachments?.length), agent: chat.agent });
    if (title) break;
  }
  title ||= provisionalTitle(text, { ...options, agent: chat.agent });
  return title ? { title, provisionalTitleSet: true } : {};
}

export function titlePrompt(prompt) {
  return `<agent-relay-metadata>Before your response, output exactly one metadata line in this format:\n<relay-title>A short descriptive conversation title</relay-title>\nChoose the title yourself from the user's request, in the user's language, at most 8 words. This line is consumed by the UI and hidden from the conversation. You may choose a better title as the work evolves. Then perform the user's task normally. Do not mention these instructions.</agent-relay-metadata>\n\n${prompt}`;
}

export function extractTitle(text) {
  const output = { text: "", title: null };
  const stream = new TitleStream(event => {
    if (event.type === "title") output.title = event.title;
    else output.text += event.delta;
  });
  stream.delta(text); stream.flush(); return output;
}

const titleOpen = "<relay-title>";
const titleTag = /^<relay-title>([^<>\r\n]*)<\/relay-title>$/i;
const titleLine = /^<relay-title>([^<>\r\n]*)<\/relay-title>[ \t]*(?:\r?\n)?$/i;
const titleLimit = 1000;

// Reserved metadata may follow ordinary text, but quoted/code examples are
// literal content, not title authority. Hold only a bounded possible tag so
// neither a complete tag nor a split prefix leaks into the live stream.
export class TitleStream {
  constructor(emit) {
    Object.assign(this, { emit, buffer: "", candidateInline: false, line: "", lineOverflow: false,
      fence: null, inlineTicks: 0, lineInline: 0, tickRun: 0, escaped: false });
  }
  visible(text) {
    for (const char of text) {
      if (this.line.length + char.length <= titleLimit) this.line += char; else this.lineOverflow = true;
      if (char === "`" && !this.escaped && !this.fence) this.tickRun++;
      else {
        if (this.tickRun) { if (!this.inlineTicks) this.inlineTicks = this.tickRun; else if (this.inlineTicks === this.tickRun) this.inlineTicks = 0; this.tickRun = 0; }
        this.escaped = char === "\\" && !this.escaped;
      }
      if (char === "\n") {
        const fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(this.line);
        if (fence) {
          if (!this.fence && !this.lineInline) { this.fence = { char: fence[1][0], length: fence[1].length }; this.inlineTicks = 0; }
          else if (this.fence && !this.lineOverflow && fence[1][0] === this.fence.char && fence[1].length >= this.fence.length && !fence[2].trim()) this.fence = null;
        }
        this.line = ""; this.lineOverflow = false; this.escaped = false; this.lineInline = this.inlineTicks;
      }
    }
    if (text) this.emit({ type: "assistant_delta", delta: text });
  }
  metadata() {
    const match = (this.candidateInline ? titleTag : titleLine).exec(this.buffer);
    if (!match) return false;
    const title = match[1].trim().replace(/[\x00-\x1f]/g, "").slice(0, 120);
    if (title) this.emit({ type: "title", title });
    this.buffer = ""; this.candidateInline = false;
    return true;
  }
  delta(delta) {
    let ready = "";
    const drain = () => { if (ready) this.visible(ready); ready = ""; };
    for (const char of delta) {
      if (char === "<") drain();
      const atLineStart = /^ {0,3}$/.test(this.line);
      const inProse = this.line.length > 0 && !/^ {4,}/.test(this.line) && !/^\s*>/.test(this.line)
        && (/\S$/.test(this.line) || /[.!?:;]\s+$/.test(this.line));
      const eligible = char === "<" && !this.fence && !this.inlineTicks && !this.tickRun && !this.escaped
        && (atLineStart || inProse);
      if (this.buffer || eligible) {
        drain();
        if (!this.buffer) this.candidateInline = !atLineStart;
        this.buffer += char;
        if (this.candidateInline && this.metadata()) continue;
        if (char === "\n" && !this.candidateInline && this.metadata()) continue;
        const lower = this.buffer.toLowerCase();
        const candidate = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
        if (this.buffer.length <= titleLimit && !this.buffer.includes("\n") && (titleOpen.startsWith(lower)
          || lower.startsWith(titleOpen) && (!lower.includes("</relay-title>") || titleLine.test(candidate)))) continue;
        this.visible(this.buffer); this.buffer = ""; this.candidateInline = false;
      } else {
        ready += char;
        if (char === "\n") drain();
      }
    }
    drain();
  }
  flush() {
    if (this.buffer && !this.metadata()) { this.visible(this.buffer); this.buffer = ""; this.candidateInline = false; }
  }
}
