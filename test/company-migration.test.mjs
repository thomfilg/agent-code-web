import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRecords } from "../src/database.mjs";
import { targets as t, migrationPlan, applyMigrationPlan } from "../scripts/maintenance/company-migration-20260918.mjs";

async function fixture() {
  const records = new MemoryRecords();
  for (const [kind, id, value] of [
    ["relay-auth", "legacy-owner", { ownerId: "fixture-owner" }],
    ["chat", t.chat, { ownerId: "fixture-owner", environmentId: t.environment, repositories: [{ fullName: "12-apps/future-pay", githubConnectionId: t.personal }, { fullName: "g2i-ai/clickdown", githubConnectionId: t.work }] }],
    ["github_connection", t.personal, { login: "thomfilg", revision: 5, token: "fixture-personal", companies: ["12-apps", "thomfilg"] }],
    ["github_connection", t.work, { login: "thompson-filgueiras-g2i", revision: 2, token: "fixture-work" }],
    ["mcp", t.linear, { name: "linear", revision: 8, companies: ["12-apps", "g2i"], url: "https://mcp.linear.app/mcp", authGeneration: "old", oauth: { tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh" }, client: { client_secret: "fixture-client" } } }],
    ["environment", t.environment, { revision: 4, backend: "ec2", companies: ["12-apps", "thomfilg"], variables: [{ key: "PRIVATE_TEST", value: "fixture-variable", secret: true }], setupScript: "fixture setup", mcpIds: [] }],
    ["preferences", "new-chat", { model: "fixture-model", agentAccountId: "own-account", repositories: [{ fullName: "12-apps/future-pay", githubConnectionId: t.personal }, { fullName: "g2i-ai/clickdown", githubConnectionId: t.work }] }],
    ["agent-account", "own-account", { credentials: "fixture-agent" }],
    ["user:other:github_connection", "other-github", { token: "fixture-other" }],
    ["attachment", "owned-file", { chatId: t.chat }],
    ["attachment", "unrelated-file", { chatId: "other-chat" }],
    ["preview-host", "owned-preview", { chatId: t.chat, ownerId: "fixture-owner", status: "ready", distributionId: "TEST-DISTRIBUTION" }],
    ["preview-host", "unrelated-preview", { chatId: "other-chat", ownerId: "other", status: "ready" }],
  ]) await records.put(kind, id, { id, ...value });
  return records;
}

test("authorized migration preserves credentials, isolates companies and deletes only the exact chat", async () => {
  const records = await fixture(), before = structuredClone(records.rows), plan = await migrationPlan(records);
  assert.deepEqual(records.rows, before, "planning is read only");
  const summary = await applyMigrationPlan(records, plan);
  assert.equal(summary.githubCredentialsPreserved, true); assert.equal(summary.linearCredentialsPreserved, true); assert.equal(summary.environmentVariablesPreserved, true);
  assert.equal(await records.get("chat", t.chat), null);
  assert.equal(await records.get("attachment", "owned-file"), null);
  for (const key of ["agent-account/own-account", "user:other:github_connection/other-github", "attachment/unrelated-file", "preview-host/unrelated-preview"]) assert.deepEqual(records.rows.get(key), before.get(key));
  assert.equal((await records.get("github_connection", t.personal)).companyId, "12-apps");
  assert.equal((await records.get("github_connection", t.personal)).companies, undefined);
  assert.equal((await records.get("github_connection", t.work)).companyId, "g2i");
  const linear = await records.get("mcp", t.linear);
  assert.deepEqual(linear.companies, ["g2i"]); assert.notEqual(linear.authGeneration, "old");
  assert.deepEqual(linear.oauth, before.get(`mcp/${t.linear}`).oauth);
  const env = await records.get("environment", t.workEnvironment);
  assert.deepEqual(env.variables, []); assert.equal(env.setupScript, "");
  assert.deepEqual((await records.get("preferences", "new-chat")).repositories.map(r => r.companyId), ["12-apps"]);
  assert.equal((await records.get("preview-host", "owned-preview")).desired, "deleted");
  assert.equal(Number.isSafeInteger((await records.get("preview-host", "owned-preview")).updatedAt), true);
  await assert.rejects(migrationPlan(records), /already applied/);
});

for (const [name, kind, id, patch] of [
  ["different chat owner", "chat", t.chat, { ownerId: "other" }],
  ["different repository", "chat", t.chat, { repositories: [{ fullName: "other/repo", githubConnectionId: t.work }] }],
  ["changed GitHub", "github_connection", t.work, { revision: 3 }],
  ["changed Linear", "mcp", t.linear, { revision: 9 }],
  ["changed environment", "environment", t.environment, { revision: 5 }],
  ["different preview owner", "preview-host", "owned-preview", { ownerId: "other" }],
]) test(`migration rejects ${name} without writing`, async () => {
  const records = await fixture(); await records.put(kind, id, { ...await records.get(kind, id), ...patch });
  const before = structuredClone(records.rows);
  await assert.rejects(migrationPlan(records), /preflight failed/); assert.deepEqual(records.rows, before);
});

test("offline runner commits or rolls back encrypted PostgreSQL changes and exact workspace move", async t => {
  const { openDatabase } = await import("../src/database.mjs");
  const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createServer } = await import("node:net");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  for (const shouldFail of [false, true]) {
    const root = await mkdtemp(`${tmpdir()}/relay-company-migration-test-`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    const config = { mode: "embedded", directory: `${root}/control`, port };
    let records = await openDatabase(config);
    const input = await fixture();
    for (const [key, value] of input.rows) {
      const split = key.indexOf("/"); await records.put(key.slice(0, split), key.slice(split + 1), value);
    }
    await records.close();
    await mkdir(`${root}/state/chats/${tChat()}`, { recursive: true });
    await writeFile(`${root}/state/chats/${tChat()}/test-file.txt`, "fixture workspace");
    const planner = await readFile(new URL("../scripts/maintenance/company-migration-20260918.mjs", import.meta.url), "utf8");
    let runner = (await readFile(new URL("../scripts/maintenance/run-company-migration-20260918.mjs", import.meta.url), "utf8"))
      .replace('"/app/src/database.mjs"', JSON.stringify(new URL("../src/database.mjs", import.meta.url).href))
      .replace('"./company-migration-20260918.mjs"', JSON.stringify(`data:text/javascript;base64,${Buffer.from(planner).toString("base64")}`))
      .replace('"/var/lib/relay"', JSON.stringify(root)).replace("port: 55438", `port: ${port}`);
    if (shouldFail) runner = runner.replace("await applyMigrationPlan(records, plan);", 'await applyMigrationPlan(records, plan); throw new Error("fixture failure");');
    // Feed as a data module so this test never creates a runnable helper on disk.
    const childEnv = { ...process.env }; delete childEnv.AGENT_ENCRYPTION_KEY;
    const result = await execute(process.execPath, ["--input-type=module", "--eval", runner], { env: childEnv, timeout: 20000 }).catch(error => error);
    const receipt = JSON.parse(result.stdout.trim()); assert.equal(receipt.ok, !shouldFail);
    records = await openDatabase(config);
    try {
      assert.equal(Boolean(await records.get("chat", tChat())), shouldFail);
      assert.equal(Boolean(await records.get("maintenance", "company-migration-20260918")), !shouldFail);
      assert.equal((await readdir(`${root}/state/chats`)).includes(tChat()), shouldFail);
      assert.equal((await records.get("agent-account", "own-account")).credentials, "fixture-agent");
      const backup = await readFile(`${root}/maintenance/company-migration-20260918/records.json`, "utf8");
      assert.equal(backup.includes("fixture-refresh"), false); assert.equal(backup.includes("fixture-variable"), false);
    } finally { await records.close(); }
  }
  function tChat() { return "chat_d50034e32eef41d2a9de0f63288a9d7a"; }
});
