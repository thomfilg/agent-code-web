import { leaseId } from "./worker-lease-scope.mjs";

export const sessionFailure = (code = "SCOPE_UNAVAILABLE") => Object.assign(new Error(`Native history: ${code}`), { code });
export function nativeSessionRecords(scope) {
  if (!scope || !/^user_[a-f0-9]{32}$/.test(scope.ownerId || "") || !/^chat_[a-f0-9]{32}$/.test(scope.chatId || "")
    || !/^account_[a-f0-9-]{36}$/.test(scope.accountId || "") || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(scope.companyId || "")
    || scope.environmentId !== null && !leaseId(scope.environmentId) || typeof scope.legacy !== "boolean") throw sessionFailure("INVALID_SCOPE");
  const prefix = scope.legacy ? "" : `user:${scope.ownerId}:`;
  return [["chat", scope.chatId], ["agent-account", scope.accountId], ["agent-account-disconnection", scope.accountId],
    [`${prefix}company`, scope.companyId], ...(scope.environmentId === null ? [] : [[`${prefix}environment`, scope.environmentId]])];
}
