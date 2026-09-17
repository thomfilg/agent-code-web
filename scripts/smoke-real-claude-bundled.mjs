import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ProviderGateway } from "../src/provider-gateway.mjs";
import { spawnWorker } from "../src/worker-process.mjs";
import { ModelCatalog } from "../src/models.mjs";

// Real installed bundled prompts, native asset extraction and tool effects.
// Only model replies/data are authored. No real accounts, network, uploads,
// feature-flag overrides, live services or existing chats are used.
const exec = promisify(execFile);
for (const option of process.argv.slice(2)) assert(["--network-isolated", "--trace", "--design-sync", "--update-config", "--deny", "--resume"].includes(option));
assert(!process.argv.includes("--design-sync") || !process.argv.includes("--deny") && !process.argv.includes("--resume"));
assert(!process.argv.includes("--design-sync") || !process.argv.includes("--update-config"));
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 90000, killSignal: "SIGKILL", maxBuffer: 30000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || error.message); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-bundled-"), requests = [], assetRoots = [], approvals = [];
  const trace = process.argv.includes("--trace"), design = process.argv.includes("--design-sync"), deny = process.argv.includes("--deny");
  const resume = process.argv.includes("--resume"), configuration = process.argv.includes("--update-config");
  const question = configuration ? "Update only this private user's settings: use Sonnet and Plan mode, set RELAY_BUNDLED_FLAG=yes, and preserve the existing env entry.\nPreserve ação; no shared profiles." : "Use only authored fixture data: Ação 7, Beta 12, Gamma 5.\nKeep this second line; do not upload anything.";
  const environmentCommand = "node -p 'JSON.stringify({keep:process.env.RELAY_BUNDLED_KEEP,flag:process.env.RELAY_BUNDLED_FLAG})'";
  const initialSettings = { model: "opus[1m]", permissions: { defaultMode: "acceptEdits", allow: [`Bash(${environmentCommand})`] }, env: { RELAY_BUNDLED_KEEP: "ação" } };
  const updatedSettings = { ...initialSettings, model: "sonnet", permissions: { ...initialSettings.permissions, defaultMode: "plan" }, env: { ...initialSettings.env, RELAY_BUNDLED_FLAG: "yes" } };
  const chart = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authored fixture chart</title>
