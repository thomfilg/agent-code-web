import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PreviewGrants } from "../src/preview-grants.mjs";
import { openWorkerTcp, WORKER_TCP_BRIDGE } from "../src/worker-tcp-bridge.mjs";
import { SSH_WORKER_LAUNCHER, sshWorkerRequest } from "../src/ssh-worker-launcher.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

// A real local process runs the unchanged SSH launcher and TCP bridge. This is
// a component contract test, not an SSH network, app-proxy or AWS acceptance.
async function fixture(t, { grantTtlMs = 5000 } = {}) {
  const root = await temporaryDirectory(t), heartbeat = path.join(root, ".heartbeat");
  await writeFile(heartbeat, "");
  const connections = new Set(), children = [], bridges = [], errors = [];
  const server = createServer(socket => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => connections.delete(socket));
    socket.pipe(socket);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  const current = new Map();
  const grants = new PreviewGrants({ grantTtlMs, isCurrent: saved => {
    const selected = current.get(saved.hostname);
    return Boolean(selected) && Object.keys(selected).every(key => selected[key] === saved[key]);
  } });
  const executor = { workspace: root, spawn(command, args, options) {
    assert.equal(command, "/usr/bin/node");
    assert.deepEqual(args, ["--input-type=module", "-e", WORKER_TCP_BRIDGE]);
    assert.deepEqual(options.env, {});
    const child = spawn(process.execPath, ["--input-type=module", "-e", SSH_WORKER_LAUNCHER], { ...options, env: {} });
    children.push(child);
    child.stdin.write(sshWorkerRequest({ command: process.execPath, args, cwd: root, env: {}, heartbeat }));
    return child;
  } };
  const account = (name, overrides = {}) => {
    const binding = Object.freeze({ ownerId: `owner_${name}`, sessionId: `session_${name}`,
      chatId: `chat_${name}`, hostname: `d${name}fixture.cloudfront.net`, port, runtimeGeneration: 1, ...overrides });
    current.set(binding.hostname, binding);
    const { ticket } = grants.issueTicket(binding);
    const { grant } = grants.exchangeTicket(ticket, binding.hostname);
    return { binding, ticket, grant };
  };
  const open = (account, observedHostname = account.binding.hostname) => {
    // The network destination is taken only from the returned authoritative
    // lease, never the observed Host. No public routing exists in this fixture.
    const lease = grants.authorize(account.grant, observedHostname);
    const bridge = openWorkerTcp(executor, { port: lease.binding.port, signal: lease.signal,
      connectTimeoutMs: 2000, idleTimeoutMs: 3000, maxLifetimeMs: 6000 });
    bridge.on("error", error => errors.push(error.code));
    const closed = new Promise(resolve => bridge.once("close", resolve));
    bridges.push({ bridge, closed });
    return { bridge, closed, lease };
  };
  t.after(async () => {
    grants.close();
    for (const { bridge } of bridges) bridge.destroy();
    await Promise.all(bridges.map(value => value.closed));
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { account, open, grants, current, children, bridges, connections, errors };
}

async function echo(bridge, text) {
  const observed = once(bridge, "data"); bridge.write(text);
  assert.equal((await observed)[0].toString(), text);
}

test("owner/session revocation closes only that user's real bridge and its launcher", { timeout: 12000 }, async t => {
  const f = await fixture(t), alice = f.account("alice"), bob = f.account("bob");
  const a = f.open(alice), b = f.open(bob);
  await Promise.all([a.bridge.ready, b.bridge.ready]);
  await echo(a.bridge, "alice-before"); await echo(b.bridge, "bob-before");
  assert.equal(f.connections.size, 2);
  assert.equal(f.grants.revokeSession(alice.binding.ownerId, alice.binding.sessionId), 1);
  await a.closed;
  assert.equal(a.lease.signal.aborted, true); assert.equal(a.bridge.cleanupConfirmed, true);
  assert.equal(b.lease.signal.aborted, false); assert.equal(b.bridge.destroyed, false);
  assert.ok(f.children[0].exitCode !== null || f.children[0].signalCode !== null);
  await waitFor(() => f.connections.size === 1);
  await echo(b.bridge, "bob-after-alice-logout");
  assert.throws(() => f.open(alice), /Preview access is unavailable/);
  assert.equal(f.children.length, 2, "revoked authorization must not create another child");
});

test("a live connection expires without another authorize/prune call", { timeout: 10000 }, async t => {
  const f = await fixture(t, { grantTtlMs: 800 }), account = f.account("expiry"), opened = f.open(account);
  await opened.bridge.ready; await echo(opened.bridge, "before-expiry");
  await opened.closed;
  assert.equal(opened.lease.signal.aborted, true); assert.equal(opened.bridge.cleanupConfirmed, true);
  assert.deepEqual(f.errors, ["cancelled"]);
  await waitFor(() => f.connections.size === 0);
  assert.throws(() => f.open(account), /Preview access is unavailable/);
  assert.equal(f.children.length, 1);
});

test("scope replacement rejects stale authority and aborts the existing bridge", { timeout: 10000 }, async t => {
  const f = await fixture(t), account = f.account("generation"), opened = f.open(account);
  await opened.bridge.ready; await echo(opened.bridge, "old-runtime");
  f.current.set(account.binding.hostname, { ...account.binding, runtimeGeneration: 2 });
  // Real lifecycle integration must call revokeChat immediately on replacement;
  // this additionally proves revalidation rejects an old scope before spawning.
  assert.throws(() => f.open(account), /Preview access is unavailable/);
  await opened.closed; assert.equal(opened.lease.signal.aborted, true);
  assert.equal(opened.bridge.cleanupConfirmed, true); assert.equal(f.children.length, 1);
  assert.equal(f.grants.revokeChat(account.binding.ownerId, account.binding.chatId), 0);
});

test("wrong-host and replayed-ticket requests never choose a destination or launch a child", async t => {
  const f = await fixture(t), account = f.account("authority");
  for (const host of ["dotherfixture.cloudfront.net", "127.0.0.1", "169.254.169.254", "localhost", "relay.invalid:8787"])
    assert.throws(() => f.open(account, host), /Preview access is unavailable/);
  assert.throws(() => f.grants.exchangeTicket(account.ticket, account.binding.hostname), /Preview access is unavailable/);
  assert.equal(f.children.length, 0); assert.equal(f.connections.size, 0);
});
