import os from "node:os";
import { readdirSync, statfsSync } from "node:fs";
import { publicHarnessUpdate } from "./harness-state.mjs";

const age = (date, now) => date && Number.isFinite(Date.parse(date)) ? Math.max(0, now - Date.parse(date)) : null;
function toolCategory(value) {
  const name = String(value || "").toLowerCase();
  if (/^(?:command|bash|shell)$/.test(name)) return "command";
  if (/^(?:files?|edit|read|write|glob|grep|workspace)$/.test(name)) return "files";
  if (/browser|playwright|chrome/.test(name)) return "browser";
  if (/^(?:agent|task)$/.test(name)) return "agent";
  if (/web|search|fetch|http/.test(name)) return "network";
  if (/^mcp(?:__|$)/.test(name)) return "integration";
  return "other";
}
const toolSummaries = { command: "Shell command", files: "File operation", browser: "Browser action", agent: "Agent operation",
  network: "Network operation", integration: "Integration operation", other: "Active tool" };
let previousCpu = null;

export function localSystemMetrics(workspace = process.cwd()) {
  const total = os.totalmem(), free = os.freemem();
  const cores = os.cpus(), cpuTimes = cores.reduce((sum, core) => {
    const values = Object.values(core.times); return { idle: sum.idle + core.times.idle, total: sum.total + values.reduce((value, time) => value + time, 0) };
  }, { idle: 0, total: 0 });
  const cpuDelta = previousCpu && cpuTimes.total > previousCpu.total
    ? Math.round((1 - (cpuTimes.idle - previousCpu.idle) / (cpuTimes.total - previousCpu.total)) * 100) : null;
  previousCpu = cpuTimes;
  let disk = null, processCount = null;
  try { const stat = statfsSync(workspace); disk = { usedPercent: Math.round((1 - Number(stat.bavail) / Number(stat.blocks || 1)) * 100), freeBytes: Number(stat.bavail) * Number(stat.bsize) }; } catch {}
  try { processCount = readdirSync("/proc", { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).length; } catch {}
  return { cpu: { usedPercent: cpuDelta }, cpuCount: cores.length, load: os.loadavg().map(value => Number(value.toFixed(2))),
    ram: { usedBytes: total - free, totalBytes: total, usedPercent: Math.round((1 - free / total) * 100) }, disk, processCount };
}

export function machineHealthSnapshot({ chat, runtime, activity, system, now = Date.now() }) {
  const agent = runtime?.adapter?.machineHealth?.() || null;
  const current = [...(chat?.messages || [])].reverse().find(message => message.kind === "tool" && ["running", "stopping"].includes(message.meta?.state));
  const startedAt = current?.meta?.startedAt || current?.createdAt || null;
  const deadlineAt = current?.meta?.deadlineAt || null;
  const category = toolCategory(current?.meta?.tool);
  const tool = current ? { type: category, summary: toolSummaries[category],
    pid: Number.isSafeInteger(current.meta?.pid) ? current.meta.pid : null, pgid: Number.isSafeInteger(current.meta?.pgid) ? current.meta.pgid : null,
    state: current.meta?.state, startedAt, durationMs: age(startedAt, now), deadlineAt } : null;
  const heartbeatAgeMs = age(agent?.heartbeatAt, now);
  const anomalies = [];
  const failure = `${runtime?.failureCause?.message || ""} ${chat?.statusDetail || ""}`;
  if (/\boom\b|out of memory/i.test(failure)) anomalies.push("oom");
  if (agent?.state === "running" && agent.heartbeatExpected && (heartbeatAgeMs === null || heartbeatAgeMs > 15_000)) anomalies.push("missing-heartbeat");
  if (runtime && agent && (["dead", "exited"].includes(agent.state) || agent.state === "stopped" && chat?.status !== "starting")) anomalies.push("dead-process");
  if (deadlineAt && Date.parse(deadlineAt) < now) anomalies.push("tool-past-deadline");
  if ((system?.cpu?.usedPercent || 0) >= 95 || (system?.ram?.usedPercent || 0) >= 90 || (system?.disk?.usedPercent || 0) >= 90
    || (system?.load?.[0] || 0) > (system?.cpuCount || 1) * 1.5) anomalies.push("pressure");
  if (/network|ECONN|ENET|EHOST|ETIMEDOUT|connection lost/i.test(failure)) anomalies.push("network-failure");
  return {
    sampledAt: new Date(now).toISOString(),
    worker: { backend: chat?.runtimeMetadata?.backend || runtime?.executor?.metadata?.backend || "local", state: chat?.status || "stopped",
      ec2: chat?.runtimeMetadata?.instanceId ? { instanceId: chat.runtimeMetadata.instanceId, state: chat.workerLifecycle?.state || chat.status } : null,
      control: agent?.control || (runtime ? "connected" : "disconnected"), lease: activity },
    agent: agent ? { ...agent, heartbeatAgeMs } : { pid: null, pgid: null, state: runtime ? "unknown" : "stopped", heartbeatAt: null, heartbeatAgeMs: null, heartbeatExpected: false, control: runtime ? "unknown" : "disconnected" },
    tool, system, harness: publicHarnessUpdate(runtime?.harnessUpdate), anomaly: anomalies[0] || null, anomalies,
  };
}
