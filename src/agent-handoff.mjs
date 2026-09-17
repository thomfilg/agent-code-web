// The workspace and visible chat stay shared; provider-native session IDs do not.
export function handoffPrompt(chat, prompt) {
  if (!chat.needsAgentHandoff) return prompt;
  const messages = chat.messages.slice(0, -1).filter(message => !message.meta?.renderingSample && ["user", "assistant", "tool"].includes(message.role));
  const history = []; let remaining = 80000;
  for (const message of [...messages].reverse()) {
    const text = `${message.text || ""}${message.role === "tool" && message.meta?.output ? `\n${message.meta.output}` : ""}${message.attachments?.length ? `\nUser attachments: ${JSON.stringify(message.attachments.map(({ name, path }) => ({ name, path })))}` : ""}`;
    if (!text) continue;
    const clipped = text.slice(-Math.min(12000, remaining));
    history.unshift({ role: message.role, text: clipped }); remaining -= clipped.length;
    if (remaining <= 0) break;
  }
  return `You are taking over this existing Agent Relay conversation from another agent. The workspace is unchanged. Below is recent conversation context, not a new task; long history/tool output may be truncated. Use it to continue the user's work, and inspect the workspace if more context is needed.\n\n${JSON.stringify(history)}\n\nCurrent user message:\n${prompt}`;
}
