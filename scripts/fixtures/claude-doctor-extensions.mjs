import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Authored, private extension candidates for the real native doctor fixture.
// Install only this local marketplace, never a remote package or user profile.
export async function doctorExtensions({ root, chat, profile, config, commands, exec, userSettings, localSettings }) {
  const market = "doctor-fixture-market", plugin = "doctor-fixture-plugin";
  const candidates = [
    { name: "doctor-unused-project", directory: `${chat.workspace}/.claude/skills/doctor-unused-project`, marker: "DOCTOR_PROJECT_SKILL_BODY" },
    { name: "doctor-unused-user", directory: `${profile}/skills/doctor-unused-user`, marker: "DOCTOR_USER_SKILL_BODY" },
    { name: "doctor-keep", directory: `${profile}/skills/doctor-keep`, marker: "DOCTOR_KEPT_SKILL_BODY", keep: true },
  ];
  const skill = item => `---\nname: ${item.name}\ndescription: Authored doctor acceptance candidate ${item.name}\n---\n${item.marker}\nReport only this marker; do not change files or run commands.\n`;
  for (const item of candidates) { await mkdir(item.directory, { recursive: true }); await writeFile(`${item.directory}/SKILL.md`, skill(item)); }
  const marketplace = `${root}/marketplace`, pluginPath = `${marketplace}/plugins/${plugin}`;
  await mkdir(`${marketplace}/.claude-plugin`, { recursive: true }); await mkdir(`${pluginPath}/.claude-plugin`, { recursive: true });
  await writeFile(`${marketplace}/.claude-plugin/marketplace.json`, JSON.stringify({ name: market, owner: { name: "Private doctor fixture" }, plugins: [{ name: plugin, source: `./plugins/${plugin}` }] }));
  await writeFile(`${pluginPath}/.claude-plugin/plugin.json`, JSON.stringify({ name: plugin, version: "1.0.0", description: "Private doctor cleanup fixture" }));
  await mkdir(`${pluginPath}/skills/stamp`, { recursive: true });
  const pluginSkill = { name: "stamp", marker: "DOCTOR_PLUGIN_SKILL_BODY" };
  await writeFile(`${pluginPath}/skills/stamp/SKILL.md`, skill(pluginSkill));
  const environment = await commands.env("claude", chat);
  const cli = args => exec(config.claude.bin, ["plugin", ...args], { cwd: chat.workspace, env: environment, timeout: 20000, maxBuffer: 10000 });
  await cli(["marketplace", "add", marketplace]); await cli(["install", `${plugin}@${market}`, "--scope", "project"]);
  const projectFile = `${chat.workspace}/.claude/settings.json`, projectSettings = await readFile(projectFile, "utf8");
  assert.equal(JSON.parse(projectSettings).enabledPlugins[`${plugin}@${market}`], true);
  const disabledLocal = { ...localSettings, skillOverrides: { "doctor-unused-project": "off" }, enabledPlugins: { [`${plugin}@${market}`]: false } };
  const userFile = `${profile}/settings.json`, localFile = `${chat.workspace}/.claude/settings.local.json`;
  const installedUser = JSON.parse(await readFile(userFile, "utf8"));
  assert.deepEqual(installedUser.env, userSettings.env);
  const disabledUser = { ...installedUser, skillOverrides: { ...installedUser.skillOverrides, "doctor-unused-user": "off" } };
  const changes = [
    { name: "Read", input: { file_path: localFile } },
    { name: "Write", input: { file_path: localFile, content: `${JSON.stringify(disabledLocal, null, 2)}\n` } },
    { name: "Read", input: { file_path: userFile } },
    { name: "Write", input: { file_path: userFile, content: `${JSON.stringify(disabledUser, null, 2)}\n` } },
  ];
  const targets = candidates.concat({ name: `${plugin}:stamp`, marker: pluginSkill.marker });
  const visible = async () => (await commands.list(chat)).commands.map(command => command.name);
  const before = await visible();
  for (const item of targets) assert(before.includes(item.name), `Actual native catalog must expose ${item.name} before cleanup`);
  return { changes, disabledLocal, disabledUser, installedUser, targets, userFile,
    proposal: ` Also disable only doctor-unused-project (local override), doctor-unused-user (private user override) and ${plugin}@${market} (local override of project enablement). Keep doctor-keep. Do not remove any package or source file.`,
    async verifyFiles(disabled) {
      assert.equal(await readFile(projectFile, "utf8"), projectSettings, "Doctor must not disable plugins by editing the shared project configuration");
      assert.deepEqual(JSON.parse(await readFile(userFile, "utf8")), disabled ? disabledUser : installedUser);
      for (const item of candidates) assert.equal(await readFile(`${item.directory}/SKILL.md`, "utf8"), skill(item));
      assert.equal(await readFile(`${pluginPath}/skills/stamp/SKILL.md`, "utf8"), skill(pluginSkill));
    },
  };
}
