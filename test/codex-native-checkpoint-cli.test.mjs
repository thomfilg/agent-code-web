import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { once } from "node:events";
import { JsonRpcProcess } from "../src/json-rpc-process.mjs";
import { restoreSessionBundleIfFresh } from "../src/codex-session-bundle.mjs";
import { nativeId, nativeRow } from "./fixtures/native-session.mjs";
import { temporaryDirectory } from "./helpers.mjs";

// Explicit opt-in: installed CLI only, no login/model/turn. The only provider
// configured is an unreachable loopback endpoint. No inherited HOME or auth.
test("installed Codex loads an exact imported journal in a fresh private profile without starting a turn", { skip: !process.env.CODEX_NATIVE_COMPAT_BIN, timeout: 30000 }, async t => {
  const root = await temporaryDirectory(t), home = path.join(root, "codex"), workspace = path.join(root, "workspace");
  await mkdir(home, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  const data = nativeRow("session_meta", { id: nativeId, timestamp: "2026-09-19T12:00:00.000Z", cwd: workspace,
    originator: "relay-native-checkpoint-fixture", cli_version: "0.155.0", source: "cli", model_provider: "fixture", base_instructions: { text: "Synthetic fixture only" } })
    + nativeRow("event_msg", { type: "task_started", turn_id: nativeId, model_context_window: 200000, collaboration_mode_kind: "default" })
    + nativeRow("event_msg", { type: "user_message", message: "Synthetic native history sentinel", images: [], local_images: [], text_elements: [] })
    + nativeRow("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic native history sentinel" }] })
    + nativeRow("response_item", { type: "reasoning", encrypted_content: "synthetic-opaque-native-history", summary: [] })
    + nativeRow("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic stored response" }] })
    + nativeRow("event_msg", { type: "agent_message", message: "Synthetic stored response", phase: "final_answer" })
    + nativeRow("event_msg", { type: "task_complete", turn_id: nativeId, last_agent_message: "Synthetic stored response" });
  const restored = await restoreSessionBundleIfFresh(home, { version: 1, threadId: nativeId, goal: null, files: [{ id: nativeId, data: Buffer.from(data).toString("base64") }] });
  const args = ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"', "-c", 'model_provider="fixture"', "-c", 'model="synthetic-model"',
    "-c", 'model_providers.fixture.name="No-network native checkpoint fixture"', "-c", 'model_providers.fixture.base_url="http://127.0.0.1:9/v1"',
    "-c", 'model_providers.fixture.wire_api="responses"', "-c", "model_providers.fixture.requires_openai_auth=false", "-c", 'web_search="disabled"'];
  const rpc = new JsonRpcProcess({ command: process.env.CODEX_NATIVE_COMPAT_BIN, args, requestTimeoutMs: 10000,
    spawnOptions: { cwd: workspace, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, LANG: "C.UTF-8", NO_COLOR: "1" } } });
  const notifications = []; rpc.on("notification", message => notifications.push(message)); rpc.on("error", () => {});
  rpc.start();
  try {
    await rpc.request("initialize", { clientInfo: { name: "relay_native_checkpoint_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized", {});
    const read = await rpc.request("thread/read", { threadId: nativeId, includeTurns: true });
    assert.equal(read.thread.id, nativeId); assert.match(JSON.stringify(read.thread), /Synthetic native history sentinel/);
    const resumed = await rpc.request("thread/resume", { threadId: nativeId, cwd: workspace, modelProvider: "fixture", model: "synthetic-model", approvalPolicy: "never", sandbox: "read-only" });
    assert.equal(resumed.thread.id, nativeId);
    assert.equal(notifications.some(message => message.method === "turn/started"), false);
    assert.ok((await readFile(restored.path, "utf8")).startsWith(data), "native resume never replaces imported records");
  } finally {
    // The npm launcher may exit before its native child's inherited pipes
    // close. Observe close as well as exit before removing the private home.
    const closed = rpc.child ? once(rpc.child, "close") : Promise.resolve();
    await rpc.stop(); await closed;
  }
});
