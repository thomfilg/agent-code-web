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
    const trimmed = this.buffer.trimStart().toLowerCase();
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