<style>
:root{color-scheme:light;--surface:#fcfcfb;--ink:#0b0b0b;--a:#2a78d6;--b:#eb6834;--c:#1baf7a}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--surface:#1a1a19;--ink:#fff;--a:#3987e5;--b:#d95926;--c:#199e70}}
body{margin:24px;background:var(--surface);color:var(--ink);font:16px system-ui}svg{width:min(100%,600px);height:auto}text{fill:var(--ink)}td,th{padding:8px;text-align:left}
</style>
<h1>Authored fixture data</h1><p>Deterministic test data, not actual research.</p>
<svg role="img" aria-labelledby="title desc" viewBox="0 0 600 160"><title id="title">Three fixture values</title><desc id="desc">Ação 7; Beta 12; Gamma 5.</desc>
<rect x="80" y="10" width="245" height="30" fill="var(--a)"/><text x="0" y="32">Ação</text><text x="335" y="32">7</text>
<rect x="80" y="60" width="420" height="30" fill="var(--b)"/><text x="0" y="82">Beta</text><text x="510" y="82">12</text>
<rect x="80" y="110" width="175" height="30" fill="var(--c)"/><text x="0" y="132">Gamma</text><text x="265" y="132">5</text></svg>
<table><caption>Exact fixture values</caption><thead><tr><th>Label</th><th>Value</th></tr></thead><tbody><tr><td>Ação</td><td>7</td></tr><tr><td>Beta</td><td>12</td></tr><tr><td>Gamma</td><td>5</td></tr></tbody></table></html>
`;
  let manager, store, gatewayServer, chat, failure, shutdown, titles = 0, step = 0, round = 0, assetRoot, expectedApproval, deferredDesign = false;
  const mainText = body => body.messages.flatMap(message => typeof message.content === "string" ? [message.content] : (message.content || []).map(block => block.text || "")).join("\n");
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    assert.equal(request.headers["x-api-key"], "controller-only-bundled-fixture");
    let raw = ""; for await (const part of request) raw += part;
    const body = JSON.parse(raw), text = mainText(body);
    let content;
    if (!body.tools?.length && text.includes("Write the title in the predominant language")) { titles++; content = [{ type: "text", text: "Native bundled fixture" }]; }
    else {
      requests.push(body); assert(requests.length <= 24, "Unexpected native bundled inference loop");
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
      const result = results.at(-1), check = pattern => { assert(result); assert(!result.is_error, JSON.stringify(result)); if (pattern) assert.match(JSON.stringify(result), pattern); };
      const tool = (name, input) => {
        expectedApproval = { name, input };
        return [{ type: "tool_use", id: `bundled_${requests.length}`, name, input }];
      };
      const done = text => [{ type: "text", text }];
      if (configuration) {
        const file = `${store.runtimeHome(chat.id)}/claude/settings.json`;
        if (step === 0) { assert(text.includes(question)); assert.match(text, /Full Settings JSON Schema/); content = tool("Read", { file_path: file }); }
        else if (step === 1) { check(/RELAY_BUNDLED_KEEP/); content = tool("Write", { file_path: file, content: `${JSON.stringify(updatedSettings, null, 2)}\n` }); }
        else if (step === 2) {
          if (deny) assert.equal(result?.is_error, true); else check();
          content = done(deny ? "The settings write was denied; the private profile was not changed." : "The private settings were updated, preserving the existing environment entry.");
        } else if (step === 3) {
          assert.match(text, /Verify the next native model/);
          assert.match(body.model, deny ? /opus/ : /sonnet/);
          content = tool("Bash", { command: environmentCommand, description: "Read only this fixture's two harmless environment settings" });
        } else if (step === 4) {
          check(/ação/); if (deny) assert.doesNotMatch(JSON.stringify(result), /yes/); else check(/yes/);
          content = done("The following native turn used the selected model and actual fixture environment settings.");
        } else throw Error(`Unexpected update-config step ${step}`);
      } else if (step === 0) {
        assert(text.includes(question));
        assetRoot = [...text.matchAll(/Base directory for this skill: ([^\n]+)/g)].at(-1)?.[1];
        assert(assetRoot, "The native bundled prompt must include its extracted resource directory");
        assert(assetRoot.startsWith(`${store.runtimeHome(chat.id)}/`), "Bundled files must stay in this chat's private profile");
        assert.equal(await realpath(assetRoot), assetRoot);
        assetRoots.push(assetRoot);
        assert.equal(path.basename(assetRoot), design ? "design-sync" : "dataviz");
        content = tool("Read", { file_path: `${assetRoot}/${design ? "non-storybook/SKILL.md" : "references/palette.md"}` });
      } else if (design) {
        if (step === 1) {
          check(/_ds_bundle/);
          deferredDesign = !body.tools.some(tool => tool.name === "DesignSync");
          if (deferredDesign) assert(body.tools.some(tool => tool.name === "ToolSearch"), JSON.stringify(body.tools.map(tool => tool.name)));
          content = deferredDesign ? tool("ToolSearch", { query: "select:DesignSync", max_results: 1 }) : tool("DesignSync", { method: "list_projects" });
        } else if (step === 2 && deferredDesign) { check(/DesignSync/); content = tool("DesignSync", { method: "list_projects" }); }
        else if (step === (deferredDesign ? 3 : 2)) {
          assert(result?.is_error, "A private unauthenticated profile must not obtain real projects");
          assert.match(JSON.stringify(result), /needs design-system authorization/);
          assert.match(JSON.stringify(result), /interactive terminal/);
          content = done("DesignSync requires a separately authorized account. No projects were read and no files were uploaded.");
        } else throw Error(`Unexpected design-sync step ${step}`);
      } else {
        const validator = `node '${assetRoot}/scripts/validate_palette.js'`;
        if (step === 1) { check(/#2a78d6/i); content = tool("Read", { file_path: `${assetRoot}/scripts/validate_palette.js` }); }
        else if (step === 2) { check(/DEFAULT_SURFACE/); content = tool("Bash", { command: `${validator} '#2a78d6,#eb6834,#1baf7a' --mode light --pairs all`, description: "Validate the fixture's actual light palette with the bundled script" }); }
        else if (step === 3 && deny) { assert.equal(result?.is_error, true); content = done("Palette validation was denied; no chart was written."); }
        else if (step === 3) { check(/ALL CHECKS PASS/); content = tool("Bash", { command: `${validator} '#3987e5,#d95926,#199e70' --mode dark --pairs all`, description: "Validate the actual dark palette with the bundled script" }); }
        else if (step === 4) { check(/ALL CHECKS PASS/); content = tool("Bash", { command: `${validator} '#808080,#808080,#808080' --mode light --pairs all`, description: "Verify the native validator rejects indistinguishable fixture colors" }); }
        else if (step === 5) { assert.equal(result?.is_error, true); assert.match(JSON.stringify(result), /FAILED/); content = tool("Write", { file_path: `${chat.workspace}/chart-${round}.html`, content: chart }); }
        else if (step === 6) { check(); content = done(`Both native palette checks passed and the invalid palette was rejected. [Open the authored chart](chart-${round}.html).`); }
        else throw Error(`Unexpected dataviz step ${step}`);
      }
      step++;
      if (trace) console.log("MODEL", JSON.stringify({ round, step, tool: content[0].name, result: result ? JSON.stringify(result).slice(0, 360) : undefined }));
    }
    const block = content[0], tool = block.type === "tool_use";
    const message = { id: `msg_bundled_${requests.length + titles}`, type: "message", role: "assistant", model: body.model, content, stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  const server = http.createServer((request, response) => { void respond(request, response).catch(error => {
    failure ||= error; if (!response.headersSent) response.writeHead(500); response.end(); shutdown ||= manager?.shutdown();
  }); });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", CLAUDE_MODEL: initialSettings.model, ANTHROPIC_API_KEY: "controller-only-bundled-fixture" });
    store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 });
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve)); const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    const workerBackend = { sleep: async () => {}, shutdown: async () => {}, acquire: async current => ({
      workspace: current.workspace, runtimeHome: store.runtimeHome(current.id), metadata: { backend: "local" }, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(command, args, options) {
        assert(!JSON.stringify([args, options.env]).includes(config.claude.providerKey));
        return spawnWorker(command, args, options);
      },
    }) };
    // The picker inventory is fixture input, not a model-discovery test. All
    // selected settings still flow through the real catalog/adapter/native CLI.
    const models = new ModelCatalog(config);
    models.claude = async () => ({ models: ["opus", "opus[1m]", "sonnet", "haiku", "default"].map(id => ({ id, efforts: ["auto", "high"] })) });
    manager = new RuntimeManager({ store, config, models, broker, gatewayOrigin, workerBackend, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Native bundled fixture" }); await manager.setMode(chat.id, "accept_edits");
    if (configuration) {
      await mkdir(`${store.runtimeHome(chat.id)}/claude`, { recursive: true, mode: 0o700 });
      await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify(initialSettings));
    }
    const other = await manager.createChat({ agent: "claude", title: "Unrelated private fixture" });
    const submit = async text => {
      let finished = false;
      const sending = manager.send(chat.id, text).catch(error => { failure ||= error; }).finally(() => { finished = true; });
      const seen = new Set(), deadline = Date.now() + 35000;
      while (!finished && !failure && Date.now() < deadline) {
        const pending = store.get(chat.id).pendingRequest;
        if (pending && !seen.has(pending.requestId)) {
          seen.add(pending.requestId);
          if (design) {
            assert.equal(expectedApproval?.name, "DesignSync");
            assert.deepEqual(JSON.parse(pending.command), { method: "list_projects", __consentBitShown: null, __consentAskCanReachUser: false }, "No design uploads, project creation or consent grants are allowed");
          } else if (configuration && expectedApproval?.name === "Write") {
            assert.deepEqual(JSON.parse(pending.command), expectedApproval.input);
            assert.equal(expectedApproval.input.file_path, `${store.runtimeHome(chat.id)}/claude/settings.json`);
          } else {
            assert.equal(expectedApproval?.name, "Bash", "Only this fixture's exact native tool calls may be approved");
            assert.equal(JSON.parse(pending.command).command, expectedApproval.input.command);
          }
          approvals.push(pending.requestId);
          await manager.respond(chat.id, pending.requestId, { decision: deny && (!configuration || expectedApproval?.name === "Write") ? "decline" : "accept" });
        }
        await delay(25);
      }
      if (failure) throw failure;
      assert(finished, "The native bundled command did not settle"); await sending;
    };
    let session;
    if (configuration) {
      await submit(`/update-config ${question}`);
      assert.equal(step, 3);
      session = store.get(chat.id).agentSessionId;
      assert.deepEqual(JSON.parse(await readFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, "utf8")), deny ? initialSettings : updatedSettings);
      assert.equal(store.get(chat.id).model, deny ? initialSettings.model : "sonnet", "The web model must reflect the saved native configuration");
      assert.equal(store.get(chat.id).mode, deny ? "accept_edits" : "plan", "The web mode must reflect the saved native configuration");
      if (resume) await manager.stop(chat.id);
      await submit("Verify the next native model and the two harmless fixture environment values without changing files.");
      assert.equal(step, 5);
      assert.equal(store.get(chat.id).agentSessionId, session);
      const restored = new ChatStore(root); await restored.initialize();
      assert.equal(restored.get(chat.id).model, deny ? initialSettings.model : "sonnet");
    } else for (round = 0; round < (resume ? 2 : 1); round++) {
      step = 0;
      await submit(`/${design ? "design-sync" : "dataviz"} ${question}`);
      assert.equal(step, design ? (deferredDesign ? 4 : 3) : deny ? 4 : 7);
      assert.equal(store.get(chat.id).agentSessionId, session ||= store.get(chat.id).agentSessionId);
      assert(!manager.isBusy(chat.id));
      if (!design && !deny) assert.equal(await readFile(`${chat.workspace}/chart-${round}.html`, "utf8"), chart);
      else await assert.rejects(readFile(`${chat.workspace}/chart-${round}.html`), { code: "ENOENT" });
      await manager.stop(chat.id);
    }
    assert.equal(new Set(assetRoots).size, assetRoots.length, "A resumed process must extract fresh private resource paths");
    assert.equal(store.get(other.id).messages.length, 0);
    await assert.rejects(readFile(`${other.workspace}/chart-0.html`), { code: "ENOENT" });
    assert(!store.get(chat.id).messages.some(message => message.kind === "error"), JSON.stringify(store.get(chat.id).messages));
    console.log(`PASS: native ${configuration ? `update-config ${deny ? "denial and unchanged settings" : "private settings write, model/mode readback and subsequent environment effects"}` : design ? "design-sync resource extraction and anonymous authorization refusal; no upload" : `dataviz resources, ${deny ? "native validation denial and no output file" : "real light/dark palette validation, invalid palette rejection and HTML/SVG file creation"}`}${resume ? `; same-history Stop/resume${configuration ? "" : " with fresh private assets"}` : ""}; unrelated chat unchanged; ${requests.length} authored main replies, ${titles} titles, ${approvals.length} one-time tool decisions.`);
  } finally {
    await (shutdown ||= manager?.shutdown()); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); if (gatewayServer) await new Promise(resolve => gatewayServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
