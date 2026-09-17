import { nowIso, redact } from "./utils.mjs";

export function publicRequest(request) {
  if (!request) return null;
  const params = request.params || {};
  return { requestId: request.requestId, method: request.method, createdAt: nowIso(),
    prompt: redact(params.reason || params.command || "Agent needs your input"),
    command: params.command ? redact(params.command) : null, cwd: params.cwd || null,
    permissions: params.permissions && typeof params.permissions === "object" ? params.permissions : null,
    ...(Array.isArray(params.availableDecisions) ? { availableDecisions: params.availableDecisions.filter(value => ["accept", "acceptForSession", "decline", "cancel"].includes(value)) } : {}),
    questions: Array.isArray(params.questions) ? params.questions : null };
}

export function responseFor(request, input = {}) {
  if (["item/tool/requestUserInput", "claude/tool/requestUserInput"].includes(request.method)) {
    if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers)) throw new Error("answers object required");
    const ids = new Set((request.questions || []).map(question => question.id));
    return { answers: Object.fromEntries(Object.entries(input.answers).map(([key, answer]) => {
      const values = Array.isArray(answer) ? answer : [answer];
      if (!ids.has(key) || values.length > 32 || values.some(value => typeof value !== "string" || value.length > 10000)) throw new Error("Answer must match a requested question and contain text");
      return [key, { answers: values }];
    })) };
  }
  const decision = input.decision;
  if (request.availableDecisions && !request.availableDecisions.includes(decision)) throw new Error("This approval decision is not available for the request");
  if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) throw new Error("decision must be accept, acceptForSession, decline, or cancel");
  if (request.method === "item/permissions/requestApproval") return decision === "accept" || decision === "acceptForSession"
    ? { permissions: request.permissions || {}, scope: decision === "acceptForSession" ? "session" : "turn" }
    : { permissions: {} };
  return { decision };
}
