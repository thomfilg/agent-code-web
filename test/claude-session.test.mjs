import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir } from "node:fs/promises";
import { ClaudeSession, claudeCallResult, CLAUDE_SCHEDULE_DIAGNOSTICS } from "../src/claude-session.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { claudeFastCredential } from "../src/claude-fast.mjs";
import { mergeUsage } from "../src/session-info.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

// Protocol double only; smoke-real-claude-run verifies actual installed Claude,
// native background processes, HTTP requests, journal and control effects.
function transport(f) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  f.child = child; f.inputs ||= []; f.controls ||= []; f.signals ||= []; f.total = 0;
  f.emit = event => child.stdout.write(`${JSON.stringify(event)}\n`);
  const close = (code, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code; child.signalCode = signal; child.stdout.end(); child.stderr.end();
    child.emit("exit", code, signal); child.emit("close", code, signal);
  };
  child.kill = signal => { f.signals.push(signal); setImmediate(() => close(null, signal)); };
  child.stdin.on("finish", () => setImmediate(() => close(0, null)));
  f.complete = (text = "Application turn completed.", failed = false) => {
    f.total++;
    f.emit({ type: "assistant", message: { id: `message_${f.total}`, model: "fixture", content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 10 } } });
    f.emit({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed, result: text, session_id: f.nativeSession,
      ...(f.fastState ? { fast_mode_state: f.fastState } : {}),
      usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: f.total / 10,
      modelUsage: { fixture: { inputTokens: f.total * 100, outputTokens: f.total * 10, costUSD: f.total / 10, contextWindow: 200000 } } });
  };
  f.respond = packet => {
    let response = {};
    if (f.mcp && packet.request.subtype === "mcp_toggle" && f.refuse !== "mcp_toggle") {
      f.mcp.find(server => server.name === packet.request.serverName).status = packet.request.enabled ? "connected" : "disabled";
    }
    if (f.mcp && packet.request.subtype === "mcp_status") response = { mcpServers: f.mcp.map(server => ({ ...server })) };
    if (packet.request.subtype === "get_settings") response = f.settingsSnapshot || { sources: [{ source: "flagSettings", settings: f.flagSettings || {} }] };
    if (packet.request.subtype === "reload_plugins") response = f.pluginSnapshot || { commands: [{ name: "fixture:stamp", description: "Native plugin stamp" }], plugins: [{ name: "fixture" }], agents: [], mcpServers: [], error_count: 0 };
    if (packet.request.subtype === "apply_flag_settings" && f.fastState && f.refuse !== "apply_flag_settings" && typeof packet.request.settings.fastMode === "boolean") {
      f.fastState = !f.fastPolicyDenied && packet.request.settings.fastMode ? "on" : "off";
    }
    f.emit({ type: "control_response", response: { request_id: packet.request_id,
      subtype: f.refuse === packet.request.subtype ? "error" : "success", response, error: "Fixture control rejected" } });
    if (packet.request.subtype === "interrupt" && !f.refuse) f.complete("Interrupted at native checkpoint.", f.failInterrupt);
  };
  let buffer = "";
  child.stdin.setEncoding("utf8"); child.stdin.on("data", chunk => {
    buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop();
    for (const line of lines) {
      const packet = JSON.parse(line);
      if (packet.type === "control_request") {
        f.controls.push(packet);
        if (f.hold !== packet.request.subtype) setImmediate(() => f.respond(packet));
      } else if (packet.type === "control_response") {
        (f.permissionReplies ||= []).push(packet);
      } else {
        f.inputs.push(packet);
        setImmediate(() => {
          f.emit({ type: "command_lifecycle", command_uuid: packet.uuid, state: "started" });
          if (!f.block) f.complete(f.reply, f.failResult);
        });
      }
    }
  });
  return child;
}

async function fixture(t, { interactive = false } = {}) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ agent: "claude", title: "Application transport" }), config = testConfig(root);
  const f = { launches: [], events: [], sessions: [], requests: [] }, broker = new CapabilityBroker({ ttlMs: 60000 });
  const executor = { workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id), metadata: { backend: "local" }, mkdir: directory => mkdir(directory, { recursive: true }),
    spawn(command, args, options) {
      if (f.spawnFailure) throw Error("Fixture spawn failure");
      f.launches.push({ command, args, env: options.env }); f.nativeSession = args[args.indexOf(args.includes("--session-id") ? "--session-id" : "--resume") + 1]; return transport(f);
    } };
  const adapter = new ClaudeAdapter({ chat, store, config, executor, broker, gatewayOrigin: "http://127.0.0.1:9",
    hooks: { onSessionId: id => f.sessions.push(id), onEvent: event => f.events.push(event), ...(interactive ? { onRequest: request => f.requests.push(request) } : {}) } });
  t.after(() => adapter.stop());
  return Object.assign(f, { adapter, config, broker, chat, store });
}

test("private ordinary turns use live native approvals and close their transport after the reply", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("Write the fixture recipe", { mode: "default" });
  await waitFor(() => f.inputs?.length);
  assert(f.launches[0].args.includes("--permission-prompt-tool"));
  assert.equal(f.launches[0].args[f.launches[0].args.indexOf("--permission-mode") + 1], "default");
  assert.equal(f.controls[0].request.subtype, "initialize");
  f.emit({ type: "control_request", request_id: "native-write", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "fixture.txt", content: "Original native input" } } });
  await waitFor(() => f.requests.length === 1);
  await f.adapter.respond(f.requests[0].requestId, { decision: "accept" });
  assert.deepEqual(f.permissionReplies[0].response.response, { behavior: "allow", updatedInput: { file_path: "fixture.txt", content: "Original native input" } });
  f.complete(); await running;
  assert.notEqual(f.child.exitCode ?? f.child.signalCode, null); assert.equal(f.adapter.turnSession, null); assert.equal(f.adapter.applicationSession, undefined);
  await assert.rejects(f.adapter.respond(f.requests[0].requestId, { decision: "accept" }), /no longer active/);
  const next = f.adapter.send("Ask again"), rejected = assert.rejects(next, /interrupted/);
  await waitFor(() => f.inputs.length === 2);
  f.emit({ type: "control_request", request_id: "native-again", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "node fixture.mjs" } } });
  await waitFor(() => f.requests.length === 2);
  await f.adapter.stop(); await rejected;
  assert.equal(f.permissionReplies.at(-1).response.response.behavior, "deny");
  await assert.rejects(f.adapter.respond(f.requests[1].requestId, { decision: "accept" }), /no longer active/);
});

test("Stop during private ordinary SDK initialization sends no user input and revokes the gateway capability", async t => {
  const f = await fixture(t, { interactive: true }); f.hold = "initialize";
  const running = f.adapter.send("Do not send this after Stop"), rejected = assert.rejects(running, /stopped|closed|interrupted/);
  await waitFor(() => f.controls?.length); const capability = f.adapter.capability;
  await f.adapter.stop(); await rejected;
  assert.deepEqual(f.inputs, []); assert.deepEqual(f.requests, []); assert.equal(f.adapter.turnSession, null);
  assert.equal(f.broker.validate(capability, "anthropic"), null);
});

test("control-only plugin reload uses its native owner without model input or an unjournaled resume ID", async t => {
  for (const interactive of [false, true]) {
    const f = await fixture(t, { interactive });
    const result = await f.adapter.send("/reload-plugins");
    assert.match(result.text, /^Reloaded 1 plugin/); assert.deepEqual(f.inputs, []); assert.deepEqual(f.sessions, []);
    assert(!f.adapter.sessionId); assert.equal(f.launches.length, 1); assert.equal(f.child.exitCode, null);
    assert.equal(f.controls.filter(packet => packet.request.subtype === "reload_plugins").length, 1);
    assert(f.events.some(event => event.type === "command_catalog" && event.commands[0].name === "fixture:stamp"));
    const session = f.nativeSession;
    await f.adapter.send("/fixture:stamp Preserve ação\nand this line");
    assert.equal(f.launches.length, 1); assert.equal(f.adapter.sessionId, session);
    assert.deepEqual(f.inputs.map(packet => packet.message.content), ["/fixture:stamp Preserve ação\nand this line"]);
    assert.equal(f.adapter.hasScheduledWork(), false);
  }
});

