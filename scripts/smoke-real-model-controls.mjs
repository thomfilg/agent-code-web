import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { loadConfig } from "../src/config.mjs";

// Installed CLI + disposable profile + loopback Responses fixture only.
// No personal account, paid inference, host configuration or live chat access.
const directory = await mkdtemp("/tmp/relay-model-controls-");
const requests = [], settings = [];
let adapter, timeout;
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { request.resume(); response.writeHead(404); response.end(); return; }
  let body = ""; for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body)); const id = requests.length;
  if (id > 5) { response.writeHead(429); response.end("Unexpected model request"); return; }
  const item = { type: "message", id: `msg_model_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Local model-settings fixture.", annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_model_${id}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_model_${id}`, status: "completed", output: [item], usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-only" });
  const store = new ChatStore(directory); await store.initialize();
  const chat = await store.create({ agent: "codex", title: "Disposable model controls" }); await mkdir(chat.workspace, { recursive: true });
  const create = agentSessionId => new CodexAdapter({ chat: { ...chat, agentSessionId }, store, config, broker: new CapabilityBroker({ ttlMs: 120000 }), gatewayOrigin: `http://127.0.0.1:${server.address().port}`,
    hooks: { onRequest: () => assert.fail("No tools expected"), onFatal: () => {} } });
  const watch = () => adapter.rpc.on("notification", event => { if (event.method === "thread/settings/updated" && event.params.threadId === adapter.threadId) settings.push(event.params.threadSettings); });
  adapter = create(null); timeout = setTimeout(() => { void adapter?.stop(); server.closeAllConnections(); }, 45000);
  await adapter.start(); watch();
  const native = (await adapter.rpc.request("model/list", { includeHidden: false })).data;
  const model = native.find(model => model.supportsPersonality && model.serviceTiers?.some(tier => /^(fast|priority)$/i.test(tier.id) || /^fast$/i.test(tier.name)));
  assert(model, "Installed model catalog must advertise a Fast tier and personality support");
  const catalog = new ModelCatalog(config);
  catalog.codex = async () => ({ models: [{ id: model.model, supportsPersonality: model.supportsPersonality, serviceTiers: model.serviceTiers,
    efforts: model.supportedReasoningEfforts.map(item => item.reasoningEffort), defaultEffort: model.defaultReasoningEffort }] });
  let selected = { ...chat, model: model.model, effort: model.defaultReasoningEffort };
  const send = async (fast, personality) => {
    selected = { ...selected, ...await catalog.fastSettings(selected, fast), personality };
    const turn = await catalog.turnSettings(selected);
    const acknowledgements = settings.length;
    await adapter.send("Verify this local fixture; do not use tools.", turn);
    assert(settings.length > acknowledgements, "Each turn must produce a new native settings acknowledgement");
    // The installed CLI normalizes an explicit null (clear) to "default".
    assert.equal(settings.at(-1)?.serviceTier, selected.serviceTier ?? "default", "Installed CLI must acknowledge the selected tier");
    assert.equal(settings.at(-1)?.personality, personality, "Installed CLI must acknowledge the selected personality");
    const tier = requests.at(-1).service_tier;
    if (selected.serviceTier) assert.equal(tier, selected.serviceTier, "The advertised tier must reach the Responses request");
    else assert([null, undefined, "default", "auto"].includes(tier), "Fast off must remove the paid/fast tier from the model request");
  };
  await send("on", "friendly");
  await send("toggle", "pragmatic");
  await send("on", "none");
  const threadId = adapter.threadId;
  await adapter.stop(); adapter = create(threadId); await adapter.start(); watch();
  assert.equal(adapter.threadId, threadId);
  await send("off", "none");
  assert.equal(requests.length, 4, "Settings must not create additional inference requests");
  console.log(`Installed Codex ${adapter.cliVersion}: catalog-driven Fast on/toggle/off and friendly/pragmatic/none acknowledged by native settings; tiers reach loopback requests; same session resumes. Four fixture responses, zero external model calls.`);
} finally {
  clearTimeout(timeout); await adapter?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
