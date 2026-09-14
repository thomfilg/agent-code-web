const $ = s => document.querySelector(s);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const known = n => typeof n === "number" && Number.isFinite(n);
const count = n => !known(n) ? "Not reported" : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const percent = n => known(n) ? `${Math.round(n)}%` : "Not reported";
const duration = n => known(n) ? `${Math.floor(n / 60000)}m ${Math.round(n / 1000) % 60}s` : "Not reported";
const button = (text, fn) => { const n = el("button", text); n.type = "button"; n.onclick = fn; return n; };
export class UsagePanel {
  constructor({ api, state, toast }) {
    Object.assign(this, { api, state, toast }); this.cache = new Map(); this.pending = new Map();
    $("#usage-menu").addEventListener("toggle", () => { if ($("#usage-menu").open) { this.render(); void this.refresh(); } });
    $("#usage-close").onclick = () => $("#usage-dialog").close();
    $("#usage-refresh").onclick = () => this.refresh();
    $("#usage-copy").onclick = async () => { try { await navigator.clipboard.writeText($("#usage-details").innerText); this.toast("Usage copied"); } catch { this.toast("Clipboard unavailable"); } };
    setInterval(() => { if ($("#usage-menu").open || $("#usage-dialog").open) void this.refresh(); }, 30000);
  }
  info() {
    const chat = this.state.active || {}, entry = this.cache.get(chat.id) || {}, cached = entry.agent && entry.agent !== chat.agent ? {} : entry;
    const usage = cached.usage && (!chat.usage || cached.usage.recordedAt > chat.usage.recordedAt) ? cached.usage : chat.usage;
    return { ...cached, usage, rateLimits: [...new Map([...(cached.rateLimits || []), ...(chat.rateLimits || [])].map(n => [n.id, n])).values()] };
  }
  async refresh() {
    const chat = this.state.active; if (!chat) return;
    if (this.pending.has(chat.id)) return this.pending.get(chat.id);
    const task = this.api(`/api/chats/${chat.id}/session-info`).then(info => {
      this.cache.set(chat.id, info); if (this.state.active?.id === chat.id) this.render();
    }).catch(error => { if (this.state.active?.id === chat.id) $("#session-usage").append(el("p", error.message, "form-error")); }).finally(() => this.pending.delete(chat.id));
    this.pending.set(chat.id, task); return task;
  }
  detailed() { $("#usage-menu").open = false; if (!$("#usage-dialog").open) $("#usage-dialog").showModal(); this.render(); void this.refresh(); }
  context(info) {
    const usage = info.usage || {}, row = el("div", undefined, "usage-context");
    const p = known(usage.contextTokens) && usage.contextWindow > 0 ? usage.contextTokens / usage.contextWindow * 100 : null;
    const heading = button("", () => this.detailed()); heading.className = "usage-line";
    heading.append(el("span", "Context window"), el("span", `${count(usage.contextTokens)} / ${count(usage.contextWindow)}${known(p) ? ` (${percent(p)})` : ""} ›`)); row.append(heading);
    const bar = el("div", undefined, "context-bar"); bar.setAttribute("role", "meter"); bar.setAttribute("aria-label", "Context used"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); if (known(p)) bar.setAttribute("aria-valuenow", String(Math.min(100, p)));
    if (known(p)) {
      let remaining = 100;
      const parts = usage.context ? [usage.context.inputTokens, usage.context.cacheReadTokens, usage.context.cacheWriteTokens, usage.context.outputTokens] : [usage.contextTokens];
      for (const [i, value] of parts.entries()) { const segment = el("span", undefined, `segment segment-${i}`); const width = Math.min(remaining, (value || 0) / usage.contextWindow * 100); segment.style.width = `${width}%`; remaining -= width; bar.append(segment); }
    }
    row.append(bar); return row;
  }
  limits(info) {
    const root = el("section", undefined, "usage-limits");
    root.append(el("p", `Plan usage limits${info.account?.planType ? ` · ${info.account.planType}` : ""}`, "muted"));
    if (!info.rateLimits?.length) root.append(el("p", "Subscription limits not reported by this CLI/auth mode.", "muted"));
    const extra = el("details", undefined, "usage-extra"); extra.append(el("summary", "Other model limits"));
    for (const limit of info.rateLimits || []) for (const window of limit.windows || []) {
      const primary = ["codex", "all-models", "five_hour", "seven_day"].includes(limit.id) || /all models/i.test(limit.name);
      const name = window.minutes === 300 ? "5-hour limit" : window.minutes === 10080 ? `Weekly · ${primary ? "all models" : limit.name}` : `${limit.name} · ${window.minutes ? `${window.minutes / 60}h` : "limit"}`;
      const row = el("div", undefined, "usage-limit"); const line = el("div", undefined, "usage-line");
      const reset = window.resetsAt ? new Date(window.resetsAt * 1000) : null; let resetText = "";
      if (reset) { const ms = reset.getTime() - Date.now(); resetText = ms <= 0 ? "Awaiting refresh" : ms < 86400000 ? `Resets in ${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m` : `Resets ${reset.toLocaleDateString(undefined, { weekday: "short" })} ${reset.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`; }
      line.append(el("strong", name), el("span", resetText, "muted"), el("span", percent(window.usedPercent)));
      const progress = el("progress"); progress.max = 100; if (known(window.usedPercent)) progress.value = Math.max(0, Math.min(100, window.usedPercent)); else { progress.value = 0; progress.className = "unknown"; }
      progress.setAttribute("aria-label", `${name}: ${percent(window.usedPercent)}`); row.append(line, progress); (primary ? root : extra).append(row);
    }
    if (extra.children.length > 1) root.append(extra); return root;
  }
  render() {
    const info = this.info(), usage = info.usage || {};
    const p = known(usage.contextTokens) && usage.contextWindow > 0 ? usage.contextTokens / usage.contextWindow * 100 : 0;
    $("#usage-ring").style.setProperty("--usage", `${Math.min(100, p)}%`);
    if ($("#usage-menu").open) {
      const compact = button("Compact session", async () => {
        if (!confirm("Compact this session now? This can use model tokens.")) return;
        try { await this.api(`/api/chats/${this.state.active.id}/compact`, { method: "POST", body: "{}" }); await this.refresh(); } catch (error) { this.toast(error.message); }
      }); compact.disabled = !info.canCompact; compact.title = info.canCompact ? "Compact context" : "Manual compaction requires an awake, idle Codex session; Claude compacts automatically";
      $("#session-usage").replaceChildren(this.context(info), compact, this.limits(info), button("See detailed breakdown ›", () => this.detailed()));
    }
    if (!$("#usage-dialog").open) return;
    const root = $("#usage-details"), selected = root.querySelector("select")?.value || "all";
    root.replaceChildren(this.context(info), this.limits(info), el("h3", "This session"));
    const totals = usage.totals || {}, summary = el("div", undefined, "usage-session-grid");
    const cached = (totals.cacheReadTokens || 0), input = (totals.inputTokens || 0) + cached + (totals.cacheWriteTokens || 0);
    for (const [label, value] of [["Estimated cost", known(totals.costUsd) ? `$${totals.costUsd.toFixed(2)}` : "Not reported"], ["API", duration(totals.apiDurationMs)], ["Active", duration(totals.durationMs)], ["Cache hit", input ? percent(cached / input * 100) : "Not reported"]]) summary.append(el("span", `${label} ${value}`));
    root.append(summary, el("h3", "Breakdown"));
    const select = el("select"); select.setAttribute("aria-label", "Usage model");
    for (const model of [{ id: "all", name: "All models" }, ...(usage.models || []).map(m => ({ id: m.id, name: m.id }))]) { const option = el("option", model.name); option.value = model.id; select.append(option); }
    if ([...select.options].some(o => o.value === selected)) select.value = selected;
    const table = el("dl", undefined, "usage-breakdown");
    const draw = () => { const data = select.value === "all" ? totals : usage.models.find(m => m.id === select.value) || {}; table.replaceChildren(); for (const [key, label] of [["inputTokens", "Input"], ["outputTokens", "Output"], ["cacheReadTokens", "Cache read"], ["cacheWriteTokens", "Cache write"], ["reasoningTokens", "Reasoning (included in output)"]]) { const value = el("dd", count(data[key])); if (known(data[key])) value.title = data[key].toLocaleString(); table.append(el("dt", label), value); } };
    select.onchange = draw; draw(); root.append(select, table);
    root.append(el("p", "Context is the latest request; the breakdown is cumulative session usage. Cost is the CLI's API-price estimate, not a subscription charge.", "muted"));
    if (usage.partial || !usage.version) root.append(el("p", "Historical detail is partial; complete breakdowns are collected from new turns.", "muted"));
    root.append(el("p", "Per-MCP token attribution is not reported by these CLIs.", "muted"), el("p", info.note || "Opening usage does not wake a sleeping worker.", "muted"));
  }
}