test("Stop after only plugin reload leaves no missing native journal to resume", async t => {
  const f = await fixture(t, { interactive: true });
  await f.adapter.send("/reload-plugins"); await f.adapter.stop(); assert(!f.adapter.sessionId);
  await f.adapter.send("/reload-plugins --force");
  assert.equal(f.launches.length, 2); assert(f.launches[1].args.includes("--session-id")); assert(!f.launches[1].args.includes("--resume"));
  assert.deepEqual(f.sessions, []); assert.deepEqual(f.inputs, []);
  await f.adapter.send("Continue from the initialized worker"); assert.equal(f.sessions.length, 1); assert.equal(f.launches.length, 2);
});

test("failed and partially loaded plugins do not fake success, send a fallback prompt or kill an existing application", async t => {
  const f = await fixture(t, { interactive: true }); await f.adapter.send("/run Keep this app alive");
  const session = f.adapter.sessionId, capability = f.adapter.capability;
  f.refuse = "reload_plugins"; await assert.rejects(f.adapter.send("/reload-plugins"), /Native plugin reload failed/);
  assert(!f.events.some(event => event.type === "command_catalog"));
  f.refuse = null; f.pluginSnapshot = { commands: [], plugins: [], agents: [], mcpServers: [], error_count: 1 };
  await assert.rejects(f.adapter.send("/reload-plugins"), /1 component load error/);
  assert(f.events.some(event => event.type === "command_catalog" && event.commands.length === 0), "A verified partial inventory is still authoritative");
  assert.equal(f.child.exitCode, null); assert.deepEqual(f.signals, []); assert.equal(f.adapter.sessionId, session); assert.equal(f.adapter.capability, capability);
  assert.deepEqual(f.inputs.map(packet => packet.message.content), ["/run Keep this app alive"]);
  f.pluginSnapshot = null; await f.adapter.send("/reload-plugins"); assert.equal(f.launches.length, 1);
});

test("Send now during plugin reload waits for the native receipt and ignores late publication without killing the app", async t => {
  const f = await fixture(t, { interactive: true }); await f.adapter.send("/run Keep this app alive"); f.hold = "reload_plugins";
  const running = f.adapter.send("/reload-plugins"), rejected = assert.rejects(running, /interrupted/);
  await waitFor(() => f.controls.some(packet => packet.request.subtype === "reload_plugins"));
  const interrupting = f.adapter.interrupt(); let finished = false; void interrupting.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.deepEqual(f.signals, []);
  f.respond(f.controls.find(packet => packet.request.subtype === "reload_plugins")); await interrupting; await rejected;
  assert(!f.events.some(event => event.type === "command_catalog")); assert.equal(f.child.exitCode, null); assert.equal(f.launches.length, 1);
  f.hold = null; await f.adapter.send("Selected follow-up");
  assert.deepEqual(f.inputs.map(packet => packet.message.content), ["/run Keep this app alive", "Selected follow-up"]);
});

test("Stop, expired capabilities and shared host profiles cannot publish late plugin reload results", async t => {
  for (const variant of ["stop", "capability", "host"]) {
    const f = await fixture(t, { interactive: true }); f.hold = "reload_plugins";
    if (variant === "host") {
      f.config.claude.authMode = "host"; await assert.rejects(f.adapter.send("/reload-plugins"), /private Claude profile/); assert.equal(f.launches.length, 0); continue;
    }
    const running = f.adapter.send("/reload-plugins"), rejected = assert.rejects(running, /reload failed|gateway access expired/);
    await waitFor(() => f.controls?.some(packet => packet.request.subtype === "reload_plugins"));
    if (variant === "stop") await f.adapter.stop();
    else { f.broker.revoke(f.adapter.capability); f.respond(f.controls.find(packet => packet.request.subtype === "reload_plugins")); }
    await rejected; assert(!f.events.some(event => event.type === "command_catalog")); assert.deepEqual(f.inputs, []); assert.deepEqual(f.sessions, []);
  }
});

test("local plugin reload does not contact the account API when the chat has Fast enabled", async t => {
  const f = await fixture(t, { interactive: true }); let calls = 0;
  f.adapter.fetchImpl = async () => { calls++; throw Error("A local reload must not inspect a paid inference feature"); };
  await f.adapter.send("/reload-plugins", { fastMode: true, fastCredential: claudeFastCredential(f.config.claude), fastState: "on" });
  assert.equal(calls, 0); assert.deepEqual(f.inputs, []);
});

test("Send now cannot proceed after an unverified plugin reload receipt", async t => {
  const f = await fixture(t, { interactive: true }); await f.adapter.send("/run Keep this app alive"); f.hold = "reload_plugins";
  const running = f.adapter.send("/reload-plugins"), rejected = assert.rejects(running, /Native plugin reload failed/);
  await waitFor(() => f.controls.some(packet => packet.request.subtype === "reload_plugins"));
  const interrupting = assert.rejects(f.adapter.interrupt(), /selected input was not sent/);
  f.refuse = "reload_plugins"; f.respond(f.controls.find(packet => packet.request.subtype === "reload_plugins"));
  await interrupting; await rejected; assert.equal(f.child.exitCode, null);
  assert.deepEqual(f.inputs.map(packet => packet.message.content), ["/run Keep this app alive"]);
});

test("native mode observations follow the current main session, survive retained replies and stop with interruption", async t => {
  const f = await fixture(t, { interactive: true }), first = [], second = [];
  f.block = true;
  const running = f.adapter.send("/run Start the fixture", { onPermissionMode: mode => first.push(mode) });
  await waitFor(() => f.inputs?.length);
  const status = permissionMode => ({ type: "system", subtype: "status", status: null, session_id: f.nativeSession, permissionMode });
  f.emit(status("plan")); await waitFor(() => first.length === 1);
  f.emit({ ...status("default"), session_id: "foreign-session" }); f.emit({ ...status("default"), parent_tool_use_id: "child" });
  f.complete(); await running;
  f.emit(status("acceptEdits")); await waitFor(() => first.length === 2);
  assert.deepEqual(first, ["plan", "accept_edits"]);
  const next = f.adapter.send("/verify Verify the fixture", { onPermissionMode: mode => second.push(mode) });
  const rejected = assert.rejects(next, /interrupted/); await waitFor(() => f.inputs.length === 2);
  f.emit(status("plan")); await waitFor(() => second.length === 1);
  await f.adapter.interrupt(); await rejected;
  f.emit(status("default")); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(second, ["plan"]); assert.deepEqual(first, ["plan", "accept_edits"]);
});

test("failed native-mode synchronization reaches the runtime fatal handler without an unhandled rejection", async t => {
  for (const asynchronous of [false, true]) {
    const f = await fixture(t, { interactive: true }), errors = []; f.block = true;
    f.adapter.hooks.onFatal = error => { errors.push(error.message); void f.adapter.stop(); };
    const onPermissionMode = () => { if (asynchronous) return Promise.reject(Error("Private persistence error")); throw Error("Private persistence error"); };
    const running = f.adapter.send("/run Start the fixture", { onPermissionMode }), rejected = assert.rejects(running, /interrupted/);
    await waitFor(() => f.inputs?.length);
    f.emit({ type: "system", subtype: "status", status: null, session_id: f.nativeSession, permissionMode: "plan" });
    await rejected; assert.equal(errors.length, 1); assert.match(errors[0], /could not be synchronized/);
    assert.doesNotMatch(errors[0], /Private persistence/);
  }
});

const scheduleCall = (f, name, id = "cron-call", input = {}) => f.emit({ type: "assistant", session_id: f.nativeSession,
  message: { content: [{ type: "tool_use", id, name, input }] } });
