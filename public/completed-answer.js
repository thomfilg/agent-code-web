const sources = new Map([["codex-final-answer", "codex"], ["claude-success-result", "claude"], ["mock-final-answer", "mock"]]);
export const FINAL_ANSWER_LIMIT = 100000;

// Provenance is supplied by the native result adapter, never inferred from
// display text or from being the last assistant message in the transcript.
export function finalAnswerText(answer, agent) {
  return answer && sources.has(answer.source) && sources.get(answer.source) === agent && typeof answer.text === "string"
    && answer.text.length <= FINAL_ANSWER_LIMIT && answer.text.trim() ? answer.text : null;
}
export function excludedMessage(message) {
  const meta = message.meta || {};
  return Boolean(meta.renderingSample || meta.source === "github" || meta.githubEventId || meta.generated || meta.interrupted || meta.commentary);
}
export function completedAnswerText(message) {
  if (excludedMessage(message) || message.role !== "assistant" || message.kind !== "message" || message.meta?.finalAnswer?.version !== 1) return null;
  return finalAnswerText(message.meta.finalAnswer, message.agent);
}
export function latestCompletedAnswer(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = completedAnswerText(messages[i]);
    if (text !== null) return text;
  }
  return null;
}
