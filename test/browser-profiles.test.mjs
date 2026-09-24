import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, stat, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryRecords } from "../src/database.mjs";
import { Companies } from "../src/companies.mjs";
import { Environments } from "../src/environments.mjs";
import { BrowserProfiles, buildProfileArchive, inspectProfileArchive } from "../src/browser-profiles.mjs";
import { SharedBrowsers, chatProfileDirectory } from "../src/shared-browser.mjs";
import { prepareChrome } from "../src/chrome-software.mjs";
import { spawnWorker } from "../src/worker-process.mjs";
import { temporaryDirectory } from "./helpers.mjs";

// A minimal Chrome user-data-dir: fake cookies only, never a real profile.
// Chrome stores cookie expiry as microseconds since 1601-01-01.
const chromeTime = date => BigInt(Date.parse(date)) * 1000n + 11644473600000000n;
async function fakeProfile(t, { scheme = "v10", extra = null, version = "153.0.8010.12", cookies = null } = {}) {
  const directory = await temporaryDirectory(t, "relay-fake-profile-");
  await mkdir(path.join(directory, "Default", "Local Storage", "leveldb"), { recursive: true });
  const db = new DatabaseSync(path.join(directory, "Default", "Cookies"));
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, expires_utc INTEGER, has_expires INTEGER, is_persistent INTEGER)");
  const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?)");
  for (const [host, name, expires] of cookies || [[".clickup.com", "sid"], [".clickup.com", "sid"], ["app.clickup.com", "sid"], [".example.test", "sid"]]) {
    insert.run(host, name, Buffer.from(`${scheme}fixture`), expires ? chromeTime(expires) : 0n, expires ? 1 : 0, expires ? 1 : 0);
  }
  db.close();
  await writeFile(path.join(directory, "Default", "Local Storage", "leveldb", "000001.log"), "fixture");
  await writeFile(path.join(directory, "Default", "Preferences"), "{}");
  await writeFile(path.join(directory, "Local State"), "{}");
  await writeFile(path.join(directory, "Last Version"), version);
  // Never archived: caches, locks and history are outside the allowlist.
  await mkdir(path.join(directory, "Default", "Cache"), { recursive: true });
  await writeFile(path.join(directory, "Default", "Cache", "data_0"), "cache");
  await writeFile(path.join(directory, "Default", "History"), "history");
  await writeFile(path.join(directory, "SingletonLock"), "lock");
  if (extra) await extra(directory);
  return directory;
}
const tarList = archive => spawnSync("tar", ["-tzf", "-"], { input: archive }).stdout.toString().split("\n").filter(Boolean);
const tarOf = (cwd, ...names) => spawnSync("tar", ["-czf", "-", ...names], { cwd }).stdout;

async function services() {
  const records = new MemoryRecords(), companies = new Companies(records);
  await companies.save({ id: "g2i", name: "G2i" }); await companies.save({ id: "acme", name: "Acme" });
  return { records, companies, profiles: new BrowserProfiles(records, { companies }), environments: new Environments(records) };
}

test("profile archives keep only login state and pass inspection", async t => {
  const directory = await fakeProfile(t);
  const archive = await buildProfileArchive(directory);
  const names = tarList(archive);
  assert.ok(names.includes("Default/Cookies"));
  assert.ok(names.some(name => name.startsWith("Default/Local Storage/")));
  assert.ok(!names.some(name => /Cache|History|Singleton/.test(name)), names.join(","));
  const details = await inspectProfileArchive(archive);
  assert.equal(details.chromeVersion, "153.0.8010.12");
  assert.deepEqual(details.sites.slice(0, 2), ["clickup.com", "app.clickup.com"]);
});

test("keyring-bound, unsafe or unexpected archives are rejected", async t => {
  await assert.rejects(inspectProfileArchive(await buildProfileArchive(await fakeProfile(t, { scheme: "v11" }))), /keyring \(v11\)/);
  const withHistory = await fakeProfile(t);
  await assert.rejects(inspectProfileArchive(tarOf(withHistory, "Default/Cookies", "Default/History")), /unsupported file: Default\/History/);
  const withLink = await fakeProfile(t, { extra: directory => symlink("/etc/passwd", path.join(directory, "Default", "Login Data")) });
  await assert.rejects(inspectProfileArchive(tarOf(withLink, "Default/Cookies", "Default/Login Data")), /regular files and folders/);
  await assert.rejects(inspectProfileArchive(tarOf(withHistory, "Default/Preferences")), /no Default\/Cookies/);
  await assert.rejects(inspectProfileArchive(Buffer.alloc(0)), /Choose a profile archive/);
});