const scheduleResult = (f, data, { id = "cron-call", failed = false, ...extra } = {}) => f.emit({ type: "user", session_id: f.nativeSession,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "Native scheduling result", is_error: failed }] }, tool_use_result: data, ...extra });
const schedule = { id: "abcdef12", recurring: true, humanSchedule: "Every minute", durable: false };
const scheduledTurnStarted = (f, count = 1) => waitFor(() => f.inputs?.length === count && f.adapter.turnSession?.active?.started);
const scheduleDiagnostic = text => `2026-09-17T10:21:52.177Z [DEBUG] ${text}\n`;
const wakeup = { scheduledFor: 1789641540000, clampedDelaySeconds: 60, wasClamped: false };
const stopWakeup = { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 };

test("a bound dynamic wakeup retains the native worker before its first scheduler poll and stops without another input", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("/loop Watch the fixture"); await scheduledTurnStarted(f);
  scheduleCall(f, "ScheduleWakeup"); scheduleResult(f, wakeup); f.complete(); await running;
  assert.equal(f.adapter.hasScheduledWork(), true); assert.equal(f.child.exitCode, null);
  assert.equal(f.adapter.applicationSession.scheduledJobs.size, 0);
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled abcdef12 for 2026-09-17T10:39:00.000Z"));
  assert.equal(f.adapter.applicationSession.dynamicWakeup.id, "abcdef12");
  scheduleCall(f, "ScheduleWakeup", "stop", { stop: true }); scheduleResult(f, stopWakeup, { id: "stop" });
  assert.equal(f.adapter.hasScheduledWork(), false); assert.equal(f.adapter.applicationSession.scheduledJobs.size, 0);
  assert.deepEqual(f.inputs.map(input => input.message.content), ["/loop Watch the fixture"]);
});

test("dynamic replacement, native snapshots and cancellation preserve ordinary and restored schedules", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("Schedule several checks"); await scheduledTurnStarted(f);
  f.child.stderr.write(scheduleDiagnostic("resume: resurrected 1 session cron task(s)"));
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled 11111111 for 2026-09-17T10:39:00.000Z"));
  scheduleCall(f, "CronCreate", "fixed"); scheduleResult(f, schedule, { id: "fixed" });
  scheduleCall(f, "ScheduleWakeup", "first"); scheduleResult(f, wakeup, { id: "first" });
  // CronList can identify the new pending ID before the scheduler polls it.
  scheduleCall(f, "CronList", "list"); scheduleResult(f, { jobs: [{ id: "11111111" }, schedule, { id: "22222222" }] }, { id: "list" });
  assert.equal(f.adapter.applicationSession.dynamicWakeup.id, "22222222");
  scheduleCall(f, "ScheduleWakeup", "replacement");
  // stderr and stdout are independent pipes: native scheduling may arrive
  // before the structured receipt, but is not a second fixed-interval job.
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled 33333333 for 2026-09-17T10:40:00.000Z"));
  scheduleResult(f, { ...wakeup, scheduledFor: wakeup.scheduledFor + 60000 }, { id: "replacement" });
  assert.equal(f.adapter.applicationSession.dynamicWakeup.id, "33333333");
  assert(!f.adapter.applicationSession.scheduledJobs.has("22222222"));
  f.child.stderr.write(scheduleDiagnostic("[loop/dynamic] cancelled 1 pending loop wakeup(s) on user abort"));
  assert.equal(f.adapter.applicationSession.dynamicWakeup, null);
  assert.deepEqual([...f.adapter.applicationSession.scheduledJobs].sort(), ["11111111", schedule.id]);
  assert.equal(f.adapter.hasScheduledWork(), true);
  f.complete(); await running;
});

test("native dynamic firing, empty snapshots and Stop reconcile without leaving a phantom schedule", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("/loop Watch"); await scheduledTurnStarted(f);
  scheduleCall(f, "ScheduleWakeup"); scheduleResult(f, wakeup); f.complete(); await running;
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled abcdef12 for 2026-09-17T10:39:00.000Z"));
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] firing abcdef12"));
  assert.equal(f.adapter.hasScheduledWork(), false);
  scheduleCall(f, "ScheduleWakeup", "again"); scheduleResult(f, wakeup, { id: "again" });
  scheduleCall(f, "CronList", "empty"); scheduleResult(f, { jobs: [] }, { id: "empty" });
  assert.equal(f.adapter.hasScheduledWork(), false);
  scheduleCall(f, "ScheduleWakeup", "last"); scheduleResult(f, wakeup, { id: "last" });
  await f.adapter.stop(); assert.equal(f.adapter.hasScheduledWork(), false);
});

test("ambiguous new native job IDs are never guessed to belong to a dynamic loop", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("Inspect scheduling"); await scheduledTurnStarted(f);
  scheduleCall(f, "ScheduleWakeup"); scheduleResult(f, wakeup);
  scheduleCall(f, "CronList", "ambiguous"); scheduleResult(f, { jobs: [{ id: "11111111" }, { id: "22222222" }] }, { id: "ambiguous" });
  assert.equal(f.adapter.applicationSession.dynamicWakeup.id, null);
  scheduleCall(f, "ScheduleWakeup", "stop", { stop: true }); scheduleResult(f, stopWakeup, { id: "stop" });
  assert.deepEqual([...f.adapter.applicationSession.scheduledJobs], ["11111111", "22222222"]);
  scheduleCall(f, "CronList", "reconcile"); scheduleResult(f, { jobs: [] }, { id: "reconcile" });
  assert.equal(f.adapter.hasScheduledWork(), false); f.complete(); await running;
});

test("failed, foreign, quoted, unbound, zero and malformed wakeup receipts cannot retain an ordinary worker", async t => {
  for (const variant of ["failed", "foreign", "child", "quoted", "unbound", "zero", "malformed"]) {
    const f = await fixture(t, { interactive: true }); f.block = true;
    const running = f.adapter.send("Inspect only"); await scheduledTurnStarted(f);
    if (variant !== "unbound") scheduleCall(f, "ScheduleWakeup");
    if (variant === "quoted") f.emit({ type: "assistant", session_id: f.nativeSession, message: { content: [{ type: "text", text: JSON.stringify(wakeup) }] } });
    else scheduleResult(f, variant === "zero" ? { ...wakeup, scheduledFor: 0, clampedDelaySeconds: 0 } : variant === "malformed" ? { ...wakeup, scheduledFor: "soon" } : wakeup,
      { ...(variant === "failed" ? { failed: true } : {}), ...(variant === "foreign" ? { session_id: "foreign" } : {}), ...(variant === "child" ? { parent_tool_use_id: "child" } : {}) });
    f.complete(); await running;
    assert.equal(f.adapter.hasScheduledWork(), false); assert.equal(f.adapter.applicationSession, undefined);
  }
});

test("a denied or unavailable reschedule cannot erase an existing native wakeup; late success cannot survive cancellation", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("/loop Inspect"); await scheduledTurnStarted(f);
  scheduleCall(f, "ScheduleWakeup"); scheduleResult(f, wakeup);
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled abcdef12 for 2026-09-17T10:39:00.000Z"));
  scheduleCall(f, "ScheduleWakeup", "denied", { stop: true }); scheduleResult(f, stopWakeup, { id: "denied", failed: true });
  scheduleCall(f, "ScheduleWakeup", "unavailable"); scheduleResult(f, { ...wakeup, scheduledFor: 0, clampedDelaySeconds: 0 }, { id: "unavailable" });
  assert.equal(f.adapter.applicationSession.dynamicWakeup.id, "abcdef12");
  f.hold = "interrupt"; const rejected = assert.rejects(running, /interrupted/);
  scheduleCall(f, "ScheduleWakeup", "late");
  const interrupting = f.adapter.interrupt(); await waitFor(() => f.controls.some(control => control.request.subtype === "interrupt"));
  f.child.stderr.write(scheduleDiagnostic("[loop/dynamic] cancelled 1 pending loop wakeup(s) on user abort"));
  scheduleResult(f, wakeup, { id: "late" });
  f.respond(f.controls.find(control => control.request.subtype === "interrupt"));
  await interrupting; await rejected;
  assert.equal(f.adapter.hasScheduledWork(), false);
});

