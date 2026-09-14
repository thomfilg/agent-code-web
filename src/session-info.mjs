const number = value => Number.isFinite(value) && value >= 0 ? value : null;
export function codexUsage(value) {
  const last = value?.last || {};
  return { inputTokens: number(last.inputTokens), outputTokens: number(last.outputTokens), cachedTokens: number(last.cachedInputTokens),
    contextTokens: number(last.totalTokens), contextWindow: number(value?.modelContextWindow), totalTokens: number(value?.total?.totalTokens), recordedAt: new Date().toISOString() };
}
export function claudeUsage(result) {
  const usage = result.usage || {};
  const models = Object.values(result.modelUsage || {});
  return { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cachedTokens: number(usage.cache_read_input_tokens),
    contextTokens: null, contextWindow: models.length === 1 ? number(models[0].contextWindow) : null,
    costUsd: number(result.total_cost_usd), recordedAt: new Date().toISOString() };
}
export function safeRateLimits(result) {
  return Object.entries(result.rateLimitsByLimitId || (result.rateLimits ? { codex: result.rateLimits } : {})).map(([id, limit]) => ({
    id: id.slice(0, 100), name: String(limit.limitName || id).slice(0, 100),
    windows: [limit.primary, limit.secondary].filter(Boolean).map(window => ({ usedPercent: number(window.usedPercent), minutes: number(window.windowDurationMins), resetsAt: number(window.resetsAt) })),
  }));
}
