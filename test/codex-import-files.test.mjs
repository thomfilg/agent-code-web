import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, writeFile, readFile, readlink, symlink, link, rename, unlink, open, utimes } from "node:fs/promises";
import { temporaryDirectory } from "./helpers.mjs";
import { codexImportFileState, inspectCodexImportFiles } from "../src/codex-import-files.mjs";

async function fixture(t) {
  const directory = await temporaryDirectory(t), workspace = path.join(directory, "workspace"), home = path.join(directory, "private-home"), codexHome = path.join(home, "codex");
  await mkdir(workspace); await mkdir(codexHome, { recursive: true });
  const options = { workspace, home, codexHome, source: "claude-code", includeHome: true };
  const file = async (name, content = "Fixture data") => { await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, content); return name; };
  await file(path.join(workspace, "CLAUDE.md"), "Project fixture instructions");
  await file(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { PRIVATE_FIXTURE_VALUE: "never-return-this-content" } }));
  await file(path.join(codexHome, "config.toml"), 'model = "gpt-5.4"\n');
  return { directory, workspace, home, codexHome, options, file, inspect: changes => codexImportFileState({ ...options, ...changes }) };
}

test("import inspection fingerprints scoped source/target files without returning their contents or paths", async t => {
  const f = await fixture(t);
  const first = await f.inspect(), second = await f.inspect();
  assert.equal(first.revision, second.revision); assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(first.files, 3); assert.ok(first.bytes > 0);
  assert.doesNotMatch(JSON.stringify(first), /never-return|private-home|workspace|CLAUDE/);
  assert.equal(await readFile(path.join(f.workspace, "CLAUDE.md"), "utf8"), "Project fixture instructions");
  await f.file(path.join(f.workspace, "unrelated-source-code.mjs"), "Unrelated edits do not invalidate setup review");
  assert.equal((await f.inspect()).revision, first.revision);
  await f.file(path.join(f.workspace, "CLAUDE.md"), "Changed fixture instructions");
  assert.notEqual((await f.inspect()).revision, first.revision);
});

test("missing targets, same-size edits and replaced setup directories invalidate fingerprints", async t => {
  const f = await fixture(t), before = await f.inspect();
  const target = await f.file(path.join(f.workspace, "AGENTS.md"), "new target");
  const after = await f.inspect(); assert.notEqual(after.revision, before.revision);
  await f.file(target, "new TARGET"); await utimes(target, new Date(0), new Date(0));
  assert.notEqual((await f.inspect()).revision, after.revision);
  const original = path.join(f.home, ".claude"), moved = path.join(f.home, ".claude-old");
  await rename(original, moved); await mkdir(original);
  await f.file(path.join(original, "settings.json"), await readFile(path.join(moved, "settings.json")));
  assert.notEqual((await f.inspect()).revision, before.revision);
});

test("source and destination symlinks, including linked parents, are rejected without exposing their targets", async t => {
  for (const location of ["source-file", "source-directory", "target-file", "root-parent"]) {
    const f = await fixture(t), outside = await temporaryDirectory(t);
    await f.file(path.join(outside, "private.txt"), "Other company secret");
    if (location === "source-file") { await unlink(path.join(f.workspace, "CLAUDE.md")); await symlink(path.join(outside, "private.txt"), path.join(f.workspace, "CLAUDE.md")); }
    if (location === "source-directory") await symlink(outside, path.join(f.workspace, ".claude"));
    if (location === "target-file") { await unlink(path.join(f.codexHome, "config.toml")); await symlink(path.join(outside, "private.txt"), path.join(f.codexHome, "config.toml")); }
    if (location === "root-parent") { await symlink(f.directory, path.join(outside, "alias")); f.options.workspace = path.join(outside, "alias", "workspace"); }
    await assert.rejects(f.inspect(), error => /symbolic link|replaced directory/.test(error.message) && !error.message.includes(outside) && !/Other company/.test(error.message), location);
  }
});

