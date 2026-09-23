import assert from "node:assert/strict";
import test from "node:test";
import { modelOptionLabel } from "../public/model-picker.js";
import { ModelCatalog } from "../src/models.mjs";

test("model option labels retain Codex versions and expose Claude versions from native descriptions", () => {
  assert.equal(modelOptionLabel({ id: "gpt-6-sol", label: "GPT-6-Sol", description: "Workhorse model for coding." }), "GPT-6-Sol");
  assert.equal(modelOptionLabel({ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", description: "Older coding model." }), "GPT-5.6-Sol");
  assert.equal(modelOptionLabel({ id: "opus[1m]", label: "Opus (1M context)", description: "Opus 5.5 with 1M context · Best for complex tasks" }), "Opus 5.5 with 1M context");
  assert.equal(modelOptionLabel({ id: "default", label: "Default (recommended)", description: "Opus 5.5 with 1M context · Best for complex tasks" }), "Default (recommended) · Opus 5.5 with 1M context");
  assert.equal(modelOptionLabel({ id: "sonnet", label: "Sonnet", description: "Sonnet 5 · Efficient" }), "Sonnet 5");
});

test("Codex account catalog removes only duplicate effective model IDs", async () => {
  const accounts = { models: async () => [
    { model: "gpt-6-sol", displayName: "GPT-6-Sol", supportedReasoningEfforts: [] },
    { model: "gpt-6-sol", displayName: "Duplicate page result", supportedReasoningEfforts: [] },
    { model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", supportedReasoningEfforts: [] },
  ] };
  const catalog = new ModelCatalog({ google: { enabled: true }, codex: {}, claude: {} }, accounts);
  const result = await catalog.list("codex", { ownerId: "owner", agentAccountId: "account" });
  assert.deepEqual(result.models.map(model => [model.id, model.label]), [["gpt-6-sol", "GPT-6-Sol"], ["gpt-5.6-sol", "GPT-5.6-Sol"]]);
});
