// Keeps saved browser sign-ins alive. Sites such as Google rotate their session
// cookies, so a snapshot that is never opened goes stale. For each profile a
// hidden system chat (no agent ever runs in it) opens the current version on
// its own worker, visits every signed-in site so the site renews its cookies,
// and publishes the result as a new version only when no sign-in was lost.
// The chat and its worker are deleted afterwards.
import { inspectProfileArchive } from "./browser-profiles.mjs";
import { prepareWorkspace } from "./workspace.mjs";
import { loginState } from "../public/browser-profile-sessions.js";

export const REFRESH_SYSTEM_KIND = "browser-profile-refresh";
const HOUR = 3600000;
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

// Sites whose sign-in is still worth keeping, and where to visit them.
export function refreshTargets(profile) {
  return (profile.sessions || []).filter(session => !session.sessionOnly && loginState(session).level !== "expired")
    .map(session => ({ site: session.site, url: `https://${session.host || session.site}/` }));
}

// A refreshed version is published only when every site that was signed in
// before still has a login cookie that has not expired.
export function compareRefresh(before, after, now = Date.now()) {
  const current = new Map((after || []).map(session => [session.site, session]));
  const lost = [], renewed = [];
  for (const session of before || []) {
    if (session.sessionOnly || loginState(session, now).level === "expired") continue;
    const next = current.get(session.site);
    if (!next || next.sessionOnly || loginState(next, now).level === "expired") lost.push(session.site);
    else if (Date.parse(next.expiresAt) > Date.parse(session.expiresAt)) renewed.push(session.site);
  }
  return { lost, renewed, publish: lost.length === 0 };
}

export class BrowserProfileRefresher {
  constructor({ store, manager, resources, agentAccounts, intervalMs = 24 * HOUR, settleMs = 8000, now = Date.now, log = console }) {
    Object.assign(this, { store, manager, resources, agentAccounts, intervalMs, settleMs, now, log });
    this.running = new Map();
  }
  // Any connected agent account of the owner can admit the worker; the agent never runs.
  account(ownerId) {
    return [...(this.agentAccounts?.metadata?.values() || [])].find(account => account.ownerId === ownerId && account.status === "connected") || null;
  }
  refresh(ownerId, profileId) {
    const key = `${ownerId || "local"}:${profileId}`;
    if (!this.running.has(key)) this.running.set(key, this.run(ownerId, profileId).finally(() => this.running.delete(key)));
    return this.running.get(key);
  }
  async run(ownerId, profileId) {
    const services = await this.resources.forOwner(ownerId);
    const profile = await services.browserProfiles.get(profileId);
    const targets = refreshTargets(profile);
    const record = outcome => services.browserProfiles.recordRefresh(profileId, { at: new Date(this.now()).toISOString(), ...outcome }).then(() => outcome);
    if (!profile.currentVersion || !targets.length) return record({ status: "skipped", message: "No saved sign-in to renew." });
    const account = this.account(ownerId);
    if (!account) return record({ status: "failed", message: "Connect a Codex or Claude account: renewal runs on a private worker." });
    await record({ status: "running", message: "Renewing saved sign-ins on a private worker…" });
    const chat = await this.store.create({ title: `Browser profile refresh · ${profile.name}`, agent: account.provider, agentAccountId: account.id, ownerId, autoTitle: false });
    try {
      await prepareWorkspace({ destination: chat.workspace, source: "" });
      await this.store.update(chat.id, { system: { kind: REFRESH_SYSTEM_KIND, profileId, version: profile.currentVersion }, workspaceReady: true });
      await this.manager.browsers.ensure(chat.id);
      for (const target of targets) {
        await this.manager.browsers.command(chat.id, "navigate", { url: target.url }).catch(() => {});
        await settle(this.settleMs);
      }
      const { archive } = await this.manager.browsers.captureProfile(chat.id);
      const { sessions } = await inspectProfileArchive(archive);
      const comparison = compareRefresh(profile.sessions, sessions, this.now());
      if (!comparison.publish) return record({ status: "needs-sign-in", lost: comparison.lost, message: `Sign in again: ${comparison.lost.join(", ")}` });
      const latest = await services.browserProfiles.get(profileId);
      // A version published meanwhile (upload or Save to profile) wins.
      if (latest.currentVersion !== profile.currentVersion) return record({ status: "skipped", message: "A newer version was saved during renewal." });
      const saved = await services.browserProfiles.addVersion(profileId, archive, { source: "refresh" });
      return record({ status: "renewed", version: saved.currentVersion, renewed: comparison.renewed });
    } catch (error) {
      this.log.error?.(`browser profile refresh ${profileId} failed: ${String(error?.message || error).split("\n")[0].slice(0, 300)}`);
      return record({ status: "failed", message: "Renewal could not complete; the saved profile is unchanged." });
    } finally {
      await this.manager.remove(chat.id).catch(error => this.log.error?.(`browser profile refresh cleanup ${chat.id}: ${error?.message}`));
    }
  }
  // Profiles whose current version (or last attempt) is older than the interval.
  async due() {
    const owners = new Set([...(this.agentAccounts?.metadata?.values() || [])].filter(account => account.status === "connected").map(account => account.ownerId));
    const due = [];
    for (const ownerId of owners) {
      const services = await this.resources.forOwner(ownerId).catch(() => null);
      for (const profile of services ? await services.browserProfiles.list().catch(() => []) : []) {
        const version = profile.versions.at(-1);
        const last = Math.max(version ? Date.parse(version.createdAt) : 0, profile.refresh ? Date.parse(profile.refresh.at) : 0);
        if (version && refreshTargets(profile).length && this.now() - last >= this.intervalMs) due.push({ ownerId, profileId: profile.id });
      }
    }
    return due;
  }
  // One profile at a time, so renewals never pile up workers.
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try { for (const { ownerId, profileId } of await this.due()) await this.refresh(ownerId, profileId); }
    catch (error) { this.log.error?.(`browser profile refresh schedule: ${error?.message}`); }
    finally { this.ticking = false; }
  }
  start(checkEveryMs = HOUR) {
    this.timer = setInterval(() => { void this.tick(); }, checkEveryMs); this.timer.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); }
}
