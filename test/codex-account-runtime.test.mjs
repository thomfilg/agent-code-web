import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("named-account workers receive access only, refresh privately and redact credentials from native output", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ title: "Named account", agent: "codex", agentAccountId: "selected-account" });
  await mkdir(chat.workspace, { recursive: true, mode: 0o700 });
  const broker = new CapabilityBroker({ ttlMs: 10000 }), requests = [], events = [], calls = [];
  const adapter = new CodexAdapter({ chat, store, broker,
    config: testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs") }),
    hooks: { onEvent: value => events.push(value), onRequest: value => requests.push(value), accountCredentials: async input => {
      calls.push(input);
      if (input.previousAccountId && input.previousAccountId !== "chosen-workspace") throw Error("private-provider-error");
      return { accessToken: "private-fixture-access-value", chatgptAccountId: "chosen-workspace", chatgptPlanType: "pro" };
    } },
  });
  t.after(() => adapter.stop()); await adapter.start();
  assert.equal(adapter.nativeAuthMode, "account"); assert.equal(broker.size, 0);
  assert.ok(adapter.rpc.args.includes('cli_auth_credentials_store="ephemeral"'));
  assert.ok(adapter.rpc.args.includes('model_provider="openai"'));
  const env = adapter.rpc.spawnOptions.env;
  assert.notEqual(env.HOME, process.env.HOME);
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.AGENT_SESSION_TOKEN, undefined);
  await assert.rejects(access(path.join(env.CODEX_HOME, "auth.json")), { code: "ENOENT" });
  const refreshed = await adapter.rpc.request("fixture/accountRefresh", { previousAccountId: "chosen-workspace" });
  assert.deepEqual(refreshed, { fields: ["accessToken", "chatgptAccountId", "chatgptPlanType"], accountId: "chosen-workspace", hasAccess: true });
  assert.deepEqual(calls, [{}, { refresh: true, previousAccountId: "chosen-workspace" }]);
  assert.equal(requests.length, 0, "credential renewal must never appear as a user approval");
  await assert.rejects(() => adapter.rpc.request("fixture/accountRefresh", { previousAccountId: "wrong-workspace" }), /Reconnect/);
  const echo = await adapter.rpc.request("fixture/accountEcho");
  assert.equal(echo.accessToken, "[redacted]");
  assert.doesNotMatch(JSON.stringify(events), /private-fixture-access|private-provider-error/);
});
