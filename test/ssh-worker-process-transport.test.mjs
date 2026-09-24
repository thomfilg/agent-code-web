import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createSshWorkerProcessTransport } from "../src/ssh-worker-process-transport.mjs";
import { identityFields } from "../src/worker-transport-wire.mjs";

test("SSH bridge exit logs a safe reason without logging stderr", async t => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.kill = () => {};
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  t.after(() => { console.warn = originalWarn; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const transport = createSshWorkerProcessTransport({ sshArgs: [], lease: "test-lease",
    expectedIdentity: Object.fromEntries(identityFields.map(field => [field, "test-id"])),
    spawnProcess: () => child });
  await transport.connect();
  const disconnected = once(transport, "disconnect");
  child.stderr.write("private worker data");
  child.exitCode = 23; child.emit("exit", 23, null);
  await disconnected;
  assert.match(warnings.join("\n"), /SSH bridge exit: code=23 signal=none/);
  assert.doesNotMatch(warnings.join("\n"), /private worker data/);
});
