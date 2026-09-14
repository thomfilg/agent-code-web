// Opt-in: runs one small turn using the locally authenticated CLI for each agent.
import { mkdtemp, rm } from "node:fs/promises";
import { createAgentWebServer } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
const root = await mkdtemp("/tmp/relay-title-smoke-");
const app = await createAgentWebServer({ config: loadConfig({ ...process.env, AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_WEB_PORT: "0", CODEX_AUTH_MODE: "host", CLAUDE_AUTH_MODE: "host", AGENT_IDLE_TIMEOUT_MS: "1000" }) });
try {
  await app.start();
  for (const agent of process.argv.slice(2).length ? process.argv.slice(2) : ["codex", "claude"]) {
    const chat = await app.manager.createChat({ agent });
    await app.manager.send(chat.id, "Please reply with a short greeting. Do not run tools or change files.");
    const result = app.store.get(chat.id);
    if (result.title === "New conversation" || !result.messages.some(m => m.role === "assistant") || result.messages.some(m => m.role === "assistant" && m.text.includes("<relay-title>"))) throw new Error(`${agent}: automatic title smoke failed: ${result.messages.at(-1)?.text}`);
    console.log(`${agent}: title generated and hidden from response (${result.title})`);
    await app.manager.stop(chat.id);
  }
} finally { await app.stop(); await rm(root, { recursive: true, force: true }); }
