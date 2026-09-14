import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";
import { ChatStore } from "../src/store.mjs";
import { prepareWorkspace } from "../src/workspace.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "agent-web-real-codex-"));
let adapter;
try {
  const config = loadConfig({
    AGENT_WEB_HOST: "127.0.0.1",
    AGENT_WEB_PORT: "0",
    AGENT_DATA_DIR: root,
    AGENT_PROCESS_ISOLATION: process.platform === "linux" ? "namespace" : "none",
    CODEX_AUTH_MODE: "gateway",
    OPENAI_API_KEY: "smoke-test-placeholder-never-used",
    PATH: process.env.PATH,
  });
  const store = new ChatStore(root);
  await store.initialize();
  const chat = await store.create({ title: "Protocol smoke test", agent: "codex", source: "" });
  await prepareWorkspace({ destination: chat.workspace, source: "" });
  let threadId;
  adapter = new CodexAdapter({
    chat,
    store,
    config,
    broker: new CapabilityBroker({ ttlMs: 10_000 }),
    gatewayOrigin: "http://127.0.0.1:9",
    hooks: {
      onSessionId: (id) => { threadId = id; },
      onFatal: (error) => { throw error; },
    },
  });
  await adapter.start();
  if (!threadId) throw new Error("real app-server did not return a thread id");
  console.log(`Real Codex app-server handshake passed (${threadId})`);
} finally {
  await adapter?.stop().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
