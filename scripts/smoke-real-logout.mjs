import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Real native sign-out, only for temporary dummy accounts. A network/PID
// namespace forbids real authentication/telemetry and contains every child.
// There is intentionally no fallback using a developer's profile or keyring.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  if (process.platform !== "linux") throw new Error("The logout fixture requires Linux network/PID namespaces");
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], "--network-isolated"], { timeout: 90000, maxBuffer: 500000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const directory = await mkdtemp("/tmp/relay-native-logout-"), modelCalls = [], nativeCalls = [], adapters = new Map(), modes = new Map(); let manager, starts = 0;
  const model = http.createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    modelCalls.push(JSON.parse(body)); const n = modelCalls.length;
    const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Private sign-out fixture response.", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [{ type: "response.created", response: { id: `response_${n}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `response_${n}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${model.address().port}`;
  const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "unused-private-logout-fixture", CODEX_MODEL: "gpt-5.4" });
  const records = new MemoryRecords(), store = new ChatStore(directory, records); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 });
  manager = new RuntimeManager({ store, config, broker, gatewayOrigin: origin, adapterFactory: params => {
    const runtimeHome = store.runtimeHome(params.chat.id);
    const executor = { workspace: params.chat.workspace, runtimeHome, mkdir: target => mkdir(target, { recursive: true, mode: 0o700 }),
      spawn: (command, args, options) => {
        if (args[0] === "app-server") starts++;
        const mode = modes.get(params.chat.id);
        return spawnWorker(command, args[0] === "app-server" ? [...args, "-c", "analytics.enabled=false", "-c", "check_for_update_on_startup=false", ...(mode.includes("ephemeral") ? ["-c", 'cli_auth_credentials_store="ephemeral"'] : []),
          ...(mode === "native-ephemeral" ? ["-c", "model_providers.agent_gateway.requires_openai_auth=true"] : [])] : args,
          { ...options, env: { ...options.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/no-keyring`, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost" } });
      } };
    const adapter = new CodexAdapter({ ...params, store, config, broker, gatewayOrigin: origin, executor });
    const logout = adapter.performLogout.bind(adapter); adapter.performLogout = (...args) => { nativeCalls.push(params.chat.id); return logout(...args); };
    adapters.set(params.chat.id, adapter); return adapter;
  } });
  const confirmation = review => ({ id: review.id, revision: review.revision, threadId: review.threadId, confirm: true });
  const login = adapter => adapter.rpc.request("account/login/start", { type: "apiKey", apiKey: "sk-invalid-private-logout-fixture-only" });
  try {
    await mkdir(`${directory}/sibling/codex`, { recursive: true });
    const siblingFile = `${directory}/sibling/codex/auth.json`; await writeFile(siblingFile, "Unrelated dummy credentials stay untouched");
    for (const mode of ["default-file", "native-ephemeral", "gateway-ephemeral"]) {
      const chat = await manager.createChat({ agent: "codex", title: `Network-isolated ${mode} sign-out` }); modes.set(chat.id, mode);
      const beforeStart = starts; assert.deepEqual(await manager.nativeLogout(chat.id), { reviews: [] }); assert.equal(starts, beforeStart);
      await manager.nativeLogout(chat.id, "inspect"); const adapter = adapters.get(chat.id);
      await writeFile(`${chat.workspace}/keep.txt`, "Keep private workspace and history");
      assert.deepEqual(await login(adapter), { type: "apiKey" });
      const account = await adapter.rpc.request("account/read", { refreshToken: false });
      assert.equal(account.requiresOpenaiAuth, mode === "native-ephemeral"); assert.equal(account.account?.type || null, mode === "native-ephemeral" ? "apiKey" : null);
      let inspected = await manager.nativeLogout(chat.id, "inspect");
      if (mode === "gateway-ephemeral") {
        assert.equal(inspected.canLogout, false); assert.match(inspected.reason, /does not expose/); assert.equal(inspected.review, null);
        await manager.stop(chat.id); continue;
      }
      await manager.send(chat.id, "Reply to the private logout fixture."); const beforeCalls = modelCalls.length, messages = store.get(chat.id).messages.length;
      inspected = await manager.nativeLogout(chat.id, "inspect"); assert.equal(inspected.canLogout, true); assert.equal(inspected.storage, mode.includes("ephemeral") ? "ephemeral" : "file");
      const credentialFile = `${adapter.nativeHome}/auth.json`, beforeFile = await readFile(credentialFile).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      assert.equal(Boolean(beforeFile), mode === "default-file"); assert.equal(nativeCalls.length, mode === "default-file" ? 0 : 1);
      // Same-kind account replacement must invalidate old consent, even though
      // the user-visible account type stays "Stored OpenAI API key".
      await adapter.rpc.request("account/login/start", { type: "apiKey", apiKey: "sk-invalid-private-replacement-only" });
      await assert.rejects(manager.nativeLogout(chat.id, "confirm", confirmation(inspected.review)), /credentials or storage policy changed|native account changed during inspection/);
      inspected = await manager.nativeLogout(chat.id, "inspect");
      const result = await manager.nativeLogout(chat.id, "confirm", confirmation(inspected.review)); assert.equal(result.state, "completed");
      assert.equal((await adapter.rpc.request("account/read", { refreshToken: false })).account, null);
      assert.equal(await stat(credentialFile).then(() => true).catch(error => { if (error.code !== "ENOENT") throw error; return false; }), false);
      assert.equal((await manager.nativeLogout(chat.id, "inspect")).canLogout, false); assert.equal((await manager.nativeLogout(chat.id, "confirm", confirmation(inspected.review))).state, "completed");
      assert.equal(store.get(chat.id).queuePaused, true); assert.equal(store.get(chat.id).messages.length, messages); assert.equal(modelCalls.length, beforeCalls);
      assert.equal(await readFile(`${chat.workspace}/keep.txt`, "utf8"), "Keep private workspace and history"); assert.equal(await readFile(siblingFile, "utf8"), "Unrelated dummy credentials stay untouched");
      assert.equal((await manager.sessionInfo(chat.id)).account, null);
      await manager.stop(chat.id); const stoppedStarts = starts;
      assert.equal((await manager.nativeLogout(chat.id, "confirm", confirmation(inspected.review))).state, "completed"); assert.equal(starts, stoppedStarts);
      assert.equal((await manager.nativeLogout(chat.id, "inspect")).canLogout, false); assert.equal(starts, stoppedStarts + 1);
      assert.equal(store.get(chat.id).messages.length, messages); assert.equal(modelCalls.length, beforeCalls);
      await manager.stop(chat.id);
    }
    assert.equal(nativeCalls.length, 2); assert.equal(modelCalls.length, 2);
    console.log("PASS: actual Codex default-file sign-out and ephemeral sign-out with an authenticated native provider fixture; gateway-hidden ephemeral accounts fail closed. Explicit controller review, account replacement rejection, verified native removal, sibling/workspace/history preservation, queue pause, idempotence, stopped status and restart persistence. Only dummy accounts and loopback model fixtures in network/PID namespaces; no live account or OS keyring accessed.");
  } finally {
    await manager.shutdown(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(directory, { recursive: true, force: true });
  }
}