test("hardlinks and special files fail before reading, without waiting on FIFOs", async t => {
  const f = await fixture(t), outside = await temporaryDirectory(t);
  await f.file(path.join(outside, "private.txt"), "Outside fixture data");
  const linked = path.join(f.workspace, ".mcp.json"); await link(path.join(outside, "private.txt"), linked);
  await assert.rejects(f.inspect(), /hard links/); await unlink(linked);
  execFileSync("mkfifo", [linked]); await assert.rejects(f.inspect(), /ordinary files/);
});

test("shared-profile inspection excludes home configuration and native user history", async t => {
  const f = await fixture(t), outside = await temporaryDirectory(t);
  await symlink(outside, path.join(f.home, ".claude", "linked-private-profile"));
  const first = await f.inspect({ includeHome: false });
  assert.equal(first.files, 1);
  await f.file(path.join(f.codexHome, "config.toml"), "Unrelated shared host change");
  assert.equal((await f.inspect({ includeHome: false })).revision, first.revision);
  await assert.rejects(f.inspect(), /symbolic link/);
});

test("local marketplace references are inspected only within the selected workspace/private home", async t => {
  const f = await fixture(t), settings = path.join(f.home, ".claude", "settings.json");
  const marketplace = path.join(f.workspace, "local-marketplace"), entry = await f.file(path.join(marketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "fixture", source: "plugins/fixture" }] }));
  const contents = await f.file(path.join(marketplace, "plugins", "fixture", "README.md"), "First plugin version");
  await f.file(settings, JSON.stringify({ extraKnownMarketplaces: { fixture: { source: { source: "directory", path: marketplace } } } }));
  const first = await f.inspect(); await f.file(contents, "Second plugin version");
  assert.notEqual((await f.inspect()).revision, first.revision);
  const outside = await temporaryDirectory(t);
  await f.file(entry, JSON.stringify({ plugins: [{ name: "escape", source: outside }] }));
  await assert.rejects(f.inspect(), /outside this chat/);
  await f.file(entry, JSON.stringify({ plugins: [] }));
  await f.file(settings, JSON.stringify({ extraKnownMarketplaces: { fixture: { source: { source: "git", url: `file://${outside}` } } } }));
  await assert.rejects(f.inspect(), /outside this chat/);
});

test("known marketplace install locations and Git redirects cannot bypass scope checks", async t => {
  const f = await fixture(t), outside = await temporaryDirectory(t);
  const known = path.join(f.home, ".claude", "plugins", "known_marketplaces.json");
  await f.file(known, JSON.stringify({ fixture: { installLocation: outside } }));
  await assert.rejects(f.inspect(), /outside this chat/);
  const marketplace = path.join(f.home, "marketplace"); await mkdir(marketplace);
  await f.file(known, JSON.stringify({ fixture: { installLocation: marketplace } }));
  await f.file(path.join(marketplace, ".git"), `gitdir: ${outside}\n`);
  await assert.rejects(f.inspect(), /Git metadata redirects/);
  await unlink(path.join(marketplace, ".git"));
  await f.file(path.join(marketplace, ".git", "config"), `[include]\npath = ${outside}/config\n`);
  await assert.rejects(f.inspect(), /Git metadata redirects/);
});

test("native rollout/database appends and temporary Git scratch files do not invalidate setup reviews", async t => {
  const f = await fixture(t);
  const rollout = await f.file(path.join(f.codexHome, "sessions", "2026", "09", "16", "native.jsonl"), "First native event\n");
  const database = await f.file(path.join(f.codexHome, "state_5.sqlite-wal"), Buffer.from([1, 2, 3]));
  await f.file(path.join(f.codexHome, ".tmp", "git-first", "HEAD"), "first");
  const first = await f.inspect();
  await writeFile(rollout, "Another native event\n", { flag: "a" }); await writeFile(database, Buffer.from([4]), { flag: "a" });
  await f.file(path.join(f.codexHome, ".tmp", "git-second", "HEAD"), "second");
  assert.equal((await f.inspect()).revision, first.revision);
  const outside = await temporaryDirectory(t); await symlink(outside, path.join(f.codexHome, ".tmp", "unsafe"));
  await assert.rejects(f.inspect(), /symbolic link/);
});

