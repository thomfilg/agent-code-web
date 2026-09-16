import path from "node:path";
import { spawn } from "node:child_process";
import { repositoryGroup, workflowPatch } from "../public/chat-organization.js";
import { companyForChat } from "../public/company-scope.js";

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

export function checkSummary(runs, combined) {
  const summary = { passed: 0, skipped: 0, inProgress: 0, failed: 0, total: 0 };
  for (const run of runs) {
    summary.total++;
    if (failureConclusions.has(run.conclusion)) summary.failed++;
    else if (run.status !== "completed") summary.inProgress++;
    else if (["skipped", "neutral"].includes(run.conclusion)) summary.skipped++;
    else if (run.conclusion === "success") summary.passed++;
    else summary.skipped++;
  }
  for (const status of combined.statuses || []) {
    summary.total++;
    if (["error", "failure"].includes(status.state)) summary.failed++;
    else if (status.state === "success") summary.passed++;
    else summary.inProgress++;
  }
  return summary;
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
  async request(route, options = {}) {
    const repository = /^\/repos\/([^/?]+\/[^/?]+)/.exec(route)?.[1];
    const connection = this.github.requireConnection ? await this.github.requireConnection({ ...options, repository }) : null;
    const key = `${connection?.id || options.connectionId || "auto"}:${connection?.revision || 0}:${route}`;
    const old = this.requests.get(key);
    if (old && old.until > Date.now()) return old.promise;
    const promise = this.github.request(route, { ...options, ...(connection ? { connectionId: connection.id } : {}) });
    this.requests.set(key, { until: Date.now() + Math.min(this.intervalMs / 2, 15000), promise });
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
  tracked(id, repository, number) {
    const chat = this.store.get(id);
    const pr = chat?.pullRequests?.find(pr => pr.repository === repository && pr.number === number && pr.verifiedAt);
    if (!pr || !validRepo(repository) || !Number.isSafeInteger(number)) throw Object.assign(new Error("Choose a verified PR linked to this chat"), { statusCode: 404 });
    return pr;
  }
  connectionOptions(chat, repository) {
    const selected = chatRepositories(chat || {}).find(repo => repo.fullName.toLowerCase() === repository?.toLowerCase());
    return { repository, chatCompany: companyForChat(chat || {}), ...(selected?.githubConnectionId ? { connectionId: selected.githubConnectionId } : {}) };
  }
  async files(id, repository, number) {
    this.tracked(id, repository, number);
    const files = []; let remaining = 1000000, truncated = false;
    for (let page = 1; page <= 30; page++) {
      const chunk = await this.github.request(`/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`, this.connectionOptions(this.store.get(id), repository));
      for (const file of chunk) {
        const patch = file.patch?.slice(0, Math.min(200000, remaining)) || null;
        truncated ||= (file.patch?.length || 0) > (patch?.length || 0);
        remaining -= patch?.length || 0;
        files.push({ filename: file.filename, previousFilename: file.previous_filename || null, status: file.status, additions: file.additions, deletions: file.deletions, patch });
      }
      if (remaining <= 0) { truncated = true; break; }
      if (chunk.length < 100) break;
    }
    return { files, source: "GitHub PR", note: `GitHub may omit patches for binary or very large files. Local unpushed changes are not included.${truncated ? " Display limited to 1 MB of patches; open GitHub for the full diff." : ""}` };
  }
  async autoMerge(id, repository, number, enabled) {
    this.tracked(id, repository, number);
    if (typeof enabled !== "boolean") throw new Error("Auto-merge must be enabled or disabled explicitly");
    const route = `/repos/${repository}`;
    const options = this.connectionOptions(this.store.get(id), repository);
    const pr = await this.github.request(`${route}/pulls/${number}`, options);
    if (pr.state !== "open") throw new Error("Auto-merge is only available for open pull requests");
    if (pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) throw new Error("PR repository mismatch");
    if (!pr.node_id || (enabled && !/^[a-f0-9]{40,64}$/i.test(pr.head?.sha || ""))) throw new Error("GitHub did not return a verifiable PR head");
    const repo = enabled ? await this.github.request(route, options) : null;
    if (enabled && !repo.allow_auto_merge) throw new Error("Enable Allow auto-merge in this repository's GitHub settings first");
    const mergeMethod = repo?.allow_squash_merge ? "SQUASH" : repo?.allow_merge_commit ? "MERGE" : "REBASE";
    const mutation = enabled ? "enablePullRequestAutoMerge" : "disablePullRequestAutoMerge";
    const result = await this.github.request("/graphql", { ...options, method: "POST", body: {
      query: `mutation($input: ${enabled ? "EnablePullRequestAutoMergeInput" : "DisablePullRequestAutoMergeInput"}!) { ${mutation}(input: $input) { pullRequest { number } } }`,
      variables: { input: { pullRequestId: pr.node_id, ...(enabled ? { mergeMethod, expectedHeadOid: pr.head.sha } : {}) } },
    } });
    if (result.errors?.length || !result.data?.[mutation]) throw new Error("GitHub could not change auto-merge. Check permissions, branch protection, draft status and repository merge rules.");
    // Only GitHub performs the merge after its requirements pass. Never fall back
    // to a direct merge, admin bypass, branch-rule changes or force pushes.
    await this.inflight.get(id); this.requests.clear(); await this.refresh(id);
    return this.store.get(id);
  }
  async sync(id) {
    const chat = this.store.get(id);
    if (!chat || chat.archived) return;
    const request = route => this.request(route, this.connectionOptions(chat, /^\/repos\/([^/?]+\/[^/?]+)/.exec(route)?.[1]));
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
        const pulls = await request(`/repos/${ref.repository}/pulls?state=all&head=${encodeURIComponent(head)}&sort=updated&direction=desc&per_page=100`);
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
        const pr = await request(`${route}/pulls/${candidate.number}`);
        if (pr.base?.repo?.full_name?.toLowerCase() !== candidate.repository.toLowerCase() || pr.number !== candidate.number) throw new Error("PR repository mismatch");
        let checks = "none", checksStale = false, ci = null;
        if (pr.state === "open") {
          try {
            if (!/^[a-f0-9]{40,64}$/i.test(pr.head?.sha || "")) throw new Error("Missing PR head");
            const runs = [];
            for (let page = 1; ; page++) {
              if (this.stopped) return;
              const result = await request(`${route}/commits/${pr.head.sha}/check-runs?filter=latest&per_page=100&page=${page}`);
              runs.push(...result.check_runs);
              if (result.check_runs.length < 100) break;
            }
            const first = await request(`${route}/commits/${pr.head.sha}/status`);
            const combined = { ...first, statuses: [...(first.statuses || [])] };
            for (let page = 2; combined.statuses?.length < combined.total_count; page++) {
              if (this.stopped) return;
              const more = await request(`${route}/commits/${pr.head.sha}/status?page=${page}`);
              if (!more.statuses?.length) break;
              combined.statuses.push(...more.statuses);
            }
            checks = checkState(runs, combined);
            ci = checkSummary(runs, combined);
          } catch {
            checks = previous?.headSha === pr.head.sha ? previous.checks : "unknown";
            checksStale = true;
            ci = previous?.headSha === pr.head.sha ? previous.ci : null;
            warning = "PR status verified, but checks could not be refreshed. Check GitHub permissions or the API limit.";
          }
        }
        prs.push({ repository: candidate.repository, number: pr.number, url: `https://github.com/${candidate.repository}/pull/${pr.number}`, title: pr.title,
          state: pr.state, merged: Boolean(pr.merged_at || pr.merged), headSha: pr.head?.sha || null, headRef: pr.head?.ref || null, baseRef: pr.base?.ref || null,
          additions: pr.additions || 0, deletions: pr.deletions || 0, changedFiles: pr.changed_files || 0,
          conflicts: pr.mergeable_state === "dirty" ? true : pr.mergeable === null || pr.mergeable === undefined ? null : pr.mergeable === false,
          autoMerge: Boolean(pr.auto_merge), draft: Boolean(pr.draft), ci, checks, checksStale, verifiedAt: new Date().toISOString() });
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
