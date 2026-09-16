import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, readFile, readdir, readlink, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { snapshotWorkspace, unpackWorkspaceSnapshot, workspaceSnapshot } from "../src/workspace-snapshot.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec("git", args, { cwd, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })).stdout;
const header = value => Buffer.from(`${JSON.stringify(value)}\n`);
const initial = header({ type: "workspace", version: 1 });
const end = (entries, bytes) => header({ type: "end", entries, bytes });
const file = (name, text, attrs = {}) => [header({ type: "file", path: name, size: Buffer.byteLength(text), mode: 0o644, mtime: Date.now(), ...attrs }), Buffer.from(text)];

async function fixture(t) {
  const root = await temporaryDirectory(t), source = path.join(root, "source"), destination = path.join(root, "fork");
  await mkdir(source); return { root, source, destination };
}

test("fork workspace copies Git index, edits, ignored/untracked files and internal links independently", async t => {
  const { source, destination } = await fixture(t);
  await git(source, "init", "--quiet");
  await writeFile(path.join(source, "tracked.txt"), "original\n");
  await writeFile(path.join(source, ".gitignore"), "ignored.bin\n");
  await writeFile(path.join(source, "run.sh"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(source, "run.sh"), 0o755);
  await git(source, "add", ".");
  await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "before fork");
  await writeFile(path.join(source, "tracked.txt"), "staged\n"); await git(source, "add", "tracked.txt");
  await writeFile(path.join(source, "tracked.txt"), "unstaged Café 🍺\n");
  await writeFile(path.join(source, "ignored.bin"), Buffer.alloc(180_000, 0xab));
  await mkdir(path.join(source, "files"));
  await writeFile(path.join(source, "files", "draft.txt"), "not committed");
  await link(path.join(source, "tracked.txt"), path.join(source, "hardlink.txt"));
  await symlink("../tracked.txt", path.join(source, "files", "relative"));
  await symlink(path.join(source, "tracked.txt"), path.join(source, "absolute"));
  const originalStatus = await git(source, "status", "--porcelain");
  const snapshot = await snapshotWorkspace({ source, destination });
  assert.ok(snapshot.entries > 10); assert.ok(snapshot.bytes > 180_000);
  assert.equal(await git(destination, "status", "--porcelain"), originalStatus);
  assert.equal(await git(destination, "show", ":tracked.txt"), "staged\n");
  assert.equal(await readFile(path.join(destination, "tracked.txt"), "utf8"), "unstaged Café 🍺\n");
  assert.equal((await readFile(path.join(destination, "ignored.bin"))).length, 180_000);
  assert.equal((await stat(path.join(destination, "run.sh"))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(destination, "tracked.txt"))).mode & 0o777, 0o600);
  assert.equal(await readlink(path.join(destination, "absolute")), "tracked.txt");
  assert.equal(await readFile(path.join(destination, "files", "relative"), "utf8"), "unstaged Café 🍺\n");
  await writeFile(path.join(destination, "tracked.txt"), "fork-only change");
  assert.equal(await readFile(path.join(source, "tracked.txt"), "utf8"), "unstaged Café 🍺\n");
  assert.equal(await readFile(path.join(destination, "hardlink.txt"), "utf8"), "unstaged Café 🍺\n");
  await git(destination, "add", "tracked.txt");
  assert.equal(await git(source, "show", ":tracked.txt"), "staged\n");
});

test("worker snapshot streams the selected workspace with only a minimal environment", async t => {
  const { root, source, destination } = await fixture(t), options = [];
  await writeFile(path.join(source, "actual-worker-file"), "not the controller's old clone");
  await writeFile(path.join(root, "auth.json"), "fixture credential, never copy");
  const executor = { workspace: source, runtimeHome: root, spawn: (command, args, config) => { options.push(config); return spawn(command, args, config); } };
  await snapshotWorkspace({ executor, source, destination });
  assert.deepEqual(await readdir(destination), ["actual-worker-file"]);
  assert.deepEqual(Object.keys(options[0].env).sort(), ["HOME", "LANG", "PATH"]);
  await assert.rejects(snapshotWorkspace({ executor, source: root, destination: path.join(root, "wrong") }), /selected worker workspace/);
  await assert.rejects(snapshotWorkspace({ executor, source, destination: path.join(source, "recursive") }), /outside its source/);
});

