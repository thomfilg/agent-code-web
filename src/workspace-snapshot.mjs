import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { open, lstat, mkdir, readdir, readlink, realpath, rm, symlink, utimes } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { terminateWorker } from "./worker-process.mjs";

// Full workspace copies, including ignored files and .git, with bounded memory.
// No dependency/cache exclusions can silently discard the user's work.
const MAX_BYTES = 8 * 1024 ** 3;
const MAX_ENTRIES = 250_000;
const HEADER_BYTES = 16 * 1024;
const CHUNK_BYTES = 64 * 1024;

function limits(options = {}) {
  const maxBytes = options.maxBytes ?? MAX_BYTES, maxEntries = options.maxEntries ?? MAX_ENTRIES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) throw new Error("Invalid workspace snapshot limits");
  return { maxBytes, maxEntries };
}

function relativeName(name) {
  if (typeof name !== "string" || !name || Buffer.byteLength(name) > 4096 || name.includes("\0") || name.includes("\\") || path.posix.isAbsolute(name) || name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid workspace snapshot path");
  return name;
}

function linkTarget(name, target) {
  if (typeof target !== "string" || !target || Buffer.byteLength(target) > 4096 || /[\0\\]/.test(target) || path.posix.isAbsolute(target)) throw new Error("Workspace links must stay inside the workspace");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
  if (resolved === ".." || resolved.startsWith("../")) throw new Error("Workspace links must stay inside the workspace");
  return target;
}

function unchanged(first, second) {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every(key => first[key] === second[key]);
}

const frame = value => Buffer.from(`${JSON.stringify(value)}\n`);
const stopped = signal => signal?.throwIfAborted();

// Ask Git to parse its own syntax, but do NOT resolve include paths or read
// global settings. A copied config must not redirect work into the source repo.
async function checkGitConfig(bytes) {
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["config", "--file", "-", "--no-includes", "--null", "--name-only", "--list"], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Git snapshot configuration check timed out")); }, 10000);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 1024 * 1024) { child.kill("SIGKILL"); finish(new Error("Git snapshot configuration exceeds its limit")); } });
    child.stderr.resume(); child.once("error", finish); child.stdin.on("error", finish);
    child.once("close", code => {
      if (code !== 0) return finish(new Error("Cannot parse Git configuration for an independent snapshot"));
      const unsafe = output.split("\0").some(key => key === "core.worktree" || key === "include.path" || /^includeif\..*\.path$/.test(key));
      finish(unsafe ? new Error("Fork snapshots require self-contained Git configuration, without worktree redirects or includes") : null);
    });
    child.stdin.end(bytes);
  });
}

