// User-supplied Chrome profiles. A profile is an immutable, versioned snapshot
// of the login state of a Chrome user-data-dir. Chats never write back: each
// chat seeds its own private copy and the copy dies with the chat. Only an
// explicit owner action publishes a new version.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validCompanyId } from "./companies.mjs";

// Only login state is kept. Caches, history, crash data and locks are dropped,
// which turns a ~400 MB profile into a few MB and never copies a stale lock.
export const PROFILE_ALLOWLIST = Object.freeze([
  "Local State", "Last Version",
  "Default/Preferences", "Default/Secure Preferences",
  "Default/Cookies", "Default/Cookies-journal",
  "Default/Login Data", "Default/Login Data-journal",
  "Default/Login Data For Account", "Default/Login Data For Account-journal",
  "Default/Web Data", "Default/Web Data-journal",
  "Default/Local Storage", "Default/Session Storage", "Default/IndexedDB",
  "Default/Local Extension Settings",
]);
export const PROFILE_ARCHIVE_LIMIT = 24 * 1024 * 1024;
const MAX_VERSIONS = 20;
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const allowed = entry => {
  const name = entry.replace(/^\.\//, "").replace(/\/$/, "");
  return name === "" || name === "Default" || PROFILE_ALLOWLIST.some(item => name === item || name.startsWith(`${item}/`));
};

function run(command, args, { input = null, cwd, timeoutMs = 60_000, maxOutput = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const chunks = []; let size = 0, stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(failure(`${command} timed out`, 500)); }, timeoutMs);
    child.stdout.on("data", chunk => { size += chunk.length; if (size > maxOutput) child.kill("SIGKILL"); else chunks.push(chunk); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (size > maxOutput) reject(failure(`${command} output exceeded limit`, 413));
      else if (code === 0) resolve(Buffer.concat(chunks));
      else reject(failure(`${command} failed: ${stderr.trim() || code}`));
    });
    if (input) child.stdin.end(input);
  });
}

// Chrome on Linux prefixes encrypted cookie values with v10 when it uses the
// built-in key (--password-store=basic) and v11 when the key lives in the host
// keyring. Only v10 decrypts on another machine.
async function cookieSummary(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schemes = db.prepare("SELECT substr(encrypted_value, 1, 3) AS scheme, count(*) AS n FROM cookies WHERE length(encrypted_value) > 0 GROUP BY scheme").all()
      .map(row => ({ scheme: Buffer.from(row.scheme).toString("latin1"), count: Number(row.n) }));
    const sites = db.prepare("SELECT host_key AS host, count(*) AS n FROM cookies GROUP BY host_key ORDER BY n DESC LIMIT 200").all()
      .map(row => String(row.host).replace(/^\./, ""));
    return { schemes, sites: [...new Set(sites)].slice(0, 50) };
  } finally { db.close(); }
}

