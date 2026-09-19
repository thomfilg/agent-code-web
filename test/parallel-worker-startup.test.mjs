import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { startupStage, failRunningStartup } from "../src/startup-progress.mjs";
import { prepareRepositories } from "../src/workspace.mjs";
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function waitForIO(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw Error("Fixture IO condition timed out");
}

async function fixture(t, { local = false } = {}) {
  const root = await temporaryDirectory(t), bin = path.join(root, "bin"); await mkdir(bin);
  const executable = path.resolve("test/fixtures/startup-git.mjs"); await chmod(executable, 0o755); await symlink(executable, path.join(bin, "git"));
  const originalPath = process.env.PATH; process.env.PATH = `${bin}:${originalPath}`; t.after(() => { process.env.PATH = originalPath; });
  const store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "100000" }); config.workerBackend = local ? "local" : "ec2";
  const token = Promise.withResolvers(), machine = Promise.withResolvers(), calls = { token: 0, acquire: 0, sleep: 0, upload: 0, adapter: 0, destroy: 0 };
  token.promise.catch(() => {}); machine.promise.catch(() => {});
  let lateStage;
  const manager = new RuntimeManager({ store, config, gatewayOrigin: "http://localhost", broker: new CapabilityBroker({ ttlMs: 10000 }),
    github: { tokenForRepository: async () => { calls.token++; return token.promise; } },
    workerBackend: { acquire: async (chat, { workspaceReady, onStage, check }) => {
      calls.acquire++; lateStage = onStage;
      await onStage("machine", "running");
      try { await machine.promise; check(); await onStage("machine", "completed"); }
      catch (error) { await onStage("machine", "failed").catch(() => {}); throw error; }
      await onStage("connection", "running"); await onStage("connection", "completed");
      await workspaceReady; check();
      assert.equal(store.get(chat.id).workspaceReady, true);
      await onStage("workspace", "running"); calls.upload++; await onStage("workspace", "completed");
      return { metadata: { backend: "fixture" } };
    }, sleep: async () => { calls.sleep++; }, destroy: async () => { calls.destroy++; } },
    adapterFactory: () => { calls.adapter++; throw Error("No agent should start"); },
  });
  t.after(async () => { token.resolve("fixture-token"); machine.resolve(); await manager.shutdown(); });
  const chat = await store.create({ agent: "codex", title: "Parallel fixture", repositories: [{ fullName: "fixture/project", cloneUrl: "https://github.com/fixture/project.git", directory: "fixture--project", branch: "main" }] });
  return { root, store, manager, chat, token, machine, calls, lateStage: (...args) => lateStage(...args) };
}

test("repository and machine start together; connection can finish first but upload joins clone, deduplicated without a prompt", async t => {
  const f = await fixture(t), first = f.manager.browserExecutor(f.chat.id), second = f.manager.browserExecutor(f.chat.id);
  await waitFor(() => f.calls.token === 1 && f.calls.acquire === 1);
  const active = f.store.get(f.chat.id).startupProgress;
  assert.deepEqual(active.stages.map(stage => [stage.id, stage.status]), [["repository", "running"], ["machine", "running"]]);
  assert.ok(active.startedAt); assert.ok(active.stages.every(stage => stage.startedAt && !stage.finishedAt));
  f.machine.resolve(); await waitFor(() => f.store.get(f.chat.id).startupProgress.stages.some(stage => stage.id === "connection" && stage.status === "completed"));
  assert.equal(f.calls.upload, 0); f.token.resolve("fixture-token");
  assert.equal(await first, await second); assert.equal(f.calls.upload, 1); assert.equal(f.calls.adapter, 0);
  const chat = f.store.get(f.chat.id); assert.equal(chat.workspaceReady, true); assert.deepEqual(chat.messages, []);
  assert.ok(chat.startupProgress.stages.every(stage => stage.status === "completed" && Date.parse(stage.finishedAt) >= Date.parse(stage.startedAt)));
  const restarted = new ChatStore(f.root); await restarted.initialize(); assert.deepEqual(restarted.get(chat.id).startupProgress, chat.startupProgress);
  assert.equal(f.manager.eventsSince(chat.id).filter(event => event.type === "chat_updated").at(-1).chat.startupProgress.stages.at(-1).id, "workspace");
});

