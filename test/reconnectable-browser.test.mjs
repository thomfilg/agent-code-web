import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../src/database.mjs";
import { WorkerLeaseAuthority } from "../src/worker-lease-authority.mjs";
import { WorkerProcessSupervisor } from "../src/worker-process-supervisor.mjs";
import { WorkerProcessTransport } from "../src/worker-process-transport.mjs";
import { createLocalBrowserTransport } from "../src/reconnectable-browser-process.mjs";
import { createWorkerBackend } from "../src/worker-backends.mjs";
import { SharedBrowsers } from "../src/shared-browser.mjs";
import { ChatStore } from "../src/store.mjs";
import { testConfig } from "./helpers.mjs";

const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/google-chrome-stable";
const sha = text => createHash("sha256").update(text).digest("hex");
const ownerId = "user_" + "1".repeat(32), companyId = "fixture-company", environmentId = "fixture-environment";
const accountId = "account_11111111-1111-4111-8111-111111111111";
async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > deadline) throw Error("Local browser fixture timed out"); await delay(10); }
}
async function port() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const value = socket.address().port; await new Promise(resolve => socket.close(resolve)); return value;
}
class Viewer extends EventEmitter {
  readyState = 1; frames = [];
  send(data, callback) { this.frames.push(data); callback?.(); }
  close() { this.readyState = 3; this.emit("close"); }
}

