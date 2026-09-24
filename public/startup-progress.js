import { elapsedLabel } from "./working-status.js";

const stageLabels = {
  repository: "Repositories", machine: "Machine", connection: "Connection",
  workspace: "Workspace", software: "Software", setup: "Setup script", plugins: "Plugins", agent: "Agent",
};
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

// Durations come from persisted timestamps, never from how long this page has
// been open. Parallel stages overlap; their durations must not be added up.
export function startupProgressView(chat, now = Date.now()) {
  const progress = chat?.startupProgress, start = timestamp(progress?.startedAt);
  if (start === null || !Array.isArray(progress?.stages) || !progress.stages.length) return null;
  const stages = progress.stages.filter(stage => stage && Object.hasOwn(stageLabels, stage.id)
    && ["running", "completed", "failed"].includes(stage.status));
  if (!stages.length) return null;
  const finish = timestamp(progress.finishedAt);
  const failed = stages.some(stage => stage.status === "failed");
  const active = chat.status === "starting" && finish === null && !failed;
  // Old/incomplete snapshots may not have a terminal timestamp. Freeze at the
  // last known stage timestamp instead of inventing time or ticking forever.
  const end = finish ?? (active ? now : Math.max(start, ...stages.map(stage => timestamp(stage.finishedAt) ?? timestamp(stage.startedAt) ?? start)));
  const rows = stages.map(stage => {
    const stageStart = timestamp(stage.startedAt);
    const stageEnd = timestamp(stage.finishedAt) ?? (active && stage.status === "running" ? now : end);
    const status = stage.status === "running" && !active ? "interrupted" : stage.status;
    return { id: stage.id, label: typeof stage.label === "string" && stage.label.trim() ? stage.label : stageLabels[stage.id], status,
      elapsed: stageStart === null ? "—" : elapsedLabel(stage.startedAt, stageEnd) };
  });
  const running = rows.filter(stage => stage.status === "running");
  const label = active ? running.map(stage => stage.label).join(" + ") || "Starting"
    : failed ? "Startup failed" : rows.some(stage => stage.status === "interrupted") ? "Startup interrupted" : "Startup completed";
  return { key: `${chat.id}:${progress.startedAt}`, active, rows, summary: `${label} · ${elapsedLabel(progress.startedAt, end)}` };
}

export function startupProgressPlacement(chat, view) {
  if (!view) {
    const health = !["starting", "stopped"].includes(chat?.status);
    return { banner: false, settings: false, health, detail: !health };
  }
  const banner = view.active || ["starting", "stopped"].includes(chat?.status);
  return { banner, settings: !banner, health: !banner, detail: false };
}

export class StartupProgress {
  constructor({ container, settingsContainer, settingsMenu }) {
    this.container = container; this.settingsContainer = settingsContainer; this.settingsMenu = settingsMenu;
    this.root = document.createElement("details");
    this.root.id = "startup-progress"; this.root.className = "startup-progress"; this.root.hidden = true;
    this.summary = document.createElement("summary");
    this.summary.title = "Startup stages and timings";
    this.list = document.createElement("ul"); this.list.setAttribute("aria-label", "Startup stages");
    this.root.append(this.summary, this.list); container.append(this.root);
    this.rows = new Map();
  }
  update(chat, now = Date.now()) {
    const view = startupProgressView(chat, now);
    const placement = startupProgressPlacement(chat, view);
    if (view?.key !== this.key) {
      this.root.open = false; this.list.replaceChildren(); this.rows.clear(); this.key = view?.key;
    }
    const target = placement.settings ? this.settingsContainer : this.container;
    if (target && this.root.parentElement !== target) target.append(this.root);
    this.root.hidden = !view;
    if (this.settingsMenu) this.settingsMenu.hidden = !placement.settings;
    if (!view) return placement;
    if (this.summary.textContent !== view.summary) this.summary.textContent = view.summary;
    const retained = new Set();
    for (const stage of view.rows) {
      retained.add(stage.id);
      let row = this.rows.get(stage.id);
      if (!row) {
        row = document.createElement("li"); row.dataset.stage = stage.id;
        row.append(document.createElement("span"), document.createElement("span"));
        this.rows.set(stage.id, row); this.list.append(row);
      }
      row.dataset.status = stage.status;
      const status = stage.status[0].toUpperCase() + stage.status.slice(1);
      const text = `${status} · ${stage.elapsed}`;
      if (row.firstChild.textContent !== stage.label) row.firstChild.textContent = stage.label;
      if (row.lastChild.textContent !== text) row.lastChild.textContent = text;
    }
    for (const [id, row] of this.rows) if (!retained.has(id)) { row.remove(); this.rows.delete(id); }
    return placement;
  }
}
