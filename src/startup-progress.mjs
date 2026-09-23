export const STARTUP_STAGES = Object.freeze({
  repository: "Preparing repositories",
  machine: "Starting machine",
  connection: "Connecting to machine",
  workspace: "Preparing workspace",
  software: "Preparing software",
  harness: "Checking agent harnesses",
  setup: "Running setup script",
  plugins: "Installing company plugins",
  agent: "Starting agent",
});

export function startupStage(snapshot, id, status, timestamp = new Date().toISOString()) {
  if (!STARTUP_STAGES[id] || !["running", "completed", "failed"].includes(status)) throw new Error("Invalid startup stage");
  const progress = snapshot || { startedAt: timestamp, stages: [] };
  const previous = progress.stages.find(stage => stage.id === id);
  const stage = { id, label: STARTUP_STAGES[id], status,
    startedAt: status === "running" ? timestamp : previous?.startedAt || timestamp,
    ...(status === "running" ? {} : { finishedAt: timestamp }) };
  return { startedAt: progress.startedAt, stages: [...progress.stages.filter(stage => stage.id !== id), stage]
    .sort((a, b) => Object.keys(STARTUP_STAGES).indexOf(a.id) - Object.keys(STARTUP_STAGES).indexOf(b.id)) };
}

export function failRunningStartup(snapshot, timestamp = new Date().toISOString()) {
  if (!snapshot) return null;
  return { ...snapshot, finishedAt: snapshot.finishedAt || timestamp, stages: snapshot.stages.map(stage => stage.status === "running" ? { ...stage, status: "failed", finishedAt: timestamp } : stage) };
}
