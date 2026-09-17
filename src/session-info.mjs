const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const sum = values => values.some(value => number(value) !== null) ? values.reduce((total, value) => total + (number(value) ?? 0), 0) : null;
const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "costUsd", "durationMs", "apiDurationMs"];
const counts = usage => ({ inputTokens: number(usage?.input_tokens), outputTokens: number(usage?.output_tokens), cacheReadTokens: number(usage?.cache_read_input_tokens), cacheWriteTokens: number(usage?.cache_creation_input_tokens) });
const add = (a = {}, b = {}) => Object.fromEntries(fields.map(key => [key, sum([a?.[key], b?.[key]])]));

export function cliVersionFromUserAgent(value) {
  // initialize's userAgent includes the caller name, version and platform.
  // Keep only the version, never the host/platform string or arbitrary text.
  return typeof value === "string" ? /^[\w.-]+\/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/.exec(value)?.[1] || null : null;
}
export function safeSessionDetails(agent, value = {}) {
  const plain = (value, max) => typeof value === "string" && value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim().slice(0, max) : null;
  return { agent, cwd: plain(value.cwd, 4096), model: plain(value.model, 150),
    cliVersion: typeof value.cliVersion === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.cliVersion) ? value.cliVersion.slice(0, 100) : null,
    recordedAt: new Date().toISOString() };
}

// Codex input already includes cache hits. Never add cached input to it again.
export function codexUsage(value) {
  const convert = raw => ({ inputTokens: number(raw?.inputTokens) === null ? null : Math.max(0, raw.inputTokens - (number(raw.cachedInputTokens) ?? 0)),
    cacheReadTokens: number(raw?.cachedInputTokens), cacheWriteTokens: null, outputTokens: number(raw?.outputTokens), reasoningTokens: number(raw?.reasoningOutputTokens) });
  const last = value?.last || {};
  return { version: 2, provider: "codex", scope: "thread", inputTokens: number(last.inputTokens), outputTokens: number(last.outputTokens), cachedTokens: number(last.cachedInputTokens),
    contextTokens: number(last.totalTokens), contextWindow: number(value?.modelContextWindow), context: convert(last),
    totals: convert(value?.total), totalTokens: number(value?.total?.totalTokens), recordedAt: new Date().toISOString() };
}

// Claude's status line counts input + cache reads + cache writes from the LAST
// main-agent request. Result.usage sums the whole call and is not context size.
export function claudeContext(message) {
  if (number(message?.usage?.input_tokens) === null) return null;
  const context = counts(message.usage);
  context.outputTokens = null; // Claude's native context percentage excludes output.
  return { contextTokens: sum([context.inputTokens, context.cacheReadTokens, context.cacheWriteTokens]), context,
    contextModel: String(message.model || "").slice(0, 150), contextSource: "last main-agent request", recordedAt: new Date().toISOString() };
}
export function claudeUsage(result, lastRequest = null, sampleId = null) {
  const usage = result.usage || {};
  const models = Object.entries(result.modelUsage || {}).slice(0, 100).map(([id, model]) => ({ id: id.slice(0, 150), inputTokens: number(model.inputTokens), outputTokens: number(model.outputTokens),
    cacheReadTokens: number(model.cacheReadInputTokens), cacheWriteTokens: number(model.cacheCreationInputTokens), costUsd: number(model.costUSD), contextWindow: number(model.contextWindow) }));
  const context = claudeContext(lastRequest);
  const selected = models.find(model => model.id === context?.contextModel) || (models.length === 1 ? models[0] : null);
  const totals = models.length ? models.reduce(add, {}) : counts(usage);
  return { version: 2, provider: "claude", scope: "call", sampleId, inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cachedTokens: number(usage.cache_read_input_tokens),
    contextTokens: null, ...context, contextWindow: selected?.contextWindow || null,
    totals: { ...totals, costUsd: number(result.total_cost_usd), durationMs: number(result.duration_ms), apiDurationMs: number(result.duration_api_ms) }, models,
    costUsd: number(result.total_cost_usd), recordedAt: new Date().toISOString() };
}
export function mergeUsage(previous, next) {
  if (next.scope !== "call") return { ...previous, ...next, totals: { ...previous?.totals, ...next.totals } };
  if (next.sampleId && previous?.sampleId === next.sampleId) return previous;
  const legacy = previous && previous.version !== 2 && previous.costUsd !== undefined ? { inputTokens: previous.inputTokens, outputTokens: previous.outputTokens, cacheReadTokens: previous.cachedTokens, costUsd: previous.costUsd } : null;
  const models = new Map((previous?.models || []).map(model => [model.id, model]));
  for (const model of next.models || []) models.set(model.id, { ...model, ...add(models.get(model.id), model) });
  return { ...previous, ...next, totals: add(previous?.totals || legacy, next.totals), models: [...models.values()],
    partial: Boolean(previous?.partial || legacy), costUsd: sum([previous?.totals?.costUsd ?? legacy?.costUsd, next.totals?.costUsd]) };
}
export function safeRateLimits(result) {
  return Object.entries(result.rateLimitsByLimitId || (result.rateLimits ? { codex: result.rateLimits } : {})).slice(0, 30).map(([id, limit]) => ({
    id: id.slice(0, 100), name: String(limit.limitName || id).slice(0, 100),
    windows: [limit.primary, limit.secondary].filter(Boolean).map(window => ({ usedPercent: number(window.usedPercent), minutes: number(window.windowDurationMins), resetsAt: number(window.resetsAt) })),
  }));
}
export function claudeRateLimits(info) {
  if (!info) return [];
  const minutes = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080, seven_day_fable: 10080 };
  // Older CLI versions omit utilization: missing must not be presented as 0%.
  const type = typeof info.rateLimitType === "string" ? info.rateLimitType.slice(0, 100) : "unknown";
  return [{ id: `claude:${type}`, name: type.startsWith("seven_day_") ? type.slice(10) : "All models", windows: [{
    usedPercent: number(info.utilization) === null ? null : info.utilization * 100, minutes: minutes[type] || null,
    resetsAt: number(info.resetsAt), status: ["allowed", "allowed_warning", "rejected"].includes(info.status) ? info.status : null,
  }] }];
}
