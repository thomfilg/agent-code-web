import path from "node:path";
import { spawn } from "node:child_process";
import { repositoryGroup, workflowPatch } from "../public/chat-organization.js";

const validRepo = value => typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value) && !value.split("/").some(part => [".", ".."].includes(part));
export function chatRepositories(chat) {
  const repositories = chat.repositories?.length ? chat.repositories : [{ fullName: repositoryGroup(chat).fullName }];
  return repositories.filter(repo => validRepo(repo.fullName));
}
export function pullRequestLinks(chat) {
  const allowed = new Set(chatRepositories(chat).map(repo => repo.fullName.toLowerCase()));
  const found = new Map();
  for (const message of chat.messages || []) {
    if (!["assistant", "tool"].includes(message.role)) continue;
    const text = `${message.text || ""}\n${message.meta?.output || ""}`;
    for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?!\d)/g)) {
      if (!allowed.has(match[1].toLowerCase())) continue;
      const number = Number(match[2]);
      if (!Number.isSafeInteger(number) || number < 1) continue;
      found.set(`${match[1].toLowerCase()}#${number}`, { repository: match[1], number });
    }
  }
  return [...found.values()].slice(-30);
}
function git(executor, cwd, args) {
  return new Promise((resolve, reject) => {
    // These read-only probes never receive provider/GitHub/environment secrets.
    const options = { cwd, env: { PATH: process.env.PATH || "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] };
    const child = executor?.spawn ? executor.spawn("git", args, options) : spawn("git", args, options);
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Git inspection timed out")); }, 5000);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 4096) child.kill("SIGKILL"); });
    child.stderr.resume();
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error("Git inspection unavailable")); });
  });
}
export async function inspectBranches(chat, executor) {
  const branches = [];
  for (const repo of chatRepositories(chat)) {
    // directory is controller-created metadata, never a path from agent output.
    if (repo.directory && path.basename(repo.directory) !== repo.directory) continue;
    const cwd = path.join(executor?.workspace || chat.workspace, repo.directory || "");
    try {
      const branch = await git(executor, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (!branch || branch === repo.defaultBranch || (!repo.defaultBranch && ["main", "master"].includes(branch))) continue;
      branches.push({ repository: repo.fullName, branch });
    } catch { /* Scratch workspaces, detached HEADs and unavailable workers have no branch to discover. */ }
  }
  return branches;
}

const failureConclusions = new Set(["failure", "timed_out", "cancelled", "action_required", "stale", "startup_failure"]);
export function checkState(runs, combined) {
  if (runs.some(run => failureConclusions.has(run.conclusion)) || combined.statuses?.some(status => ["error", "failure"].includes(status.state)) || ["failure", "error"].includes(combined.state)) return "failing";
  if (runs.some(run => run.status !== "completed") || (combined.total_count > 0 && combined.state === "pending")) return "pending";
  return runs.length || combined.total_count > 0 ? "passing" : "none";
}

// Control-plane polling only: never acquire/wake a worker to inspect a PR.
export class PullRequestMonitor {
  constructor({ store, github, publish, intervalMs = 60000 }) {
    Object.assign(this, { store, github, publish, intervalMs });
    this.inflight = new Map(); this.stopped = false; this.requests = new Map();
  }
  start() {
    if (!this.github?.request || this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs); this.timer.unref?.();
  }
  tick() {
    for (const chat of this.store.list()) if (!chat.archived && (chat.pullRequests?.length || chat.gitBranches?.length || pullRequestLinks(chat).length)) {
      this.refresh(chat.id).catch(() => {});
    }
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer);
    await Promise.allSettled([...this.inflight.values()]);
  }
  request(route) {
    const old = this.requests.get(route);
    if (old && old.until > Date.now()) return old.promise;
    const promise = this.github.request(route);
    this.requests.set(route, { until: Date.now() + Math.min(this.intervalMs / 2, 15000), promise });
    // Cache errors briefly too, so many chats don't hammer an expired connection.
    for (const [key, value] of this.requests) if (value.until < Date.now()) this.requests.delete(key);
    return promise;
  }
  refresh(id) {
    if (this.stopped || !this.github?.request) return Promise.resolve();
    if (this.inflight.has(id)) return this.inflight.get(id);
    const pending = this.sync(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, pending); return pending;
  }
  async sync(id) {
    const chat = this.store.get(id);
    if (!chat || chat.archived) return;
    const allowed = new Set(chatRepositories(chat).map(repo => repo.fullName.toLowerCase()));
    const candidates = new Map();
    for (const pr of [...(chat.pullRequests || []), ...pullRequestLinks(chat)]) {
      if (allowed.has(pr.repository?.toLowerCase()) && Number.isSafeInteger(pr.number) && pr.number > 0) candidates.set(`${pr.repository.toLowerCase()}#${pr.number}`, pr);
    }
    let warning = null;
    try {
      for (const ref of chat.gitBranches || []) {
        if (this.stopped) return;
        if (!allowed.has(ref.repository?.toLowerCase()) || typeof ref.branch !== "string") continue;
        const head = `${ref.repository.split("/")[0]}:${ref.branch}`;
        const pulls = await this.request(`/repos/${ref.repository}/pulls?state=all&head=${encodeURIComponent(head)}&sort=updated&direction=desc&per_page=100`);
        for (const pr of pulls) {
          if (pr.head?.ref !== ref.branch || pr.head?.repo?.full_name?.toLowerCase() !== ref.repository.toLowerCase()) continue;
          // Reused branch names must not attach old, closed PRs to a new chat.
          if (pr.state !== "open" && Date.parse(pr.updated_at) < Date.parse(chat.createdAt)) continue;
          candidates.set(`${ref.repository.toLowerCase()}#${pr.number}`, { repository: ref.repository, number: pr.number });
        }
      }
    } catch { warning = "GitHub sync unavailable. Check your connection, repository permissions or API limit. Showing last verified status."; }
    const prs = [];
    for (const candidate of [...candidates.values()].slice(-30)) {
      if (this.stopped) return;
      const previous = chat.pullRequests?.find(pr => pr.repository.toLowerCase() === candidate.repository.toLowerCase() && pr.number === candidate.number);
      try {
        const route = `/repos/${candidate.repository}`;
        const pr = await this.request(`${route}/pulls/${candidate.number}`);
        if (pr.base?.repo?.full_name?.toLowerCase() !== candidate.repository.toLowerCase() || pr.number !== candidate.number) throw new Error("PR repository mismatch");
        let checks = "none", checksStale = false;
        if (pr.state === "open") {
          try {
            if (!/^[a-f0-9]{40,64}$/i.test(pr.head?.sha || "")) throw new Error("Missing PR head");
            const runs = [];
            for (let page = 1; ; page++) {
              if (this.stopped) return;
              const result = await this.request(`${route}/commits/${pr.head.sha}/check-runs?filter=latest&per_page=100&page=${page}`);
              runs.push(...result.check_runs);
              if (result.check_runs.length < 100) break;
            }
            const combined = await this.request(`${route}/commits/${pr.head.sha}/status`);
            checks = checkState(runs, combined);
          } catch {
            checks = previous?.headSha === pr.head.sha ? previous.checks : "unknown";
            checksStale = true;
            warning = "PR status verified, but checks could not be refreshed. Check GitHub permissions or the API limit.";
          }
        }
        prs.push({ repository: candidate.repository, number: pr.number, url: `https://github.com/${candidate.repository}/pull/${pr.number}`, title: pr.title,
          state: pr.state, merged: Boolean(pr.merged_at || pr.merged), headSha: pr.head?.sha || null, checks, checksStale, verifiedAt: new Date().toISOString() });
      } catch {
        if (previous) prs.push(previous);
        warning = "GitHub sync unavailable. Check your connection, repository permissions or API limit. Showing last verified status.";
      }
    }
    if (this.stopped || !this.store.get(id)) return;
    // Successful polling with no changes must not change last-updated sorting or idle timers.
    const comparable = values => JSON.stringify(values.map(({ verifiedAt, ...pr }) => pr));
    if (comparable(prs) === comparable(chat.pullRequests || []) && (chat.githubSyncWarning || null) === warning) return;
    const updated = await this.store.update(id, current => ({ pullRequests: prs, githubSyncWarning: warning,
      ...workflowPatch({ ...current, pullRequests: prs }) }));
    this.publish(updated);
  }
}
