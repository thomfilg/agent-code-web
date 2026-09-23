import path from "node:path";
import { randomUUID } from "node:crypto";
import { captureWorker } from "./software.mjs";
import { HARNESS_UPDATE_INTERVAL_MS, HARNESS_UPDATE_FAILURE, publicHarnessUpdate, safeHarnessVersion } from "./harness-state.mjs";

const PACKAGES = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code" };
const validEnvironmentId = value => typeof value === "string" && /^env_[a-f0-9-]{8,}$/.test(value);
const versionFromOutput = output => safeHarnessVersion(String(output || "").match(/\b[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0]);

function harnessRoot(executor, environmentId) {
  if (!validEnvironmentId(environmentId)) throw new Error("Invalid environment harness identifier");
  if (executor.metadata?.backend === "ec2") return path.posix.join(executor.backend.config.ec2.remoteRoot, "environments", environmentId, "harness");
  return path.join(executor.config.dataDir, "environments", environmentId, "harness");
}

export class HarnessUpdater {
  constructor({ records, config, refreshModels = () => {}, capture = captureWorker, now = Date.now,
    intervalMs = HARNESS_UPDATE_INTERVAL_MS, timeoutMs = config.harnessUpdateTimeoutMs || 300_000, createId = randomUUID } = {}) {
    Object.assign(this, { records, config, refreshModels, capture, now, intervalMs, timeoutMs, createId });
    this.locks = new Map();
  }

  async state(environmentId) { return publicHarnessUpdate(await this.records.get("environment-harness", environmentId)); }

  prepare(executor, environment, onProgress = async () => {}) {
    const id = environment?.id;
    if (!validEnvironmentId(id)) return Promise.resolve(null);
    const existing = this.locks.get(id);
    if (existing) return existing.then(async state => {
      const current = path.join(harnessRoot(executor, id), "current");
      await this.#activate(executor, current).catch(() => false);
      return state;
    });
    const task = this.#prepare(executor, environment, onProgress).catch(async error => {
      if (error?.name === "AbortError") throw error;
      const current = path.join(harnessRoot(executor, id), "current");
      await this.#activate(executor, current).catch(() => false);
      let saved = null;
      try { saved = await this.records.get("environment-harness", id); } catch {}
      return { ...(publicHarnessUpdate(saved) || { lastAttemptAt: null, lastSuccessAt: null, installed: { codex: null, claude: null }, latest: { codex: null, claude: null } }),
        status: "failed", error: HARNESS_UPDATE_FAILURE };
    }).finally(() => {
      if (this.locks.get(id) === task) this.locks.delete(id);
    });
    this.locks.set(id, task);
    return task;
  }

  async #prepare(executor, environment, onProgress) {
    const previous = await this.records.get("environment-harness", environment.id);
    const root = harnessRoot(executor, environment.id), current = path.join(root, "current");
    if (previous?.lastAttemptAt && this.now() - Date.parse(previous.lastAttemptAt) < this.intervalMs) {
      if (previous.status === "checking") {
        const interrupted = { ...previous, status: "failed", error: HARNESS_UPDATE_FAILURE };
        await this.records.put("environment-harness", environment.id, interrupted);
        await this.#activate(executor, current).catch(() => false);
        return publicHarnessUpdate(interrupted);
      }
      await this.#activate(executor, current).catch(() => false);
      return publicHarnessUpdate(previous);
    }

    const attemptedAt = new Date(this.now()).toISOString();
    const checking = { id: environment.id, environmentId: environment.id, status: "checking", lastAttemptAt: attemptedAt,
      lastSuccessAt: previous?.lastSuccessAt || null, installed: previous?.installed || {}, latest: previous?.latest || {}, error: null };
    await this.records.put("environment-harness", environment.id, checking);
    await onProgress("Checking Claude and Codex harness updates…");
    const deadline = this.now() + this.timeoutMs;
    let observedInstalled = checking.installed, observedLatest = checking.latest;
    try {
      await executor.mkdir(path.join(root, "releases"));
      const env = this.#environment(executor, root);
      const active = await this.#activeVersions(executor, current, env, deadline)
        || await this.#configuredVersions(executor, env, deadline);
      observedInstalled = active;
      const latest = {
        codex: await this.#latest(executor, PACKAGES.codex, env, deadline),
        claude: await this.#latest(executor, PACKAGES.claude, env, deadline),
      };
      observedLatest = latest;
      let installed = active;
      let status = "current";
      if (!active.codex || !active.claude || active.codex !== latest.codex || active.claude !== latest.claude) {
        await onProgress("Updating Claude and Codex harnesses…");
        installed = await this.#install(executor, root, current, latest, env, deadline);
        status = "updated";
      }
      const success = { ...checking, status, lastSuccessAt: new Date(this.now()).toISOString(), installed, latest, error: null };
      await this.records.put("environment-harness", environment.id, success);
      await this.#activate(executor, current).catch(() => false);
      await Promise.resolve(this.refreshModels(["codex", "claude"])).catch(() => {});
      return publicHarnessUpdate(success);
    } catch {
      const failed = { ...checking, status: "failed", installed: observedInstalled, latest: observedLatest, error: HARNESS_UPDATE_FAILURE };
      await this.records.put("environment-harness", environment.id, failed);
      await this.#activate(executor, current).catch(() => false);
      return publicHarnessUpdate(failed);
    }
  }

  #environment(executor, root) {
    const basePath = executor.environmentPath || executor.backend?.config.ec2.remotePath || process.env.PATH;
    return { PATH: basePath, HOME: executor.runtimeHome, LANG: "C.UTF-8", CI: "1", NO_COLOR: "1",
      npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false",
      npm_config_userconfig: path.join(root, "npmrc"), npm_config_globalconfig: path.join(root, "npm-globalrc"),
      npm_config_registry: "https://registry.npmjs.org/", npm_config_always_auth: "false", npm_config_cache: path.join(root, "npm-cache") };
  }

  #remaining(deadline) {
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new Error("Harness update timed out");
    return Math.max(1, remaining);
  }

  async #run(executor, command, args, env, deadline, maxOutput = 12_000) {
    return this.capture(executor, command, args, { cwd: executor.workspace, env, timeoutMs: this.#remaining(deadline), maxOutput });
  }

  async #activeVersions(executor, current, env, deadline) {
    const ready = await this.#run(executor, "/bin/sh", ["-c", 'test -x "$1/bin/codex" -a -x "$1/bin/claude" && printf ready || true', "harness-check", current], env, deadline);
    if (ready !== "ready") return null;
    return {
      codex: versionFromOutput(await this.#run(executor, path.join(current, "bin/codex"), ["--version"], env, deadline)),
      claude: versionFromOutput(await this.#run(executor, path.join(current, "bin/claude"), ["--version"], env, deadline)),
    };
  }

  async #configuredVersions(executor, env, deadline) {
    const read = async (command) => {
      try { return versionFromOutput(await this.#run(executor, command, ["--version"], env, deadline)); }
      catch { return null; }
    };
    return { codex: await read(this.config.codex.bin), claude: await read(this.config.claude.bin) };
  }

  async #latest(executor, packageName, env, deadline) {
    const output = await this.#run(executor, "npm", ["view", packageName, "version", "--json"], env, deadline);
    let value;
    try { value = JSON.parse(output); } catch { value = output; }
    const version = safeHarnessVersion(value);
    if (!version) throw new Error("Harness registry returned an invalid version");
    return version;
  }

  async #install(executor, root, current, latest, env, deadline) {
    const release = path.join(root, "releases", `release-${this.createId()}`);
    const next = path.join(root, `.current-${this.createId()}`);
    await executor.mkdir(release);
    try {
      await this.#run(executor, "npm", ["install", "--global", "--prefix", release, "--no-audit", "--no-fund",
        `${PACKAGES.codex}@${latest.codex}`, `${PACKAGES.claude}@${latest.claude}`], env, deadline, 128 * 1024);
      const candidate = {
        codex: versionFromOutput(await this.#run(executor, path.join(release, "bin/codex"), ["--version"], env, deadline)),
        claude: versionFromOutput(await this.#run(executor, path.join(release, "bin/claude"), ["--version"], env, deadline)),
      };
      if (candidate.codex !== latest.codex || candidate.claude !== latest.claude) throw new Error("Harness candidate validation failed");
      let previous = null;
      try { previous = await this.#run(executor, "readlink", [current], env, deadline); } catch {}
      await this.#run(executor, "ln", ["-sfn", release, next], env, deadline);
      await this.#rename(executor, next, current, env, deadline);
      try {
        const active = await this.#activeVersions(executor, current, env, deadline);
        if (active?.codex !== latest.codex || active?.claude !== latest.claude) throw new Error("Harness activation validation failed");
      } catch (error) {
        if (previous) {
          const rollback = path.join(root, `.rollback-${this.createId()}`);
          await this.#run(executor, "ln", ["-sfn", previous, rollback], env, deadline);
          await this.#rename(executor, rollback, current, env, deadline);
        } else await this.#run(executor, "unlink", [current], env, deadline).catch(() => {});
        throw error;
      }
      return candidate;
    } catch (error) {
      await this.#run(executor, "rm", ["-rf", "--", release], env, deadline).catch(() => {});
      throw error;
    }
  }

  #rename(executor, source, target, env, deadline) {
    return this.#run(executor, "node", ["-e", 'require("node:fs").renameSync(process.argv[1],process.argv[2])', source, target], env, deadline);
  }

  async #activate(executor, current) {
    const env = this.#environment(executor, path.dirname(current));
    const deadline = this.now() + Math.min(this.timeoutMs, 10_000);
    if (await this.#run(executor, "/bin/sh", ["-c", 'test -x "$1/bin/codex" -a -x "$1/bin/claude" && printf ready || true', "harness-check", current], env, deadline) !== "ready") return false;
    const base = executor.environmentPath || executor.backend?.config.ec2.remotePath || process.env.PATH;
    const bin = path.join(current, "bin");
    executor.environmentPath = base.split(":").includes(bin) ? base : `${bin}:${base}`;
    executor.harnessBins = { codex: path.join(bin, "codex"), claude: path.join(bin, "claude") };
    return true;
  }
}

export { HARNESS_UPDATE_INTERVAL_MS, HARNESS_UPDATE_FAILURE, publicHarnessUpdate } from "./harness-state.mjs";
