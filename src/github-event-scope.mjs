export const githubEventFailure = (code = "SCOPE_UNAVAILABLE") => Object.assign(new Error(`GitHub events: ${code}`), { code, statusCode: code === "INVALID_SCOPE" ? 400 : 409 });
export function githubEventRecords(chatId, scope) {
  if (!/^chat_[a-f0-9]{32}$/.test(chatId || "")) throw githubEventFailure("INVALID_SCOPE");
  if (!scope) return [["chat", chatId]];
  if (scope.chatId !== chatId || !/^user_[a-f0-9]{32}$/.test(scope.ownerId || "")
    || !/^account_[a-f0-9-]{36}$/.test(scope.accountId || "") || !["codex", "claude"].includes(scope.provider)
    || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(scope.companyId || "")
    || scope.environmentId !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.environmentId || "")
    || scope.connectionId !== "github" && !/^github_[a-f0-9-]{36}$/.test(scope.connectionId || "")
    || typeof scope.legacy !== "boolean") throw githubEventFailure("INVALID_SCOPE");
  const prefix = scope.legacy ? "" : `user:${scope.ownerId}:`;
  return [["chat", chatId], ["agent-account", scope.accountId], ["agent-account-disconnection", scope.accountId],
    [`${prefix}company`, scope.companyId], [`${prefix}${scope.connectionId === "github" ? "connection" : "github_connection"}`, scope.connectionId],
    ...(scope.environmentId === null ? [] : [[`${prefix}environment`, scope.environmentId]])];
}
export const githubEventLockedKind = kind => ["github-event-state", "github-webhook", "github_connection", "connection", "relay-session", "browser-user-session"].includes(kind)
  || /^user:user_[a-f0-9]{32}:(github_connection|connection)$/.test(kind);
export function webhookId(id) { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id || "")) throw githubEventFailure("INVALID_DELIVERY"); return id; }
export function githubEventNext(next, id, revision) {
  if (!next || next.chatId !== id || !Number.isSafeInteger(revision + 1) || Buffer.byteLength(JSON.stringify(next)) > 256 * 1024) throw githubEventFailure("INVALID_TRANSITION");
  return { ...next, revision: revision + 1 };
}
export function githubEventSessionRecords(session) {
  if (!session) return [];
  if (!/^user_[a-f0-9]{32}$/.test(session.ownerId || "")
    || !(session.kind === "relay-session" && /^[a-f0-9-]{36}$/.test(session.id || "")
      || session.kind === "browser-user-session" && /^[a-f0-9]{64}$/.test(session.id || ""))) throw githubEventFailure("INVALID_CALLER");
  return [[session.kind, session.id]];
}
export function assertGitHubEventSession(session, row, chat, now) {
  if (session && (!row || row.id !== session.id || row.ownerId !== session.ownerId || chat?.ownerId !== session.ownerId
    || !Number.isFinite(row.expiresAt) || row.expiresAt <= now)) throw Object.assign(githubEventFailure("SESSION_REVOKED"), { statusCode: 401 });
}