test("only transient scratch scans retry concurrent changes, retaining link checks and bounded retries", async t => {
  const f = await fixture(t), scratch = path.join(f.codexHome, ".tmp"); await f.file(path.join(scratch, "HEAD"), "native scratch");
  const baseline = await f.inspect(), original = fs.promises.readdir;
  let changed = false, scans = 0, target = scratch, action = () => f.file(path.join(scratch, "new-child"), "native scratch");
  t.mock.method(fs.promises, "readdir", async (...args) => {
    const names = await original(...args);
    if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fd/") && await readlink(args[0]) === target) {
      scans++; if (!changed) { changed = true; await action(); }
    }
    return names;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await f.inspect()).revision, baseline.revision); assert.equal(scans, 2);
  changed = false; scans = 0; action = () => symlink(f.workspace, path.join(scratch, "unsafe"));
  await assert.rejects(f.inspect(), /symbolic link/); assert.equal(scans, 2); await unlink(path.join(scratch, "unsafe"));
  changed = false; scans = 0; action = async () => { changed = false; await f.file(path.join(scratch, `churn-${scans}`), "churn"); };
  await assert.rejects(f.inspect(), /changed while being inspected/); assert.equal(scans, 3);
  target = path.join(f.home, ".claude"); changed = false; scans = 0; action = () => f.file(path.join(target, "new-config.json"), "{}");
  await assert.rejects(f.inspect(), /changed while being inspected/); assert.equal(scans, 1, "Real source changes cannot silently obtain another review");
});

test("file-size and directory-depth bounds reject oversized inputs instead of partial fingerprints", async t => {
  const f = await fixture(t), file = await open(path.join(f.workspace, ".mcp.json"), "w");
  try { await file.truncate(512 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(f.inspect(), /512 MiB/); await unlink(path.join(f.workspace, ".mcp.json"));
  const deep = path.join(f.workspace, ".claude", ...Array.from({ length: 66 }, () => "d")); await mkdir(deep, { recursive: true });
  await assert.rejects(f.inspect(), /deeply nested/);
});

test("Cursor sources are fingerprinted independently and source paths remain validated", async t => {
  const f = await fixture(t);
  await f.file(path.join(f.workspace, ".cursorrules"), "Cursor instructions");
  await f.file(path.join(f.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
  const before = await f.inspect({ source: "cursor" });
  await f.file(path.join(f.workspace, "CLAUDE.md"), "Claude-only change");
  assert.equal((await f.inspect({ source: "cursor" })).revision, before.revision);
  await f.file(path.join(f.workspace, ".cursorrules"), "Updated Cursor instructions");
  assert.notEqual((await f.inspect({ source: "cursor" })).revision, before.revision);
  for (const input of [{ workspace: "/" }, { workspace: "/fixture/../escape" }, { home: "relative" }, { codexHome: "/outside/native-profile" }, { source: "fallback-provider" }, { includeHome: "true" }]) await assert.rejects(f.inspect(input), /scope|profile/);
});

test("remote import inspection uses worker-owned roots and a minimal environment", async t => {
  const f = await fixture(t), calls = [];
  const executor = { metadata: { backend: "ec2" }, workspace: f.workspace, runtimeHome: f.home, spawn: (command, args, options) => { calls.push(options); return spawn(command, args, options); } };
  const local = await f.inspect();
  const remote = await inspectCodexImportFiles(executor, { ...f.options, workspace: "/controller/private", home: "/controller/home", codexHome: "/controller/codex" });
  assert.equal(remote, local.revision); assert.equal(calls[0].cwd, f.workspace);
  assert.deepEqual(Object.keys(calls[0].env).sort(), ["LANG", "PATH"]);
  let checks = 0;
  await assert.rejects(inspectCodexImportFiles(executor, f.options, () => { if (++checks > 1) throw new Error("Ownership changed"); }), /Ownership changed/);
  await assert.rejects(inspectCodexImportFiles({ ...executor, spawn: () => { throw new Error("sensitive worker credential"); } }, f.options), error => /could not start/.test(error.message) && !/credential/.test(error.message));
});
