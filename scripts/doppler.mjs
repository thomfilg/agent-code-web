import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), "..");
const project = "code-web", config = "dev";
const modes = ["start", "dev", "check"];

async function readToken(filename) {
  const info = await stat(filename);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077))) {
    throw new Error("The Doppler service-token file must be private to your OS user (chmod 600)");
  }
  return readFile(filename, "utf8");
}

export async function dopplerInvocation(mode, env = process.env, read = readToken) {
  if (!modes.includes(mode)) throw new Error("Expected start, dev or check");
  const childEnv = { ...env };
  if (!childEnv.DOPPLER_TOKEN?.trim()) {
    // Project-specific name: never adopt a sibling application's service token.
    const tokenFile = env.DOPPLER_DEV_TOKEN_FILE || path.resolve(root, "../.doppler-code-web-dev-token");
    try {
      childEnv.DOPPLER_TOKEN = (await read(tokenFile)).trim();
      if (!childEnv.DOPPLER_TOKEN) throw new Error("The Doppler service-token file is empty");
    } catch (error) {
      // An explicitly selected file must not silently fall back to a wider CLI login.
      if (error.code !== "ENOENT" || env.DOPPLER_DEV_TOKEN_FILE) throw error;
      delete childEnv.DOPPLER_TOKEN;
    }
  }
  return {
    command: "doppler",
    args: ["run", "--project", project, "--config", config, "--no-fallback", "--no-check-version", "--",
      process.execPath, filename, "--injected", mode],
    env: childEnv,
    cwd: root,
  };
}

export function injectedSettings(input, mode = "start") {
  if (!modes.includes(mode)) throw new Error("Expected start, dev or check");
  if (input.DOPPLER_PROJECT !== project || input.DOPPLER_CONFIG !== config) {
    throw new Error("Refusing to start: expected Doppler project code-web, config dev");
  }
  const env = { ...input, AGENT_GOOGLE_AUTH: "1",
    AGENT_WEB_PUBLIC_URL: input.AGENT_WEB_PUBLIC_URL || "http://localhost:8787" };
  // Only the Doppler subprocess needs its service token. Do not give it to Relay
  // or its workers. Worker environments already use a separate explicit allowlist.
  delete env.DOPPLER_TOKEN;
  delete env.DOPPLER_DEV_TOKEN_FILE;
  if (mode === "dev") env.AGENT_ENABLE_MOCK ??= "1";
  const resolved = loadConfig(env);
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "AGENT_OWNER_EMAIL"]
    .filter(name => !env[name]?.trim());
  return { env, missing, report: { project, config,
    googleClientIdConfigured: Boolean(env.GOOGLE_CLIENT_ID?.trim()),
    googleClientSecretConfigured: Boolean(env.GOOGLE_CLIENT_SECRET?.trim()),
    ownerEmailConfigured: Boolean(env.AGENT_OWNER_EMAIL?.trim()),
    origin: resolved.google.origin,
    callbackUrl: `${resolved.google.origin}/api/auth/callback/google`,
    missing,
  } };
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    const handlers = ["SIGINT", "SIGTERM"].map(signal => {
      const handler = () => child.kill(signal);
      process.on(signal, handler); return [signal, handler];
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      for (const [name, handler] of handlers) process.off(name, handler);
      resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
}

async function main(args) {
  const injected = args[0] === "--injected";
  const mode = args[injected ? 1 : 0] || "start";
  if (!injected) {
    const { command, args: childArgs, ...options } = await dopplerInvocation(mode);
    return runChild(command, childArgs, options);
  }
  const settings = injectedSettings(process.env, mode);
  if (mode === "check") {
    console.log(JSON.stringify(settings.report, null, 2));
    return settings.missing.length ? 1 : 0;
  }
  if (settings.missing.length) {
    throw new Error(`Set ${settings.missing.join(", ")} in Doppler code-web/dev before starting Relay`);
  }
  return runChild(process.execPath, [...(mode === "dev" ? ["--watch"] : []), "src/server.mjs"],
    { cwd: root, env: settings.env });
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    // Never serialize a child-process error object: it may include its environment.
    console.error(error.code === "ENOENT"
      ? "Doppler CLI or the explicitly configured token file was not found. See docs/google-login.md."
      : error.message);
    process.exitCode = 1;
  }
}
