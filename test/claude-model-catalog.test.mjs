import assert from "node:assert/strict";
import test from "node:test";
import { ModelCatalog } from "../src/models.mjs";

const context = { ownerId: "fixture-owner", agentAccountId: "fixture-account" };
const native = [
  { value: "default", displayName: "Default (recommended)", description: "Native account default", supportedEffortLevels: ["low", "high"] },
  { value: "fixture-live", displayName: "Current native model", supportedEffortLevels: ["high", "high", "invalid"] },
  { value: "fixture-disabled", displayName: "Upcoming native model", description: "Update to the CLI version specified by Claude", disabled: true, supportedEffortLevels: ["high"] },
];
const fixture = (models = native, model = "default") => new ModelCatalog({ google: { enabled: true }, claude: { model, effort: "high" } }, { models: async (...args) => {
  assert.deepEqual(args, [context.ownerId, context.agentAccountId, "claude"]); return models;
} });

test("selected-account native rows retain unavailable reasons without inventing model identifiers", async () => {
  const catalog = fixture(), result = await catalog.list("claude", context);
  assert.deepEqual(result.models.map(model => model.id), native.map(model => model.value));
  assert.equal(result.models[2].disabled, true); assert.equal(result.models[2].disabledReason, native[2].description);
  assert.deepEqual(result.models[1].efforts, ["auto", "high"]);
  assert.deepEqual(result.defaults, { model: "default", effort: "high" });
  assert.deepEqual(await catalog.creationSettings("claude", context), { model: "default", effort: "high" });
  await assert.rejects(() => catalog.validate("claude", { ...context, model: "fixture-disabled" }), /currently unavailable/);
  await assert.rejects(() => catalog.turnSettings({ ...context, agent: "claude", model: "fixture-disabled" }), /currently unavailable/);
  await assert.rejects(() => catalog.validate("claude", { ...context, model: "invented" }), /available models/);
  await assert.rejects(() => catalog.list("claude"), /select an agent account/);
});

test("disabled configured defaults never become creation defaults and duplicates do not produce extra picker rows", async () => {
  const catalog = fixture([...native, native[0], null], "fixture-disabled"), result = await catalog.list("claude", context);
  assert.equal(result.models.length, 3); assert.equal(result.defaults.model, "default");
  assert.deepEqual(await catalog.creationSettings("claude", context), { model: "default", effort: "high" });
});

test("a partial discovery is visible without aliases from a host or another account", async () => {
  const models = [native[0]]; Object.defineProperty(models, "discoveryIncomplete", { value: true });
  const result = await fixture(models).list("claude", context);
  assert.match(result.note, /could not be confirmed/); assert.match(result.note, /additional models may be missing/);
  assert.deepEqual(result.models.map(model => model.id), ["default"]);
});

test("empty or all-disabled named catalogs cannot fall through to an invented default model", async () => {
  for (const models of [[], [native[2]], [{ ...native[0], disabled: true }]]) {
    const catalog = fixture(models);
    assert.equal((await catalog.list("claude", context)).defaults.model, null);
    await assert.rejects(() => catalog.creationSettings("claude", context), /No enabled|currently unavailable/);
    await assert.rejects(() => catalog.turnSettings({ ...context, agent: "claude" }), /No enabled|currently unavailable/);
  }
});
