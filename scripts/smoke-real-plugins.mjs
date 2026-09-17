import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { JsonRpcProcess } from "../src/json-rpc-process.mjs";
import { CodexPlugins, CodexPluginCli } from "../src/codex-plugins.mjs";

// Private local marketplace, no host configuration/account or inference. The
// supported CLI commands are used instead of under-development plugin RPCs.
const directory = await mkdtemp("/tmp/relay-native-plugins-smoke-");
const workspace = path.join(directory, "workspace"), profile = path.join(directory, "profile");
const execute = promisify(execFile);
let rpc, runner;
const env = { HOME: directory, CODEX_HOME: profile, PATH: process.env.PATH, LANG: "C.UTF-8", NO_COLOR: "1" };
const cli = async args => {
  const result = await execute("codex", ["plugin", ...args], { cwd: workspace, env, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout);
};
try {
  await mkdir(profile, { recursive: true });
  await mkdir(path.join(workspace, ".agents/plugins"), { recursive: true });
  await mkdir(path.join(workspace, "plugins/fixture/skills/fixture-skill"), { recursive: true });
  await writeFile(path.join(workspace, "plugins/fixture/plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "fixture", version: "1.0.0", description: "Private plugin smoke fixture" }));
  await writeFile(path.join(workspace, "plugins/fixture/skills/fixture-skill/SKILL.md"), "---\nname: fixture-skill\ndescription: Private plugin smoke fixture.\n---\nThis is test fixture content, not an instruction to execute.\n");
  await writeFile(path.join(workspace, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "relay-fixture", interface: { displayName: "Relay fixture" }, plugins: [{ name: "fixture", source: { source: "local", path: "./plugins/fixture" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }));
  await cli(["marketplace", "add", workspace, "--json"]);
  rpc = new JsonRpcProcess({ command: "codex", args: ["app-server"], spawnOptions: { cwd: workspace, env }, requestTimeoutMs: 20000 });
  rpc.on("error", () => {}); rpc.start();
  await rpc.request("initialize", { clientInfo: { name: "relay_plugin_fixture", version: "1" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized", {});
  const { thread } = await rpc.request("thread/start", { cwd: workspace, model: "gpt-5.4", ephemeral: true });
  const skills = async () => (await rpc.request("skills/list", { cwds: [workspace], forceReload: true })).data.flatMap(entry => entry.skills);
  runner = new CodexPluginCli({ command: "codex", workspace, env });
  const calls = [];
  const plugins = new CodexPlugins({ run: args => runner.run(args), request: (method, params) => { calls.push(method); return rpc.request(method, params); }, workspace, thread: () => thread.id, mutable: true, changed: skills });
  let catalog = await plugins.list();
  const change = async action => { catalog = await plugins.change({ id: "fixture@relay-fixture", action, confirm: true, threadId: catalog.threadId, revision: catalog.revision }); };
  const fixtureSkill = async () => (await skills()).find(skill => skill.pluginId === "fixture@relay-fixture");
  assert.deepEqual(catalog.plugins[0].actions, ["install"]);
  await change("install"); assert.equal((await fixtureSkill())?.enabled, true);
  assert.match(await readFile(path.join(profile, "config.toml"), "utf8"), /fixture@relay-fixture/);
  await change("disable"); assert.equal(await fixtureSkill(), undefined);
  await change("enable"); assert.equal((await fixtureSkill())?.enabled, true);
  await change("remove"); assert.equal(await fixtureSkill(), undefined);
  assert.equal(catalog.plugins[0].installed, false);
  assert.ok(!calls.some(method => ["plugin/list", "plugin/read", "plugin/install", "plugin/uninstall", "turn/start"].includes(method)));
  console.log("PASS: installed Codex plugin discovery, install, disable, enable, remove and skill refresh in a private profile; no host account or inference.");
} finally { await runner?.stop(); await rpc?.stop(); await rm(directory, { recursive: true, force: true }); }
