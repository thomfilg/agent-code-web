import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const execFileAsync = promisify(execFile);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const repoName = name => {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) || name.split("/").some(part => part === "." || part === "..")) throw fail("Invalid GitHub repository name");
  return name;
};

function repository(repo) {
  return { id: repo.id, fullName: repo.full_name, name: repo.name, private: repo.private, defaultBranch: repo.default_branch, description: repo.description || "", archived: repo.archived || false };
}

export class GitHubConnection {
  constructor({ records, config, fetchImpl = fetch, localToken = null }) {
    this.records = records; this.config = config; this.fetch = fetchImpl;
    this.localToken = localToken || (async () => (await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 10000 })).stdout.trim());
    this.cache = null; this.pending = new Map();
  }
  async status() {
    const connection = await this.records.get("connection", "github");
    const connected = Boolean(connection?.token && (!connection.expiresAt || Date.parse(connection.expiresAt) > Date.now()));
    return { connected, login: connection?.login || null, expiresAt: connection?.expiresAt || null, expired: Boolean(connection && !connected), localAvailable: this.config.localConnection, oauthAvailable: Boolean(this.config.clientId) };
  }
  async requireConnection() {
    const connection = await this.records.get("connection", "github");
    if (!connection?.token || (connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now())) throw fail("Connect GitHub to continue. Your saved connection is missing or expired.", 401);
    return connection;
  }
  async connect({ method, token, expiresAt }) {
    if (method === "local") {
      if (!this.config.localConnection) throw fail("Connecting the local GitHub CLI is disabled", 403);
      try { token = await this.localToken(); } catch { throw fail("No local GitHub login found. Run gh auth login, or connect with an access token."); }
    }
    if (typeof token !== "string" || token.length < 10 || token.length > 1000 || /\s/.test(token)) throw fail("Enter a valid GitHub access token");
    const response = await this.request("/user", { token, raw: true });
    const account = await response.json();
    const detectedExpiry = response.headers.get("github-authentication-token-expiration");
    const dates = [detectedExpiry, expiresAt].filter(Boolean).map(date => Date.parse(date));
    if (dates.some(date => !Number.isFinite(date) || date <= Date.now())) throw fail("The token expiry must be in the future");
    await this.records.put("connection", "github", {
      login: account.login, accountId: account.id, token,
      expiresAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null, connectedAt: new Date().toISOString(),
    });
    this.cache = null;
    return this.status();
  }
  async disconnect() { this.cache = null; this.pending.clear(); await this.records.delete("connection", "github"); return this.status(); }
  async request(route, { token, raw = false } = {}) {
    const auth = token || (await this.requireConnection()).token;
    const response = await this.fetch(`${this.config.apiBase}${route}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${auth}`, "x-github-api-version": "2022-11-28", "user-agent": "agent-code-web" },
      signal: AbortSignal.timeout(20000), redirect: "error",
    });
    if (response.status === 401) {
      if (!token) { const old = await this.records.get("connection", "github"); if (old) await this.records.put("connection", "github", { ...old, token: null }); this.cache = null; }
      throw fail("GitHub credentials expired or were revoked. Reconnect your account.", 401);
    }
    if (response.status === 403) throw fail("GitHub denied access. Check repository permissions, organization SSO, or the API rate limit.", 403);
    if (response.status === 404) throw fail("Repository or branch not found, or your connected GitHub account cannot access it.", 404);
    if (!response.ok) throw fail(`GitHub request failed (${response.status}). Try again.`, 502);
    return raw ? response : response.json();
  }
  async repositories(query = "", refresh = false) {
    const account = await this.requireConnection();
    if (refresh || !this.cache || this.cache.login !== account.login || this.cache.until < Date.now()) {
      const repos = [];
      for (let page = 1; ; page++) {
        const chunk = await this.request(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
        repos.push(...chunk.map(repository));
        if (chunk.length < 100) break;
      }
      this.cache = { login: account.login, repos, until: Date.now() + 300000 };
    }
    const q = query.trim().toLowerCase();
    return this.cache.repos.filter(repo => repo.fullName.toLowerCase().includes(q));
  }
  async branches(name) {
    repoName(name);
    const branches = [];
    for (let page = 1; ; page++) {
      const chunk = await this.request(`/repos/${name}/branches?per_page=100&page=${page}`);
      branches.push(...chunk.map(branch => branch.name));
      if (chunk.length < 100) break;
    }
    return branches;
  }
  async resolveSelections(selections) {
    await this.requireConnection();
    if (!Array.isArray(selections) || !selections.length || selections.length > 100) throw fail("Select between 1 and 100 repositories");
    const seen = new Set(); const resolved = [];
    for (const selection of selections) {
      const name = repoName(selection.fullName);
      if (seen.has(name.toLowerCase())) throw fail("Select each repository only once");
      seen.add(name.toLowerCase());
      const repo = await this.request(`/repos/${name}`);
      const branch = selection.branch || repo.default_branch;
      if (typeof branch !== "string" || !branch || branch.length > 250 || /[\r\n\0]/.test(branch) || branch.startsWith("-")) throw fail("Invalid repository branch");
      // GitHub is the authority for private repo and branch access, not browser data.
      if (repo.size !== 0) await this.request(`/repos/${name}/branches/${encodeURIComponent(branch)}`);
      resolved.push({ ...repository(repo), branch, empty: repo.size === 0, cloneUrl: `https://github.com/${repo.full_name}.git`, directory: `${repo.full_name.replace("/", "--")}--${repo.id}` });
    }
    return resolved;
  }
  async beginDevice() {
    if (!this.config.clientId) throw fail("GitHub OAuth is not configured. Use the local CLI or an access token.");
    const response = await this.fetch("https://github.com/login/device/code", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: this.config.clientId, scope: "repo read:user" }), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok || data.error || !data.device_code) throw fail("GitHub could not start the connection flow");
    for (const [id, state] of this.pending) if (state.expires < Date.now()) this.pending.delete(id);
    const id = randomUUID();
    this.pending.set(id, { code: data.device_code, expires: Date.now() + data.expires_in * 1000, interval: data.interval || 5, next: 0 });
    return { id, userCode: data.user_code, verificationUrl: data.verification_uri, expiresIn: data.expires_in, interval: data.interval || 5 };
  }
  async pollDevice(id) {
    const state = this.pending.get(id);
    if (!state || state.expires <= Date.now()) { this.pending.delete(id); throw fail("GitHub connection request expired. Try again."); }
    if (state.next > Date.now()) return { pending: true, interval: state.interval };
    state.next = Date.now() + state.interval * 1000;
    const response = await this.fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: this.config.clientId, device_code: state.code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (data.error === "slow_down") { state.interval += 5; return { pending: true, interval: state.interval }; }
    if (data.error === "authorization_pending") return { pending: true, interval: state.interval };
    this.pending.delete(id);
    if (!response.ok || data.error || !data.access_token) throw fail("GitHub connection was denied or expired. Try again.");
    return this.connect({ token: data.access_token, expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null });
  }
}
