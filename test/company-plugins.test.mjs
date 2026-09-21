import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { CompanyPlugins, inspectPluginCheckout, normalizePluginSource } from "../src/company-plugins.mjs";
import { Companies } from "../src/companies.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const snapshot = {
  source: "thomfilg/ai-plugin-work", revision: "abc123", marketplace: { name: "work-workflow", description: "Work plugins" },
  plugins: [
    { name: "work-workflow", version: "1.2.3", description: "Work", commands: [{ name: "work-workflow:work", aliases: ["work"], description: "Run work" }] },
    { name: "synapsys", version: "1.2.2", description: "Memory", commands: [{ name: "synapsys:status", aliases: ["status"], description: "Memory status" }] },
  ],
};

test("company plugin settings validate scope, publish pre-chat aliases and prepare private Claude/Codex profiles over HTTPS", async () => {
  const records = new MemoryRecords(), companies = new Companies(records); await companies.save({ id: "acme", name: "Acme" });
  const calls = [], states = new Map(), capture = async (_executor, command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (command === "/bin/sh" && args[1].includes("cat --")) return states.get(args[3]) || "";
    if (command === "/bin/sh" && args[1].includes("umask 077")) states.set(args[3], args[4]);
    return "";
  };
  const plugins = new CompanyPlugins(records, { companies, config: { claude: { bin: "claude" }, codex: { bin: "codex" } }, inspect: async source => ({ ...snapshot, source: normalizePluginSource(source) }), capture });
  const saved = await plugins.save({ companyId: "acme", source: "https://github.com/thomfilg/ai-plugin-work.git", targets: { claude: ["work-workflow", "synapsys"], codex: ["work-workflow", "synapsys"] } });
  assert.equal(saved.source, "thomfilg/ai-plugin-work");
  assert.deepEqual((await plugins.commands("acme", "claude")).find(command => command.name === "work-workflow:work")?.aliases, ["work"]);
  assert.deepEqual((await plugins.commands("acme", "codex")).map(command => command.name), ["work-workflow:work", "synapsys:status"]);
  await assert.rejects(plugins.save({ companyId: "acme", source: saved.source, targets: { claude: ["missing"], codex: [] } }), /valid Claude plugins/);

  const executor = { workspace: "/workspace", runtimeHome: "/runtime", environmentPath: "/bin", mkdir: async () => {} };
  await plugins.prepare(executor, { agent: "claude", repositories: [{ fullName: "acme/repo" }] });
  assert(calls.some(call => call.args.join(" ").includes("marketplace add https://github.com/thomfilg/ai-plugin-work.git --scope user")));
  assert(calls.some(call => call.args.includes("work-workflow@work-workflow") && call.env.CLAUDE_CONFIG_DIR === "/runtime/claude"));
  calls.length = 0;
  await plugins.prepare(executor, { agent: "claude", repositories: [{ fullName: "acme/repo" }] });
  assert.equal(calls.filter(call => call.command === "claude").length, 0, "an exact prepared profile is reused");
  await plugins.save({ companyId: "acme", source: saved.source, revision: saved.revision, targets: { claude: ["work-workflow"], codex: ["work-workflow", "synapsys"] } }, saved.id);
  calls.length = 0;
  await plugins.prepare(executor, { agent: "claude", repositories: [{ fullName: "acme/repo" }] });
  assert(calls.some(call => call.args.includes("uninstall") && call.args.includes("synapsys@work-workflow")), "an unchecked managed plugin is removed");
  calls.length = 0;
  await plugins.prepare(executor, { agent: "codex", repositories: [{ fullName: "acme/repo" }] });
  assert(calls.some(call => call.args.includes("work-workflow@work-workflow") && call.env.CODEX_HOME === "/runtime/codex"));
  assert(calls.some(call => call.args.includes("synapsys@work-workflow")));
  await plugins.remove(saved.id); calls.length = 0;
  assert.equal(await plugins.configured({ agent: "claude", repositories: [{ fullName: "acme/repo" }] }), true, "a previously managed profile remains eligible for cleanup");
  await plugins.prepare(executor, { agent: "claude", repositories: [{ fullName: "acme/repo" }] });
  assert(calls.some(call => call.args.includes("uninstall") && call.args.includes("work-workflow@work-workflow")), "removing the last marketplace cleans a reused profile");
});

test("static marketplace inspection reads skills without executing plugin code", async t => {
  const root = await temporaryDirectory(t, "relay-plugin-checkout-");
  await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(root, "plugins/work/.claude-plugin"), { recursive: true });
  await mkdir(path.join(root, "plugins/work/skills/work"), { recursive: true });
  await writeFile(path.join(root, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "fixture", metadata: { description: "Fixture" }, plugins: [{ name: "work", source: "./plugins/work", description: "Work plugin" }] }));
  await writeFile(path.join(root, "plugins/work/.claude-plugin/plugin.json"), JSON.stringify({ name: "work", version: "1.0.0" }));
  await writeFile(path.join(root, "plugins/work/skills/work/SKILL.md"), "---\nname: work\ndescription: Run the workflow\nuser-invocable: true\n---\nNever executed during inspection.\n");
  const result = await inspectPluginCheckout(root, "owner/repo", "deadbeef");
  assert.deepEqual(result.plugins[0].commands, [{ name: "work:work", aliases: ["work"], description: "Run the workflow" }]);
});
