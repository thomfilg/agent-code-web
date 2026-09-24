export function agentAccountLabel(account) {
  return `${account.provider === "claude" ? "Claude" : "Codex"} · ${account.name}${account.email ? ` · ${account.email}` : ""}`;
}

export function agentProjectKey(chat = {}) {
  const name = chat.repositories?.[0]?.fullName;
  return typeof name === "string" && /^[\w.-]+\/[\w.-]+$/.test(name) ? name.toLowerCase() : null;
}