test("profiles are company scoped, versioned, integrity checked and protected while in use", async t => {
  const { records, profiles, environments } = await services();
  await assert.rejects(profiles.create({ name: "No company" }), /Choose the company/);
  const profile = await profiles.create({ name: "ClickUp sandbox", companyId: "g2i" });
  await assert.rejects(profiles.create({ name: "clickup SANDBOX", companyId: "g2i" }), /already exists/);
  const archive = await buildProfileArchive(await fakeProfile(t));
  const v1 = await profiles.addVersion(profile.id, archive);
  const v2 = await profiles.addVersion(profile.id, archive, { source: "chat" });
  assert.equal(v1.currentVersion, 1); assert.equal(v2.currentVersion, 2);
  assert.deepEqual(v2.versions.map(v => v.source), ["upload", "chat"]);
  assert.deepEqual(await profiles.archive(profile.id, 1), archive);
  const stored = await records.get("browser-profile-archive", `${profile.id}.v2`);
  await records.put("browser-profile-archive", `${profile.id}.v2`, { data: Buffer.from("tampered").toString("base64") });
  await assert.rejects(profiles.archive(profile.id, 2), /integrity/);
  await records.put("browser-profile-archive", `${profile.id}.v2`, stored);
  assert.deepEqual((await profiles.list("acme")), []);
  assert.equal((await profiles.list("g2i")).length, 1);

  await assert.rejects(environments.save({ name: "Wrong company", backend: "local", companyId: "acme", browserProfileId: profile.id }), /belongs to this environment's company/);
  await assert.rejects(environments.save({ name: "Missing", backend: "local", companyId: "g2i", browserProfileId: "bprof_00000000-0000-0000-0000-000000000000" }), /not found/);
  const environment = await environments.save({ name: "Sandbox", backend: "local", companyId: "g2i", browserProfileId: profile.id });
  assert.equal(environment.browserProfileId, profile.id);
  assert.equal((await environments.runtime(environment.id, { repositories: [{ fullName: "g2i/app", companyId: "g2i" }] })).browserProfileId, profile.id);
  await assert.rejects(profiles.remove(profile.id, await environments.list()), /used by “Sandbox”/);
  await environments.save({ ...environment, browserProfileId: null }, environment.id);
  await profiles.remove(profile.id, await environments.list());
  assert.equal(await records.get("browser-profile-archive", `${profile.id}.v1`), null);
});

// Real worker commands on the local backend: seed, pin, restart, capture.
test("each chat seeds one private pinned copy and only an explicit capture reads it back", async t => {
  const root = await temporaryDirectory(t, "relay-chat-");
  for (const chatId of ["chat-a", "chat-b", "chat-c", "x"]) await mkdir(path.join(root, chatId, "runtime-home"), { recursive: true });
  const executorFor = chatId => ({ runtimeHome: path.join(root, chatId, "runtime-home"), workspace: root, spawn: (command, args, options) => spawnWorker(command, args, { ...options, isolation: "none" }) });
  const { profiles } = await services();
  const profile = await profiles.create({ name: "ClickUp", companyId: "g2i" });
  await profiles.addVersion(profile.id, await buildProfileArchive(await fakeProfile(t)));
  let archiveReads = 0;
  const browsers = new SharedBrowsers({ store: { get: () => ({}) }, config: {}, acquire: async chatId => executorFor(chatId), profiles: {
    resolve: async () => { const current = await profiles.get(profile.id); return { id: current.id, name: current.name, version: current.currentVersion, chromeVersion: current.chromeVersion }; },
    archive: async (chatId, id, version) => { archiveReads++; return profiles.archive(id, version); },
  } });

  const first = await browsers.prepareProfile("chat-a", executorFor("chat-a"));
  assert.equal(first.version, 1); assert.equal(first.directory, chatProfileDirectory(executorFor("chat-a")));
  const cookies = path.join(first.directory, "Default", "Cookies");
  assert.ok((await stat(cookies)).isFile());
  // The chat copy changes (the agent logs in somewhere else) and a v2 is published.
  await writeFile(path.join(first.directory, "Default", "Preferences"), '{"changed":true}');
  await profiles.addVersion(profile.id, await buildProfileArchive(await fakeProfile(t)));
  const restarted = await browsers.prepareProfile("chat-a", executorFor("chat-a"));
  assert.equal(restarted.version, 1, "an existing chat keeps its pinned copy");
  assert.equal(await readFile(path.join(first.directory, "Default", "Preferences"), "utf8"), '{"changed":true}');
  assert.equal(archiveReads, 1);

  const other = await browsers.prepareProfile("chat-b", executorFor("chat-b"));
  assert.equal(other.version, 2, "a new chat gets the current version");
  assert.equal(await readFile(path.join(other.directory, "Default", "Preferences"), "utf8"), "{}", "chats never share a copy");

  const captured = await browsers.captureProfile("chat-a");
  assert.equal(captured.profileId, profile.id);
  const saved = await profiles.addVersion(profile.id, captured.archive, { source: "chat" });
  assert.equal(saved.currentVersion, 3);
  assert.ok(!tarList(captured.archive).some(name => name.includes("relay-profile")), "the chat marker is never published");
  await assert.rejects(browsers.captureProfile("chat-c"), /does not use a saved profile/);
  assert.equal(await new SharedBrowsers({ store: {}, config: {}, acquire: async () => executorFor("x") }).prepareProfile("x", executorFor("x")), null);
});

test("an old image Chrome is replaced by the current stable build for newer profiles", async () => {
  const calls = [];
  const executor = { runtimeHome: "/home/agent", workspace: "/work", mkdir: async () => {} };
  const capture = async (_executor, command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "/bin/sh" && args[1].startsWith("command -v")) return "/usr/bin/google-chrome\n";
    if (command === "/usr/bin/google-chrome") return "Google Chrome 150.0.7000.1";
    if (command === "/bin/sh") return "";
    if (command === "npm") return "chrome@154.0.8037.57 /home/agent/shared-chrome/cache/chrome/linux-154/chrome";
    if (command.endsWith("/chrome")) return "Google Chrome for Testing 154.0.8037.57";
    return "";
  };
  assert.equal(await prepareChrome(executor, capture, () => {}, "google-chrome", { minimumMajor: 150 }), "/usr/bin/google-chrome");
  assert.ok(!calls.some(call => call.startsWith("npm")));
  assert.equal(await prepareChrome(executor, capture, () => {}, "google-chrome", { minimumMajor: 153 }), "/home/agent/shared-chrome/google-chrome");
  assert.ok(calls.some(call => call.includes("browsers install chrome@stable")));
  assert.equal(await prepareChrome(executor, capture), "/usr/bin/google-chrome", "no profile keeps the image Chrome");
});