// Linux worker traversal is anchored to open directory descriptors. Swapping a
// source directory for a symlink while the copy runs cannot read another home.
export async function* workspaceSnapshot(source, options = {}) {
  if (process.platform !== "linux") throw new Error("Workspace snapshot transfer currently requires a Linux worker");
  if (typeof source !== "string" || !path.isAbsolute(source) || path.resolve(source) === "/") throw new Error("Choose a workspace directory");
  const rootPath = await realpath(source), { maxBytes, maxEntries } = limits(options);
  const root = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const records = []; let bytes = 0, entries = 0;
  const header = entry => {
    relativeName(entry.path);
    if (++entries > maxEntries) throw new Error("Workspace snapshot exceeds its file-count limit");
    const result = frame(entry);
    if (result.length > HEADER_BYTES) throw new Error("Workspace snapshot path is too long");
    return result;
  };
  async function* walk(directory, prefix, depth = 0) {
    stopped(options.signal);
    if (depth > 128) throw new Error("Workspace snapshot is nested too deeply");
    const directoryBefore = await directory.stat({ bigint: true });
    const directoryPath = `/proc/self/fd/${directory.fd}`;
    for (const name of (await readdir(directoryPath)).sort()) {
      stopped(options.signal);
      const relative = relativeName(prefix ? `${prefix}/${name}` : name), filename = `${directoryPath}/${name}`;
      const before = await lstat(filename, { bigint: true });
      records.push({ path: relative, stat: before });
      if (before.isDirectory()) {
        if (/(?:^|\/)\.git\/worktrees$/.test(relative)) throw new Error("Forking a linked Git worktree or alternate object store is not supported yet");
        const child = await open(filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          if (!unchanged(before, await child.stat({ bigint: true }))) throw new Error("Workspace changed while taking its snapshot; retry the fork");
          yield header({ type: "directory", path: relative, mode: Number(before.mode) & 0o777, mtime: Number(before.mtimeMs) });
          yield* walk(child, relative, depth + 1);
        } finally { await child.close(); }
      } else if (before.isSymbolicLink()) {
        let target = await readlink(filename);
        if (path.isAbsolute(target)) {
          const internal = path.relative(rootPath, path.resolve(target));
          if (internal === ".." || internal.startsWith(`..${path.sep}`) || path.isAbsolute(internal)) throw new Error("Workspace links must stay inside the workspace");
          target = path.posix.relative(path.posix.dirname(relative), internal || ".") || ".";
        }
        yield header({ type: "symlink", path: relative, target: linkTarget(relative, target) });
      } else if (before.isFile()) {
        // Linked worktrees and Git alternates point back to another repository.
        // Refuse rather than claiming that this is an independent workspace.
        if (name === ".git" || /(?:^|\/)objects\/info\/alternates$/.test(relative) || /(?:^|\/)\.git\/commondir$/.test(relative)) throw new Error("Forking a linked Git worktree or alternate object store is not supported yet");
        const size = Number(before.size); bytes += size;
        if (!Number.isSafeInteger(size) || bytes > maxBytes) throw new Error("Workspace snapshot exceeds its byte limit");
        const gitConfig = /(?:^|\/)\.git\/config(?:\.worktree)?$/.test(relative) ? [] : null;
        if (gitConfig && size > 1024 * 1024) throw new Error("Git snapshot configuration exceeds its limit");
        const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!unchanged(before, await file.stat({ bigint: true }))) throw new Error("Workspace changed while taking its snapshot; retry the fork");
          yield header({ type: "file", path: relative, size, mode: Number(before.mode) & 0o777, mtime: Number(before.mtimeMs) });
          let offset = 0;
          while (offset < size) {
            stopped(options.signal);
            const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - offset));
            const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
            if (!bytesRead) throw new Error("Workspace changed while taking its snapshot; retry the fork");
            offset += bytesRead;
            if (gitConfig) gitConfig.push(chunk.subarray(0, bytesRead));
            yield chunk.subarray(0, bytesRead);
          }
          if (gitConfig) await checkGitConfig(Buffer.concat(gitConfig));
          if (!unchanged(before, await file.stat({ bigint: true }))) throw new Error("Workspace changed while taking its snapshot; retry the fork");
        } finally { await file.close(); }
      } else throw new Error("Workspace contains a socket, device or other unsupported file");
    }
    if (!unchanged(directoryBefore, await directory.stat({ bigint: true }))) throw new Error("Workspace changed while taking its snapshot; retry the fork");
  }
  // Check every copied entry again before completing. Re-open each directory
  // without following links, so the validation pass has the same containment.
  async function inspect(relative) {
    let current = root; const opened = [];
    try {
      const parts = relative.split("/"), name = parts.pop();
      for (const part of parts) {
        current = await open(`/proc/self/fd/${current.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        opened.push(current);
      }
      return await lstat(`/proc/self/fd/${current.fd}/${name}`, { bigint: true });
    } finally { await Promise.all(opened.map(file => file.close())); }
  }
  try {
    yield frame({ type: "workspace", version: 1 });
    const before = await root.stat({ bigint: true });
    yield* walk(root, "");
    for (const record of records) {
      stopped(options.signal);
      if (!unchanged(record.stat, await inspect(record.path))) throw new Error("Workspace changed while taking its snapshot; retry the fork");
    }
    if (!unchanged(before, await root.stat({ bigint: true }))) throw new Error("Workspace changed while taking its snapshot; retry the fork");
    yield frame({ type: "end", entries, bytes });
  } finally { await root.close(); }
}

class SnapshotReader {
  constructor(stream, signal) { this.iterator = stream[Symbol.asyncIterator](); this.signal = signal; this.buffer = Buffer.alloc(0); this.offset = 0; }
  async take(size) {
    stopped(this.signal);
    while (this.offset === this.buffer.length) {
      const next = await this.iterator.next();
      if (next.done) return null;
      this.buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value); this.offset = 0;
    }
    const end = Math.min(this.offset + size, this.buffer.length), value = this.buffer.subarray(this.offset, end); this.offset = end; return value;
  }
  async line() {
    const chunks = []; let size = 0;
    while (true) {
      const value = await this.take(HEADER_BYTES);
      if (!value) throw new Error("Incomplete workspace snapshot");
      const newline = value.indexOf(10), end = newline < 0 ? value.length : newline;
      size += end; if (size > HEADER_BYTES) throw new Error("Workspace snapshot header exceeds its limit");
      chunks.push(value.subarray(0, end));
      if (newline >= 0) { this.offset -= value.length - newline - 1; break; }
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid workspace snapshot header"); }
  }
}

// Destination must be a NEW controller-owned chat directory. Nothing in an
// existing destination is overwritten, and failed copies remove only their own
// freshly created directory. Link creation is delayed until all files are done.
export async function unpackWorkspaceSnapshot(stream, destination, options = {}) {
  if (typeof destination !== "string" || !path.isAbsolute(destination) || path.resolve(destination) === "/") throw new Error("Choose a new workspace directory");
  const parent = path.dirname(destination);
  if (await realpath(parent) !== parent) throw new Error("Workspace destination parent must not be a symlink");
  const { maxBytes, maxEntries } = limits(options), reader = new SnapshotReader(stream, options.signal);
  const kinds = new Map(), directories = [], links = []; let entries = 0, bytes = 0, owned = null;
  try {
    const initial = await reader.line();
    if (initial?.type !== "workspace" || initial.version !== 1) throw new Error("Unsupported workspace snapshot");
    await mkdir(destination, { mode: 0o700 });
    owned = await lstat(destination, { bigint: true });
    while (true) {
      const entry = await reader.line();
      if (entry?.type === "end") {
        if (entry.entries !== entries || entry.bytes !== bytes || await reader.take(1)) throw new Error("Workspace snapshot totals do not match");
        break;
      }
      const name = relativeName(entry?.path), directory = path.posix.dirname(name);
      if (++entries > maxEntries || kinds.has(name)) throw new Error("Workspace snapshot has too many or duplicate entries");
      if (directory !== "." && kinds.get(directory) !== "directory") throw new Error("Workspace snapshot parent must be a directory");
      if (!["directory", "file", "symlink"].includes(entry.type)) throw new Error("Unsupported workspace snapshot entry");
      kinds.set(name, entry.type);
      const target = path.join(destination, name);
      if (entry.type === "symlink") { links.push({ target, link: linkTarget(name, entry.target) }); continue; }
      if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !Number.isFinite(entry.mtime)) throw new Error("Invalid workspace file attributes");
      if (entry.type === "directory") { await mkdir(target, { mode: 0o700 }); directories.push({ target, ...entry }); continue; }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || (bytes += entry.size) > maxBytes) throw new Error("Workspace snapshot exceeds its byte limit");
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        let remaining = entry.size;
        while (remaining) {
          const chunk = await reader.take(Math.min(CHUNK_BYTES, remaining));
          if (!chunk) throw new Error("Incomplete workspace snapshot file");
          let written = 0;
          while (written < chunk.length) written += (await file.write(chunk, written, chunk.length - written)).bytesWritten;
          remaining -= chunk.length;
        }
        // Keep owner access; never copy setuid bits or expose private chat files
        // to other users just because the source had world-readable defaults.
        await file.chmod((entry.mode & 0o100) | 0o600);
        await file.utimes(entry.mtime / 1000, entry.mtime / 1000);
      } finally { await file.close(); }
    }
    for (const { target, link } of links) { stopped(options.signal); await symlink(link, target); }
    for (const { target, mtime } of directories.reverse()) await utimes(target, mtime / 1000, mtime / 1000);
    stopped(options.signal);
    return { entries, bytes };
  } catch (error) {
    const current = owned && await lstat(destination, { bigint: true }).catch(() => null);
    if (current?.dev === owned?.dev && current?.ino === owned?.ino && current?.isDirectory()) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally { await reader.iterator.return?.(); }
}

// Same producer on local and remote Linux workers. No shell interpolation,
// Git checkout, credentials, complete runtime-home copy, or arbitrary tar paths.
const workerScript = `
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { open, lstat, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const MAX_BYTES = ${MAX_BYTES}, MAX_ENTRIES = ${MAX_ENTRIES}, HEADER_BYTES = ${HEADER_BYTES}, CHUNK_BYTES = ${CHUNK_BYTES};
${limits}
${relativeName}
${linkTarget}
${unchanged}
const frame = ${frame}, stopped = ${stopped};
${checkGitConfig}
${workspaceSnapshot}
try { await pipeline(Readable.from(workspaceSnapshot(process.argv[1], JSON.parse(process.argv[2]))), process.stdout); }
catch (error) { process.stderr.write(String(error.message).slice(0, 2000)); process.exitCode = 1; }
`;

export async function snapshotWorkspace({ executor = null, source, destination, signal, ...options }) {
  const bounded = limits(options);
  if (executor && source !== executor.workspace) throw new Error("Snapshot source must be the selected worker workspace");
  const relative = path.relative(path.resolve(source), path.resolve(destination));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Fork workspace must be outside its source");
  if (!executor) {
    const relative = path.relative(await realpath(source), path.resolve(destination));
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Fork workspace must be outside its source");
    return unpackWorkspaceSnapshot(Readable.from(workspaceSnapshot(source, { ...bounded, signal })), destination, { ...bounded, signal });
  }
  stopped(signal);
  const child = executor.spawn("node", ["--input-type=module", "-e", workerScript, source, JSON.stringify(bounded)], {
    cwd: executor.runtimeHome, env: { HOME: executor.runtimeHome, PATH: executor.environmentPath || process.env.PATH, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  const complete = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(stderr || "Worker workspace snapshot failed")));
  });
  complete.catch(() => {});
  const abort = () => { child.stdout.destroy(signal?.reason || new Error("Workspace snapshot timed out")); void terminateWorker(child).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 300_000);
  async function* verified() { yield* child.stdout; await complete; }
  try { return await unpackWorkspaceSnapshot(verified(), destination, { ...bounded, signal }); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); await terminateWorker(child).catch(() => {}); }
}
