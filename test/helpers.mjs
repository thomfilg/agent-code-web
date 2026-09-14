import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";

export async function temporaryDirectory(t, prefix = "agent-web-test-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function testConfig(dataDir, overrides = {}) {
  const env = {
    AGENT_WEB_HOST: "127.0.0.1",
    AGENT_WEB_PORT: "0",
    AGENT_DATA_DIR: dataDir,
    AGENT_IDLE_TIMEOUT_MS: "100",
    AGENT_ENABLE_MOCK: "1",
    AGENT_DATABASE_MODE: "memory",
    AGENT_PROCESS_ISOLATION: "none",
    CODEX_AUTH_MODE: "gateway",
    CLAUDE_AUTH_MODE: "gateway",
    OPENAI_API_KEY: "sk-control-plane-openai-fixture",
    ANTHROPIC_API_KEY: "sk-ant-control-plane-fixture",
    PATH: process.env.PATH,
    ...overrides,
  };
  return loadConfig(env);
}

export async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met in ${timeoutMs} ms`);
}
