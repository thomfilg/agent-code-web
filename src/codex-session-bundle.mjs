import { constants } from "node:fs";
import { open, mkdir, lstat, writeFile, link, unlink, realpath, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as zlib from "node:zlib";
import { terminateWorker } from "./worker-process.mjs";

export const MAX_SESSION_BYTES = 128 * 1024 * 1024;
const MAX_LINEAGE = 64;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validId = id => { if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid native session ID"); return id; };

export async function readSessionBytes(filename, boundary = null) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || !/\.jsonl(?:\.zst)?$/.test(filename)) throw new Error("Unsupported native session file");
  if (boundary !== null && (!Number.isSafeInteger(boundary) || boundary <= 0 || boundary > MAX_SESSION_BYTES)) throw new Error("Invalid native session byte boundary");
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    const compressed = filename.endsWith(".zst"), limit = compressed || boundary === null ? stat.size : boundary;
    if (!stat.isFile() || limit > MAX_SESSION_BYTES) throw new Error("Native session file exceeds the transfer limit");
    let bytes = Buffer.alloc(limit), read = 0;
    while (read < limit) { const result = await file.read(bytes, read, limit - read, read); if (!result.bytesRead) throw new Error("Native session source is shorter than its boundary"); read += result.bytesRead; }
    if (filename.endsWith(".zst")) {
      if (!zlib.zstdDecompressSync) throw new Error("This Node version cannot transfer compressed Codex sessions");
      bytes = zlib.zstdDecompressSync(bytes, { maxOutputLength: MAX_SESSION_BYTES });
    }
    if (bytes.length > MAX_SESSION_BYTES) throw new Error("Native session file exceeds the transfer limit");
    if (boundary !== null && bytes.length < boundary) throw new Error("Native session source is shorter than its boundary");
    return boundary === null ? bytes : bytes.subarray(0, boundary);
  } finally { await file.close(); }
}

export async function readScopedSessionBytes(home, filename, boundary = null) {
  if (typeof home !== "string" || !path.isAbsolute(home) || path.resolve(home) === path.parse(home).root
    || await realpath(home) !== path.resolve(home)) throw new Error("Native checkpoint requires a private profile");
  const actual = await realpath(filename);
  if (actual !== path.resolve(filename) || !["sessions", "archived"].some(folder => actual.startsWith(`${path.resolve(home)}/${folder}/`))) throw new Error("Native history is outside the selected private profile");
  const bytes = await readSessionBytes(filename, boundary);
  // A writer may be appending its next JSON record. Only a complete native
  // prefix is eligible; its incomplete suffix is not a durable checkpoint.
  if (boundary !== null) return bytes;
  const end = bytes.lastIndexOf(10);
  if (end < 0) throw new Error("Native history has no complete records");
  return bytes.subarray(0, end + 1);
}

function inspectFile(bytes, id) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_SESSION_BYTES || bytes.at(-1) !== 10) throw new Error("Native session snapshot is incomplete or too large");
  if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error("Native session contains invalid UTF-8");
  const first = bytes.indexOf(10);
  let header;
  try { header = JSON.parse(bytes.subarray(0, first).toString("utf8")); }
  catch { throw new Error("Invalid native session header"); }
  if (header.type !== "session_meta" || header.payload?.id !== validId(id)) throw new Error("Native session identity does not match its requested thread");
  const meta = header.payload;
  if (meta.history_mode && !["paginated", "legacy"].includes(meta.history_mode)) throw new Error("Unsupported native session history mode");
  if (!Number.isFinite(Date.parse(meta.timestamp))) throw new Error("Invalid native session timestamp");
  // Parse every complete record: UTF-8 character counts cannot be substituted
  // for the byte offsets in paginated history_base records.
  for (const line of bytes.toString("utf8").trimEnd().split("\n")) {
    try { const record = JSON.parse(line); if (!record || typeof record.type !== "string") throw new Error(); }
    catch { throw new Error("Native session contains an invalid record"); }
  }
  const base = meta.history_base;
  if (base != null) {
    validId(base.thread_id);
    if (base.thread_id === id || meta.forked_from_id !== base.thread_id || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset <= 0 || base.end_byte_offset > MAX_SESSION_BYTES || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive < 0 || meta.forked_from_ordinal_exclusive !== base.end_ordinal_exclusive) throw new Error("Invalid native session lineage boundary");
  } else if (meta.history_mode === "paginated" && meta.forked_from_id && meta.forked_from_ordinal_exclusive > 0) {
    throw new Error("Paginated native fork is missing its lineage boundary");
  }
  return { meta, base };
}

