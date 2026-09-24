import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryRecords } from "../src/database.mjs";
import { Companies } from "../src/companies.mjs";
import { BrowserProfiles, buildProfileArchive } from "../src/browser-profiles.mjs";
import { BrowserProfileRefresher, compareRefresh, refreshTargets, REFRESH_SYSTEM_KIND } from "../src/browser-profile-refresh.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const chromeTime = date => BigInt(Date.parse(date)) * 1000n + 11644473600000000n;
async function archiveWith(t, cookies) {
  const directory = await temporaryDirectory(t, "relay-refresh-profile-");
  await mkdir(path.join(directory, "Default"), { recursive: true });
  const db = new DatabaseSync(path.join(directory, "Default", "Cookies"));
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, expires_utc INTEGER, has_expires INTEGER, is_persistent INTEGER)");
  for (const [host, name, expires] of cookies) db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, 1, 1)").run(host, name, Buffer.from("v10fixture"), chromeTime(expires));
  db.close();
  await writeFile(path.join(directory, "Last Version"), "154.0.8037.57");
  return buildProfileArchive(directory);
}
const googleBefore = [[".google.com", "__Secure-1PSIDTS", "2026-09-28T00:00:00Z"], [".app.clickup.com", "cu_refresh", "2027-09-18T00:00:00Z"]];

async function setup(t, { captured, account = { id: "account_1", ownerId: "owner", provider: "codex", status: "connected" } } = {}) {
  const records = new MemoryRecords(), companies = new Companies(records);
  await companies.save({ id: "g2i", name: "G2i" });
  const profiles = new BrowserProfiles(records, { companies });
  const profile = await profiles.create({ name: "Work", companyId: "g2i" });
  await profiles.addVersion(profile.id, await archiveWith(t, googleBefore));
  const chats = new Map(), calls = [];
  const store = {
    async create(input) { const chat = { id: `chat_${chats.size + 1}`, workspace: await temporaryDirectory(t, "relay-refresh-workspace-"), ...input }; chats.set(chat.id, chat); return chat; },
    async update(id, patch) { Object.assign(chats.get(id), patch); return chats.get(id); },
  };
  const manager = {
    browsers: {
      ensure: async id => { calls.push(["ensure", chats.get(id).system]); },
      command: async (id, action, params) => { calls.push([action, params.url]); },
      captureProfile: async () => ({ profileId: profile.id, archive: await captured() }),
    },
    remove: async id => { calls.push(["remove", id]); chats.delete(id); },
  };
  const refresher = new BrowserProfileRefresher({ store, manager, resources: { forOwner: async () => ({ browserProfiles: profiles }) },
    agentAccounts: { metadata: new Map(account ? [[account.id, account]] : []) }, settleMs: 0, now: () => NOW, log: { error() {} } });
  return { profiles, profile, refresher, calls, chats };
}

test("renewal targets only live sign-ins and publishes only when none was lost", () => {
  const before = [
    { site: "google.com", host: "google.com", expiresAt: "2026-09-28T00:00:00Z" },
    { site: "clickup.com", host: "app.clickup.com", expiresAt: "2027-09-18T00:00:00Z" },
    { site: "old.example", expiresAt: "2026-01-01T00:00:00Z" },
    { site: "linear.app", sessionOnly: true },
  ];
  assert.deepEqual(refreshTargets({ sessions: before }).map(target => target.url), ["https://google.com/", "https://app.clickup.com/"]);
  const renewed = compareRefresh(before, [{ site: "google.com", expiresAt: "2026-10-25T00:00:00Z" }, { site: "clickup.com", expiresAt: "2027-09-18T00:00:00Z" }], NOW);
  assert.deepEqual(renewed, { lost: [], renewed: ["google.com"], publish: true });
  const lost = compareRefresh(before, [{ site: "clickup.com", expiresAt: "2027-09-18T00:00:00Z" }], NOW);
  assert.deepEqual(lost.lost, ["google.com"]); assert.equal(lost.publish, false);
});

test("a renewal visits each signed-in site on a hidden system chat and saves the renewed cookies", async t => {
  const renewedCookies = [[".google.com", "__Secure-1PSIDTS", "2026-10-25T00:00:00Z"], [".app.clickup.com", "cu_refresh", "2027-09-18T00:00:00Z"]];
  const { profiles, profile, refresher, calls, chats } = await setup(t, { captured: () => archiveWith(t, renewedCookies) });
  const outcome = await refresher.refresh("owner", profile.id);
  assert.equal(outcome.status, "renewed"); assert.deepEqual(outcome.renewed, ["google.com"]);
  const saved = await profiles.get(profile.id);
  assert.equal(saved.currentVersion, 2); assert.equal(saved.versions.at(-1).source, "refresh");
  assert.equal(saved.refresh.status, "renewed");
  assert.deepEqual(calls[0], ["ensure", { kind: REFRESH_SYSTEM_KIND, profileId: profile.id, version: 1 }]);
  assert.deepEqual(calls.filter(call => call[0] === "navigate").map(call => call[1]), ["https://google.com/", "https://app.clickup.com/"]);
  assert.equal(calls.at(-1)[0], "remove", "the system chat and its worker are always deleted");
  assert.equal(chats.size, 0);
});

test("a lost sign-in keeps the saved version and asks for a new sign-in", async t => {
  const { profiles, profile, refresher, calls } = await setup(t, { captured: () => archiveWith(t, [[".app.clickup.com", "cu_refresh", "2027-09-18T00:00:00Z"]]) });
  const outcome = await refresher.refresh("owner", profile.id);
  assert.equal(outcome.status, "needs-sign-in"); assert.deepEqual(outcome.lost, ["google.com"]);
  assert.equal((await profiles.get(profile.id)).currentVersion, 1);
  assert.equal(calls.at(-1)[0], "remove");
});

test("renewal needs an agent account, never overwrites a newer version, and runs once per profile", async t => {
  const noAccount = await setup(t, { account: null, captured: () => { throw new Error("must not capture"); } });
  assert.equal((await noAccount.refresher.refresh("owner", noAccount.profile.id)).status, "failed");
  assert.equal(noAccount.calls.length, 0, "no worker without an account");

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const racing = await setup(t, { captured: async () => { await gate; return archiveWith(t, googleBefore.map(([host, name]) => [host, name, "2027-12-01T00:00:00Z"])); } });
  const first = racing.refresher.refresh("owner", racing.profile.id);
  assert.equal(racing.refresher.refresh("owner", racing.profile.id), first, "concurrent requests share one renewal");
  await new Promise(resolve => setTimeout(resolve, 50));
  await racing.profiles.addVersion(racing.profile.id, await archiveWith(t, googleBefore), { source: "chat" });
  release();
  assert.equal((await first).status, "skipped");
  assert.equal((await racing.profiles.get(racing.profile.id)).versions.at(-1).source, "chat");
});

test("the schedule picks profiles whose last version or renewal is older than the interval", async t => {
  const { profiles, profile, refresher } = await setup(t, { captured: () => archiveWith(t, googleBefore) });
  refresher.intervalMs = 24 * 3600000;
  const createdAt = Date.parse((await profiles.get(profile.id)).versions[0].createdAt);
  refresher.now = () => createdAt + 23 * 3600000;
  assert.deepEqual(await refresher.due(), []);
  refresher.now = () => createdAt + 25 * 3600000;
  assert.deepEqual(await refresher.due(), [{ ownerId: "owner", profileId: profile.id }]);
});