test("browser and agent startup share one parallel acquisition and send only the requested turn", async t => {
  const f = await fixture(t); let starts = 0, sends = 0;
  f.manager.adapterFactory = () => ({ start: async () => { starts++; }, stop: async () => {}, send: async () => { sends++; return { text: "Fixture done" }; } });
  const browser = f.manager.browserExecutor(f.chat.id), turn = f.manager.send(f.chat.id, "Fixture-only requested turn");
  await waitFor(() => f.calls.acquire === 1 && f.calls.token === 1);
  assert.equal(starts, 0); f.machine.resolve(); f.token.resolve("fixture-token"); await Promise.all([browser, turn]);
  assert.equal(f.calls.acquire, 1); assert.equal(f.calls.upload, 1); assert.equal(starts, 1); assert.equal(sends, 1);
});

test("clone failure waits for in-flight boot before cleanup and never uploads or starts an agent", async t => {
  const f = await fixture(t), waking = await f.manager.wake(f.chat.id);
  await waitFor(() => f.calls.token === 1 && f.calls.acquire === 1);
  const failure = assert.rejects(waking.completion, /Fixture clone denied/);
  f.token.reject(Error("Fixture clone denied")); await waitFor(() => f.store.get(f.chat.id).startupProgress.stages[0].status === "failed"); assert.equal(f.calls.sleep, 0);
  f.machine.resolve(); await failure;
  assert.equal(f.calls.sleep, 1); assert.equal(f.calls.upload, 0); assert.equal(f.calls.adapter, 0);
  assert.equal(f.store.get(f.chat.id).status, "error"); assert.equal(f.store.get(f.chat.id).workspaceReady, false);
  assert.ok(f.store.get(f.chat.id).startupProgress.stages.every(stage => stage.status === "failed"));
});

for (const action of ["stop", "remove"]) test(`${action} cancels both branches; stale stage callbacks cannot resurrect chat or upload`, async t => {
  const f = await fixture(t), waking = await f.manager.wake(f.chat.id);
  await waitFor(() => f.calls.token === 1 && f.calls.acquire === 1);
  const cancelled = assert.rejects(waking.completion, /cancelled/), stopping = f.manager[action](f.chat.id);
  f.token.resolve("fixture-token"); f.machine.resolve(); await cancelled; await stopping;
  assert.equal(f.calls.upload, 0); assert.equal(f.calls.adapter, 0); assert.equal(f.calls.sleep, 1);
  await assert.rejects(f.lateStage("machine", "completed"), /cancelled/);
  if (action === "remove") { assert.equal(f.store.get(f.chat.id), null); assert.equal(f.calls.destroy, 1); }
  else { assert.equal(f.store.get(f.chat.id).status, "stopped"); assert.ok(f.store.get(f.chat.id).startupProgress.stages.every(stage => stage.status === "failed")); }
});

test("local backend still acquires only after repositories are ready", async t => {
  const f = await fixture(t, { local: true }), pending = f.manager.browserExecutor(f.chat.id);
  await waitFor(() => f.calls.token === 1); assert.equal(f.calls.acquire, 0);
  f.token.resolve("fixture-token"); f.machine.resolve(); await pending;
  assert.equal(f.calls.acquire, 1); assert.equal(f.calls.upload, 1); assert.equal(f.calls.adapter, 0);
});