export function validateSessionBundle(bundle, threadId = bundle?.threadId) {
  validId(threadId);
  if (bundle?.version !== 1 || bundle.threadId !== threadId || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > MAX_LINEAGE) throw new Error("Invalid native session bundle");
  const files = new Map(); let total = 0;
  for (const entry of bundle.files) {
    validId(entry.id);
    if (files.has(entry.id) || typeof entry.data !== "string" || entry.data.length > Math.ceil(MAX_SESSION_BYTES / 3) * 4) throw new Error("Invalid native session bundle entry");
    const bytes = Buffer.from(entry.data, "base64"); total += bytes.length;
    if (bytes.toString("base64") !== entry.data) throw new Error("Invalid native session encoding");
    if (total > MAX_SESSION_BYTES) throw new Error("Native session bundle exceeds the transfer limit");
    files.set(entry.id, { bytes, ...inspectFile(bytes, entry.id) });
  }
  const seen = new Set(); let id = threadId;
  while (id) {
    if (seen.has(id)) throw new Error("Native session lineage is cyclic");
    seen.add(id);
    const file = files.get(id);
    if (!file) throw new Error("Native session bundle is missing a source thread");
    if (file.base) {
      const source = files.get(file.base.thread_id);
      if (!source || source.bytes.length !== file.base.end_byte_offset) throw new Error("Source history must end at the exact fork boundary");
    }
    id = file.base?.thread_id;
  }
  if (seen.size !== files.size) throw new Error("Native session bundle contains unrelated threads");
  if (bundle.goal != null && (bundle.goal.threadId !== threadId || typeof bundle.goal.objective !== "string" || !bundle.goal.objective.trim() || bundle.goal.objective.length > 4000 || !["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(bundle.goal.status))) throw new Error("Invalid native fork goal");
  if (bundle.goal?.tokenBudget != null && (!Number.isSafeInteger(bundle.goal.tokenBudget) || bundle.goal.tokenBudget <= 0)) throw new Error("Invalid native fork goal budget");
  return files;
}

// readThread is the owning adapter's read-only native RPC. No request-supplied
// paths or broad copies of CODEX_HOME are accepted. Only history_base ancestors
// are visited, clipped to the frozen byte boundary recorded by native fork.
export async function captureSessionBundle({ threadId, readThread, readBytes = readSessionBytes, goal = null }) {
  validId(threadId);
  const bundle = { version: 1, threadId, goal, files: [] };
  const visited = new Set(); let id = threadId, boundary = null, total = 0;
  while (id) {
    if (visited.has(id) || visited.size >= MAX_LINEAGE) throw new Error("Native fork lineage is cyclic or too deep");
    visited.add(id);
    const thread = await readThread(id);
    if (thread?.id !== id || typeof thread.path !== "string" || thread.ephemeral) throw new Error("Native fork source is unavailable or temporary");
    const source = await readBytes(thread.path, boundary);
    if (!Buffer.isBuffer(source) || (boundary !== null && source.length < boundary)) throw new Error("Native fork source is shorter than its recorded boundary");
    const bytes = boundary === null ? source : source.subarray(0, boundary);
    total += bytes.length;
    if (total > MAX_SESSION_BYTES) throw new Error("Native session bundle exceeds the transfer limit");
    const { base } = inspectFile(bytes, id);
    bundle.files.push({ id, data: bytes.toString("base64") });
    id = base?.thread_id; boundary = base?.end_byte_offset ?? null;
  }
  validateSessionBundle(bundle);
  return bundle;
}

// Install only into a private worker profile. Existing files are never replaced:
// a retry may accept an exact prefix, including a thread already continued there.
// Credentials, settings, plugins and host account databases are not copied.
export async function installSessionBundle(codexHome, bundle) {
  const files = validateSessionBundle(bundle);
  if (typeof codexHome !== "string" || !path.isAbsolute(codexHome) || path.resolve(codexHome) === path.parse(codexHome).root) throw new Error("Choose a private Codex profile directory");
  let directory = codexHome;
  for (const part of ["", "sessions", "relay-forks", bundle.threadId]) {
    directory = part ? path.join(directory, part) : directory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Native session destination must be a private directory, not a symlink");
  }
  let rootPath;
  for (const [id, file] of files) {
    const timestamp = new Date(file.meta.timestamp).toISOString().slice(0, 19).replaceAll(":", "-");
    const filename = path.join(directory, `rollout-${timestamp}-${id}.jsonl`);
    if (id === bundle.threadId) rootPath = filename;
    const temporary = path.join(directory, `.import-${randomUUID()}`);
    try {
      await writeFile(temporary, file.bytes, { flag: "wx", mode: 0o600 });
      try { await link(temporary, filename); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await readSessionBytes(filename);
        if (existing.length < file.bytes.length || !existing.subarray(0, file.bytes.length).equals(file.bytes)) throw new Error("Refusing to replace an existing native session");
      }
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  return rootPath;
}

export async function restoreSessionBundleIfFresh(home, bundle) {
  validateSessionBundle(bundle);
  if (typeof home !== "string" || !path.isAbsolute(home) || path.resolve(home) === path.parse(home).root
    || await realpath(home) !== path.resolve(home)) throw new Error("Native restore requires a private profile");
  const stat = await lstat(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Native restore requires a private profile");
  // Never seed alongside an original/continued rollout with the same UUID.
  // A surviving profile resumes its native file; only an empty replacement
  // profile is eligible for restoration from the controller checkpoint.
  if ((await readdir(home)).length) return { restored: false };
  return { restored: true, path: await installSessionBundle(home, bundle) };
}

// The same validated file operations run in an EC2 worker without SSHing its
// credentials or an entire home directory back to the controller.
const workerScript = `
import { constants } from "node:fs";
import { open, mkdir, lstat, writeFile, link, unlink, realpath, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as zlib from "node:zlib";
const MAX_SESSION_BYTES = ${MAX_SESSION_BYTES}, MAX_LINEAGE = ${MAX_LINEAGE};
const UUID = ${UUID}; const validId = ${validId};
${readSessionBytes}
${readScopedSessionBytes}
${inspectFile}
${validateSessionBundle}
${installSessionBundle}
${restoreSessionBundleIfFresh}
try {
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; if (length > MAX_SESSION_BYTES * 1.4 + 65536) throw new Error("Native transfer input exceeds its limit"); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (input.action === "read") process.stdout.write(JSON.stringify({ data: (await readSessionBytes(input.path, input.boundary ?? null)).toString("base64") }));
  else if (input.action === "readScoped") process.stdout.write(JSON.stringify({ data: (await readScopedSessionBytes(input.home, input.path, input.boundary ?? null)).toString("base64") }));
  else if (input.action === "install") process.stdout.write(JSON.stringify({ path: await installSessionBundle(input.home, input.bundle) }));
  else if (input.action === "restoreFresh") process.stdout.write(JSON.stringify(await restoreSessionBundleIfFresh(input.home, input.bundle)));
  else throw new Error("Unknown native transfer operation");
} catch (error) { process.stderr.write(String(error.message).slice(0, 2000)); process.exitCode = 1; }
`;

export async function workerSessionIO(executor, input) {
  if (!["read", "readScoped", "install", "restoreFresh"].includes(input?.action)) throw new Error("Unknown native transfer operation");
  if (["install", "restoreFresh"].includes(input.action)) validateSessionBundle(input.bundle);
  if (!executor) {
    if (input.action === "restoreFresh") return restoreSessionBundleIfFresh(input.home, input.bundle);
    if (input.action === "install") return { path: await installSessionBundle(input.home, input.bundle) };
    return { data: (input.action === "readScoped" ? await readScopedSessionBytes(input.home, input.path, input.boundary ?? null)
      : await readSessionBytes(input.path, input.boundary ?? null)).toString("base64") };
  }
  return new Promise((resolve, reject) => {
    const child = executor.spawn("node", ["--input-type=module", "-e", workerScript], {
      cwd: executor.runtimeHome, env: { HOME: executor.runtimeHome, PATH: executor.environmentPath || process.env.PATH, LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = []; let length = 0, stderr = "", done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const abort = error => { void terminateWorker(child).catch(() => {}); finish(error); };
    const timer = setTimeout(() => abort(new Error("Native session transfer timed out")), 60000);
    child.stdout.on("data", chunk => { length += chunk.length; if (length > MAX_SESSION_BYTES * 1.4 + 65536) abort(new Error("Native transfer output exceeds its limit")); else if (!done) chunks.push(chunk); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", error => finish(error)); child.stdin.on("error", error => abort(error));
    child.once("close", code => {
      if (done) return;
      if (code !== 0) return finish(new Error(stderr || "Native session transfer failed"));
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { finish(new Error("Invalid native session transfer response")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