test("native restored schedules retain an ordinary resume without synthetic turns or readback tools", async t => {
  const f = await fixture(t, { interactive: true }); f.hold = "initialize";
  f.adapter.sessionId = "saved-native-session";
  const running = f.adapter.send("Continue our conversation");
  await waitFor(() => f.controls?.length);
  assert(CLAUDE_SCHEDULE_DIAGNOSTICS.every(argument => f.launches[0].args.includes(argument)));
  const restored = scheduleDiagnostic("resume: resurrected 2 session cron task(s)");
  f.child.stderr.write(restored.slice(0, 20)); f.child.stderr.write(restored.slice(20));
  assert.equal(f.adapter.hasScheduledWork(), true);
  f.respond(f.controls[0]); const result = await running;
  assert.equal(f.child.exitCode, null); assert.equal(f.adapter.applicationSession.restoredJobs, 2);
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled abcdef12 for 2026-09-17T10:22:24.844Z"));
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled abcdef12 for 2026-09-17T10:22:24.844Z"));
  assert.equal(f.adapter.applicationSession.restoredJobs, 1);
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled 12345678 for 2026-09-17T10:22:24.844Z"));
  assert.equal(f.adapter.applicationSession.restoredJobs, 0);
  assert.equal(f.adapter.applicationSession.scheduledJobs.size, 2);
  assert.deepEqual(f.inputs.map(input => input.message.content), ["Continue our conversation"]);
  assert.doesNotMatch(JSON.stringify([result, f.events]), /resurrected|ScheduledTasks/);
  await f.adapter.stop(); assert.equal(f.adapter.hasScheduledWork(), false);
});

test("native one-shot fire and recurring expiry release only their own sleep protection", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("Schedule two checks"); await scheduledTurnStarted(f);
  scheduleCall(f, "CronList"); scheduleResult(f, { jobs: [schedule, { ...schedule, id: "12345678", recurring: false }] });
  f.complete(); await running;
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] firing 12345678"));
  assert.deepEqual([...f.adapter.applicationSession.scheduledJobs], [schedule.id]);
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] firing abcdef12 (recurring)"));
  assert.equal(f.adapter.hasScheduledWork(), true);
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] recurring task abcdef12 aged out (168h since creation), deleting after final fire"));
  assert.equal(f.adapter.hasScheduledWork(), false); assert.equal(f.child.exitCode, null);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.events.filter(event => event.type === "scheduled_work").length, 2);
});

test("native deletion or empty readback before the first scheduler poll clears restored pending counts", async t => {
  for (const action of ["delete", "list", "never"]) {
    const f = await fixture(t, { interactive: true }); f.block = true;
    const running = f.adapter.send("Inspect restored schedules"); await scheduledTurnStarted(f);
    f.child.stderr.write(scheduleDiagnostic("resume: resurrected 1 session cron task(s)"));
    if (action === "delete") { scheduleCall(f, "CronDelete", "delete", { id: schedule.id }); scheduleResult(f, { id: schedule.id }, { id: "delete" }); }
    else if (action === "list") { scheduleCall(f, "CronList"); scheduleResult(f, { jobs: [] }); }
    else f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled abcdef12 for never"));
    assert.equal(f.adapter.hasScheduledWork(), false);
    f.child.stderr.write(scheduleDiagnostic("resume: resurrected 1 session cron task(s)"));
    assert.equal(f.adapter.hasScheduledWork(), false, "A duplicate startup diagnostic is not a new restore");
    f.complete(); await running;
  }
});

test("quoted, malformed and oversized diagnostics cannot retain a worker or leak debug text", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("No scheduling"); await scheduledTurnStarted(f);
  const line = scheduleDiagnostic("[ScheduledTasks] scheduled abcdef12 for 2026-09-17T10:22:24.844Z");
  f.emit({ type: "assistant", session_id: f.nativeSession, message: { content: [{ type: "text", text: `Quoted: ${line}` }] } });
  f.child.stderr.write(`Quoted: ${line}`);
  f.child.stderr.write(scheduleDiagnostic("resume: resurrected 99 session cron task(s)"));
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled other-id for tomorrow"));
  f.child.stderr.write("x".repeat(9000)); f.child.stderr.write(line);
  f.child.stderr.write(scheduleDiagnostic("resume: private unrelated diagnostic"));
  assert.equal(f.adapter.hasScheduledWork(), false);
  f.complete(); await running;
  assert.equal(f.adapter.applicationSession, undefined);
  assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
  assert.doesNotMatch(JSON.stringify(f.events), /private unrelated diagnostic/);
});

test("native scheduling diagnostics from an interrupted or stopped worker cannot resurrect it", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true; f.hold = "interrupt";
  const running = f.adapter.send("Schedule a check"), rejected = assert.rejects(running, /interrupted/);
  await scheduledTurnStarted(f);
  const session = f.adapter.turnSession, interrupting = f.adapter.interrupt();
  await waitFor(() => f.controls.some(control => control.request.subtype === "interrupt"));
  f.child.stderr.write(scheduleDiagnostic("resume: resurrected 1 session cron task(s)"));
  f.child.stderr.write(scheduleDiagnostic("[ScheduledTasks] scheduled abcdef12 for 2026-09-17T10:22:24.844Z"));
  f.respond(f.controls.find(control => control.request.subtype === "interrupt"));
  await interrupting; await rejected; await f.adapter.stop();
  session.trackScheduleDiagnostic(scheduleDiagnostic("resume: resurrected 1 session cron task(s)").trimEnd());
  assert.equal(f.adapter.hasScheduledWork(), false); assert.equal(session.hasScheduledWork(), false);
});

test("actual native cron creation retains both slash and ordinary sessions; deletion releases idle protection", async t => {
  for (const text of ["/loop 1m Check the fixture", "Check the fixture every minute"]) {
    const f = await fixture(t, { interactive: true }); f.block = true;
    const running = f.adapter.send(text); await scheduledTurnStarted(f);
    scheduleCall(f, "CronCreate"); scheduleResult(f, schedule); f.complete(); await running;
    assert.equal(f.adapter.hasScheduledWork(), true); assert.equal(f.child.exitCode, null);
    assert(f.events.some(event => event.type === "scheduled_work"));
    const next = f.adapter.send("Cancel that schedule"); await scheduledTurnStarted(f, 2);
    scheduleCall(f, "CronDelete", "delete", { id: schedule.id }); scheduleResult(f, { id: schedule.id }, { id: "delete" });
    f.complete(); await next;
    assert.equal(f.adapter.hasScheduledWork(), false); assert.equal(f.launches.length, 1);
    assert.deepEqual(f.inputs.map(input => input.message.content), [text, "Cancel that schedule"]);
    await f.adapter.stop(); assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
  }
});

test("quoted, failed, foreign, child, unbound and malformed cron results cannot retain a worker", async t => {
  for (const variant of ["quoted", "failed", "foreign", "child", "unbound", "malformed", "missing", "child-call"]) {
    const f = await fixture(t, { interactive: true }); f.block = true;
    const running = f.adapter.send("Inspect only"); await scheduledTurnStarted(f);
    if (variant === "child-call") f.emit({ type: "assistant", session_id: f.nativeSession, parent_tool_use_id: "child",
      message: { content: [{ type: "tool_use", id: "cron-call", name: "CronCreate", input: {} }] } });
    else if (variant !== "unbound") scheduleCall(f, "CronCreate");
    if (variant === "quoted") f.emit({ type: "assistant", session_id: f.nativeSession, message: { content: [{ type: "text", text: JSON.stringify(schedule) }] } });
    else scheduleResult(f, variant === "malformed" ? { ...schedule, id: "" } : variant === "missing" ? undefined : schedule, {
      ...(variant === "failed" ? { failed: true } : {}), ...(variant === "foreign" ? { session_id: "foreign" } : {}), ...(variant === "child" ? { parent_tool_use_id: "child" } : {}),
    });
    f.complete(); await running;
    assert.equal(f.adapter.hasScheduledWork(), false); assert.equal(f.adapter.applicationSession, undefined);
    assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
  }
});

