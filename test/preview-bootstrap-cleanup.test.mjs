import assert from "node:assert/strict";
import test from "node:test";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { boundedFixtureOperation, cleanupPreviewBootstrapFixture, previewBootstrapReceipt, previewFixtureEnvironment } from "../scripts/fixtures/preview-bootstrap-cleanup.mjs";

function fixture(overrides = {}) {
  const events = [];
  return { events, resources: {
    client: { callTool: async () => { events.push("browser-close"); return { isError: false }; }, close: async () => { events.push("client-close"); } },
    transport: { close: async () => { events.push("transport-close"); } }, transportClosed: Promise.resolve(),
    bootstrap: { close: () => events.push("grants-closed") },
    sockets: [{ destroy: () => events.push("socket-destroyed") }],
    server: { close: callback => { events.push("server-close"); callback(); } }, directory: "/tmp/owned-fixture-example", ...overrides,
  }, options: { timeoutMs: 30, remove: async () => { events.push("removed"); } } };
}

test("cleanup observes exact transport close before deleting fixture or emitting success", async () => {
  let resolveClose;
  const f = fixture({ transportClosed: new Promise(resolve => { resolveClose = resolve; }) });
  const pending = cleanupPreviewBootstrapFixture(f.resources, f.options);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, ["browser-close", "client-close", "transport-close"]);
  resolveClose(); assert.equal(await pending, true);
  assert.deepEqual(f.events.slice(3), ["grants-closed", "socket-destroyed", "server-close", "removed"]);
  assert.deepEqual(previewBootstrapReceipt({ fixtureOnly: true }, null, true), { fixtureOnly: true, ok: true, cleanupConfirmed: true });
});

test("resolved browser_close isError fails cleanup and retains private evidence", async () => {
  const f = fixture(); f.resources.client.callTool = async () => ({ isError: true, content: [{ text: "PRIVATE-DO-NOT-PRINT" }] });
  assert.equal(await cleanupPreviewBootstrapFixture(f.resources, f.options), false);
  assert.ok(f.events.includes("transport-close")); assert.ok(f.events.includes("server-close")); assert.ok(!f.events.includes("removed"));
});

test("transport close submission without observed child closure cannot claim cleanup", async () => {
  const f = fixture({ transportClosed: new Promise(() => {}) });
  assert.equal(await cleanupPreviewBootstrapFixture(f.resources, f.options), false);
  assert.ok(!f.events.includes("removed")); assert.ok(f.events.includes("server-close"));
});

test("hanging or failed client close does not skip remaining exact resource cleanup", async () => {
  for (const close of [async () => { throw Error("private-cause"); }, () => new Promise(() => {})]) {
    const f = fixture(); f.resources.client.close = close;
    assert.equal(await cleanupPreviewBootstrapFixture(f.resources, f.options), false);
    assert.ok(f.events.includes("transport-close")); assert.ok(f.events.includes("server-close")); assert.ok(!f.events.includes("removed"));
  }
});

test("server close and removal failures are not silently converted to successful cleanup", async () => {
  const f = fixture({ server: { close: callback => callback(Error("private-listener-error")) } });
  assert.equal(await cleanupPreviewBootstrapFixture(f.resources, f.options), false); assert.ok(!f.events.includes("removed"));
  const other = fixture(); other.options.remove = async () => { throw Error("private-path-error"); };
  assert.equal(await cleanupPreviewBootstrapFixture(other.resources, other.options), false);
});

test("primary assertion survives cleanup failure and success requires both evidence and cleanup", () => {
  const primary = { ok: false, fixtureOnly: true, phase: "repeat-open" };
  assert.deepEqual(previewBootstrapReceipt(null, primary, false), { ...primary, cleanupConfirmed: false });
  assert.deepEqual(previewBootstrapReceipt(null, primary, true), { ...primary, cleanupConfirmed: true });
  assert.deepEqual(previewBootstrapReceipt({ browserPassed: true }, null, false), { ok: false, fixtureOnly: true, phase: "cleanup-unconfirmed", cleanupConfirmed: false });
  assert.equal(previewBootstrapReceipt(null, null, true).ok, false);
});

test("fixture child environment is explicit and private, not copied from host", () => {
  const env = previewFixtureEnvironment("/tmp/fixture", "/opt/node/bin/node");
  assert.equal(env.HOME, "/tmp/fixture/home"); assert.equal(env.TMPDIR, "/tmp/fixture/tmp"); assert.equal(env.PATH, "/opt/node/bin:/usr/bin:/bin");
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "TMPDIR", "PATH", "LANG", "USER", "LOGNAME", "SHELL", "TERM", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"].sort());
});

test("real SDK transport callback observes termination of its exact local child", async () => {
  let observedClose;
  const closed = new Promise(resolve => { observedClose = resolve; });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["-e", "process.stdin.resume()"], env: previewFixtureEnvironment("/tmp/fixture-no-files", process.execPath), stderr: "pipe" });
  transport.onclose = observedClose; transport.stderr.on("data", () => {});
  try {
    await boundedFixtureOperation(transport.start(), 2000); const pid = transport.pid; assert.ok(Number.isInteger(pid));
    const f = fixture({ client: null, transport, transportClosed: closed }); f.options.timeoutMs = 3000;
    assert.equal(await cleanupPreviewBootstrapFixture(f.resources, f.options), true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }); assert.ok(f.events.includes("removed"));
  } finally { await transport.close(); }
});
