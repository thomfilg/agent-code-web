import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";

// Exercise the installed CLIs and Relay adapters, never a real model account.
// All provider responses are deterministic fixtures on this loopback server.
const directory = await mkdtemp("/tmp/relay-compact-smoke-");
const reviewOnly = process.argv.includes("--review-only");
const claudeCommands = process.argv.includes("--claude-commands");
const calls = { codex: 0, claude: 0 };
let reviewResponse = false, holdReviewResponse = false;
const sample = "This isolated fixture documents context compaction and message ordering. ".repeat(80);
const server = http.createServer(async (request, response) => {
  let input = ""; for await (const chunk of request) input += chunk;
  if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":5000}'); return; }
  if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
  const data = JSON.parse(input || "{}");
  if (request.url.endsWith("/responses")) {
    if (holdReviewResponse) return; // Interrupt fixture: keep only this isolated response pending.
    const text = reviewResponse ? JSON.stringify({ findings: [], overall_correctness: "patch is correct", overall_explanation: "This isolated fixture found no issues.", overall_confidence_score: 1 }) : sample;
    const n = ++calls.codex, item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item], usage: { input_tokens: 5000, output_tokens: 1000, total_tokens: 6000 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  } else if (/\/messages(?:\?|$)/.test(request.url)) {
    const message = { id: `msg_fixture_${++calls.claude}`, type: "message", role: "assistant", model: data.model, content: [{ type: "text", text: sample }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5000, output_tokens: 1000 } };
    if (!data.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: sample } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1000 } },
      { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  } else response.writeHead(404);
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const gatewayOrigin = `http://127.0.0.1:${server.address().port}`;
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", CLAUDE_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused", ANTHROPIC_API_KEY: "fixture-unused", CODEX_MODEL: "gpt-5.4", CLAUDE_MODEL: "sonnet" });
const store = new ChatStore(directory); await store.initialize();
let adapter;
try {
  for (const [agent, Adapter] of [["codex", CodexAdapter], ["claude", ClaudeAdapter]]) {
    if (reviewOnly && agent !== "codex") continue;
    if (claudeCommands && agent !== "claude") continue;
    const events = [], chat = await store.create({ agent, title: "Isolated compaction fixture" }); await mkdir(chat.workspace, { recursive: true });
    adapter = new Adapter({ chat, store, config, broker: new CapabilityBroker({ ttlMs: 120000 }), gatewayOrigin, hooks: { onEvent: event => events.push(event), onRequest: () => assert.fail("The fixture never requests tool approval"), onFatal: () => {} } });
    await adapter.start();
    if (agent === "codex") {
      assert.deepEqual((await adapter.inspectCommand("ps")).items, []);
      assert.ok((await adapter.inspectCommand("debug-config")).items.length > 0);
      await assert.rejects(adapter.terminateBackground("not-a-task"), /no longer tracked/);
      await adapter.terminateBackground("all");
    }
    const timeout = setTimeout(() => { void adapter.stop(); }, 60000);
    try {
      for (let n = 0; n < (reviewOnly ? 1 : 3); n++) await adapter.send(`Fixture history ${n}: ${sample}`);
      const before = calls[agent];
      if (!reviewOnly) {
      const result = agent === "codex" ? await adapter.compact() : await adapter.send("/compact");
      assert.equal(result.status, "completed"); assert.ok(calls[agent] > before, `${agent} did not ask the local stub to summarize`);
      if (agent === "claude") assert.equal(result.compacted, true, "Claude did not emit its native compact_boundary");
      console.log(`${agent}: native compaction completed through Relay's adapter (${calls[agent]} local fixture responses; no real model calls).`);
      }
      if (claudeCommands) {
        for (const command of ["/reload-skills", "/autocompact 200k", "/config"]) {
          const before = calls.claude, result = await adapter.send(command);
          console.log(JSON.stringify({ command, status: result.status, text: result.text.slice(0, 300), modelCalls: calls.claude - before }));
          assert.equal(result.status, "completed");
          assert.ok(result.text.trim(), `${command} returned no visible result`);
          assert.equal(calls.claude, before, `${command} must remain a native local command, not a model prompt`);
          assert.doesNotMatch(result.text, /Couldn't parse|Unknown command/);
        }
      }
      if (agent === "codex") {
        reviewResponse = true;
        if (process.argv.includes("--trace-review")) {
          adapter.rpc.on("notification", ({ method, params = {} }) => console.log(JSON.stringify({ method, threadId: params.threadId, turnId: params.turn?.id, status: params.turn?.status, itemType: params.item?.type })));
          const request = adapter.rpc.request.bind(adapter.rpc);
          adapter.rpc.request = async (method, params, timeout) => { console.log(JSON.stringify({ request: method })); try { const result = await request(method, params, timeout); console.log(JSON.stringify({ response: method, keys: Object.keys(result || {}), reviewThreadId: result.reviewThreadId })); return result; } catch (error) { console.log(JSON.stringify({ request: method, error: error.message })); throw error; } };
        }
        const nativeReview = await adapter.send("", { model: "gpt-5.4", effort: "low", mode: "plan", reviewTarget: { type: "custom", instructions: "This is an isolated protocol fixture. Return a review of the provided example: no bugs were found. Do not execute tools." } });
        assert.equal(nativeReview.status, "completed");
        assert.match(nativeReview.text, /isolated fixture/);
        console.log("codex: native review completed through Relay's adapter and returned the reviewer output (loopback fixture only).");
        holdReviewResponse = true;
        const pending = adapter.send("", { model: "gpt-5.4", mode: "plan", reviewTarget: { type: "custom", instructions: "Isolated interrupt fixture" } });
        const rejected = assert.rejects(pending, /interrupted/);
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && (!adapter.current?.reviewTurnId || !adapter.current?.turnId || adapter.current.turnId === adapter.current.reviewTurnId)) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(adapter.current?.turnId, "Native review did not start");
        await adapter.interrupt(); await rejected;
        holdReviewResponse = false;
        console.log("codex: native review interruption completed using its active inner turn ID.");
      }
    } finally { clearTimeout(timeout); await adapter.stop(); }
  }
} finally {
  await adapter?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
