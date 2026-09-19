import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir } from "node:fs/promises";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

// Protocol fixture only. The separate installed-CLI smoke verifies real review
// instructions, repository tools, file edits and the native resume journal.
async function fixture(t) {
  const root = await temporaryDirectory(t), store = new ChatStore(root);
  await store.initialize();
  const chat = await store.create({ agent: "claude", title: "Review interruption" });
  const config = testConfig(root), broker = new CapabilityBroker({ ttlMs: 60000 });
  const f = { inputs: [], controls: [], launches: [], sessions: [], signals: [], events: [], block: false };
  const executor = { workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id),
    mkdir: directory => mkdir(directory, { recursive: true }),
    spawn(command, args, options) {
      if (f.spawnFailure) throw Error("Fixture spawn failed");
      f.launches.push({ command, args, env: options.env });
      const child = new EventEmitter();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
      const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
      const close = (code, signal) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.exitCode = code; child.signalCode = signal;
        child.stdout.end(); child.stderr.end(); child.emit("exit", code, signal); child.emit("close", code, signal);
      };
      child.kill = signal => { f.signals.push(signal); setImmediate(() => close(null, signal)); };
      child.stdin.on("finish", () => setImmediate(() => close(0, null)));
      let buffer = "";
      child.stdin.on("data", chunk => {
        buffer += chunk;
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) {
          const message = JSON.parse(line);
          if (message.type === "user") {
            f.inputs.push(message.message.content);
            setImmediate(() => {
              send({ type: "system", subtype: "init", slash_commands: ["code-review"] });
              if (!f.block) send({ type: "result", subtype: "success", result: "total.mjs:2 — Fixture review finding." });
            });
          } else {
            f.controls.push(message.request);
            if (f.ignoreControl) continue;
            setImmediate(() => {
              send({ type: "control_response", response: { request_id: message.request_id, subtype: f.refuseControl ? "error" : "success", response: {}, error: "Fixture interruption refused" } });
              if (!f.refuseControl) send({ type: "result", subtype: "success", result: "Review interrupted." });
            });
          }
        }
      });
      return child;
    },
  };
  const adapter = new ClaudeAdapter({ chat, store, config, broker, executor, gatewayOrigin: "http://127.0.0.1:9",
    hooks: { onSessionId: id => { f.sessions.push(id); }, onEvent: event => f.events.push(event) } });
  t.after(() => adapter.stop());
  return Object.assign(f, { adapter, config });
}

test("Claude reviews retain literal multiline arguments, native mode/model/effort and a checkpointed resume ID", async t => {
  const f = await fixture(t), text = "/code-review high --fix src/ação.mjs\nKeep the public contract";
  const result = await f.adapter.send(text, { mode: "plan", model: "sonnet", effort: "high" });
  assert.equal(result.text, "total.mjs:2 — Fixture review finding.");
  assert.deepEqual(f.inputs, [text]); assert.deepEqual(f.controls, []);
  const args = f.launches[0].args, flag = name => args[args.indexOf(name) + 1];
  assert.equal(flag("--input-format"), "stream-json"); assert.equal(flag("--permission-mode"), "plan");
  assert.equal(flag("--model"), "sonnet"); assert.equal(flag("--effort"), "high");
  assert.equal(f.sessions[0], flag("--session-id"));
  assert(!JSON.stringify(f.launches).includes(f.config.claude.providerKey));
  await f.adapter.send("/code-review low total.mjs", { effort: "low", ultracode: false });
  assert.equal(f.launches[1].args[f.launches[1].args.indexOf("--resume") + 1], f.sessions[0]);
  assert.equal(f.sessions.length, 1); assert.equal(f.adapter.reviewInterruption, null);
});

test("review interruption waits for the native checkpoint without losing the first session or capability", async t => {
  const f = await fixture(t); f.block = true;
  const running = f.adapter.send("/code-review high total.mjs"), rejected = assert.rejects(running, /interrupted/);
  await waitFor(() => f.inputs.length); const capability = f.adapter.capability, session = f.adapter.sessionId;
  assert.deepEqual(f.sessions, [], "Initialization alone is not a resumable review journal");
  await f.adapter.interrupt(); await rejected;
  assert.deepEqual(f.controls, [{ subtype: "interrupt" }]); assert.deepEqual(f.signals, []);
  assert.equal(f.adapter.capability, capability); assert.deepEqual(f.sessions, [session]);
  assert.equal(f.adapter.reviewInterruption, null);
  f.block = false; await f.adapter.send("/code-review high total.mjs");
  assert(f.launches[1].args.includes("--resume")); assert.equal(f.inputs.length, 2);
});

test("failed review startup and forced Stop do not retain a nonexistent first-session journal or replay a mutation", async t => {
  const f = await fixture(t); f.spawnFailure = true;
  await assert.rejects(f.adapter.send("/code-review high --fix total.mjs"), /spawn failed/);
  assert.equal(f.adapter.sessionId, null); assert.deepEqual(f.sessions, []);
  f.spawnFailure = false; f.block = true; f.refuseControl = true;
  const running = f.adapter.send("/code-review high --fix total.mjs"), rejected = assert.rejects(running, /interrupted/);
  await waitFor(() => f.inputs.length); await f.adapter.stop(); await rejected;
  assert.deepEqual(f.signals, ["SIGTERM"]); assert.equal(f.adapter.sessionId, null); assert.deepEqual(f.sessions, []);
  assert.equal(f.inputs.length, 1); assert.equal(f.adapter.reviewInterruption, null);
  f.block = false; f.refuseControl = false;
  await f.adapter.send("/code-review low total.mjs");
  assert(f.launches[1].args.includes("--session-id")); assert(!f.launches[1].args.includes("--resume"));
  assert.deepEqual(f.inputs, ["/code-review high --fix total.mjs", "/code-review low total.mjs"]);
});

test("an unresponsive review control has a bounded Stop and never clears an existing session", async t => {
  const f = await fixture(t); await f.adapter.send("/code-review total.mjs");
  const session = f.adapter.sessionId; f.block = true; f.ignoreControl = true;
  const running = f.adapter.send("/code-review high --fix total.mjs"), rejected = assert.rejects(running, /interrupted/);
  await waitFor(() => f.inputs.length === 2); const started = Date.now();
  await f.adapter.stop(); await rejected;
  assert(Date.now() - started < 6000); assert.deepEqual(f.signals, ["SIGTERM"]);
  assert.equal(f.adapter.sessionId, session); assert.deepEqual(f.sessions, [session]);
  assert.equal(f.adapter.reviewInterruption, null); assert.equal(f.inputs.length, 2);
});
