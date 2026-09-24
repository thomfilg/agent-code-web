import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import path from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Installed native Claude, fake access-only credentials, network-isolated
// loopback inference. No account consent, real credentials or paid model calls.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], "--network-isolated"], { timeout: 120000, maxBuffer: 100000 });
  assert.match(result.stdout, /^PASS:/m); process.stdout.write(result.stdout);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-account-native-"), events = [], credentials = [], authorizations = [];
  let adapter, server, refreshes = 0, requests = 0, failure;
  const serve = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":1}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    requests++; assert.ok(requests <= 8, "Unexpected native retry loop");
    authorizations.push(request.headers.authorization);
    if (request.headers.authorization !== "Bearer sk-ant-oat01-fixture-refreshed-access") {
      response.writeHead(401, { "content-type": "application/json" }); response.end('{"type":"error","error":{"type":"authentication_error","message":"Fixture access expired"}}'); return;
    }
    let raw = ""; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
    const message = { id: `msg_fixture_${requests}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }, { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  try {
    server = http.createServer((request, response) => { void serve(request, response).catch(error => { failure = error; response.destroy(); }); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CLAUDE_AUTH_MODE: "host" });
    const store = new ChatStore(root); await store.initialize();
    const chat = await store.create({ title: "Native Claude account fixture", agent: "claude", agentAccountId: "fixture-account" }); await mkdir(chat.workspace, { recursive: true });
    const executor = { workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id), mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(command, args, options) {
        assert.equal(options.env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH, "1"); assert.equal(options.env.CLAUDE_CODE_ENTRYPOINT, "local-agent");
        assert.equal(options.env.ANTHROPIC_API_KEY, undefined); assert.equal(options.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, undefined);
        assert.notEqual(options.env.HOME, process.env.HOME);
        return spawnWorker(command, [...args, "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}'], { ...options, env: { ...options.env, ANTHROPIC_BASE_URL: origin, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
      } };
    const broker = new CapabilityBroker({ ttlMs: 1000 });
    adapter = new ClaudeAdapter({ chat, store, config, broker, executor, hooks: {
      onEvent: event => events.push(event), onSessionId: id => store.update(chat.id, { agentSessionId: id }), onRequest: () => { throw Error("No tool approval is permitted"); },
      accountCredentials: async options => {
        credentials.push(options); if (options.refresh) refreshes++;
        return { accessToken: refreshes ? "sk-ant-oat01-fixture-refreshed-access" : "sk-ant-oat01-fixture-initial-access", accountId: "fixture-user", organizationId: "fixture-org", expiresAt: Date.now() + 3600000 };
      },
    } });
    await adapter.start(); const result = await adapter.send("Respond only OK. Do not use tools.", { model: "haiku", mode: "default", resetEffort: true });
    assert.equal(result.text.trim(), "OK"); assert.equal(broker.size, 0); assert.ok(refreshes >= 1, "Native 401 must request private host renewal");
    assert.ok(authorizations.includes("Bearer sk-ant-oat01-fixture-initial-access")); assert.ok(authorizations.includes("Bearer sk-ant-oat01-fixture-refreshed-access"));
    assert.doesNotMatch(JSON.stringify(events), /sk-ant-oat01-fixture|oauth_token_refresh|refresh_token/);
    await assert.rejects(access(path.join(store.runtimeHome(chat.id), "claude", ".credentials.json")), { code: "ENOENT" });
    if (failure) throw failure;
    const id = store.get(chat.id).agentSessionId; assert.ok(id); await adapter.stop(); await adapter.start();
    const resumed = await adapter.send("Respond only OK again. Do not use tools.", { model: "haiku", mode: "default", resetEffort: true });
    assert.equal(resumed.text.trim(), "OK"); assert.equal(store.get(chat.id).agentSessionId, id);
    console.log(`PASS: native Claude access-only login, ${refreshes} private renewal, ${requests} loopback inference requests, same-session resume, no approval/credential leak.`);
  } finally { await adapter?.stop(); await new Promise(resolve => server ? server.close(resolve) : resolve()); await rm(root, { recursive: true, force: true }); }
}