test("Git worktree redirects and config includes cannot bind a copied repository back to the source", async t => {
  const { root, source, destination } = await fixture(t);
  await git(source, "init", "--quiet");
  await git(source, "config", "core.worktree", source);
  await assert.rejects(snapshotWorkspace({ source, destination }), /self-contained Git configuration/);
  await git(source, "config", "--unset", "core.worktree");
  await git(source, "config", "includeIf.gitdir:example.path", path.join(root, "external-config"));
  await assert.rejects(snapshotWorkspace({ source, destination }), /self-contained Git configuration/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
});

test("snapshot fails closed on external links, limits, linked Git worktrees and existing destinations", async t => {
  const { root, source, destination } = await fixture(t);
  await mkdir(destination); await writeFile(path.join(destination, "keep"), "existing");
  await assert.rejects(snapshotWorkspace({ source, destination }), /EEXIST/);
  assert.equal(await readFile(path.join(destination, "keep"), "utf8"), "existing");
  await assert.rejects(snapshotWorkspace({ source, destination: path.join(source, "recursive") }), /outside its source/);
  const external = path.join(root, "external"); await writeFile(external, "private");
  await symlink(external, path.join(source, "external"));
  const failed = path.join(root, "failed");
  await assert.rejects(snapshotWorkspace({ source, destination: failed }), /links must stay inside/);
  await assert.rejects(lstat(failed), { code: "ENOENT" });
  const source2 = path.join(root, "source2"); await mkdir(source2); await writeFile(path.join(source2, "large"), "1234");
  await assert.rejects(snapshotWorkspace({ source: source2, destination: failed, maxBytes: 3 }), /byte limit/);
  await assert.rejects(lstat(failed), { code: "ENOENT" });
  await writeFile(path.join(source2, "other"), "x");
  await assert.rejects(snapshotWorkspace({ source: source2, destination: failed, maxEntries: 1 }), /file-count limit/);
  await writeFile(path.join(source2, ".git"), `gitdir: ${source}/.git\n`);
  await assert.rejects(snapshotWorkspace({ source: source2, destination: failed }), /linked Git worktree/);
  await assert.rejects(lstat(failed), { code: "ENOENT" });
});

test("snapshot reader rejects traversal, symlink parents, duplicates, excess data and incomplete files", async t => {
  const { root } = await fixture(t);
  const bad = [
    [initial, ...file("../escape", "oops"), end(1, 4)],
    [initial, ...file("/absolute", "oops"), end(1, 4)],
    [initial, header({ type: "symlink", path: "link", target: "../outside" }), end(1, 0)],
    [initial, header({ type: "symlink", path: "link", target: "." }), ...file("link/child", "oops"), end(2, 4)],
    [initial, ...file("same", "one"), ...file("same", "two"), end(2, 6)],
    [initial, ...file("file", "short", { size: 9999 })],
    [initial, ...file("file", "x"), end(1, 2)],
    [initial, ...file("file", "x"), end(1, 1), Buffer.from("extra")],
    [initial, ...file("file", "x", { mode: 0o4777 }), end(1, 1)],
  ];
  for (let i = 0; i < bad.length; i++) {
    const destination = path.join(root, `bad-${i}`);
    await assert.rejects(unpackWorkspaceSnapshot(Readable.from(bad[i]), destination));
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  }
  const fragmented = Buffer.concat([initial, ...file("utf8", "Café 🍺"), end(1, Buffer.byteLength("Café 🍺"))]);
  const destination = path.join(root, "fragmented");
  await unpackWorkspaceSnapshot(Readable.from([...fragmented].map(byte => Buffer.from([byte]))), destination);
  assert.equal(await readFile(path.join(destination, "utf8"), "utf8"), "Café 🍺");
  await assert.rejects(lstat(path.join(root, "escape")), { code: "ENOENT" });
});

test("source edits and replaced directories invalidate a snapshot without following outside files", async t => {
  const { root, source, destination } = await fixture(t);
  await mkdir(path.join(source, "dir")); await writeFile(path.join(source, "dir", "file"), "original");
  let changed = false;
  async function* modifying() {
    for await (const chunk of workspaceSnapshot(source)) {
      yield chunk;
      if (!changed && chunk.toString() === "original") { changed = true; await writeFile(path.join(source, "dir", "file"), "changed during snapshot"); }
    }
  }
  await assert.rejects(unpackWorkspaceSnapshot(modifying(), destination), /Workspace changed/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  const outside = path.join(root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "secret"), "never capture");
  changed = false; const chunks = [];
  async function captureReplaced() {
    for await (const chunk of workspaceSnapshot(source)) {
      chunks.push(chunk);
      if (!changed && chunk.toString().includes('"path":"dir"')) {
        changed = true; await rename(path.join(source, "dir"), path.join(root, "moved-dir")); await symlink(outside, path.join(source, "dir"));
      }
    }
  }
  await assert.rejects(captureReplaced());
  assert.doesNotMatch(Buffer.concat(chunks).toString(), /never capture/);
});

test("cancelled and failed worker copies clean only their new destination", async t => {
  const { root, source, destination } = await fixture(t);
  await writeFile(path.join(source, "file"), "keep source");
  const controller = new AbortController();
  async function* cancelling() { yield initial; controller.abort(new Error("fixture cancelled")); yield* file("file", "x"); }
  await assert.rejects(unpackWorkspaceSnapshot(cancelling(), destination, { signal: controller.signal }), /fixture cancelled/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  const executor = { workspace: source, runtimeHome: root, spawn: () => spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(Buffer.concat([initial, ...file("file", "x"), end(1, 1)]).toString())}); process.exitCode=1`]) };
  await assert.rejects(snapshotWorkspace({ executor, source, destination }), /snapshot failed/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  assert.equal(await readFile(path.join(source, "file"), "utf8"), "keep source");
});