test("cron snapshots and background cancellation reconcile state without trusting failed or mismatched deletions", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("List restored schedules"); await scheduledTurnStarted(f);
  scheduleCall(f, "CronList"); scheduleResult(f, { jobs: [schedule, { ...schedule, id: "12345678" }] });
  f.complete(); await running;
  assert.equal(f.adapter.applicationSession.scheduledJobs.size, 2);
  scheduleCall(f, "CronDelete", "wrong", { id: "12345678" }); scheduleResult(f, { id: schedule.id }, { id: "wrong" });
  scheduleCall(f, "CronDelete", "failed", { id: schedule.id }); scheduleResult(f, { id: schedule.id }, { id: "failed", failed: true });
  assert.equal(f.adapter.applicationSession.scheduledJobs.size, 2);
  scheduleCall(f, "CronList", "invalid"); scheduleResult(f, { jobs: [null] }, { id: "invalid" });
  assert.equal(f.adapter.applicationSession.scheduledJobs.size, 2);
  scheduleCall(f, "CronList", "empty"); scheduleResult(f, { jobs: [] }, { id: "empty" });
  assert.equal(f.adapter.hasScheduledWork(), false);
  scheduleCall(f, "CronCreate", "background"); scheduleResult(f, schedule, { id: "background" });
  assert.equal(f.adapter.hasScheduledWork(), true);
  await f.adapter.stop(); assert.equal(f.adapter.hasScheduledWork(), false);
});

test("interrupted or completed cron calls cannot promote a late success", async t => {
  for (const completed of [false, true]) {
    const f = await fixture(t, { interactive: true }); f.block = true; f.hold = "interrupt";
    const running = f.adapter.send("Create a schedule"), rejected = assert.rejects(running, /interrupted/);
    await scheduledTurnStarted(f);
    scheduleCall(f, "CronCreate");
    if (completed) scheduleResult(f, {}, { failed: true });
    const interrupting = f.adapter.interrupt(); await waitFor(() => f.controls.some(control => control.request.subtype === "interrupt"));
    scheduleResult(f, schedule);
    f.respond(f.controls.find(control => control.request.subtype === "interrupt"));
    await interrupting; await rejected;
    assert.equal(f.adapter.hasScheduledWork(), false); assert.equal(f.adapter.applicationSession, undefined);
  }
});

test("native scheduled lifecycle is busy between replies and interruption waits for its own cancellation receipt", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("/loop 1m Check"); await scheduledTurnStarted(f);
  scheduleCall(f, "CronCreate"); scheduleResult(f, schedule); f.complete(); await running;
  const lifecycle = { type: "command_lifecycle", session_id: f.nativeSession, command_uuid: "scheduled-tick", state: "started" };
  f.emit({ ...lifecycle, session_id: "foreign" }); f.emit({ ...lifecycle, parent_tool_use_id: "child" });
  assert.equal(f.adapter.isBackgroundBusy(), false);
  f.emit(lifecycle); assert.equal(f.adapter.isBackgroundBusy(), true);
  assert(f.events.some(event => event.type === "background_turn" && event.active));
  f.hold = "interrupt"; let completed = false;
  const interrupting = f.adapter.interrupt().then(() => { completed = true; });
  await waitFor(() => f.controls.some(control => control.request.subtype === "interrupt"));
  f.respond(f.controls.find(control => control.request.subtype === "interrupt"));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
  f.emit({ ...lifecycle, command_uuid: "unrelated", state: "cancelled" });
  assert.equal(f.adapter.isBackgroundBusy(), true);
  f.emit({ ...lifecycle, state: "cancelled" }); await interrupting;
  assert.equal(f.adapter.isBackgroundBusy(), false); assert.equal(f.adapter.hasScheduledWork(), true);
  assert.equal(f.child.exitCode, null); assert.equal(f.inputs.length, 1);
  f.emit({ ...lifecycle, command_uuid: "second-tick" }); assert.equal(f.adapter.isBackgroundBusy(), true);
  await f.adapter.stop(); assert.equal(f.adapter.isBackgroundBusy(), false);
});

test("a native background Bash task retains an ordinary or generated-skill session without replaying input", async t => {
  for (const text of ["Start this project's HTTP app", "/run-fixture Start the generated recipe"]) {
    const f = await fixture(t, { interactive: true }); f.block = true;
    const running = f.adapter.send(text); await waitFor(() => f.inputs?.length === 1);
    f.emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "shell-app", name: "Bash", input: { command: "node server.mjs", run_in_background: true } }] } });
    f.emit({ type: "system", subtype: "task_started", session_id: f.nativeSession, task_type: "local_bash", task_id: "native-app", tool_use_id: "shell-app" });
    f.complete(); await running;
    assert(f.adapter.applicationSession); assert.equal(f.child.exitCode, null); assert.equal(f.child.stdin.writable, true);
    const capability = f.adapter.capability, session = f.adapter.sessionId;
    f.block = false; await f.adapter.send("Check the same app", { mode: "plan", model: "haiku" });
    assert.equal(f.launches.length, 1); assert.equal(f.adapter.sessionId, session);
    assert.deepEqual(f.inputs.map(input => input.message.content), [text, "Check the same app"]);
    await f.adapter.stop(); assert.notEqual(f.child.exitCode ?? f.child.signalCode, null); assert.equal(f.broker.validate(capability, "anthropic"), null);
  }
});

test("only a bound live native Bash task can retain a private ordinary session", async t => {
  const changes = [
    { session_id: "foreign" }, { parent_tool_use_id: "child-agent" }, { task_type: "unknown" },
    { task_id: "" }, { task_id: null }, { tool_use_id: "unreported" }, { type: "assistant" }, { subtype: "task_progress" },
  ];
  for (const change of changes) {
    const f = await fixture(t, { interactive: true }); f.block = true;
    const running = f.adapter.send("Do not retain unrelated activity"); await waitFor(() => f.inputs?.length === 1);
    f.emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "shell-app", name: "Bash", input: { command: "node server.mjs" } }] } });
    f.emit({ type: "system", subtype: "task_started", session_id: f.nativeSession, task_type: "local_bash", task_id: "native-app", tool_use_id: "shell-app", ...change });
    f.complete(); await running;
    assert.equal(f.adapter.applicationSession, undefined); assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
  }
});

test("interruption cannot promote a late background task or keep an ordinary session alive", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true; f.hold = "interrupt";
  const running = f.adapter.send("Start a task"), rejected = assert.rejects(running, /interrupted/);
  await waitFor(() => f.inputs?.length === 1);
  f.emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "shell-app", name: "Bash", input: {} }] } });
  const interrupting = f.adapter.interrupt(); await waitFor(() => f.controls.some(control => control.request.subtype === "interrupt"));
  f.emit({ type: "system", subtype: "task_started", session_id: f.nativeSession, task_type: "local_bash", task_id: "late-app", tool_use_id: "shell-app" });
  f.respond(f.controls.find(control => control.request.subtype === "interrupt"));
  await interrupting; await rejected;
  assert.equal(f.adapter.applicationSession, undefined); assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
});

test("child tools, completed calls and quoted task metadata do not promote an ordinary session", async t => {
  for (const variant of ["child", "read", "completed", "text", "missing-id"]) {
    const f = await fixture(t, { interactive: true }); f.block = true;
    const running = f.adapter.send("Do not retain unsupported activity"); await waitFor(() => f.inputs?.length === 1);
    const task = { type: "system", subtype: "task_started", session_id: f.nativeSession, task_type: "local_bash", task_id: "native-app", tool_use_id: variant === "missing-id" ? undefined : "shell-app" };
    f.emit({ type: "assistant", ...(variant === "child" ? { parent_tool_use_id: "child-agent" } : {}), message: { content: [variant === "text"
      ? { type: "text", text: JSON.stringify(task) }
      : { type: "tool_use", id: task.tool_use_id, name: variant === "read" ? "Read" : "Bash", input: {} }] } });
    if (variant === "completed") f.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "shell-app", content: "Completed without a background task" }] } });
    if (variant !== "text") f.emit(task);
    f.complete(); await running;
    assert.equal(f.adapter.applicationSession, undefined); assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
  }
});

