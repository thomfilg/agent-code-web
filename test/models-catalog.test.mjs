import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelCatalog } from "../src/models.mjs";
import { compareSemver } from "../src/utils.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const templatePath = fileURLToPath(new URL("./fixtures/fake-claude-cli.mjs", import.meta.url));

// Writes an executable "claude" stand-in whose --help/--version output is
// fixed at creation time. ModelCatalog.claude() execs config.claude.bin
// directly (no shell, no extra env forwarding), so the fixture must be a
// real executable, not a shell command string.
async function fakeClaudeCli(t, { version, mentionsFable = true }) {
  const root = await temporaryDirectory(t, "fake-claude-cli-");
  const script = (await readFile(templatePath, "utf8"))
    .replace("__VERSION__", version)
    .replace("__MENTIONS_FABLE__", String(mentionsFable));
  const scriptPath = path.join(root, "fake-claude.mjs");
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test("compareSemver orders numerically and refuses to guess at unparsable input", () => {
  assert.equal(compareSemver("2.1.280", "2.1.279"), 1);
  assert.equal(compareSemver("2.1.279", "2.1.280"), -1);
  assert.equal(compareSemver("2.1.280", "2.1.280"), 0);
  assert.equal(compareSemver("2.2.0", "2.1.999"), 1);
  assert.equal(compareSemver("10.0.0", "9.9.9"), 1);
  assert.equal(compareSemver(null, "2.1.280"), null);
  assert.equal(compareSemver("not-a-version", "2.1.280"), null);
});

test("Claude model catalog gates fable on a real semver threshold, not a substring guess", async t => {
  const belowBin = await fakeClaudeCli(t, { version: "2.1.279", mentionsFable: true });
  const below = await new ModelCatalog({ ...testConfig(await temporaryDirectory(t, "models-below-")), claude: { bin: belowBin } }).list("claude");
  assert.equal(below.installedVersion, "2.1.279");
  assert(!below.models.some(model => model.id === "fable"), "fable must stay disabled below the version gate");

  const atBin = await fakeClaudeCli(t, { version: "2.1.280", mentionsFable: true });
  const at = await new ModelCatalog({ ...testConfig(await temporaryDirectory(t, "models-at-")), claude: { bin: atBin } }).list("claude");
  assert.equal(at.installedVersion, "2.1.280");
  assert(at.models.some(model => model.id === "fable"), "fable must be enabled once the CLI reaches the version gate");

  const aboveBin = await fakeClaudeCli(t, { version: "3.0.0", mentionsFable: true });
  const above = await new ModelCatalog({ ...testConfig(await temporaryDirectory(t, "models-above-")), claude: { bin: aboveBin } }).list("claude");
  assert(above.models.some(model => model.id === "fable"));

  const noMentionBin = await fakeClaudeCli(t, { version: "9.9.9", mentionsFable: false });
  const noMention = await new ModelCatalog({ ...testConfig(await temporaryDirectory(t, "models-no-mention-")), claude: { bin: noMentionBin } }).list("claude");
  assert(!noMention.models.some(model => model.id === "fable"), "a version-eligible CLI that never advertises fable must still not show it");
});

test("invalidate() forces a fresh lookup and a stale in-flight lookup cannot overwrite the fresher one", async t => {
  const catalog = new ModelCatalog(testConfig(await temporaryDirectory(t, "models-race-")));
  let call = 0;
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  catalog.claude = () => { const index = call++; return gates[index].promise.then(() => ({ models: [{ id: `v${index}`, efforts: [] }], source: "fixture" })); };

  const first = catalog.list("claude");
  catalog.invalidate("claude");
  const second = catalog.list("claude");
  assert.notEqual(first, second, "invalidate() during an in-flight lookup must start a new one, not reuse the stale promise");

  gates[1].resolve();
  const secondResult = await second;
  assert.equal(secondResult.models[0].id, "v1");

  gates[0].resolve();
  await first;
  const cached = await catalog.list("claude");
  assert.equal(cached.models[0].id, "v1", "the superseded lookup must not clobber the cache after the fresher one already wrote it");
  assert.equal(call, 2, "the cache must serve the fresh result without triggering a third lookup");
});

test("invalidate(agent) only clears the named agent; invalidate() with no argument clears all", async t => {
  const catalog = new ModelCatalog(testConfig(await temporaryDirectory(t, "models-scope-")));
  let codexCalls = 0, claudeCalls = 0;
  catalog.codex = async () => { codexCalls++; return { models: [{ id: "codex-model", efforts: [] }] }; };
  catalog.claude = async () => { claudeCalls++; return { models: [{ id: "claude-model", efforts: [] }] }; };
  await catalog.list("codex"); await catalog.list("claude");
  catalog.invalidate("claude");
  await catalog.list("codex"); await catalog.list("claude");
  assert.equal(codexCalls, 1); assert.equal(claudeCalls, 2);
  catalog.invalidate();
  await catalog.list("codex"); await catalog.list("claude");
  assert.equal(codexCalls, 2); assert.equal(claudeCalls, 3);
});
