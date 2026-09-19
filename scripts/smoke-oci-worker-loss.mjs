// Explicit opt-in acceptance harness, not part of the default Node suite.
// The OCI worker is real; the native provider is an explicitly synthetic CLI.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { mkdtemp, rm, access, readlink, readFile } from "node:fs/promises";
import path from "node:path";
import { createOciWorker } from "../test/fixtures/oci-worker.mjs";
import { nativeFixture, nativeId } from "../test/fixtures/native-session.mjs";
import { openDatabase } from "../src/database.mjs";
import { ChatStore } from "../src/store.mjs";
import { NativeSessionCheckpoints } from "../src/native-session-checkpoints.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { testConfig } from "../test/helpers.mjs";

test("actual rootless OCI deletion preserves controller messages and restores the same synthetic native journal in a different container", { timeout: 90000 }, async t => {
  assert(path.isAbsolute(process.env.RELAY_TEST_RUNC || ""), "Set RELAY_TEST_RUNC to a separately verified runc binary");
  const directory = await mkdtemp("/tmp/relay-oci-controller-"), workers = [], adapters = [];
  let records, store, service;
  t.after(async () => {
    const failures = [];
    for (const adapter of adapters.reverse()) { try { await adapter.stop(); } catch (error) { failures.push(error); } }
    for (const worker of workers.reverse()) { try { await worker.cleanup(); } catch (error) { failures.push(error); } }
    let databaseClosed = false;
    try { await records?.close(); databaseClosed = true; } catch (error) { failures.push(error); }
    // Keep controller evidence if cleanup is uncertain; one cleanup failure
    // must not prevent attempts to stop other independently owned fixtures.
    if (databaseClosed && !failures.length) await rm(directory, { recursive: true });
    if (failures.length) throw new AggregateError(failures, `Fixture cleanup incomplete; controller evidence retained at ${directory}`);
  });
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const database = { mode: "embedded", directory: path.join(directory, "db"), port };
  records = await openDatabase(database);
  const fixture = await nativeFixture(records), chatId = fixture.chat.id;
  await records.put("chat", chatId, { ...fixture.chat, agentSessionId: null, workspace: "/workspace" });
  store = new ChatStore(directory, records); await store.initialize(); service = fixture.service;
  const makeWorker = async () => {
    const worker = await createOciWorker(process.env.RELAY_TEST_RUNC); workers.push(worker);
    const state = worker.inspect(); assert.equal(state.status, "running");
    // Check the kernel namespace boundary, not merely the wrapper executable.
    for (const namespace of ["pid", "mnt", "net", "user"]) assert.notEqual(await readlink(`/proc/${state.pid}/ns/${namespace}`), await readlink(`/proc/self/ns/${namespace}`));
    const spec = JSON.parse(await readFile(path.join(worker.root, "bundle/config.json"), "utf8"));
    assert.equal(spec.mounts.some(mount => mount.type === "bind" || mount.options?.includes("bind") || mount.options?.includes("rbind")), false);
    for (const file of ["fake-codex-native-journal.mjs", "native-session-data.mjs"]) await worker.put(new URL(`../test/fixtures/${file}`, import.meta.url).pathname, `/fixtures/${file}`);
    return worker;
  };
  const makeAdapter = worker => {
    const adapter = new CodexAdapter({ chat: store.get(chatId), store, executor: worker, nativeSessions: service,
      config: testConfig(directory, { CODEX_BIN: "/fixtures/fake-codex-native-journal.mjs" }), broker: new CapabilityBroker({ ttlMs: 10000 }),
      hooks: { onSessionId: id => store.update(chatId, { agentSessionId: id }), onEvent: () => {},
        accountCredentials: async () => ({ accessToken: "synthetic-only", chatgptAccountId: "synthetic-identity" }) } });
    adapters.push(adapter); return adapter;
  };
  const firstWorker = await makeWorker(), first = makeAdapter(firstWorker);
  await first.start();
  const prompt = "Keep the original user instruction after actual OCI deletion";
  await store.appendMessage(chatId, { role: "user", kind: "text", text: prompt });
  const { text: answer } = await first.send(prompt);
  assert.equal(answer, "Native fixture completed");
  await store.appendMessage(chatId, { role: "assistant", kind: "text", text: answer });
  const messages = store.get(chatId).messages, journal = await first.rpc.request("fixture/history", {});
  const checkpoint = await service.read(store.get(chatId)); assert.equal(checkpoint.value.boundary, "turn-completed");
  assert.equal(Buffer.from(checkpoint.value.bundle.files[0].data, "base64").toString(), journal.data);

  // Abruptly kill the real container, remove its runtime entry and writable
  // bundle. The adapter is not stopped first and the controller remains alive.
  await firstWorker.delete(); await assert.rejects(access(firstWorker.rootfs), { code: "ENOENT" });
  assert.deepEqual(store.get(chatId).messages, messages);
  await first.stop();
  await records.close(); records = await openDatabase(database);
  store = new ChatStore(directory, records); await store.initialize();
  service = new NativeSessionCheckpoints({ records });
  assert.deepEqual(store.get(chatId).messages, messages, "controller database reopen must preserve exact message IDs and bytes");
  assert.equal(store.get(chatId).agentSessionId, nativeId);
  const secondWorker = await makeWorker(); assert.notEqual(secondWorker.id, firstWorker.id); assert.notEqual(secondWorker.rootfs, firstWorker.rootfs);
  const resumed = makeAdapter(secondWorker); await resumed.start();
  const recovered = await resumed.rpc.request("fixture/history", {});
  assert.equal(resumed.threadId, nativeId); assert.equal(recovered.data, journal.data);
  assert.equal(recovered.calls.includes("thread/start"), false); assert.equal(recovered.calls.includes("turn/start"), false);
  assert.deepEqual(store.get(chatId).messages, messages);
  t.diagnostic("Real OCI container and writable layer deleted; real PostgreSQL reopened; production adapter restored exact synthetic native bytes without a prompt. This does not prove installed native-writer flush ordering, mid-turn zero loss, child-session recovery or cloud lifecycle acceptance.");
});
