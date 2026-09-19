import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ModelCatalog } from "../src/models.mjs";
import { Environments, SOFTWARE_CATALOG } from "../src/environments.mjs";
import { MemoryRecords } from "../src/database.mjs";

test("named Codex catalogs use only models available to that account, with no host fallback in Google mode", async () => {
  const config = { google: { enabled: true }, codex: { model: "unavailable-global-default", effort: "high", authMode: "host" } };
  const calls = [], catalog = new ModelCatalog(config, { models: async (owner, id) => {
    calls.push({ owner, id });
    return [{ model: "account-default", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }];
  } });
  const context = { ownerId: "fixture-user", agentAccountId: "fixture-account" };
  assert.deepEqual(await catalog.creationSettings("codex", context), { model: "account-default", effort: "medium" });
  assert.ok(calls.every(call => call.owner === context.ownerId && call.id === context.agentAccountId));
  await assert.rejects(() => catalog.list("codex"), /select an agent account/);
  await assert.rejects(() => catalog.list("claude"), /select an agent account/);
});
import { prepareSoftware } from "../src/software.mjs";
import { testConfig } from "./helpers.mjs";

test("model catalog validates provider-specific effort and resets sticky Codex selections", async () => {
  const catalog = new ModelCatalog(testConfig("/tmp/unused-model-fixture"));
  catalog.codex = async () => ({ models: [{ id: "gpt-5.6-sol", efforts: ["low", "medium", "high"], defaultEffort: "low" }, { id: "gpt-fixture", isDefault: true, efforts: ["low", "medium"], defaultEffort: "medium" }, { id: "gpt-second", efforts: ["high"], defaultEffort: "high" }] });
  catalog.claude = async () => ({ models: [{ id: "opus", efforts: ["low", "high", "max"] }, { id: "haiku", efforts: [] }] });
  assert.deepEqual(await catalog.validate("codex", { model: "gpt-second", effort: "high" }), { model: "gpt-second", effort: "high" });
  await assert.rejects(catalog.validate("codex", { model: "gpt-second", effort: "low" }), /not supported/);
  await assert.rejects(catalog.validate("codex", { model: "invented" }), /available/);
  await assert.rejects(catalog.validate("claude", { model: "haiku", effort: "high" }), /not supported/);
  assert.deepEqual(await catalog.turnSettings({ agent: "codex", modelSelectionSet: true }), { model: "gpt-5.6-sol", effort: "high", resetEffort: false });
  assert.deepEqual(await catalog.creationSettings("codex"), { model: "gpt-5.6-sol", effort: "high" });
  assert.deepEqual(await catalog.creationSettings("claude"), { model: "opus", effort: "high" });
  assert.deepEqual(await catalog.creationSettings("claude", { model: "haiku" }), { model: "haiku", effort: null });
  assert.deepEqual(await catalog.turnSettings({ agent: "claude", modelSelectionSet: true }), { model: "opus", effort: "high", resetEffort: false });
});

test("Fast and personality settings use the selected model's advertised capabilities", async () => {
  const catalog = new ModelCatalog(testConfig("/tmp/unused-command-model-fixture"));
  catalog.codex = async () => ({ models: [
    { id: "gpt-5.6-sol", efforts: ["high"], supportsPersonality: true, serviceTiers: [{ id: "priority", name: "Fast" }] },
    { id: "plain", efforts: ["high"], supportsPersonality: false, serviceTiers: [] },
  ] });
  const chat = { agent: "codex", model: "gpt-5.6-sol", effort: "high" };
  assert.deepEqual(await catalog.fastSettings(chat), { serviceTier: "priority" });
  assert.deepEqual(await catalog.fastSettings({ ...chat, serviceTier: "priority" }), { serviceTier: null });
  assert.deepEqual(await catalog.fastSettings(chat, "off"), { serviceTier: null });
  assert.deepEqual(await catalog.validate("codex", { ...chat, serviceTier: "priority", personality: "friendly" }), { model: chat.model, effort: "high", serviceTier: "priority", personality: "friendly" });
  await assert.rejects(catalog.validate("codex", { ...chat, serviceTier: "invented" }), /not available/);
  await assert.rejects(catalog.validate("codex", { ...chat, personality: "invented" }), /supported personality/);
  await assert.rejects(catalog.validate("codex", { ...chat, model: "plain", personality: "pragmatic" }), /supported personality/);
  await assert.rejects(catalog.fastSettings({ ...chat, model: "plain" }), /does not advertise/);
  assert.deepEqual(await catalog.turnSettings({ ...chat, serviceTier: "priority", personality: "pragmatic" }), { model: chat.model, effort: "high", resetEffort: false, serviceTier: "priority", personality: "pragmatic" });
  assert.deepEqual(await catalog.turnSettings({ ...chat, model: "plain", serviceTier: "priority", personality: "pragmatic" }), { model: "plain", effort: "high", resetEffort: false, serviceTier: null, personality: "none" });
});
test("Docker is persisted as a capability but cannot share a local control-plane daemon", async () => {
  const environments = new Environments(new MemoryRecords());
  await environments.companies.save({ id: "fixture", name: "Fixture" });
  assert.ok(SOFTWARE_CATALOG.some(item => item.id === "docker"));
  await assert.rejects(environments.save({ name: "Unsafe local", backend: "local", software: ["docker"] }), /dedicated EC2/);
  const environment = await environments.save({ name: "Container worker", backend: "ec2", companies: ["fixture"], software: ["docker"] });
  assert.deepEqual((await environments.runtime(environment.id, { repositories: [{ fullName: "fixture/project" }] })).software, ["docker"]);
  await assert.rejects(prepareSoftware({ runtimeHome: "/tmp/fake-home", metadata: { backend: "local" }, mkdir: async () => {}, spawn: () => assert.fail("Local Docker must not be contacted") }, { software: ["docker"] }, async () => {}), /dedicated EC2/);
});
test("Docker preflight uses the dedicated worker and injects only worker-local socket/config", async () => {
  const calls = [];
  const executor = { runtimeHome: "/opt/agent-web/runtime", workspace: "/opt/agent-web/workspace", metadata: { backend: "ec2" }, backend: { config: { ec2: { remotePath: "/usr/bin:/usr/local/bin" } } }, mkdir: async () => {},
    spawn(command, args, options) {
      calls.push({ command, args, env: options.env });
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stdout.end("ready"); child.emit("close", 0); }); return child;
    },
  };
  await prepareSoftware(executor, { id: "test", revision: 1, software: ["docker"] }, async () => {});
  assert.deepEqual(calls[0].args, ["-n", "/usr/local/sbin/agent-web-enable-docker"]);
  assert.equal(executor.capabilityVariables.DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(executor.capabilityVariables.DOCKER_CONFIG, "/opt/agent-web/runtime/docker-config");
  assert.equal(calls[0].env.OPENAI_API_KEY, undefined); assert.equal(calls[0].env.GH_TOKEN, undefined);
  assert.match(calls[1].args.join(" "), /docker info.*docker compose.*docker buildx/);
});
