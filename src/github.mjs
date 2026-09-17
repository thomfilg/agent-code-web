import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { companyForChat, companyScope, normalizeCompanyScope, scopeAllows } from "../public/company-scope.js";
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
    this.cache = new Map(); this.pending = new Map(); this.queue = Promise.resolve();
  }
  async connections() {
    const legacy = await this.records.get("connection", "github");
    return [...(legacy ? [{ ...legacy, id: "github" }] : []), ...await this.records.list("github_connection")];
  }
  public(connection) {
    const { token, ...value } = connection;
    return { ...value, name: value.name || value.login || "GitHub", revision: value.revision || 0, ...companyScope(value), scopeNeedsReview: !Array.isArray(value.companies), connected: Boolean(token && (!value.expiresAt || Date.parse(value.expiresAt) > Date.now())) };
  }
  async get(id) {
    if (id !== "github" && !/^github_[a-f0-9-]{36}$/.test(id || "")) throw fail("Choose a saved GitHub connection", 404);
    const record = await this.records.get(id === "github" ? "connection" : "github_connection", id);
    if (!record) throw fail("GitHub connection not found", 404);
    return { ...record, id };
  }
  async put(connection) { await this.records.put(connection.id === "github" ? "connection" : "github_connection", connection.id, connection); this.cache.delete(connection.id); }
  async status() {
    const connections = (await this.connections()).map(connection => this.public(connection)), active = connections.filter(connection => connection.connected);
    return { connections, connected: Boolean(active.length), login: active.length === 1 ? active[0].login : active.length ? `${active.length} connections` : null, expiresAt: active.length === 1 ? active[0].expiresAt : null, expired: Boolean(connections.length && !active.length), localAvailable: this.config.localConnection, oauthAvailable: Boolean(this.config.clientId) };
  }
  async requireConnection({ connectionId, repository: name, chatCompany } = {}) {
    if (name) repoName(name);
    const candidates = connectionId ? [await this.get(connectionId)] : await this.connections();
    const active = candidates.filter(connection => this.public(connection).connected);
    if (!active.length) throw fail("Connect GitHub to continue. Your saved connection is missing or expired.", 401);
    const allowed = active.filter(connection => (!name || scopeAllows(connection, name.split("/")[0])) && (chatCompany === undefined || scopeAllows(connection, chatCompany)));
    if (!allowed.length) throw fail(`No selected GitHub credential is available for this repository${chatCompany !== undefined ? ` in ${chatCompany || "unassigned chats"}` : ""}. Choose its allowed companies in GitHub settings.`, 403);
    if (allowed.length !== 1) throw fail("Multiple GitHub connections match. Select the intended connection for this repository.", 409);
    return allowed[0];
  }
  connect(input) {
    const result = this.queue.then(() => this.connectUnlocked(input)); this.queue = result.catch(() => {}); return result;
  }
  async connectUnlocked(input) {
    let { method, token, expiresAt } = input;
    const old = input.id ? await this.get(input.id) : null;
    if (old && input.revision !== (old.revision || 0)) throw fail("GitHub connection changed. Reload before saving.", 409);
    const scope = normalizeCompanyScope(input, old || {});
    const name = String(input.name ?? old?.name ?? "GitHub").trim();
    if (!name || name.length > 80) throw fail("Connection name must contain 1–80 characters");
    if (method === "local") {
      if (!this.config.localConnection) throw fail("Connecting the local GitHub CLI is disabled", 403);
      try { token = await this.localToken(); } catch { throw fail("No local GitHub login found. Run gh auth login, or connect with an access token."); }
    }
    if (token === undefined && old) {
      await this.put({ ...old, name, ...scope, revision: (old.revision || 0) + 1 });
      return { ...await this.status(), connection: this.public(await this.get(old.id)) };
    }
    if (typeof token !== "string" || token.length < 10 || token.length > 1000 || /\s/.test(token)) throw fail("Enter a valid GitHub access token");
    const response = await this.request("/user", { token, raw: true });
    const account = await response.json();
    const detectedExpiry = response.headers.get("github-authentication-token-expiration");
    const dates = [detectedExpiry, expiresAt].filter(Boolean).map(date => Date.parse(date));
    if (dates.some(date => !Number.isFinite(date) || date <= Date.now())) throw fail("The token expiry must be in the future");
    const connection = {
      id: old?.id || `github_${randomUUID()}`, name, ...scope, revision: (old?.revision || 0) + 1,
      login: account.login, accountId: account.id, token,
      expiresAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null, connectedAt: new Date().toISOString(),
    };
    await this.put(connection);
    return { ...await this.status(), connection: this.public(connection) };
  }
  disconnect(id) {
    const result = this.queue.then(async () => {
      const connection = id ? await this.get(id) : await this.requireConnection();
      this.cache.delete(connection.id);
      for (const [flowId, flow] of this.pending) if (flow.settings.id === connection.id) this.pending.delete(flowId);
      await this.records.delete(connection.id === "github" ? "connection" : "github_connection", connection.id);
      return this.status();
    });
    this.queue = result.catch(() => {}); return result;
  }
  async request(route, { token, raw = false, method = "GET", body, connectionId, repository: name, chatCompany } = {}) {
    if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) throw fail("Invalid GitHub API route");
    const routeRepository = /^\/repos\/([^/?]+\/[^/?]+)/.exec(route)?.[1];
    if (route === "/graphql" && !name && !token) throw fail("A repository is required for scoped GitHub GraphQL requests");
    const connection = token ? null : await this.requireConnection({ connectionId, repository: routeRepository || name, chatCompany });
    const auth = token || connection.token;
    const response = await this.fetch(`${this.config.apiBase}${route}`, {
      method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      headers: { accept: "application/vnd.github+json", "content-type": "application/json", authorization: `Bearer ${auth}`, "x-github-api-version": "2022-11-28", "user-agent": "agent-code-web" },
      signal: AbortSignal.timeout(20000), redirect: "error",
    });
    if (response.status === 401) {
      if (connection) { const old = await this.get(connection.id).catch(() => null); if (old?.token === connection.token) await this.put({ ...old, token: null, revision: (old.revision || 0) + 1 }); }
      throw fail("GitHub credentials expired or were revoked. Reconnect your account.", 401);
    }
    if (response.status === 403) throw fail("GitHub denied access. Check repository permissions, organization SSO, or the API rate limit.", 403);
    if (response.status === 404) throw fail("Repository or branch not found, or your connected GitHub account cannot access it.", 404);
    if (!response.ok) throw fail(`GitHub request failed (${response.status}). Try again.`, 502);
    return raw ? response : response.json();
  }
  async repositories(query = "", refresh = false) {
    const connections = (await this.connections()).filter(connection => this.public(connection).connected), result = [];
    for (const account of connections) {
      if (!companyScope(account).companies.length) continue;
      let cached = this.cache.get(account.id);
      if (refresh || !cached || cached.revision !== account.revision || cached.until < Date.now()) {
        const repos = [];
        for (let page = 1; ; page++) {
          const chunk = await this.request(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, { connectionId: account.id });
          repos.push(...chunk.map(repository));
          if (chunk.length < 100) break;
        }
        cached = { revision: account.revision, repos, until: Date.now() + 300000 }; this.cache.set(account.id, cached);
      }
      const current = await this.get(account.id).catch(() => null);
      if (!current || !this.public(current).connected) continue;
      result.push(...cached.repos.filter(repo => scopeAllows(current, repo.fullName.split("/")[0])).map(repo => ({ ...repo, githubConnectionId: account.id, connectionName: current.name || current.login })));
    }
    const q = query.trim().toLowerCase();
    return result.filter(repo => repo.fullName.toLowerCase().includes(q));
  }
  async branches(name, connectionId) {
    repoName(name);
    const branches = [];
    for (let page = 1; ; page++) {
      const chunk = await this.request(`/repos/${name}/branches?per_page=100&page=${page}`, { connectionId });
      branches.push(...chunk.map(branch => branch.name));
      if (chunk.length < 100) break;
    }
    return branches;
  }
  async resolveSelections(selections, { company } = {}) {
    if (!Array.isArray(selections) || !selections.length || selections.length > 100) throw fail("Select between 1 and 100 repositories");
    const chatCompany = company ?? repoName(selections[0]?.fullName).split("/")[0];
    const seen = new Set(), checked = [], resolved = [];
    for (const selection of selections) {
      const name = repoName(selection?.fullName);
      if (seen.has(name.toLowerCase())) throw fail("Select each repository only once");
      seen.add(name.toLowerCase());
      const connection = await this.requireConnection({ connectionId: selection.githubConnectionId, repository: name, chatCompany });
      checked.push({ selection, name, connectionId: connection.id });
    }
    for (const { selection, name, connectionId } of checked) {
      const repo = await this.request(`/repos/${name}`, { connectionId, chatCompany });
      if (repo.full_name?.toLowerCase() !== name.toLowerCase()) throw fail("GitHub repository identity changed. Refresh the picker.");
      const branch = selection.branch || repo.default_branch;
      if (typeof branch !== "string" || !branch || branch.length > 250 || /[\r\n\0]/.test(branch) || branch.startsWith("-")) throw fail("Invalid repository branch");
      // GitHub is the authority for private repo and branch access, not browser data.
      if (repo.size !== 0) await this.request(`/repos/${name}/branches/${encodeURIComponent(branch)}`, { connectionId, chatCompany });
      resolved.push({ ...repository(repo), githubConnectionId: connectionId, branch, empty: repo.size === 0, cloneUrl: `https://github.com/${repo.full_name}.git`, directory: `${repo.full_name.replace("/", "--")}--${repo.id}` });
    }
    return resolved;
  }
  async tokenForRepository(repo, chat = { repositories: [repo] }) { return (await this.requireConnection({ connectionId: repo.githubConnectionId, repository: repo.fullName, chatCompany: companyForChat(chat) })).token; }
  async beginDevice(input = {}) {
    if (!this.config.clientId) throw fail("GitHub OAuth is not configured. Use the local CLI or an access token.");
    const old = input.id ? await this.get(input.id) : null;
    if (old && input.revision !== (old.revision || 0)) throw fail("GitHub connection changed. Reload before signing in.", 409);
    const settings = { id: old?.id, revision: old?.revision || 0, name: input.name || old?.name || "GitHub", ...normalizeCompanyScope(input, old || {}) };
    const response = await this.fetch("https://github.com/login/device/code", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: this.config.clientId, scope: "repo read:user" }), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok || data.error || !data.device_code) throw fail("GitHub could not start the connection flow");
    for (const [id, state] of this.pending) if (state.expires < Date.now()) this.pending.delete(id);
    const id = randomUUID();
    this.pending.set(id, { settings, code: data.device_code, expires: Date.now() + data.expires_in * 1000, interval: data.interval || 5, next: 0 });
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
    return this.connect({ ...state.settings, token: data.access_token, expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null });
  }
}
