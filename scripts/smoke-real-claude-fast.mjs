import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readlink, writeFile, rm } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ProviderGateway } from "../src/provider-gateway.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Actual installed CLI, isolated credentials, no real inference or network
// egress. The controller receives allowed/denied organization responses from a
// loopback fixture; the worker receives ONLY its short-lived gateway capability.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  const mountNamespace = await readlink("/proc/self/ns/mnt");
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated", `--parent-mount=${mountNamespace}`], { timeout: 90000, maxBuffer: 200000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.match(result.stdout, /^PASS:/m, "The isolated process must finish its assertions, not merely exit zero");
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-fast-"), requests = [], launches = [], nativeResults = [], workerEnv = {};
  let manager, allowed = true, availabilityCalls = 0, failure = null, clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const notifications = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/claude_code_penguin_mode") {
      assert.equal(request.headers["x-api-key"], "controller-only-fast-fixture"); availabilityCalls++;
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ enabled: allowed, disabled_reason: allowed ? null : "preference" })); return;
    }
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), index = requests.push(body), text = "Native Fast fixture reply.";
    if (body.speed === "fast" && failure) {
      const status = failure === "org" ? 400 : failure === "overload" ? 529 : 429;
      response.writeHead(status, { "content-type": "application/json", "retry-after": "600", ...(["credits", "disabled"].includes(failure) ? { "anthropic-ratelimit-unified-overage-disabled-reason": failure === "credits" ? "out_of_credits" : "org_level_disabled" } : {}) });
      response.end(JSON.stringify({ type: "error", error: { type: status === 400 ? "invalid_request_error" : status === 529 ? "overloaded_error" : "rate_limit_error", message: failure === "org" ? "Fast mode is not enabled for this organization" : "Controlled Fast rejection" } })); return;
    }
    const message = { id: `msg_fast_${index}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  let gatewayServer;
  try {
    if (process.argv.includes("--policy")) {
      const parentMount = process.argv.find(value => value.startsWith("--parent-mount="))?.slice("--parent-mount=".length);
      assert(parentMount, "A verified parent mount namespace is required for the managed-policy fixture");
      assert.notEqual(await readlink("/proc/self/ns/mnt"), parentMount, "Never mount over the host's /etc");
      await mkdir(`${root}/etc/claude-code`, { recursive: true });
      await writeFile(`${root}/etc/claude-code/managed-settings.json`, JSON.stringify({ fastModePerSessionOptIn: true }));
      await exec("/usr/bin/mount", ["--bind", `${root}/etc`, "/etc"]);
    }
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-fast-fixture" });
    const store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 });
    const gateway = new ProviderGateway({ config, broker, now, fetchImpl: (url, options) => fetch(`${origin}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve));
    const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, models: new ModelCatalog(config), adapterFactory: params => {
      const executor = { workspace: params.chat.workspace, runtimeHome: store.runtimeHome(params.chat.id), environmentVariables: workerEnv, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
        spawn(command, args, options) {
          assert(!JSON.stringify(options.env).includes(config.claude.providerKey), "The controller key must never enter the worker");
          launches.push({ args, optedIn: options.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK === "1" });
          const child = spawnWorker(command, args, options); let buffered = "";
          child.stdout.on("data", chunk => { buffered += chunk; const lines = buffered.split("\n"); buffered = lines.pop(); for (const line of lines) { try { const event = JSON.parse(line); if (event.type === "result") nativeResults.push({ text: event.result, state: event.fast_mode_state, reason: event.fast_mode_disabled_reason }); if (event.type === "system" && event.subtype === "notification" || event.type === "rate_limit_event") notifications.push(event); } catch {} } });
          return child;
        } };
      return new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin, executor, now,
        fetchImpl: (url, options) => { assert.equal(url, "https://api.anthropic.com/api/claude_code_penguin_mode"); return fetch(`${origin}${new URL(url).pathname}`, options); } });
    } });
    let chat = await manager.createChat({ agent: "claude", title: "Private Fast acceptance" });
    assert((await new CommandCatalog(config).list(store.get(chat.id))).commands.some(command => command.name === "fast"), "The installed command catalog must expose Fast in this private profile");
    const send = async text => {
      const before = store.get(chat.id).messages.length; await manager.send(chat.id, text);
      assert.deepEqual(store.get(chat.id).messages.slice(before).filter(message => message.kind === "error").map(message => message.text), [], `${text}: ${JSON.stringify(nativeResults.at(-1))}`);
    };
    if (process.argv.includes("--policy")) {
      await manager.send(chat.id, "/fast on");
      assert.equal(nativeResults.at(-1).state, "off"); assert.equal(requests.length, 0);
      assert.match(store.get(chat.id).messages.at(-1).text, /native availability could not be confirmed/);
      assert.notEqual(store.get(chat.id).claudeFastMode, true, "Managed per-session opt-in defeats a stale native ON prose acknowledgment");
      await send("Verify the managed per-session opt-in.");
      assert.notEqual(requests.at(-1).speed, "fast"); assert.equal(nativeResults.at(-1).state, "off");
      await manager.stop(chat.id); await send("Managed policy still applies after Stop.");
      assert.notEqual(requests.at(-1).speed, "fast"); assert.notEqual(store.get(chat.id).claudeFastMode, true);
      await send("/fast off"); assert.equal(store.get(chat.id).claudeFastMode, false);
      assert.deepEqual(JSON.parse(await readFile("/etc/claude-code/managed-settings.json", "utf8")), { fastModePerSessionOptIn: true });
      assert.equal(requests.length, 2);
      console.log("PASS: actual managed per-session opt-in policy remains enforced with native print-mode startup flags, stale ON prose, two standard replies and Stop/resume; private mount/network/PID namespace, no host policy edits.");
    } else if (process.argv.includes("--limits")) {
      for (const scenario of ["credits", "org", "disabled", "rate", "overload"]) {
        chat = await manager.createChat({ agent: "claude", title: `Private ${scenario} acceptance` }); failure = scenario;
        const noInference = requests.length; await send("/fast on"); assert.equal(requests.length, noInference);
        const before = requests.length, eventsBefore = notifications.length, messagesBefore = store.get(chat.id).messages.length;
        await send(`Verify native ${scenario} fallback.`);
        const state = store.get(chat.id), cooldown = state.claudeFastCooldown, session = state.agentSessionId;
        const limited = ["rate", "overload"].includes(scenario), disabled = ["org", "disabled"].includes(scenario);
        assert.equal(state.claudeFastMode, !disabled);
        assert.equal(state.claudeFastStatus.state, limited ? "cooldown" : disabled ? "off" : "on");
        if (limited) {
          assert(cooldown.until > now() && cooldown.until <= now() + 600000);
          assert.equal(cooldown.reason, scenario === "rate" ? "rate_limit" : "overloaded");
        } else assert.equal(cooldown, null);
        if (disabled) assert.equal(state.claudeFastStatus.disabledReason, scenario === "org" ? "preference" : "extra_usage_disabled");
        const saved = new ChatStore(root); await saved.initialize();
        assert.deepEqual(saved.get(chat.id).claudeFastCooldown, cooldown); assert.equal(saved.get(chat.id).claudeFastMode, !disabled);
        const lookups = availabilityCalls;
        await manager.stop(chat.id); await send("Continue after Stop with the rejection retained.");
        assert.equal(store.get(chat.id).agentSessionId, session);
        assert.equal(store.get(chat.id).claudeFastMode, !disabled);
        assert.equal(store.get(chat.id).claudeFastStatus.state, limited ? "cooldown" : disabled ? "off" : "on");
        assert.deepEqual(store.get(chat.id).claudeFastCooldown, cooldown);
        assert.deepEqual(requests.slice(before).map(request => request.speed || "standard"), scenario === "credits" ? ["fast", "standard", "fast", "standard"] : scenario === "org" ? ["fast", "fast", "standard", "standard"] : ["fast", "standard", "standard"]);
        if (scenario === "credits") {
          assert.equal(notifications.slice(eventsBefore).filter(event => event.key === "fast-mode-overage-rejected").length, 2);
          assert.equal(store.get(chat.id).messages.slice(messagesBefore).filter(message => message.kind === "notice" && /credits exhausted/.test(message.text)).length, 2, "Show each native credit notice once per turn; retain the opt-in as native headless mode does");
        } else assert.equal(availabilityCalls, lookups, "Standard-only fallback does not reauthorize Fast");
        failure = null;
        if (limited) {
          const rejectedChat = chat;
          chat = await manager.createChat({ agent: "claude", title: "Independent Fast chat" });
          await send("/fast on"); await send("Another chat keeps its own Fast preference."); assert.equal(requests.at(-1).speed, "fast");
          await manager.stop(chat.id); chat = rejectedChat;
          if (scenario === "rate") {
            // Advance only Relay's injected clock, never the real CLI's clock.
            // The new native print process must receive Fast again on expiry.
            clockOffset += 601000;
            await manager.stop(chat.id); await send("Retry after the saved provider deadline."); assert.equal(requests.at(-1).speed, "fast");
            assert.equal(store.get(chat.id).claudeFastStatus.state, "on"); assert.equal(store.get(chat.id).claudeFastCooldown, null);
          } else {
            const offLookups = availabilityCalls, offRequests = requests.length;
            await send("/fast"); assert.equal(store.get(chat.id).claudeFastMode, false); assert.equal(store.get(chat.id).claudeFastCooldown, null);
            assert.equal(availabilityCalls, offLookups); assert.equal(requests.length, offRequests);
            await send("/fast on"); await send("Explicitly re-enabled Fast after disabling the cooldown."); assert.equal(requests.at(-1).speed, "fast");
          }
        }
        await manager.stop(chat.id);
        console.log(`Verified native ${scenario} rejection and subsequent turns.`);
      }
      console.log(`PASS: actual gateway/native rejection, credits, organization/extra-usage denial, cooldown persistence, expiry, explicit toggle, same-session Stop/reload and independent chats; ${requests.length} loopback requests, no external network or real credentials.`);
    } else if (process.argv.includes("--settings")) {
      await send("/fast on");
      for (const command of ["/config fastMode=true", "/settings fastMode=false", "/config fastModePerSessionOptIn=true"]) {
        await send(command);
        assert.match(nativeResults.at(-1).text, /isn't a \/config setting/);
        assert.equal(store.get(chat.id).claudeFastMode, true, "An unsupported native setting is not permission to change the Fast opt-in");
        const saved = await readFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, "utf8").then(JSON.parse).catch(() => ({}));
        assert.equal(saved.fastMode, undefined); assert.equal(saved.fastModePerSessionOptIn, undefined);
      }
      assert.equal(requests.length, 0, "Settings and Fast controls never become model inference");
      await send("/config model=sonnet"); assert.equal(store.get(chat.id).model, "sonnet");
      await send("Native model configuration determines actual speed."); assert.match(requests.at(-1).model, /sonnet/); assert.notEqual(requests.at(-1).speed, "fast");
      assert.equal(store.get(chat.id).claudeFastMode, true, "An incompatible model suspends Fast without erasing the user's opt-in");
      await send("/settings model=opus"); assert.equal(store.get(chat.id).model, "opus");
      const session = store.get(chat.id).agentSessionId; await manager.stop(chat.id);
      await send("Native settings and Fast survive Stop together."); assert.match(requests.at(-1).model, /opus/); assert.equal(requests.at(-1).speed, "fast");
      assert.equal(store.get(chat.id).agentSessionId, session);
      await send("/fast off"); await send("/config model=sonnet"); await send("/settings model=opus"); await send("Settings must not turn Fast back on."); assert.notEqual(requests.at(-1).speed, "fast");
      assert.equal(store.get(chat.id).claudeFastMode, false); assert.equal(requests.length, 3);
      console.log("PASS: native /config and /settings model interoperability, invalid raw-setting keys, explicit Fast-off, same-session Stop/resume and three loopback replies; no personal profiles or external network.");
    } else {
    await send("/fast"); assert.equal(store.get(chat.id).claudeFastMode, true); assert.equal(store.get(chat.id).claudeFastStatus.state, "on");
    assert.equal(requests.length, 0, "Fast control must never become inference");
    await send("First Fast request."); assert.equal(requests.at(-1).speed, "fast");
    const session = store.get(chat.id).agentSessionId;
    await manager.stop(chat.id); await send("Continue Fast after Stop."); assert.equal(requests.at(-1).speed, "fast"); assert.equal(store.get(chat.id).agentSessionId, session);
    await send("/fast off"); await send("Standard speed now."); assert.notEqual(requests.at(-1).speed, "fast");
    await manager.setModel(chat.id, { model: "sonnet", effort: "high" }); await send("/fast on");
    assert.equal(store.get(chat.id).model, "opus"); assert.equal(store.get(chat.id).effort, "high");
    await send("Native promotion should persist."); assert.match(requests.at(-1).model, /opus/); assert.equal(requests.at(-1).speed, "fast");
    await manager.setModel(chat.id, { model: "sonnet", effort: "high" }); await send("An explicit model switch wins.");
    assert.match(requests.at(-1).model, /sonnet/); assert.notEqual(requests.at(-1).speed, "fast");
    await send("/fast"); assert.equal(store.get(chat.id).model, "opus"); assert.equal(store.get(chat.id).claudeFastMode, true);
    await send("A toggle from inactive Sonnet enables Fast again."); assert.equal(requests.at(-1).speed, "fast");
    allowed = false; const before = launches.length, inference = requests.length;
    await manager.send(chat.id, "/fast on"); assert.match(store.get(chat.id).messages.at(-1).text, /disabled by the organization/);
    assert.equal(launches.length, before); assert.equal(requests.length, inference);
    await send("Standard mode remains usable after a denial."); assert.notEqual(requests.at(-1).speed, "fast");
    assert.equal(store.get(chat.id).claudeFastMode, false);
    await send("/fast off");
    assert.equal(launches.at(-1).optedIn, false);
    allowed = true; workerEnv.CLAUDE_CODE_DISABLE_FAST_MODE = "1"; const noInference = requests.length;
    await manager.send(chat.id, "/fast on"); assert.match(store.get(chat.id).messages.at(-1).text, /disabled by worker policy/); assert.equal(requests.length, noInference);
    assert.equal(store.get(chat.id).claudeFastMode, false); delete workerEnv.CLAUDE_CODE_DISABLE_FAST_MODE;
    await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify({ availableModels: ["sonnet"] }));
    await manager.send(chat.id, "/fast on"); assert.match(store.get(chat.id).messages.at(-1).text, /not allowed|not available|unavailable/i);
    assert.equal(requests.length, noInference); assert.equal(store.get(chat.id).claudeFastMode, false);
    console.log(`PASS: native Claude Fast state, ${requests.length} actual loopback model requests (Fast/standard), same-session Stop/resume, model promotion/switch, native disable/model policies, and fresh allowed/denied account checks (${availabilityCalls}). Controller key never enters worker; no external network or personal profiles.`);
    }
  } finally {
    await manager?.shutdown(); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), ...(gatewayServer ? [new Promise(resolve => gatewayServer.close(resolve))] : [])]); await rm(root, { recursive: true, force: true });
  }
}