test("normal SharedBrowsers path reconnects disposable real Chrome with durable local authority", { timeout: 120000 }, async t => {
  // No skip can turn a missing real-browser prerequisite into acceptance.
  execFileSync(executable, ["--version"], { stdio: "ignore" });
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-browser-reconnect-"));
  const records = await openDatabase({ mode: "embedded", directory: path.join(root, "postgres"), port: await port() });
  const website = http.createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<title>fixture</title><button id='counter'>count</button>"); });
  await new Promise(resolve => website.listen(0, "127.0.0.1", resolve));
  const websiteUrl = `http://127.0.0.1:${website.address().port}/`;
  t.after(async () => { await new Promise(resolve => website.close(resolve)); await records.close(); await rm(root, { recursive: true, force: true }); });
  const store = new ChatStore(path.join(root, "chats"), records); await store.initialize();
  await records.put("agent-account", accountId, { id: accountId, ownerId, provider: "codex", status: "connected", revision: 1, auth: { synthetic: true } });
  await records.put(`user:${ownerId}:company`, companyId, { id: companyId, revision: 1, name: "Fixture company" });
  await records.put(`user:${ownerId}:environment`, environmentId, { id: environmentId, revision: 1, companies: [companyId], allowUnassigned: false });
  const bootId = sha(await readFile("/proc/sys/kernel/random/boot_id", "utf8"));
  const config = testConfig(root, { AGENT_CHROME_BIN: executable, AGENT_IDLE_TIMEOUT_MS: "60000" });

  async function fixture(t) {
    const chat = await store.create({ ownerId, agent: "codex", agentAccountId: accountId, environmentId,
      repositories: [{ fullName: "fixture/project", companyId, directory: "fixture--project", branch: "main" }] });
    // Normal RuntimeManager preparation supplies these before browser acquire;
    // this fixture creates only its empty synthetic workspace, never a clone.
    await mkdir(chat.workspace, { recursive: true, mode: 0o700 });
    await mkdir(store.runtimeHome(chat.id), { recursive: true, mode: 0o700 });
    const contexts = [], f = { chat, contexts, issueGate: null, spawnGate: null, issued: 0 };
    const initialLifetime = randomUUID();
    const browserTransport = createLocalBrowserTransport({ watchLeaseMs: 1000, controllerLifetimeId: initialLifetime, openAttempt: async selected => {
      assert.equal(selected.id, chat.id);
      const directory = await mkdtemp(path.join(root, "attempt-"));
      const identity = { deploymentId: "local-fixture", ownerId, chatId: chat.id, workerId: "local-worker", provider: "codex", accountId, attemptId: randomUUID() };
      let supervisor, activeAdmission;
      const authority = new WorkerLeaseAuthority({ records, deploymentId: identity.deploymentId, bootForWorker: () => bootId,
        invalidateLease: id => supervisor?.invalidateLease(id) });
      const binding = await authority.prepare(identity), controllerId = "controller-fixture";
      const claim = await authority.claim(binding, controllerId), admitted = authority.forAttempt(binding, controllerId);
      activeAdmission = admitted;
      const socketPath = path.join(directory, "process.sock");
      supervisor = await new WorkerProcessSupervisor({ socketPath, expectedIdentity: identity, authorize: request => activeAdmission.authorize(request) }).listen();
      let ledgerWrites = 0;
      const ledgerRecords = { workerTransportGet: request => records.workerTransportGet(request), workerTransportTransaction: async (...args) => {
        if (++ledgerWrites === 2 && f.failLaunchCommit) throw Error("synthetic launch receipt commit failure");
        return records.workerTransportTransaction(...args);
      } };
      const context = { boundary: "local-validation", identity, binding, claim, records: ledgerRecords, socketPath, authority, admitted, supervisor,
        replaceAdmission: next => { activeAdmission = next; },
        issueLease: async () => { ++f.issued; await f.issueGate?.(); return admitted.issue(); }, renewLease: id => admitted.renew(id),
        dispose: async ({ failed }) => {
          if (context.disposed) return;
          if (f.failDispose) throw Error("synthetic owner cleanup failure");
          if (failed) await ownerCleanup(context);
          else await supervisor.close();
          await admitted.revoke(); context.disposed = true;
        } };
      contexts.push(context); return context;
    } });
    const spawn = browserTransport.spawnBrowser.bind(browserTransport);
    browserTransport.spawnBrowser = async (...args) => {
      const child = await spawn(...args); f.spawnedChild = child;
      await f.spawnGate?.(child); return child;
    };
    const backend = createWorkerBackend({ store, config, gatewayOrigin: "http://127.0.0.1", browserTransport });
    f.browsers = new SharedBrowsers({ store, config, acquire: selected => backend.acquire(store.get(selected)) });
    t.after(async () => {
      await f.browsers.shutdown();
      for (const context of contexts) {
        await ownerCleanup(context);
        if (!context.disposed) await context.admitted.revoke().catch(() => {});
      }
    });
    f.open = async () => {
      const entry = await f.browsers.ensure(chat.id); f.entry = entry; f.child = entry.browser.child; f.context = contexts.at(-1);
      return entry;
    };
    f.restartController = async () => {
      const previous = f.context;
      f.child.detach(); await until(() => f.child.detached);
      clearInterval(f.entry.browser.heartbeat); clearTimeout(f.entry.idleTimer);
      const controllerId = `controller-${randomUUID()}`;
      const authority = new WorkerLeaseAuthority({ records, deploymentId: previous.identity.deploymentId, bootForWorker: () => bootId,
        invalidateLease: id => previous.supervisor.invalidateLease(id) });
      const row = await records.workerAttemptGet(previous.claim.attemptId);
      const claim = await authority.takeover(previous.binding, controllerId, { expectedRevision: row.revision });
      const admitted = authority.forAttempt(previous.binding, controllerId); previous.replaceAdmission(admitted);
      const context = { ...previous, claim, authority, admitted, disposed: false,
        issueLease: async () => { ++f.issued; return admitted.issue(); }, renewLease: id => admitted.renew(id),
        dispose: async ({ failed }) => {
          if (context.disposed) return;
          if (failed) await ownerCleanup(context); else await context.supervisor.close();
          await admitted.revoke(); context.disposed = true;
        } };
      contexts.push(context);
      const resumedTransport = createLocalBrowserTransport({ watchLeaseMs: 1000, controllerLifetimeId: randomUUID(), openAttempt: async selected => {
        assert.equal(selected.id, chat.id); return context;
      } });
      const resumedBackend = createWorkerBackend({ store, config, gatewayOrigin: "http://127.0.0.1", browserTransport: resumedTransport });
      f.browsers = new SharedBrowsers({ store, config, acquire: selected => resumedBackend.acquire(store.get(selected)) });
      return f.open();
    };
    return f;
  }
  async function ownerCleanup(context) {
    // Explicit trusted owner cleanup in this synthetic fixture only. Revoked
    // production cgroup/service cleanup is NOT implemented by this local slice.
    for (const entry of context.supervisor.processes.values()) {
      await context.supervisor.terminate(entry);
      await until(() => { context.supervisor.acknowledge(entry, entry.outputSeq); context.supervisor.drain(entry); return entry.exitRecorded; });
      context.supervisor.acknowledge(entry, entry.outputSeq);
    }
    await context.supervisor.close();
  }

  await t.test("ensure/command preserve helper, Chrome PID, page memory and idempotent caller entry after link loss; Stop is real", async t => {
    const f = await fixture(t); const original = await f.open();
    await f.browsers.command(f.chat.id, "navigate", { url: websiteUrl });
    await f.browsers.command(f.chat.id, "evaluate", { expression: "window.reconnectSentinel='private-fixture-memory'; window.counter=0; document.querySelector('#counter').onclick=()=>window.counter++; 'ready'" });
    const before = await f.browsers.command(f.chat.id, "status"), receipt = f.child.receipt;
    assert.equal(before.processIdentity.helperPid, receipt.pid); assert.notEqual(before.processIdentity.chromePid, receipt.pid);
    f.child.detach(); await until(() => f.child.detached);
    assert.equal(original.browser.error, undefined); assert.equal(f.child.stdout.destroyed, false);
    assert.equal(await f.browsers.ensure(f.chat.id), original);
    const after = await f.browsers.command(f.chat.id, "status"); assert.deepEqual(after.processIdentity, before.processIdentity);
    assert.equal(await f.browsers.command(f.chat.id, "evaluate", { expression: "window.reconnectSentinel" }), "private-fixture-memory");
    await f.browsers.command(f.chat.id, "click", { selector: "#counter" });
    assert.equal(await f.browsers.command(f.chat.id, "evaluate", { expression: "window.counter" }), 1);
    await f.child.outputQueue;
    const ledger = (await records.workerTransportGet(f.child.storageRequest)).value;
    assert.deepEqual(ledger.inbox, []); assert.equal(ledger.committedOutputSeq, ledger.appliedOutputSeq);
    await f.browsers.stop(f.chat.id);
    assert.equal(f.context.supervisor.processes.get("shared-chrome").groupCleaned, true);
    await until(async () => { try { const raw = await readFile(`/proc/${before.processIdentity.chromePid}/stat`, "utf8"); return raw.slice(raw.lastIndexOf(") ") + 2).startsWith("Z "); } catch { return true; } });
  });

  await t.test("a fresh controller adopts the exact quiescent browser process without replacing Chrome or replaying input", async t => {
    const f = await fixture(t); await f.open();
    await f.browsers.command(f.chat.id, "navigate", { url: websiteUrl });
    await f.browsers.command(f.chat.id, "evaluate", { expression: "window.controllerRestartSentinel='same-renderer'; window.controllerRestartCount=0; 'ready'" });
    const before = await f.browsers.command(f.chat.id, "status"), receipt = f.child.receipt;
    clearInterval(f.entry.browser.heartbeat);
    await f.entry.browser.heartbeatPending?.catch(() => {});
    await f.child.outputQueue; await f.child.inputQueue; await f.child.storageQueue;
    await until(async () => {
      const ledger = (await records.workerTransportGet(f.child.storageRequest)).value;
      return !ledger.input && ledger.rpcs.length === 0 && ledger.inbox.length === 0 && ledger.committedOutputSeq === ledger.appliedOutputSeq;
    });
    const supervisor = f.context.supervisor, inputBefore = supervisor.processes.get("shared-chrome").inputSeq;
    const recovered = await f.restartController();
    assert.equal(recovered.browser.child.recovered, true);
    assert.deepEqual(recovered.browser.child.receipt, receipt);
    assert.equal(supervisor.processes.size, 1); assert.equal(supervisor.processes.get("shared-chrome").commandPid, receipt.pid);
    const after = await f.browsers.command(f.chat.id, "status");
    assert.deepEqual(after.processIdentity, before.processIdentity);
    assert.equal(await f.browsers.command(f.chat.id, "evaluate", { expression: "window.controllerRestartSentinel" }), "same-renderer");
    assert.equal(await f.browsers.command(f.chat.id, "evaluate", { expression: "++window.controllerRestartCount" }), 1);
    assert.equal(supervisor.processes.get("shared-chrome").inputSeq > inputBefore, true, "only fresh recovery/status commands advance input");
    await f.browsers.stop(f.chat.id); assert.equal(supervisor.processes.get("shared-chrome").groupCleaned, true);
  });

  await t.test("a fresh controller refuses an unresolved mutating RPC and preserves the exact process for explicit Stop", async t => {
    const f = await fixture(t); await f.open();
    await f.browsers.command(f.chat.id, "navigate", { url: websiteUrl });
    await f.browsers.command(f.chat.id, "evaluate", { expression: "window.takeoverMutation=0" });
    const original = f.child.client.writeInput.bind(f.child.client);
    f.child.client.writeInput = async (...args) => {
      if (!args[1].toString().includes("window.takeoverMutation++")) return original(...args);
      await original(...args); f.child.detach(); throw Error("synthetic lost mutation acknowledgement");
    };
    await assert.rejects(f.browsers.command(f.chat.id, "evaluate", { expression: "window.takeoverMutation++; new Promise(resolve=>setTimeout(()=>resolve(window.takeoverMutation),500))" }), /unknown|lost/i);
    await f.child.inputQueue; await f.child.storageQueue;
    const ledger = (await records.workerTransportGet(f.child.storageRequest)).value;
    assert.equal(ledger.rpcs.some(rpc => rpc.mutating), true);
    const supervisor = f.context.supervisor, entry = supervisor.processes.get("shared-chrome"), inputBefore = entry.inputSeq;
    await assert.rejects(f.restartController(), /quiescent|mutating/i);
    assert.equal(supervisor.processes.size, 1); assert.equal(entry.inputSeq, inputBefore);
    assert.equal(entry.exited, false, "failed takeover does not silently terminate or replace the retained process");
    await f.browsers.stop(f.chat.id); assert.equal(entry.groupCleaned, true);
  });

  await t.test("disconnected capture expires locally and only an actual viewer re-enables it", async t => {
    const f = await fixture(t); await f.open(); const viewer = new Viewer();
    await f.browsers.attach(f.chat.id, viewer); await until(() => viewer.frames.length > 1);
    f.child.detach(); await until(() => f.child.detached); await delay(1400);
    viewer.close();
    await f.browsers.ensure(f.chat.id);
    const off = await f.browsers.command(f.chat.id, "transportHeartbeat"); assert.equal(off.watchExpired, true); assert.equal(off.watching, false);
    const replacement = new Viewer(); await f.browsers.attach(f.chat.id, replacement);
    const on = await f.browsers.command(f.chat.id, "transportHeartbeat"); assert.equal(on.watching, true); assert.equal(on.watchExpired, false);
    replacement.close();
  });

  await t.test("Stop during a held reconnect does not resurrect or replace the helper", async t => {
    const f = await fixture(t); await f.open(); const pid = f.child.receipt.pid;
    f.child.detach(); await until(() => f.child.detached);
    let entered = false, release; f.issueGate = () => new Promise(resolve => { entered = true; release = resolve; });
    const reconnect = f.browsers.command(f.chat.id, "status"); reconnect.catch(() => {}); await until(() => entered);
    const stopped = f.browsers.stop(f.chat.id); f.issueGate = null; release();
    await stopped; await assert.rejects(reconnect, /Stop|stopped|cancelled|superseded/i);
    assert.equal(f.browsers.entries.has(f.chat.id), false); assert.equal(f.context.supervisor.processes.get("shared-chrome").commandPid, pid);
    assert.equal(f.context.supervisor.processes.get("shared-chrome").groupCleaned, true);
  });

  await t.test("accepted mutating command with a lost acknowledgement is never replayed and explicit Stop remains usable", async t => {
    const f = await fixture(t); await f.open();
    await f.browsers.command(f.chat.id, "navigate", { url: websiteUrl });
    await f.browsers.command(f.chat.id, "evaluate", { expression: "window.mutations=0" });
    const original = f.child.client.writeInput.bind(f.child.client);
    let mutatingId;
    f.child.client.writeInput = async (...args) => {
      if (!args[1].toString().includes("window.mutations++")) return original(...args);
      mutatingId = JSON.parse(args[1].toString()).id;
      await original(...args); f.child.detach(); throw Error("synthetic lost input acknowledgement");
    };
    await assert.rejects(f.browsers.command(f.chat.id, "evaluate", { expression: "window.mutations++; new Promise(resolve=>setTimeout(()=>resolve(window.mutations),500))" }), /unknown|lost/i);
    await until(() => f.child.detached);
    await f.child.inputQueue;
    const ledger = (await records.workerTransportGet(f.child.storageRequest)).value;
    assert.equal(ledger.input.unknown, true); assert.equal(ledger.input.mutating, true);
    await assert.rejects(f.browsers.command(f.chat.id, "status"), /unknown|previous|Stop/i);
    await until(() => f.context.supervisor.processes.get("shared-chrome").records.some(record => {
      if (record.channel !== "stdout") return false;
      return Buffer.from(record.data, "base64").toString().split("\n").some(line => {
        if (!line) return false;
        const message = JSON.parse(line); return message.id === mutatingId && message.value === 1;
      });
    }));
    assert.equal(f.context.supervisor.processes.get("shared-chrome").inputSeq, ledger.nextInputSeq - 1, "no browser command was replayed or silently appended");
    await f.browsers.stop(f.chat.id); assert.equal(f.context.supervisor.processes.get("shared-chrome").groupCleaned, true);
  });

  await t.test("stale credential cannot attach and persisted account revocation prevents normal app reconnect", async t => {
    const f = await fixture(t); await f.open(); const oldCredential = f.child.client.lease;
    f.child.detach(); await until(() => f.child.detached); await f.browsers.ensure(f.chat.id);
    const stale = await new WorkerProcessTransport({ socketPath: f.context.socketPath, expectedIdentity: f.context.identity, lease: oldCredential }).connect();
    await assert.rejects(stale.attach(f.child.receipt, 0), { code: "ADMISSION_DENIED" }); stale.disconnect();
    const account = await records.get("agent-account", accountId);
    await records.put("agent-account", accountId, { ...account, status: "disconnected", revision: account.revision + 1 });
    f.child.detach(); await until(() => f.child.detached);
    await assert.rejects(f.browsers.command(f.chat.id, "status"), /lease|admission|scope/i);
    assert.equal(f.context.supervisor.processes.get("shared-chrome").exited, false);
    await ownerCleanup(f.context); await records.put("agent-account", accountId, account);
  });

  await t.test("failed explicit Stop retains its receipt for retry and cannot start a replacement browser", async t => {
    const f = await fixture(t); await f.open(); const original = f.child.client.terminate.bind(f.child.client);
    f.child.client.terminate = async () => { throw Error("synthetic cleanup denial"); };
    await assert.rejects(f.browsers.stop(f.chat.id), /cleanup denial/);
    assert.equal(f.browsers.entries.get(f.chat.id), f.entry);
    assert.equal(f.context.supervisor.processes.get("shared-chrome").exited, false);
    await assert.rejects(f.browsers.ensure(f.chat.id), /stopping/);
    f.child.client.terminate = original;
    await f.browsers.stop(f.chat.id);
    assert.equal(f.browsers.entries.has(f.chat.id), false);
    assert.equal(f.context.supervisor.processes.get("shared-chrome").groupCleaned, true);
    assert.equal(f.contexts.length, 1);
  });

  await t.test("Stop while spawn is held retains the late process and failed startup cleanup for an explicit retry", async t => {
    const f = await fixture(t); let release, original;
    f.spawnGate = child => {
      original = child.client.terminate.bind(child.client);
      child.client.terminate = async () => { throw Error("synthetic startup cleanup denial"); };
      return new Promise(resolve => { release = resolve; });
    };
    const opening = f.browsers.ensure(f.chat.id); opening.catch(() => {});
    await until(() => release);
    const entry = f.browsers.entries.get(f.chat.id);
    const stopping = f.browsers.stop(f.chat.id); stopping.catch(() => {});
    await until(() => entry.stopping);
    await assert.rejects(f.browsers.ensure(f.chat.id), /stopping/);
    release();
    await assert.rejects(opening, /cleanup denial/); await assert.rejects(stopping, /cleanup denial/);
    assert.equal(f.browsers.entries.get(f.chat.id), entry);
    assert.equal(f.contexts.length, 1);
    f.spawnedChild.client.terminate = original;
    await f.browsers.stop(f.chat.id);
    assert.equal(f.browsers.entries.has(f.chat.id), false);
    assert.equal(f.contexts[0].supervisor.processes.get("shared-chrome").groupCleaned, true);
  });

  await t.test("failed receipt commit plus failed startup disposal retains owner cleanup through the normal caller", async t => {
    const f = await fixture(t); f.failLaunchCommit = true; f.failDispose = true;
    await assert.rejects(f.browsers.ensure(f.chat.id), /startup cleanup is unconfirmed/);
    const entry = f.browsers.entries.get(f.chat.id);
    assert.equal(typeof entry.pendingCleanup, "function");
    await assert.rejects(f.browsers.ensure(f.chat.id), /stopping/);
    f.failDispose = false;
    await f.browsers.stop(f.chat.id);
    assert.equal(f.browsers.entries.has(f.chat.id), false);
    assert.equal(f.contexts.length, 1);
    assert.equal(f.contexts[0].supervisor.processes.get("shared-chrome").groupCleaned, true);
  });

  await t.test("Stop retry resumes disposal after the supervisor socket has already closed", async t => {
    const f = await fixture(t); await f.open(); const dispose = f.context.dispose;
    let first = true;
    f.context.dispose = async options => {
      await f.context.supervisor.close();
      if (first) { first = false; throw Error("synthetic post-close revoke failure"); }
      return dispose(options);
    };
    await assert.rejects(f.browsers.stop(f.chat.id), /post-close revoke/);
    const issued = f.issued;
    assert.equal(f.child.processClosed, true); assert.equal(f.context.supervisor.server.listening, false);
    await f.browsers.stop(f.chat.id);
    assert.equal(f.issued, issued, "completed termination does not require another socket or lease");
    assert.equal(f.context.disposed, true); assert.equal(f.browsers.entries.has(f.chat.id), false);
  });

  await t.test("an output retention failure while reconnect drains refuses a new lease and still permits explicit Stop", async t => {
    const f = await fixture(t); await f.open(); const output = f.child.output.bind(f.child);
    let entered = false, release;
    f.child.output = async () => { entered = true; await new Promise(resolve => { release = resolve; }); throw Error("synthetic output commit failure"); };
    const command = f.browsers.command(f.chat.id, "status"); command.catch(() => {});
    await until(() => entered); f.child.detach(); await until(() => f.child.detached);
    const issued = f.issued;
    const reconnect = f.browsers.ensure(f.chat.id); reconnect.catch(() => {});
    f.child.output = output; release();
    await assert.rejects(command, /lost/); await assert.rejects(reconnect, /inbox persistence failed/);
    assert.equal(f.child.storageFailed, true); assert.equal(f.issued, issued);
    await f.browsers.stop(f.chat.id);
    assert.equal(f.context.supervisor.processes.get("shared-chrome").groupCleaned, true);
  });

  await t.test("default backends are unchanged and production/EC2 opt-in is rejected", async () => {
    const transport = createLocalBrowserTransport({ openAttempt: () => { throw Error("must not run"); } });
    assert.throws(() => createWorkerBackend({ store, config: { ...config, enableMock: false }, browserTransport: transport }), /local validation/);
    assert.throws(() => createWorkerBackend({ store, config: { ...config, workerBackend: "ec2" }, browserTransport: transport }), /local validation/);
    const backend = createWorkerBackend({ store, config });
    const chat = store.list()[0], executor = await backend.acquire(chat);
    assert.equal(executor.browserTransport, undefined);
    let disposed = false;
    const rejected = createLocalBrowserTransport({ openAttempt: async () => ({ boundary: "wrong", dispose: async ({ failed }) => { assert.equal(failed, true); disposed = true; } }) });
    await assert.rejects(rejected.spawnBrowser(chat, "unused", [], {}), /admitted named-account/);
    assert.equal(disposed, true, "invalid admission releases resources already owned by the injected coordinator");
  });
});