test("application replies retain one CLI and apply next-turn mode/model/effort without rewriting literal inputs", async t => {
  const f = await fixture(t), text = "/run Start ação\nand keep the server running";
  await f.adapter.send(text, { mode: "accept_edits", model: "sonnet", effort: "high" });
  const session = f.adapter.sessionId, capability = f.adapter.capability;
  assert.equal(f.child.exitCode, null); assert.equal(f.child.stdin.writable, true); assert.equal(f.adapter.child, null);
  await f.adapter.send("/verify Probe invalid input", { mode: "plan", model: "haiku", effort: "low" });
  assert.equal(f.launches.length, 1); assert.deepEqual(f.inputs.map(packet => packet.message.content), [text, "/verify Probe invalid input"]);
  assert.notEqual(f.inputs[0].uuid, f.inputs[1].uuid);
  assert.deepEqual(f.controls.map(packet => packet.request), [{ subtype: "initialize" }, { subtype: "set_permission_mode", mode: "plan" },
    { subtype: "set_model", model: "haiku" }, { subtype: "apply_flag_settings", settings: { effortLevel: "low" } }]);
  assert.deepEqual(f.sessions, [session]); assert.equal(f.adapter.capability, capability);
  assert(!JSON.stringify(f.launches).includes(f.config.claude.providerKey));
  await f.adapter.stop(); assert.equal(f.broker.validate(capability, "anthropic"), null);
  assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
});

test("native MCP controls preserve a retained application's CLI, session, capability and next user input", async t => {
  const f = await fixture(t); f.mcp = [{ name: "relay_one", status: "connected" }];
  await f.adapter.send("/run Keep this app"); const token = f.adapter.capability, session = f.adapter.sessionId;
  assert.equal((await f.adapter.send("/mcp reconnect relay_one")).text, 'Reconnected "relay_one".');
  assert.equal((await f.adapter.send("/mcp disable relay_one")).text, 'Disabled "relay_one".');
  assert.equal(f.mcp[0].status, "disabled");
  f.refuse = "mcp_toggle";
  await assert.rejects(f.adapter.send("/mcp enable relay_one"), /Native MCP control failed/);
  assert.equal(f.mcp[0].status, "disabled");
  f.refuse = null;
  assert.equal((await f.adapter.send("/mcp enable relay_one")).text, 'Enabled "relay_one".');
  await f.adapter.send("Continue with this literal prompt");
  assert.equal(f.inputs.at(-1).message.content, "Continue with this literal prompt");
  assert.equal(f.controls.filter(packet => packet.request.subtype === "initialize").length, 1);
  assert(!f.controls.some(packet => packet.request.subtype === "mcp_reconnect"));
  assert.equal(f.launches.length, 1); assert.equal(f.child.exitCode, null);
  assert.equal(f.adapter.sessionId, session); assert.equal(f.adapter.capability, token);
});

test("a retained application keeps gateway access past its initial capability lifetime without replacing the CLI", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000000 });
  const f = await fixture(t);
  await f.adapter.send("/run Keep the application running");
  const token = f.adapter.capability, initial = f.broker.validate(token, "anthropic");
  for (let index = 0; index < 7; index++) t.mock.timers.tick(20000);
  assert(Date.now() > initial.expiresAt);
  await f.adapter.send("/verify Check the same application after two capability lifetimes");
  assert.equal(f.launches.length, 1); assert.equal(f.adapter.capability, token);
  assert(f.broker.validate(token, "anthropic"));
  await f.adapter.stop();
  t.mock.timers.tick(20000);
  assert.equal(f.broker.validate(token, "anthropic"), null);
});

test("application capabilities reject changed accounts, profiles, owners and companies before any more input", async t => {
  const changes = [
    f => { f.config.claude.providerKey = "different-private-key"; },
    f => { f.config.claude.upstreamBaseUrl = "https://different.invalid"; },
    f => { f.config.claude.authMode = "host"; },
    f => f.store.update(f.chat.id, { ownerId: "different-owner" }),
    f => f.store.update(f.chat.id, { environmentId: "different-profile" }),
    f => f.store.update(f.chat.id, { workspace: "/different/workspace" }),
    f => f.store.update(f.chat.id, { repositories: [{ fullName: "other-company/repository" }] }),
    f => f.store.update(f.chat.id, { archived: true }),
    f => { f.adapter.executor.runtimeHome = "/different/private-profile"; },
  ];
  for (const change of changes) {
    const f = await fixture(t); await f.adapter.send("/run Keep the application running");
    const token = f.adapter.capability, controls = f.controls.length;
    await change(f);
    assert.equal(f.broker.validate(token, "anthropic"), null);
    await assert.rejects(f.adapter.send("Do not cross the changed scope"), /account\/profile changed/);
    assert.equal(f.inputs.length, 1); assert.equal(f.controls.length, controls); assert.equal(f.launches.length, 1);
    assert.equal(f.child.exitCode, null); // No silent restart or destruction of the user's app.
  }
});

test("expiry during native settings rejects unsubmitted input without leaving a stuck logical application turn", async t => {
  const f = await fixture(t); await f.adapter.send("/run Keep the application running");
  const token = f.adapter.capability;
  f.hold = "set_model";
  const pending = f.adapter.send("Never submit this input"), rejected = assert.rejects(pending, /temporary gateway access expired/);
  await waitFor(() => f.controls.at(-1).request.subtype === "set_model");
  f.broker.revoke(token); f.respond(f.controls.at(-1)); await rejected;
  assert.equal(f.inputs.length, 1); assert.equal(f.adapter.applicationSession.active, null);
  assert.equal(f.child.exitCode, null); assert.equal(f.launches.length, 1);
  await f.adapter.stop(); f.hold = null;
  await f.adapter.send("Explicit retry after Stop");
  assert.equal(f.launches.length, 2); assert.notEqual(f.adapter.capability, token);
  assert.equal(f.broker.validate(token, "anthropic"), null);
});

test("Stop revokes before slow shutdown and cannot revoke a replacement capability when the old shutdown finishes", async t => {
  const f = await fixture(t); await f.adapter.send("/run Keep the application running");
  const token = f.adapter.capability, release = Promise.withResolvers();
  f.adapter.reviewInterruption = () => release.promise;
  const stopping = f.adapter.stop();
  assert.equal(f.broker.validate(token, "anthropic"), null);
  const replacement = f.broker.issue({ chatId: f.chat.id, provider: "anthropic" });
  release.resolve(); await stopping;
  assert(f.broker.validate(replacement, "anthropic")); f.broker.revoke(replacement);
});

test("background output is independent of a turn waiting for native controls and usage is not counted twice", async t => {
  const f = await fixture(t); await f.adapter.send("/run Launch app");
  f.hold = "apply_flag_settings";
  const running = f.adapter.send("/verify New user input");
  await waitFor(() => f.controls.some(packet => packet.request.subtype === f.hold));
  f.complete("A background task ended.");
  assert.equal(f.inputs.length, 1); assert.equal(f.events.filter(event => event.type === "background_response").length, 1);
  f.respond(f.controls.at(-1)); await running;
  const usage = f.events.filter(event => event.type === "usage").reduce((value, event) => mergeUsage(value, event.usage), null);
  assert.equal(usage.totals.inputTokens, 300); assert.equal(usage.totals.outputTokens, 30);
  assert(Math.abs(usage.costUsd - 0.3) < 1e-10);
  assert.equal(f.events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), "Application turn completed.Application turn completed.");
  assert.equal(f.inputs.length, 2); assert.equal(f.launches.length, 1);
});

