import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";

// Real CLI and native filesystem tools, but deterministic local model replies.
// All repository files/profiles are disposable. Never use personal credentials,
// a paid model, a real repository, or any live approval/browser/chat state.
const directory = await mkdtemp("/tmp/relay-init-");
let manager, scenario, fixtureFailure, timeout, adapter;
const requests = [], approvals = [];
const manifest = JSON.stringify({ name: "init-fixture", description: "INIT_MANIFEST_EVIDENCE", scripts: { test: "node --test" }, type: "module" }, null, 2) + "\n";
const readme = "# Init fixture\n\nA tiny Node project. Tests live in test/. Use npm test.\n";
const instructions = "# Repository instructions\n\nPreserve the INIT_USER_POLICY canary.\n\nRun `npm test` (`node --test`) for the tests under `test/`.\n";
const codeCall = (id, input) => ({ type: "custom_tool_call", id: `code_${id}`, call_id: id, namespace: "functions", name: "exec", input });
const output = (body, id) => JSON.stringify(body.input?.find(item => item.call_id === id && /(?:function|custom_tool)_call_output/.test(item.type))?.output);
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { request.resume(); response.writeHead(404); response.end(); return; }
  let raw = ""; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw), n = requests.push(body), key = scenario?.name;
  let item;
  try {
    assert(scenario && n <= 12, "Unexpected fixture inference");
    if (scenario.step === 0) {
      assert.match(JSON.stringify(body.input), /Inspect this repository and create or improve its AGENTS\.md/);
      if (scenario.inherited) assert.match(JSON.stringify(body.input), /INIT_USER_POLICY/, "A resumed session must load its saved repository instructions");
      if (scenario.readOnly) assert.match(JSON.stringify(body.input), /read-only|readOnly/);
      // Current Codex advertises Code Mode through additional_tools input,
      // not legacy top-level tools. Exercise that real advertised surface.
      const catalog = body.input.filter(item => item.type === "additional_tools").flatMap(item => item.tools);
      assert(catalog.some(tool => tool.name === "functions" && tool.tools?.some(child => child.name === "exec")), "Native Code Mode must be advertised");
      const args = { cmd: "pwd\nrg --files\nsed -n '1,120p' package.json\nsed -n '1,120p' README.md\nif [ -f AGENTS.md ]; then sed -n '1,120p' AGENTS.md; fi", workdir: scenario.workspace, max_output_tokens: 2000 };
      item = codeCall(`${key}_read`, `text(await tools.exec_command(${JSON.stringify(args)}));`);
    } else if (scenario.step === 1) {
      assert.match(output(body, `${key}_read`), /INIT_MANIFEST_EVIDENCE/, "The native repository read must complete before the edit");
      item = codeCall(`${key}_patch`, `text(await tools.apply_patch(${JSON.stringify(scenario.patch)}));`);
    } else {
      const result = output(body, `${key}_patch`);
      assert(result, "The native patch must return a tool result");
      if (scenario.readOnly) assert.match(result, /denied|reject|not allow|read.only|permission/i);
      else assert.match(result, /Script completed/); // apply_patch returns {}; file bytes are checked below.
    }
    scenario.step++;
  } catch (error) { fixtureFailure ||= error; }
  item ||= { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", annotations: [], text: fixtureFailure ? "Local fixture assertion failed; no success is claimed." : scenario.readOnly ? "Plan fixture: no file was written." : "Local fixture completed; inspect the AGENTS.md diff." }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item], usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-only" });
  const store = new ChatStore(directory); await store.initialize();
  const broker = new CapabilityBroker({ ttlMs: 120000 }), origin = `http://127.0.0.1:${server.address().port}`;
  manager = new RuntimeManager({ store, config, broker, gatewayOrigin: origin, adapterFactory: params => {
    adapter = new CodexAdapter({ ...params, store, config, broker, gatewayOrigin: origin }); return adapter;
  } });
  manager.on("event", event => { if (event.type === "request") { approvals.push(event.request); void manager.respond(event.chatId, event.request.requestId, { decision: "decline" }); } });
  timeout = setTimeout(() => { void manager.shutdown(); server.closeAllConnections(); }, 45000);
  const chat = await manager.createChat({ agent: "codex", title: "Disposable init acceptance" });
  await mkdir(path.join(chat.workspace, "test"), { recursive: true });
  await writeFile(path.join(chat.workspace, "package.json"), manifest); await writeFile(path.join(chat.workspace, "README.md"), readme);
  await writeFile(path.join(chat.workspace, "test", "smoke.test.mjs"), "import test from 'node:test'; test('fixture', () => {});\n");
  const target = path.join(chat.workspace, "AGENTS.md"), unchanged = path.join(chat.workspace, "user-draft.txt"); await writeFile(unchanged, "Unrelated unsaved user work\n");
  scenario = { name: "create", workspace: chat.workspace, step: 0, patch: `*** Begin Patch\n*** Add File: ${target}\n${instructions.trimEnd().split("\n").map(line => "+" + line).join("\n")}\n*** End Patch` };
  await manager.send(chat.id, "/init use the verified npm test command"); assert.ifError(fixtureFailure);
  assert.equal(await readFile(target, "utf8"), instructions); assert.equal(scenario.step, 3);
  const sessionId = store.get(chat.id).agentSessionId;
  await manager.stop(chat.id);
  const addition = "\n## Scope\nEdit only this disposable repository.\n";
  scenario = { name: "preserve", workspace: chat.workspace, step: 0, inherited: true, patch: `*** Begin Patch\n*** Update File: ${target}\n@@\n Run \u0060npm test\u0060 (\u0060node --test\u0060) for the tests under \u0060test/\u0060.\n+\n+## Scope\n+Edit only this disposable repository.\n*** End Patch` };
  await manager.send(chat.id, "/init keep existing instructions and add the repository scope"); assert.ifError(fixtureFailure);
  assert.equal(store.get(chat.id).agentSessionId, sessionId); assert.equal(await readFile(target, "utf8"), instructions + addition);
  const beforePlan = await readFile(target, "utf8"); await manager.setMode(chat.id, "plan");
  scenario = { name: "plan", workspace: chat.workspace, step: 0, readOnly: true, patch: `*** Begin Patch\n*** Update File: ${target}\n@@\n # Repository instructions\n+MUST_NOT_WRITE_IN_PLAN\n*** End Patch` };
  await manager.send(chat.id, "/init propose documentation in Plan mode"); assert.ifError(fixtureFailure);
  assert.equal(await readFile(target, "utf8"), beforePlan); assert.equal(store.get(chat.id).mode, "plan");
  assert.equal(await readFile(unchanged, "utf8"), "Unrelated unsaved user work\n"); assert.equal(await readFile(path.join(chat.workspace, "package.json"), "utf8"), manifest); assert.equal(await readFile(path.join(chat.workspace, "README.md"), "utf8"), readme);
  assert.equal(requests.length, 9); assert(!store.get(chat.id).messages.some(message => message.kind === "error"));
  console.log(`Installed Codex ${adapter.cliVersion}: /init reads repository evidence, creates AGENTS.md through native apply_patch, preserves existing instructions/unrelated files on same-session resume, and cannot write in Plan. ${requests.length} loopback responses; ${approvals.length} fixture approval(s) denied. No external inference; model prose quality is not asserted.`);
} finally {
  clearTimeout(timeout); await manager?.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
