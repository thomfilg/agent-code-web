import { spawn } from "node:child_process";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} failed (${signal || code}): ${output.slice(-2_000).trim()}`));
    });
  });
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