test("Auto uses the native effort reset before input and never pins later choices through the process environment", async t => {
  const f = await fixture(t);
  await f.adapter.send("/run Launch app", { model: "sonnet", resetEffort: true });
  assert.deepEqual(f.controls.map(packet => packet.request), [{ subtype: "initialize" }, { subtype: "apply_flag_settings", settings: { effortLevel: null } }]);
  assert.equal(f.launches[0].env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  for (const effort of ["high", "low", null, "medium"]) {
    await f.adapter.send(`Continue with ${effort || "Auto"}`, { model: "sonnet", effort, resetEffort: !effort });
    assert.deepEqual(f.controls.at(-1).request, { subtype: "apply_flag_settings", settings: { effortLevel: effort } });
  }
  assert.equal(f.launches.length, 1); assert.equal(f.child.exitCode, null); assert.equal(f.inputs.length, 5);
});

test("ordinary private Auto turns reset effort through the SDK rather than overriding the worker environment", async t => {
  const f = await fixture(t, { interactive: true });
  f.adapter.executor.environmentVariables = { CLAUDE_CODE_EFFORT_LEVEL: "medium" };
  await f.adapter.send("Use native Auto", { resetEffort: true });
  assert.equal(f.launches[0].env.CLAUDE_CODE_EFFORT_LEVEL, "medium");
  assert.deepEqual(f.controls.at(-1).request, { subtype: "apply_flag_settings", settings: { effortLevel: null } });
  assert.equal(f.events.filter(event => event.type === "notice" && /CLAUDE_CODE_EFFORT_LEVEL/.test(event.text)).length, 1);
  assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
});

test("changed effort environment requires explicit Stop without mutating controls, replaying input or killing the app", async t => {
  for (const initial of [undefined, "medium"]) {
    const f = await fixture(t);
    f.adapter.executor.environmentVariables = initial ? { CLAUDE_CODE_EFFORT_LEVEL: initial } : {};
    await f.adapter.send("/run Launch app", { resetEffort: true });
    assert.equal(f.launches[0].env.CLAUDE_CODE_EFFORT_LEVEL, initial);
    const controls = f.controls.length;
    f.adapter.executor.environmentVariables = { CLAUDE_CODE_EFFORT_LEVEL: "high" };
    await assert.rejects(f.adapter.send("Do not send with stale effort", { effort: "high" }), /effort environment changed/);
    assert.equal(f.controls.length, controls); assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null);
    f.adapter.executor.environmentVariables = initial ? { CLAUDE_CODE_EFFORT_LEVEL: initial } : {};
    await f.adapter.send("Explicit retry with original environment", { resetEffort: true });
    assert.equal(f.launches.length, 1); assert.equal(f.inputs.length, 2);
    if (initial) assert.equal(f.events.filter(event => event.type === "notice" && /CLAUDE_CODE_EFFORT_LEVEL/.test(event.text)).length, 1);
  }
});

test("Stop or rejection during the first native effort reset leaves no input, application process or resume ID", async t => {
  for (const stop of [false, true]) for (const ordinary of [false, true]) {
    const f = await fixture(t, { interactive: ordinary });
    if (stop) f.hold = "apply_flag_settings"; else f.refuse = "apply_flag_settings";
    const running = f.adapter.send(ordinary ? "Do not start yet" : "/run Do not start yet", { resetEffort: true });
    const rejected = assert.rejects(running, /control failed|closed|stopped|interrupted/);
    if (stop) { await waitFor(() => f.controls?.some(packet => packet.request.subtype === "apply_flag_settings")); await f.adapter.stop(); }
    await rejected;
    assert.deepEqual(f.inputs, []); assert.equal(f.adapter.sessionId, null); assert.deepEqual(f.sessions, []);
    assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
    f.hold = null; f.refuse = null;
    await f.adapter.send(ordinary ? "Explicit retry" : "/run Explicit retry", { resetEffort: true });
    assert.equal(f.inputs.length, 1); assert.equal(f.sessions.length, 1);
    assert(f.launches.at(-1).args.includes("--session-id")); assert(!f.launches.at(-1).args.includes("--resume"));
  }
});

test("Send now interruption checkpoints the first application turn and retains its CLI and capability", async t => {
  const f = await fixture(t); f.block = true; f.failInterrupt = true;
  const running = f.adapter.send("/run Launch app"), rejected = assert.rejects(running, /interrupted/);
  await waitFor(() => f.inputs?.length); const capability = f.adapter.capability;
  assert.deepEqual(f.sessions, []);
  await f.adapter.interrupt(); await rejected;
  assert.equal(f.child.exitCode, null); assert.deepEqual(f.signals, []); assert.equal(f.sessions.length, 1);
  assert.equal(f.adapter.capability, capability); f.block = false;
  await f.adapter.send("/verify Continue"); assert.equal(f.launches.length, 1);
});

test("Stop during initialization and failed startup leave no provisional journal or orphan native input", async t => {
  const f = await fixture(t); f.spawnFailure = true;
  await assert.rejects(f.adapter.send("/run Launch app"), /spawn failure/);
  assert.equal(f.adapter.sessionId, null); f.spawnFailure = false; f.hold = "initialize";
  const running = f.adapter.send("/run Launch app"), rejected = assert.rejects(running, /stopped/);
  await waitFor(() => f.controls?.length); await f.adapter.stop(); await rejected;
  assert.equal(f.adapter.sessionId, null); assert.deepEqual(f.sessions, []); assert.deepEqual(f.inputs, []);
  assert.equal(f.adapter.applicationSession, null);
  f.hold = null; await f.adapter.send("/run Retry explicitly"); assert.equal(f.sessions.length, 1);
  assert(f.launches[1].args.includes("--session-id")); assert(!f.launches[1].args.includes("--resume"));
});

test("rejected native settings preserve a running application and do not submit or replay user input", async t => {
  const f = await fixture(t); await f.adapter.send("/run Launch app"); const session = f.adapter.sessionId;
  f.refuse = "set_permission_mode";
  await assert.rejects(f.adapter.send("/verify Do not replay", { mode: "plan" }), /control failed/);
  assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null); assert.equal(f.adapter.sessionId, session);
  f.refuse = null; await f.adapter.send("/verify Explicit retry", { mode: "plan" }); assert.equal(f.launches.length, 1);
});

test("changed system instructions fail visibly before input instead of silently retaining a stale prompt", async t => {
  const f = await fixture(t); await f.adapter.send("/run Launch app", { systemPrompt: "First instructions" });
  await assert.rejects(f.adapter.send("Changed task", { systemPrompt: "New instructions" }), /system instructions changed/);
  assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null); assert.equal(f.launches.length, 1);
});

test("failed first application result closes its process and never retains a nonexistent journal", async t => {
  const f = await fixture(t); f.failResult = true;
  await assert.rejects(f.adapter.send("/run Fail"), /worker exited/);
  assert.equal(f.adapter.sessionId, null); assert.deepEqual(f.sessions, []); assert.equal(f.adapter.applicationSession, null);
});

test("Fast off immediately reaches a retained CLI without model input or account access", async t => {
  const f = await fixture(t); await f.adapter.send("/run Launch app");
  f.adapter.fetchImpl = () => { throw Error("Fast off must not inspect an account"); };
  const result = await f.adapter.send("/fast off");
  assert.equal(result.fastPreference, false); assert.equal(result.nativeFast.state, "off");
  assert.deepEqual(f.controls.at(-1).request, { subtype: "apply_flag_settings", settings: { fastMode: false } });
  assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null);
  f.refuse = "apply_flag_settings";
  await assert.rejects(f.adapter.send("/fast off"), /control failed/);
  assert.equal(f.inputs.length, 1);
});

test("a rejected Fast opt-in disables the already-running native session before returning the error", async t => {
  for (const networkFailure of [false, true]) {
    const f = await fixture(t);
    f.adapter.fetchImpl = async () => Response.json({ enabled: true });
    const settings = { fastMode: true, fastCredential: claudeFastCredential(f.config.claude), model: "opus" };
    await f.adapter.send("/run Keep the application running", settings);
    const controls = f.controls.length;
    f.adapter.fetchImpl = async () => {
      if (networkFailure) throw Error("Unavailable account service");
      return Response.json({ enabled: false, disabled_reason: "preference" });
    };
    await assert.rejects(f.adapter.send("/fast on", settings), error => {
      assert.match(error.message, networkFailure ? /Could not verify/ : /disabled by the organization/);
      assert.equal(error.fastPreference, false); assert.equal(error.fastCooldown, null);
      return true;
    });
    assert.deepEqual(f.controls.slice(controls).map(packet => packet.request), [{ subtype: "apply_flag_settings", settings: { fastMode: false } }]);
    assert.equal(f.inputs.length, 1); assert.equal(f.launches.length, 1); assert.equal(f.child.exitCode, null);
  }
});

