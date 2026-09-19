import { extractResponse } from "./response-protocol.mjs";
import { redact } from "./utils.mjs";
import { companyForChat } from "../public/company-scope.js";
import { FINAL_ANSWER_LIMIT as limit, finalAnswerText, completedAnswerText, excludedMessage } from "../public/completed-answer.js";

// Only explicit final projections enter this feature. Never infer a final
// answer from a transcript role, a missing commentary flag, or the last item.
export function finalAnswerMeta(answer, agent) {
  if (finalAnswerText(answer, agent) === null) return {};
  const text = extractResponse(redact(answer.text), false).text;
  return text.trim() ? { finalAnswer: { version: 1, source: answer.source, text } } : {};
}
export function claudeFinalAnswer(event, sessionId) {
  if (!sessionId || event?.session_id !== sessionId || event.type !== "result" || event.subtype !== "success" || event.is_error !== false
    || event.parent_tool_use_id || (event.origin && event.origin.kind !== "human") || event.relayWorkflowInterrupted || !Number.isInteger(event.num_turns) || event.num_turns < 1
    || (event.terminal_reason !== undefined && event.terminal_reason !== "completed")
    || event.stop_reason !== "end_turn" || typeof event.result !== "string" || event.result.length > limit) return null;
  return { source: "claude-success-result", text: event.result };
}
export function captureCodexFinal(current, params, threadId, clean) {
  if (!current?.turnId || params.threadId !== threadId || params.turnId !== current.turnId || params.item?.type !== "agentMessage" || typeof params.item.id !== "string") return;
  current.searchAnswers ||= new Map();
  current.searchAnswers.delete(params.item.id);
  if (params.item.phase !== "final_answer" || typeof params.item.text !== "string") return;
  // Redact before applying any output bound. Never retain reasoning/unknown
  // items in this collection, even transiently.
  const text = clean(params.item.text);
  if (text.length <= limit && current.searchAnswers.size < 100) current.searchAnswers.set(params.item.id, text);
}
export function codexFinalAnswer(current, params, threadId) {
  if (!current?.turnId || current.interruptRequested || params.threadId !== threadId || params.turn?.id !== current.turnId || params.turn.status !== "completed") return null;
  const text = [...(current.searchAnswers?.values() || [])].join("\n\n");
  return text && text.length <= limit ? { source: "codex-final-answer", text } : null;
}
export function searchableText(message) {
  const meta = message.meta || {};
  if (excludedMessage(message)) return null;
  if (message.role === "user" && message.kind === "message" && (!meta.source || meta.source === "user") && (!meta.authorship || meta.authorship === "user")) return typeof message.text === "string" ? message.text : null;
  if (completedAnswerText(message) === null) return null;
  return finalAnswerMeta(meta.finalAnswer, message.agent).finalAnswer?.text || null;
}
const fail = message => Object.assign(Error(message), { statusCode: 400 });
export function searchMessages(chats, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Enter a search of 1–200 characters.");
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200) throw fail("Enter a search of 1–200 characters.");
  if (input.role !== undefined && !["all", "user", "assistant"].includes(input.role)) throw fail("Choose messages, answers, or both.");
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw fail("Restart this search from its first page.");
  const query = input.query.trim().toLowerCase(), role = input.role || "all", results = [];
  let position = 0, unknownAnswers = 0, scanned = 0, bytes = 0, truncated = false;
  const ordered = [...chats].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
  outer: for (const chat of ordered) {
    // Cursor counts examined records, not matches: even a page with no hits
    // can continue into old history without an unbounded rescan.
    if (position + chat.messages.length <= offset) { position += chat.messages.length; continue; }
    for (let index = chat.messages.length - 1 - Math.max(0, offset - position); index >= 0; index--) {
      position = Math.max(position, offset);
      if (scanned >= 5000 || bytes >= 4000000 || results.length >= 40) { truncated = true; break outer; }
      const message = chat.messages[index]; position++; scanned++;
      const text = searchableText(message);
      if (text === null) { if (message.role === "assistant" && message.kind === "message" && !message.meta?.commentary && !message.meta?.renderingSample) unknownAnswers++; continue; }
      if (role !== "all" && message.role !== role) continue;
      bytes += text.length;
      const matchAt = text.toLowerCase().indexOf(query); if (matchAt < 0) continue;
      const start = Math.max(0, matchAt - 80), end = Math.min(text.length, matchAt + query.length + 160);
      results.push({ chatId: chat.id, messageId: message.id, title: chat.title, companyId: companyForChat(chat), repository: chat.repositories?.[0]?.fullName || null,
        role: message.role, createdAt: message.createdAt, excerpt: text.slice(start, end), leading: start > 0, trailing: end < text.length });
    }
  }
  return { results, nextOffset: truncated ? position : null,
    truncated, unknownAnswers, coverage: "Only user messages and explicitly identified final answers are searched. Older or unclassified answers, tools and intermediate output are excluded." };
}