test("startup snapshots accept only fixed stages and retain actual concurrent intervals on cancellation", () => {
  let progress = startupStage(null, "repository", "running", "2026-09-19T01:00:00.000Z");
  progress = startupStage(progress, "machine", "running", "2026-09-19T01:00:01.000Z");
  progress = startupStage(progress, "machine", "completed", "2026-09-19T01:00:02.000Z");
  const failed = failRunningStartup(progress, "2026-09-19T01:00:03.000Z");
  assert.equal(failed.stages[0].finishedAt, "2026-09-19T01:00:03.000Z"); assert.equal(failed.stages[1].finishedAt, "2026-09-19T01:00:02.000Z");
  assert.equal(failed.startedAt, progress.startedAt); assert.throws(() => startupStage(null, "private-command", "running"), /Invalid/);
});

test("failed Stop persistence cannot abandon a late launched worker", async t => {
  const f = await fixture(t), waking = await f.manager.wake(f.chat.id);
  await waitFor(() => f.calls.acquire === 1 && f.calls.token === 1);
  const update = f.store.update.bind(f.store); let fail = true;
  f.store.update = async (...args) => { if (fail) { fail = false; throw Error("Fixture persistence failure"); } return update(...args); };
  const cancelled = assert.rejects(waking.completion, /cancelled/);
  await assert.rejects(f.manager.stop(f.chat.id), /Fixture persistence failure/);
  f.token.resolve("fixture-token"); f.machine.resolve(); await cancelled;
  assert.equal(f.calls.sleep, 1); assert.equal(f.calls.upload, 0); assert.equal(f.calls.adapter, 0);
});

test("boot failure cancels pending clone before cleanup and cannot mark its workspace ready", async t => {
  const f = await fixture(t), waking = await f.manager.wake(f.chat.id);
  await waitFor(() => f.calls.acquire === 1 && f.calls.token === 1);
  const failure = assert.rejects(waking.completion, /Fixture boot failed/);
  f.machine.reject(Error("Fixture boot failed")); await waitFor(() => f.store.get(f.chat.id).startupProgress.stages.some(stage => stage.id === "machine" && stage.status === "failed"));
  assert.equal(f.calls.sleep, 0); f.token.resolve("fixture-token"); await failure;
  assert.equal(f.calls.sleep, 1); assert.equal(f.calls.upload, 0); assert.equal(f.store.get(f.chat.id).workspaceReady, false);
});

test("failed startup cleanup retains a blocked lease until explicit Stop retries it", async t => {
  const f = await fixture(t); let fail = true;
  f.manager.workerBackend.sleep = async () => { f.calls.sleep++; if (fail) throw Error("Fixture stop denied"); };
  const waking = await f.manager.wake(f.chat.id); await waitFor(() => f.calls.acquire === 1 && f.calls.token === 1);
  const failure = assert.rejects(waking.completion, /Use Stop to retry cleanup/);
  f.token.reject(Error("Fixture clone denied")); f.machine.resolve(); await failure;
  await assert.rejects(f.manager.browserExecutor(f.chat.id), /Use Stop to retry cleanup/); assert.equal(f.calls.acquire, 1);
  fail = false; await f.manager.stop(f.chat.id); assert.equal(f.calls.sleep, 2); assert.equal(f.store.get(f.chat.id).status, "stopped");
});

test("late adapter startup cancellation cannot stop or remove a newer browser lease", async t => {
  const f = await fixture(t), gate = Promise.withResolvers(); let started = false, sent = 0;
  f.manager.adapterFactory = () => ({ start: async () => { started = true; await gate.promise; }, stop: async () => {}, send: async () => { sent++; return { text: "unexpected" }; } });
  f.token.resolve("fixture-token"); f.machine.resolve();
  const sending = f.manager.send(f.chat.id, "Fixture-only turn");
  await waitFor(() => started); await f.manager.stop(f.chat.id); assert.equal(f.calls.sleep, 1);
  const newer = await f.manager.browserExecutor(f.chat.id); assert.equal(f.calls.acquire, 2);
  const before = f.store.get(f.chat.id).startupProgress;
  gate.resolve(); await sending;
  assert.equal(f.calls.sleep, 1); assert.equal(sent, 0); assert.equal(await f.manager.browserExecutor(f.chat.id), newer);
  assert.deepEqual(f.store.get(f.chat.id).startupProgress, before);
});

