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
const titleClose = "</relay-title>";
const titleTag = /^<relay-title>([^<>\r\n]*)<\/relay-title>$/i;
const titleLimit = 1000;

// The provider can place reserved metadata after ordinary response text. Hold
// only a bounded possible tag so neither a complete tag nor a split prefix is
// exposed to the live stream; everything around it is emitted unchanged.
export class TitleStream {
  constructor(emit) {
    Object.assign(this, { emit, buffer: "", lineHasText: false, candidateAtLineStart: false, trailing: "", hideLineBreak: false });
  }
  visible(text) {
    for (const char of text) {
      if (char === "\n") this.lineHasText = false;
      else if (!/[ \t\r]/.test(char)) this.lineHasText = true;
    }
    if (text) this.emit({ type: "assistant_delta", delta: text });
  }
  metadata() {
    const match = titleTag.exec(this.buffer);
    if (!match) return false;
    const title = match[1].trim().replace(/[\x00-\x1f]/g, "").slice(0, 120);
    if (title) this.emit({ type: "title", title });
    this.buffer = ""; this.hideLineBreak = this.candidateAtLineStart; this.candidateAtLineStart = false; return true;
  }
  delta(delta) {
    let ready = "";
    const drain = () => { if (ready) this.visible(ready); ready = ""; };
    for (const char of delta) {
      if (this.hideLineBreak) {
        if (/[ \t\r]/.test(char)) { this.trailing += char; continue; }
        if (char === "\n") { this.trailing = ""; this.hideLineBreak = false; continue; }
        this.visible(this.trailing); this.trailing = ""; this.hideLineBreak = false;
      }
      if (char === "<") drain();
      if (this.buffer || char === "<") {
        drain();
        if (!this.buffer) this.candidateAtLineStart = !this.lineHasText;
        this.buffer += char;
        const lower = this.buffer.toLowerCase();
        if (this.metadata()) continue;
        const body = lower.startsWith(titleOpen) ? lower.slice(titleOpen.length) : "";
        const close = body.indexOf("<");
        const possible = titleOpen.startsWith(lower) || lower.startsWith(titleOpen) && this.buffer.length <= titleLimit
          && !/[>\r\n]/.test(body.slice(0, close < 0 ? undefined : close))
          && (close < 0 || titleClose.startsWith(body.slice(close)));
        if (possible) continue;
        this.visible(this.buffer); this.buffer = ""; this.candidateAtLineStart = false;
      } else {
        ready += char;
      }
    }
    drain();
  }
  flush() {
    if (this.buffer && !this.metadata()) { this.visible(this.buffer); this.buffer = ""; }
    this.trailing = ""; this.hideLineBreak = false;
  }
}