test("Chrome's own UI pages are never offered or selected as tabs", async () => {
  const { ChromeBrowser } = await import("../src/browser-worker.mjs");
  const browser = new ChromeBrowser();
  browser.call = async () => ({ targetInfos: [
    { type: "page", targetId: "popup", title: "", url: "chrome://omnibox-popup.top-chrome/" },
    { type: "page", targetId: "aim", title: "", url: "chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html" },
    { type: "background_page", targetId: "extension", title: "", url: "chrome-extension://id/background.html" },
    { type: "page", targetId: "tab", title: "Blank", url: "about:blank" },
    { type: "page", targetId: "settings", title: "Settings", url: "chrome://settings/" },
  ] });
  assert.deepEqual((await browser.tabs()).map(tab => tab.id), ["tab", "settings"]);
});

test("each site's sign-in lifetime comes from its longest-lived login cookie", async t => {
  const { loginState } = await import("../public/browser-profile-sessions.js");
  const archive = await buildProfileArchive(await fakeProfile(t, { cookies: [
    [".app.clickup.com", "cu_jwt", "2026-09-20T00:00:00Z"],          // short access token
    [".app.clickup.com", "cu_refresh", "2027-09-18T00:00:00Z"],      // the refresh token decides
    [".clickup.com", "_ga", "2030-01-01T00:00:00Z"],                 // analytics is ignored
    ["github.com", "logged_in", "2026-10-01T00:00:00Z"],
    ["accounts.google.co.uk", "__Secure-3PSID", "2026-09-01T00:00:00Z"],
    ["accounts.google.co.uk", "__Host-GAPS", "2030-01-01T00:00:00Z"],          // set even when signed out
    [".linear.app", "session"],                                      // session-only cookie
    ["localhost", "session_token", "2030-01-01T00:00:00Z"],          // development noise
  ] }));
  const { sessions } = await inspectProfileArchive(archive);
  const bySite = Object.fromEntries(sessions.map(session => [session.site, session]));
  assert.deepEqual(Object.keys(bySite).sort(), ["clickup.com", "github.com", "google.co.uk", "linear.app"]);
  assert.equal(bySite["clickup.com"].cookie, "cu_refresh");
  assert.equal(bySite["clickup.com"].expiresAt, "2027-09-18T00:00:00.000Z");
  assert.equal(bySite["linear.app"].sessionOnly, true);
  const now = Date.parse("2026-09-25T00:00:00Z");
  assert.equal(loginState(bySite["clickup.com"], now).level, "valid");
  assert.equal(loginState(bySite["github.com"], now).level, "expiring");
  assert.equal(loginState(bySite["google.co.uk"], now).level, "expired");
  assert.equal(loginState(bySite["linear.app"], now).level, "expired");
});

test("versions saved before sign-in lifetimes existed are inspected once and persisted", async t => {
  const { records, profiles } = await services();
  const profile = await profiles.create({ name: "Legacy", companyId: "g2i" });
  await profiles.addVersion(profile.id, await buildProfileArchive(await fakeProfile(t, { cookies: [[".clickup.com", "cu_refresh", "2027-09-18T00:00:00Z"]] })));
  const stored = await records.get("browser-profile", profile.id);
  delete stored.versions[0].sessions; await records.put("browser-profile", profile.id, stored);
  const listed = await profiles.list("g2i");
  assert.equal(listed[0].sessions[0].site, "clickup.com");
  assert.equal((await records.get("browser-profile", profile.id)).versions[0].sessions[0].cookie, "cu_refresh");
});