test("late software completion after Stop cannot clean up a newer browser lease", async t => {
  const f = await fixture(t), gate = Promise.withResolvers(); let preparing = false;
  await f.store.update(f.chat.id, { environmentId: "fixture-env" });
  f.manager.environments = { runtime: async () => ({ id: "fixture-env", revision: 1, backend: "ec2", software: [], variables: {} }) };
  const acquire = f.manager.workerBackend.acquire;
  f.manager.workerBackend.acquire = async (...args) => ({ ...await acquire(...args), runtimeHome: path.join(f.root, "runtime"),
    mkdir: async () => { preparing = true; await gate.promise; } });
  f.token.resolve("fixture-token"); f.machine.resolve();
  const sending = f.manager.send(f.chat.id, "Fixture-only turn"); await waitFor(() => preparing);
  await f.manager.stop(f.chat.id); const newer = await f.manager.browserExecutor(f.chat.id);
  gate.resolve(); await sending;
  assert.equal(f.calls.sleep, 1); assert.equal(f.calls.adapter, 0); assert.equal(await f.manager.browserExecutor(f.chat.id), newer);
});

test("software, setup and agent show only real execution stages and do not add extra prompts", async t => {
  const f = await fixture(t), sent = [];
  await f.store.update(f.chat.id, { environmentId: "fixture-env" });
  f.manager.environments = { runtime: async () => ({ id: "fixture-env", revision: 1, backend: "ec2", software: [], variables: {}, setupScript: "true" }) };
  const acquire = f.manager.workerBackend.acquire;
  f.manager.workerBackend.acquire = async (...args) => ({ ...await acquire(...args), workspace: f.chat.workspace, runtimeHome: path.join(f.root, "runtime"),
    mkdir: directory => mkdir(directory, { recursive: true }), spawn: (command, args, options) => spawn(command, args, options) });
  f.manager.adapterFactory = () => ({ start: async () => {}, stop: async () => {}, send: async text => { sent.push(text); return { text: "Fixture done" }; } });
  f.token.resolve("fixture-token"); f.machine.resolve(); await f.manager.send(f.chat.id, "Fixture-only turn");
  const chat = f.store.get(f.chat.id);
  assert.equal(sent.length, 1); assert.equal(chat.messages.filter(message => message.role === "user").length, 1);
  assert.deepEqual(chat.startupProgress.stages.map(stage => stage.id), ["repository", "machine", "connection", "workspace", "software", "setup", "agent"]);
  assert.ok(chat.startupProgress.finishedAt); assert.ok(chat.startupProgress.stages.every(stage => stage.status === "completed" && stage.finishedAt));
});

test("clone cancellation kills an owned descendant that outlives git and drains its pipes", async t => {
  const f = await fixture(t), controller = new AbortController(), destination = path.join(f.root, "descendants");
  const pending = prepareRepositories({ destination, repositories: [{ fullName: "fixture/descendants", cloneUrl: "https://github.com/fixture/descendants.git", directory: "fixture--descendants", branch: "main" }], token: "fixture-token", signal: controller.signal });
  const failure = assert.rejects(pending, /Fixture abort/);
  const pidPath = await waitForIO(async () => {
    const entries = await readdir(destination).catch(() => []); const temporary = entries.find(name => name.includes(".clone-"));
    if (!temporary) return null; const candidate = path.join(destination, temporary, "child.pid");
    try { return { candidate, pid: Number(await readFile(candidate, "utf8")) }; } catch { return null; }
  });
  controller.abort(Object.assign(Error("Fixture abort"), { name: "AbortError" }));
  await failure;
  assert.deepEqual(await readdir(destination), []);
  await waitForIO(async () => { try { const status = await readFile(`/proc/${pidPath.pid}/stat`, "utf8"); return status.split(" ")[2] === "Z"; } catch { return true; } });
});
