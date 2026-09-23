import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { openDatabase, MemoryRecords } from "../src/database.mjs";
import { Environments } from "../src/environments.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { buildWorkerEnvironment } from "../src/worker-process.mjs";
import { TitleStream, extractTitle } from "../src/title-protocol.mjs";
import { ChatStore } from "../src/store.mjs";
import path from "node:path";
import { temporaryDirectory } from "./helpers.mjs";

test("real PostgreSQL encrypts settings and reloads credentials and preferences after restart", async t => {
  const directory = await temporaryDirectory(t, "relay-postgres-test-");
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const config = { mode: "embedded", directory, port };
  let db = await openDatabase(config);
  try {
    await db.put("connection", "github", { token: "fixture-long-lived-secret", login: "fixture" });
    await db.put("preferences", "new-chat", { repositories: [{ fullName: "Company/repo", branch: "work" }], environmentId: "test-env" });
    const store = new ChatStore(path.join(directory, "first-controller"), db); await store.initialize();
    const chat = await store.create({ title: "Persisted context", agent: "codex" });
    await store.appendMessage(chat.id, { role: "user", text: "Keep this conversation outside the worker" });
    await store.update(chat.id, { usage: { version: 2, contextTokens: 137200, contextWindow: 1000000, recordedAt: "2026-09-15T18:00:00.000Z" } });
    const encrypted = await db.pool.query("SELECT payload FROM relay_records WHERE kind = $1", ["connection"]);
    assert.equal(encrypted.rows[0].payload.includes("fixture-long-lived-secret"), false);
    await db.close(); db = await openDatabase(config);
    assert.equal((await db.get("connection", "github")).token, "fixture-long-lived-secret");
    assert.equal((await db.get("preferences", "new-chat")).repositories[0].branch, "work");
    const restored = new ChatStore(path.join(directory, "empty-new-controller"), db); await restored.initialize();
    assert.equal(restored.get(chat.id).messages[0].text, "Keep this conversation outside the worker");
    assert.equal(restored.get(chat.id).usage.contextTokens, 137200);
    assert.equal(restored.get(chat.id).status, "stopped");
  } finally { await db.close(); }
});
test("protected variables never enter worker env; public values and toggles do; concurrent revisions conflict", async t => {
  const root = await temporaryDirectory(t); const records = new MemoryRecords(); const environments = new Environments(records);
  const env = await environments.save({ name: "Staging", backend: "local", allowUnassigned: true, variables: [{ key: "SERVICE_TOKEN", value: "protected-123", secret: true }, { key: "APP_REGION", value: "test-region", secret: false }, { key: "DISABLED", value: "hidden", secret: false, enabled: false }] });
  assert.equal(env.variables[0].value, undefined);
  const profile = await environments.runtime(env.id);
  const worker = await buildWorkerEnvironment({ chat: { id: "x" }, store: { runtimeHome: () => root }, provider: "openai", authMode: "gateway", capability: "temporary-capability", gatewayOrigin: "http://localhost", environmentVariables: profile.variables });
  assert.equal(worker.SERVICE_TOKEN, undefined); assert.equal(worker.APP_REGION, "test-region"); assert.equal(worker.DISABLED, undefined);
  const results = await Promise.allSettled([environments.save({ ...env, variablesEnabled: false }, env.id), environments.save({ ...env, name: "Lost update" }, env.id)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.deepEqual((await environments.runtime(env.id)).variables, {});
  const latest = await environments.get(env.id);
  await assert.rejects(environments.save({ ...latest, variables: [{ key: "OPENAI_API_KEY", value: "override" }] }, env.id), /managed by Agent Relay/);
  await assert.rejects(environments.save({ ...latest, variables: [{ key: "SERVICE_TOKEN", secret: false }] }, env.id), /Re-enter/);
});
test("protected NODE_AUTH_TOKEN is controller-readable only through the npm credential boundary", async () => {
  const records = new MemoryRecords(), environments = new Environments(records);
  await records.put("company", "fixture", { id: "fixture", name: "Fixture", revision: 1, createdAt: new Date().toISOString() });
  const chat = { repositories: [{ fullName: "fixture/repo" }] };
  const saved = await environments.save({ name: "Private npm", backend: "local", companyId: "fixture",
    variables: [{ key: "NODE_AUTH_TOKEN", value: "npm_private_fixture", secret: true }] });
  assert.equal(saved.variables[0].value, undefined);
  const runtime = await environments.runtime(saved.id, chat);
  assert.deepEqual(runtime.variables, {}); assert.deepEqual(runtime.protectedKeys, ["NODE_AUTH_TOKEN"]);
  assert.deepEqual(await environments.npmCredential(saved.id, chat), { token: "npm_private_fixture", environmentId: saved.id, revision: saved.revision });
  const latest = await environments.get(saved.id);
  await environments.save({ ...latest, variables: [{ key: "NODE_AUTH_TOKEN", value: "bad\nvalue", secret: true }] }, saved.id);
  await assert.rejects(environments.npmCredential(saved.id, chat), /single-line/);
});
test("GitHub validates access, redacts credentials, preserves primary order and detects revocation", async () => {
  const records = new MemoryRecords(); let revoked = false;
  const gh = new GitHubConnection({ records, config: { localConnection: true, apiBase: "https://api.github.com" }, localToken: async () => "fixture-github-token",
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, "Bearer fixture-github-token");
      if (revoked) return Response.json({}, { status: 401 });
      const path = new URL(url).pathname;
      if (path === "/user") return Response.json({ login: "test", id: 1 });
      if (path.includes("/branches/")) return Response.json({ name: "main" });
      const full_name = path.slice(7);
      return Response.json({ full_name, id: full_name.length, name: full_name.split("/")[1], default_branch: "main", private: true, size: 1 });
    },
  });
  assert.equal((await gh.status()).connected, false);
  const status = await gh.connect({ method: "local", companies: ["first", "second"] }); assert.equal(status.token, undefined);
  const repos = await gh.resolveSelections([{ fullName: "Second/web", branch: "develop" }, { fullName: "First/api" }]);
  assert.equal(repos[0].fullName, "Second/web"); assert.equal(repos[0].branch, "develop");
  assert.equal(repos[0].cloneUrl.includes("fixture-github-token"), false);
  await assert.rejects(gh.resolveSelections([{ fullName: "../bad" }]), /Invalid/);
  revoked = true; await assert.rejects(gh.branches("First/api"), /expired or were revoked/);
  assert.equal((await gh.status()).connected, false);
});
test("expired GitHub credentials are rejected before any network call", async () => {
  const records = new MemoryRecords(); await records.put("connection", "github", { token: "old", expiresAt: "2020-01-01" });
  const gh = new GitHubConnection({ records, config: {}, fetchImpl: () => { throw new Error("must not call"); } });
  await assert.rejects(gh.requireConnection(), /missing or expired/);
  assert.equal((await gh.status()).expired, true);
});
test("model-selected titles are stripped across arbitrary streaming boundaries", () => {
  const input = "<relay-title>Fix billing flow</relay-title>\nThe answer.";
  for (let split = 1; split < input.length; split++) {
    const events = []; const stream = new TitleStream(event => events.push(event));
    stream.delta(input.slice(0, split)); stream.delta(input.slice(split)); stream.flush();
    assert.deepEqual(events.filter(e => e.type === "title").map(e => e.title), ["Fix billing flow"]);
    assert.equal(events.filter(e => e.type === "assistant_delta").map(e => e.delta).join("").trim(), "The answer.");
  }
  assert.equal(extractTitle("No metadata here").text, "No metadata here");
});
