import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SAFE_ENV_NAMES = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "TZ",
];

export async function buildWorkerEnvironment({
  chat,
  store,
  runtimeHome = store.runtimeHome(chat.id),
  provider,
  authMode,
  capability,
  gatewayOrigin,
  ensureDirectory = (directory) => mkdir(directory, { recursive: true, mode: 0o700 }),
}) {
  const temporary = path.join(runtimeHome, "tmp");
  await ensureDirectory(temporary);

  const env = {};
  for (const name of SAFE_ENV_NAMES) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.HOME = authMode === "host" ? os.homedir() : runtimeHome;
  env.USER = authMode === "host" ? (process.env.USER || "agent") : "agent";
  env.LOGNAME = env.USER;
  env.SHELL = process.env.SHELL || "/bin/sh";
  env.TMPDIR = temporary;
  env.NO_COLOR = "1";
  env.CI = "1";

  if (provider === "openai") {
    env.CODEX_HOME = authMode === "host"
      ? (process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
      : path.join(runtimeHome, "codex");
    if (authMode === "gateway") {
      env.AGENT_SESSION_TOKEN = capability;
      env.AGENT_GATEWAY_ORIGIN = gatewayOrigin;
    }
  }

  if (provider === "anthropic") {
    env.CLAUDE_CONFIG_DIR = authMode === "host"
      ? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"))
      : path.join(runtimeHome, "claude");
    if (authMode === "gateway") {
      env.ANTHROPIC_BASE_URL = `${gatewayOrigin}/gateway/anthropic`;
      env.ANTHROPIC_AUTH_TOKEN = capability;
    }
  }
  return env;
}

export function spawnWorker(command, args, { isolation = "none", ...options } = {}) {
  const namespace = isolation === "namespace" && process.platform === "linux";
  const actualCommand = namespace ? "/usr/bin/unshare" : command;
  const actualArgs = namespace
    ? ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--", command, ...args]
    : args;
  return spawn(actualCommand, actualArgs, {
    ...options,
    detached: process.platform !== "win32",
  });
}

export async function terminateWorker(child, graceMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid, name);
    } catch {
      try { child.kill(name); } catch {}
    }
  };
  signal("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, graceMs)),
  ]);
  if (child.exitCode === null && child.signalCode === null) signal("SIGKILL");
}
