import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ModelCatalog } from "../src/models.mjs";
import { Environments, SOFTWARE_CATALOG } from "../src/environments.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { prepareSoftware } from "../src/software.mjs";
import { testConfig } from "./helpers.mjs";

test("model catalog validates provider-specific effort and resets sticky Codex selections", async () => {
  const catalog = new ModelCatalog(testConfig("/tmp/unused-model-fixture"));
  catalog.codex = async () => ({ models: [{ id: "gpt-fixture", isDefault: true, efforts: ["low", "medium"], defaultEffort: "medium" }, { id: "gpt-second", efforts: ["high"], defaultEffort: "high" }] });
  catalog.claude = async () => ({ models: [{ id: "opus", efforts: ["low", "high", "max"] }, { id: "haiku", efforts: [] }] });
  assert.deepEqual(await catalog.validate("codex", { model: "gpt-second", effort: "high" }), { model: "gpt-second", effort: "high" });
  await assert.rejects(catalog.validate("codex", { model: "gpt-second", effort: "low" }), /not supported/);
  await assert.rejects(catalog.validate("codex", { model: "invented" }), /available/);
  await assert.rejects(catalog.validate("claude", { model: "haiku", effort: "high" }), /not supported/);
  assert.deepEqual(await catalog.turnSettings({ agent: "codex", modelSelectionSet: true }), { model: "gpt-fixture", effort: "medium", resetEffort: true });
  assert.equal((await catalog.turnSettings({ agent: "claude", modelSelectionSet: true })).model, "default");
});
test("Docker is persisted as a capability but cannot share a local control-plane daemon", async () => {
  const environments = new Environments(new MemoryRecords());
  assert.ok(SOFTWARE_CATALOG.some(item => item.id === "docker"));
  await assert.rejects(environments.save({ name: "Unsafe local", backend: "local", software: ["docker"] }), /dedicated EC2/);
  const environment = await environments.save({ name: "Container worker", backend: "ec2", software: ["docker"] });
  assert.deepEqual((await environments.runtime(environment.id)).software, ["docker"]);
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
