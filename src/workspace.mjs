import { spawn } from "node:child_process";
import { access, mkdir, realpath, stat, rm, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { signal, ...spawnOptions } = options;
    signal?.throwIfAborted();
    const child = spawn(command, args, { ...spawnOptions, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let killTimer, terminating = false;
    const killGroup = name => { try { if (process.platform === "win32") child.kill(name); else if (child.pid) process.kill(-child.pid, name); } catch {} };
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      killGroup("SIGTERM");
      // Even if git exits first, descendants can retain its pipes. Escalate
      // the owned detached group, not just the now-dead direct child.
      killTimer = setTimeout(() => killGroup("SIGKILL"), 2000);
    };
    const timer = setTimeout(() => { processError ||= new Error(`${command} timed out`); terminate(); }, 180000);
    let output = "";
    let processError;
    const abort = () => { processError = signal.reason || Object.assign(new Error("Clone cancelled"), { name: "AbortError" }); terminate(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", error => { processError = error; });
    child.once("close", (code, exitSignal) => {
      if (terminating) killGroup("SIGKILL");
      clearTimeout(timer);
      clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      if (processError) reject(processError);
      else if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} failed (${exitSignal || code}): ${output.slice(-2_000).trim()}`));
    });
  });
}

export async function prepareRepositories({ destination, repositories, getToken, token: suppliedToken, onProgress = () => {}, signal }) {
  signal?.throwIfAborted();
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const repo of repositories) {
    signal?.throwIfAborted();
    if (!/^[A-Za-z0-9_.-]+--[A-Za-z0-9_.-]+$/.test(repo.directory)) throw new Error("Invalid repository directory");
    if (repo.cloneUrl !== `https://github.com/${repo.fullName}.git`) throw new Error("Repository clone URL does not match its scoped GitHub identity");
    const target = path.join(destination, repo.directory);
    try { await access(path.join(target, ".git")); continue; } catch {}
    const token = getToken ? await getToken(repo) : suppliedToken;
    signal?.throwIfAborted();
    if (typeof token !== "string" || !token) throw new Error("No scoped GitHub credential is available for this repository");
    const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    const env = {
      PATH: process.env.PATH, LANG: process.env.LANG || "C.UTF-8", GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: `http.https://github.com/${repo.fullName}.git.extraheader`, GIT_CONFIG_VALUE_1: auth,
      GIT_CONFIG_KEY_2: "http.followRedirects", GIT_CONFIG_VALUE_2: "false",
    };
    await onProgress(`Preparing ${repo.fullName} (${repo.branch})…`);
    const temporary = `${target}.clone-${randomUUID()}`;
    try {
      await run("git", ["clone", "--no-hardlinks", ...(repo.empty ? [] : ["--branch", repo.branch]), "--", repo.cloneUrl, temporary], { env, signal });
      signal?.throwIfAborted();
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      signal?.throwIfAborted();
      throw new Error(`Could not clone ${repo.fullName}. Check the branch and your GitHub permissions. ${error.message.replaceAll(token, "[redacted]").replaceAll(auth, "[redacted]")}`);
    }
  }
}

function cloneEnv() {
  const keys = ["PATH", "HOME", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND"];
  return Object.fromEntries(keys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}

function isRemoteSource(source) {
  return /^(https:\/\/|ssh:\/\/|git@)/.test(source);
}

function validateRemoteSource(source) {
  if (source.startsWith("https://")) {
    const parsed = new URL(source);
    if (parsed.username || parsed.password) {
      throw new Error("Repository URLs containing credentials are not allowed");
    }
  }
  if (/[\r\n\0]/.test(source) || source.length > 2_048) throw new Error("Invalid repository source");
}

export async function prepareWorkspace({ destination, source = "" }) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (!source) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await run("git", ["init", "--quiet", destination], { env: cloneEnv() });
    return { source: "", kind: "empty" };
  }

  const env = { ...cloneEnv(), GIT_TERMINAL_PROMPT: "0" };
  if (isRemoteSource(source)) {
    validateRemoteSource(source);
    await run("git", ["clone", "--", source, destination], { env });
    return { source, kind: "remote-git" };
  }

  const resolved = await realpath(path.resolve(source));
  if (!(await stat(resolved)).isDirectory()) throw new Error("Workspace source must be a directory or Git URL");
  await access(path.join(resolved, ".git"));
  await run("git", ["clone", "--no-hardlinks", "--", resolved, destination], { env });
  return { source: resolved, kind: "local-git" };
}