export async function inspectProfileArchive(archive) {
  if (!Buffer.isBuffer(archive) || !archive.length) throw failure("Choose a profile archive (.tar.gz)");
  if (archive.length > PROFILE_ARCHIVE_LIMIT) throw failure("Profile archive is larger than 24 MB. Build it with scripts/import-browser-profile.mjs so caches are excluded.", 413);
  const listing = (await run("tar", ["-tvzf", "-"], { input: archive })).toString("utf8").split("\n").filter(Boolean);
  const entries = [];
  for (const line of listing) {
    const type = line[0], name = line.replace(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/, "");
    if (!["-", "d"].includes(type)) throw failure("Profile archives may only contain regular files and folders");
    if (name.startsWith("/") || name.split("/").includes("..")) throw failure("Profile archive contains an unsafe path");
    if (!allowed(name)) throw failure(`Profile archive contains an unsupported file: ${name}`);
    entries.push(name.replace(/^\.\//, ""));
  }
  if (!entries.some(name => name === "Default/Cookies")) throw failure("Profile archive has no Default/Cookies database");
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-profile-check-"));
  try {
    await run("tar", ["-xzf", "-", "-C", directory, "--no-same-owner", "--no-same-permissions"], { input: archive });
    const { schemes, sites } = await cookieSummary(path.join(directory, "Default", "Cookies"));
    if (schemes.some(item => item.scheme === "v11")) throw failure("These cookies are locked to the original computer's keyring (v11). Sign in again from a chat's Browser panel and choose Save to profile, or export a profile that Chrome ran with --password-store=basic.");
    const chromeVersion = (await readFile(path.join(directory, "Last Version"), "utf8").catch(() => "")).trim();
    return { sites, chromeVersion: /^\d+(\.\d+){3}$/.test(chromeVersion) ? chromeVersion : null, files: entries.length };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Build an archive of the allowlisted files in a local user-data-dir.
export async function buildProfileArchive(directory) {
  const present = [];
  for (const item of PROFILE_ALLOWLIST) if (await stat(path.join(directory, item)).then(() => true, () => false)) present.push(item);
  if (!present.includes("Default/Cookies")) throw failure(`${directory} is not a Chrome user-data-dir (Default/Cookies is missing)`);
  return run("tar", ["-czf", "-", "--", ...present], { cwd: directory, maxOutput: PROFILE_ARCHIVE_LIMIT });
}

export const chromeMajor = version => Number(/^(\d+)\./.exec(version || "")?.[1]) || 0;

function publicProfile(profile) {
  const current = profile.versions.at(-1) || null;
  return { id: profile.id, name: profile.name, companyId: profile.companyId, createdAt: profile.createdAt, updatedAt: profile.updatedAt,
    currentVersion: current?.version || 0, sites: current?.sites || [], chromeVersion: current?.chromeVersion || null,
    versions: profile.versions.map(({ version, bytes, sha256, chromeVersion, sites, source, createdAt }) => ({ version, bytes, sha256, chromeVersion, sites, source, createdAt })) };
}

export class BrowserProfiles {
  constructor(records, { companies = null } = {}) { this.records = records; this.companies = companies; this.queue = Promise.resolve(); }
  serial(operation) { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  async list(companyId) {
    return (await this.records.list("browser-profile")).filter(profile => companyId === undefined || profile.companyId === companyId)
      .sort((a, b) => a.name.localeCompare(b.name)).map(publicProfile);
  }
  async owned(id) {
    if (!/^bprof_[a-f0-9-]{36}$/.test(id || "")) throw failure("Browser profile not found", 404);
    const profile = await this.records.get("browser-profile", id);
    if (!profile) throw failure("Browser profile not found", 404);
    return profile;
  }
  async get(id) { return publicProfile(await this.owned(id)); }
  create(input) {
    return this.serial(async () => {
      const name = String(input.name || "").trim();
      if (!name || name.length > 80) throw failure("Profile name must contain 1–80 characters");
      if (!validCompanyId(input.companyId)) throw failure("Choose the company this profile belongs to");
      await this.companies?.get(input.companyId);
      const all = await this.records.list("browser-profile");
      if (all.length >= 50) throw failure("Keep at most 50 browser profiles");
      if (all.some(profile => profile.companyId === input.companyId && profile.name.toLowerCase() === name.toLowerCase())) throw failure("A browser profile with this name already exists in this company");
      const now = new Date().toISOString();
      const profile = { id: `bprof_${randomUUID()}`, name, companyId: input.companyId, versions: [], createdAt: now, updatedAt: now };
      await this.records.put("browser-profile", profile.id, profile);
      return publicProfile(profile);
    });
  }
  addVersion(id, archive, { source = "upload" } = {}) {
    return this.serial(async () => {
      const profile = await this.owned(id);
      const details = await inspectProfileArchive(archive);
      const version = (profile.versions.at(-1)?.version || 0) + 1;
      await this.records.put("browser-profile-archive", `${id}.v${version}`, { data: archive.toString("base64") });
      const entry = { version, bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex"), ...details, source, createdAt: new Date().toISOString() };
      const versions = [...profile.versions, entry];
      for (const old of versions.splice(0, Math.max(0, versions.length - MAX_VERSIONS))) await this.records.delete("browser-profile-archive", `${id}.v${old.version}`);
      const value = { ...profile, versions, updatedAt: entry.createdAt };
      await this.records.put("browser-profile", id, value);
      return publicProfile(value);
    });
  }
  async archive(id, version) {
    const profile = await this.owned(id);
    const entry = profile.versions.find(item => item.version === version);
    const stored = entry && await this.records.get("browser-profile-archive", `${id}.v${version}`);
    if (!stored) throw failure("Browser profile version not found", 404);
    const archive = Buffer.from(stored.data, "base64");
    if (createHash("sha256").update(archive).digest("hex") !== entry.sha256) throw failure("Browser profile archive failed its integrity check", 500);
    return archive;
  }
  remove(id, environments = []) {
    return this.serial(async () => {
      const profile = await this.owned(id);
      const using = environments.filter(environment => environment.browserProfileId === id);
      if (using.length) throw failure(`This profile is used by ${using.map(environment => `“${environment.name}”`).join(", ")}. Remove it from those environments first.`, 409);
      for (const entry of profile.versions) await this.records.delete("browser-profile-archive", `${id}.v${entry.version}`);
      await this.records.delete("browser-profile", id);
    });
  }
}