test("first Fast opt-in uses native runtime settings, preserves other flag environment and retains the application", async t => {
  const f = await fixture(t); f.fastState = "off"; f.flagSettings = { env: { KEEP_FIXTURE: "unchanged" } };
  let lookups = 0; f.adapter.fetchImpl = async () => { lookups++; return Response.json({ enabled: true }); };
  await f.adapter.send("/run Start at standard speed");
  const session = f.adapter.sessionId, capability = f.adapter.capability;
  assert.equal(f.launches[0].env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, undefined);
  const result = await f.adapter.send("/fast on");
  assert.equal(lookups, 1); assert.equal(result.fastPreference, true); assert.equal(result.nativeFast.state, "on");
  assert.deepEqual(f.controls.slice(-2).map(packet => packet.request), [{ subtype: "get_settings" },
    { subtype: "apply_flag_settings", settings: { fastMode: true, effortLevel: null, env: { KEEP_FIXTURE: "unchanged", CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1" } } }]);
  assert.equal(f.inputs.at(-1).message.content, "/fast on"); assert.equal(f.launches.length, 1); assert.equal(f.child.exitCode, null);
  assert.equal(f.adapter.sessionId, session); assert.equal(f.adapter.capability, capability);
});

test("failed runtime Fast settings do not send the command, pin compatibility or replay writes; explicit retry recovers", async t => {
  const f = await fixture(t); f.fastState = "off"; f.adapter.fetchImpl = async () => Response.json({ enabled: true });
  await f.adapter.send("/run Keep this application");
  f.refuse = "apply_flag_settings";
  await assert.rejects(f.adapter.send("/fast on"), /control failed/);
  assert.equal(f.adapter.applicationSession.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, undefined);
  assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null);
  assert.equal(f.controls.filter(packet => packet.request.subtype === "apply_flag_settings").length, 1);
  f.refuse = null; assert.equal((await f.adapter.send("/fast on")).fastPreference, true);
  assert.equal(f.controls.filter(packet => packet.request.subtype === "get_settings").length, 2);
  assert.equal(f.inputs.length, 2); assert.equal(f.launches.length, 1);
});

test("invalid native settings snapshots cannot authorize a Fast environment write or submit the command", async t => {
  for (const snapshot of [{}, { sources: [null] }, { sources: [], errors: [{ message: "Private fixture parse failure" }] }, { sources: [{ source: "flagSettings", settings: { env: false } }] }]) {
    const f = await fixture(t); f.fastState = "off"; f.settingsSnapshot = snapshot;
    f.adapter.fetchImpl = async () => Response.json({ enabled: true });
    await f.adapter.send("/run Keep this application");
    await assert.rejects(f.adapter.send("/fast on"), /Cannot verify native Fast/);
    assert(!f.controls.some(packet => packet.request.subtype === "apply_flag_settings"));
    assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null);
    assert.equal(f.adapter.applicationSession.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, undefined);
  }
});

test("an unconfirmed native Fast activation is explicitly switched off without stopping the application", async t => {
  const f = await fixture(t); f.fastState = "off"; f.fastPolicyDenied = true;
  f.adapter.fetchImpl = async () => Response.json({ enabled: true });
  await f.adapter.send("/run Keep this application");
  await assert.rejects(f.adapter.send("/fast on"), error => {
    assert.match(error.message, /could not be confirmed/); assert.equal(error.fastPreference, false); return true;
  });
  assert.deepEqual(f.controls.at(-1).request, { subtype: "apply_flag_settings", settings: { fastMode: false } });
  assert.equal(f.inputs.length, 2); assert.equal(f.launches.length, 1); assert.equal(f.child.exitCode, null);
});

test("interrupting retained Fast authorization cannot send a late disable or another user input", async t => {
  const f = await fixture(t); f.adapter.fetchImpl = async () => Response.json({ enabled: true });
  const settings = { fastMode: true, fastCredential: claudeFastCredential(f.config.claude), model: "opus" };
  await f.adapter.send("/run Keep this application", settings);
  const controls = f.controls.length, gate = Promise.withResolvers(); let checking = false;
  f.adapter.fetchImpl = async (_, { signal }) => { checking = true; await gate.promise; signal.throwIfAborted(); return Response.json({ enabled: false }); };
  const pending = f.adapter.send("/fast on", settings), rejected = assert.rejects(pending, /interrupted/);
  await waitFor(() => checking); await f.adapter.interrupt(); gate.resolve(); await rejected;
  assert.equal(f.controls.length, controls); assert.equal(f.inputs.length, 1);
  assert.equal(f.child.exitCode, null); assert.equal(f.launches.length, 1);
});

test("failed native disable after account refusal cannot claim Fast was switched off", async t => {
  const f = await fixture(t); f.adapter.fetchImpl = async () => Response.json({ enabled: true });
  const settings = { fastMode: true, fastCredential: claudeFastCredential(f.config.claude), model: "opus" };
  await f.adapter.send("/run Keep this application", settings);
  f.adapter.fetchImpl = async () => Response.json({ enabled: false }); f.refuse = "apply_flag_settings";
  await assert.rejects(f.adapter.send("/fast on", settings), error => {
    assert.match(error.message, /control failed/); assert.equal(error.fastPreference, undefined); return true;
  });
  assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null); assert.equal(f.launches.length, 1);
  f.refuse = null;
  assert.equal((await f.adapter.send("/fast off", settings)).fastPreference, false);
});

test("a native process exiting cleanly without a result cannot report a successful run", async t => {
  const f = await fixture(t); f.block = true;
  const running = f.adapter.send("/run Launch app"), rejected = assert.rejects(running, /worker exited 1/);
  await waitFor(() => f.inputs?.length); f.child.stdin.end(); await rejected;
  assert.equal(f.adapter.sessionId, null); assert.deepEqual(f.sessions, []);
});

test("session accepts split UTF-8 input, handles native SDK controls and excludes an unrelated background result", async t => {
  const f = {}, background = [], session = new ClaudeSession(transport(f), [], {}, event => background.push(event));
  t.after(() => session.stop());
  const turn = await session.open([], {}), closed = once(turn, "close");
  f.complete("Unrelated result before the user input");
  assert.equal(turn.exitCode, null); assert.equal(background.at(-1).result, "Unrelated result before the user input");
  const bytes = Buffer.from("/run ação"); for (const byte of bytes) turn.stdin.write(Buffer.from([byte])); turn.stdin.end();
  await closed; assert.equal(f.inputs[0].message.content, "/run ação");
  const next = await session.open(["--input-format", "stream-json"], {}), nextClosed = once(next, "close");
  next.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content: "/verify" } }));
  await nextClosed; assert.equal(f.inputs.length, 2); assert.equal(f.controls.filter(packet => packet.request.subtype === "initialize").length, 1);
});

test("cumulative model usage becomes per-result deltas, including model changes, resets and missing fields", () => {
  const previous = { modelUsage: { one: { inputTokens: 100, outputTokens: 10, costUSD: 0.1 } }, total_cost_usd: 0.1 };
  const current = { usage: { input_tokens: 50 }, modelUsage: { one: { inputTokens: 150, outputTokens: 15, costUSD: 0.15, contextWindow: 200000 }, two: { inputTokens: 20 } }, total_cost_usd: 0.2 };
  const delta = claudeCallResult(current, previous);
  assert.equal(delta.modelUsage.one.inputTokens, 50); assert.equal(delta.modelUsage.one.outputTokens, 5);
  assert.equal(delta.modelUsage.two.inputTokens, 20); assert.equal(delta.modelUsage.one.contextWindow, 200000);
  assert.deepEqual(delta.usage, current.usage); assert.equal(delta.total_cost_usd, 0.1);
  assert.equal(claudeCallResult(previous, current).modelUsage.one.inputTokens, 100);
  assert.equal(claudeCallResult(previous, current).total_cost_usd, 0.1);
  assert.deepEqual(claudeCallResult({ modelUsage: { broken: null } }, {}).modelUsage, {});
  assert.equal(claudeCallResult({}, {}).total_cost_usd, undefined);
  assert.equal(current.modelUsage.one.inputTokens, 150, "Do not mutate the native baseline");
});
