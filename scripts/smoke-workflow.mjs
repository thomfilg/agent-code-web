// Opt-in: one small real CLI turn per agent; GitHub verification is read-only.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createAgentWebServer } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { MemoryRecords } from "../src/database.mjs";
const root = await mkdtemp("/tmp/relay-workflow-smoke-");
const records = new MemoryRecords();
const config = loadConfig({ ...process.env, AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_WEB_PORT: "0", CODEX_AUTH_MODE: "host", CLAUDE_AUTH_MODE: "host", AGENT_IDLE_TIMEOUT_MS: "1000" });
const github = new GitHubConnection({ records, config: config.github });
const app = await createAgentWebServer({ config, records, github });
try {
  await app.start();
  for (const agent of ["codex", "claude"]) {
    const chat = await app.manager.createChat({ agent });
    await app.manager.send(chat.id, "Before continuing, ask me which Git branch to use and wait for my answer. Ask in your plain-text final reply, not a tool. Do not run tools or change files.");
    const result = app.store.get(chat.id);
    assert.equal(result.workflowState, "asking_question", `${agent}: ${result.messages.at(-1)?.text}`);
    assert.notEqual(result.title, "New conversation");
    assert.ok(result.messages.some(m => m.role === "assistant"));
    assert.ok(result.messages.filter(m => m.role === "assistant").every(m => !/<relay-(waiting|title)>/.test(m.text)));
    await app.manager.stop(chat.id);
    assert.equal(app.store.get(chat.id).workflowState, "asking_question");
    console.log(`${agent}: question detected, metadata hidden, waiting state survives sleep`);
  }
  await github.connect({ method: "local" });
  const chat = await app.store.create({ agent: "mock", title: "Read-only PR verification", repositories: [{ fullName: "thomfilg/agent-code-web", defaultBranch: "main" }] });
  await app.store.appendMessage(chat.id, { role: "assistant", text: "https://github.com/thomfilg/agent-code-web/pull/1" });
  await app.manager.pullRequests.refresh(chat.id);
  const result = app.store.get(chat.id);
  assert.equal(result.pullRequests[0]?.number, 1);
  assert.equal(result.githubSyncWarning, null);
  console.log(`GitHub: PR #1 verified (${result.workflowState}, checks ${result.pullRequests[0].checks}); no worker started`);
} finally { await app.stop(); await rm(root, { recursive: true, force: true }); }
