import { randomUUID } from "node:crypto";
import { GitHubLogin, GitHubLoginError } from "./github-login.mjs";
import { companyForChat, companyScope, normalizeCompanyScope, scopeAllows } from "../public/company-scope.js";
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const repoName = name => {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) || name.split("/").some(part => part === "." || part === "..")) throw fail("Invalid GitHub repository name");
  return name;
};

function repository(repo) {
  return { id: repo.id, fullName: repo.full_name, name: repo.name, private: repo.private, defaultBranch: repo.default_branch, description: repo.description || "", archived: repo.archived || false };
}

export class GitHubConnection {
  constructor({ records, config, fetchImpl = fetch, loginFactory = () => new GitHubLogin({ executable: config.cliPath || "gh" }), onChange = () => {} }) {
    this.records = records; this.config = config; this.fetch = fetchImpl;
    this.loginFactory = loginFactory;
    this.onChange = onChange;
    this.cache = new Map(); this.pending = new Map(); this.queue = Promise.resolve();
    this.ready = this.recover();
  }
  async recover() {
    for (const record of await this.records.list("github_connection")) if (["starting", "pending"].includes(record.loginState)) {
      await this.put({ ...record, loginState: "disconnected", error: "Relay restarted before sign-in finished. Reconnect to get a new code." });
    }
  }
  async connections() {
    await this.ready;
    const legacy = await this.records.get("connection", "github");
    return [...(legacy ? [{ ...legacy, id: "github" }] : []), ...await this.records.list("github_connection")];
  }
  public(connection) {
    const { token, ...value } = connection;
    const flow = [...this.pending.values()].find(flow => flow.connectionId === connection.id);
    return { ...value, name: value.name || value.login || "GitHub", revision: value.revision || 0, ...companyScope(value), scopeNeedsReview: !Array.isArray(value.companies), connected: Boolean(token && (!value.expiresAt || Date.parse(value.expiresAt) > Date.now())), ...(flow ? { signIn: { id: flow.id, state: flow.code ? "pending" : "starting", ...flow.code } } : {}) };
  }
  async get(id) {
    await this.ready;
    if (id !== "github" && !/^github_[a-f0-9-]{36}$/.test(id || "")) throw fail("Choose a saved GitHub connection", 404);
    const record = await this.records.get(id === "github" ? "connection" : "github_connection", id);
    if (!record) throw fail("GitHub connection not found", 404);
    return { ...record, id };
  }
  changed(id) { try { this.onChange(id); } catch { /* Notifications cannot break durable saves. */ } }
  async put(connection) {
    this.changed(connection.id);
    try { await this.records.put(connection.id === "github" ? "connection" : "github_connection", connection.id, connection); }
    finally { this.cache.delete(connection.id); this.changed(connection.id); }
  }
  async status() {
    const connections = (await this.connections()).map(connection => this.public(connection)), active = connections.filter(connection => connection.connected);
    return { connections, connected: Boolean(active.length), login: active.length === 1 ? active[0].login : active.length ? `${active.length} connections` : null, expiresAt: active.length === 1 ? active[0].expiresAt : null, expired: Boolean(connections.length && !active.length), localAvailable: false, oauthAvailable: true };
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
  async connectUnlocked(input, { stillActive = () => true } = {}) {
    let { method, token, expiresAt } = input;
    const old = input.id ? await this.get(input.id) : null;
    if (old && input.revision !== (old.revision || 0)) throw fail("GitHub connection changed. Reload before saving.", 409);
    const scope = normalizeCompanyScope(input, old || {});
    const name = String(input.name ?? old?.name ?? "GitHub").trim();
    if (!name || name.length > 80) throw fail("Connection name must contain 1–80 characters");
    if (method) throw fail("Use Sign in to GitHub. Server credentials are never imported.", 400);
    if (token === undefined && old) {
      await this.put({ ...old, name, ...scope, revision: (old.revision || 0) + 1 });
      return { ...await this.status(), connection: this.public(await this.get(old.id)) };
    }
    if (typeof token !== "string" || token.length < 10 || token.length > 1000 || /\s/.test(token)) throw fail("Enter a valid GitHub access token");
    const response = await this.request("/user", { token, raw: true });
    const account = await response.json();
    if (!Number.isSafeInteger(account.id) || account.id <= 0 || typeof account.login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account.login)) throw fail("GitHub returned an invalid account identity. Try signing in again.", 502);
    if (old?.accountId && old.accountId !== account.id) throw fail("You signed in to a different GitHub account. Add it as a new connection instead.", 409);
    const detectedExpiry = response.headers.get("github-authentication-token-expiration");
    const dates = [detectedExpiry, expiresAt].filter(Boolean).map(date => Date.parse(date));
    if (dates.some(date => !Number.isFinite(date) || date <= Date.now())) throw fail("The token expiry must be in the future");
    const connection = {
      id: old?.id || `github_${randomUUID()}`, name, ...scope, revision: (old?.revision || 0) + 1,
      login: account.login, accountId: account.id, token, loginState: "connected", error: null,
      expiresAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null, connectedAt: new Date().toISOString(),
    };
    if (!stillActive()) throw fail("GitHub sign-in was cancelled.", 409);
    await this.put(connection);
    return { ...await this.status(), connection: this.public(connection) };
  }
  disconnect(id) {
    if (id) this.changed(id);
    const interrupted = [...this.pending.values()].filter(flow => flow.connectionId === id);
    for (const flow of interrupted) this.pending.delete(flow.id);
    const result = this.queue.then(async () => {
      await Promise.all(interrupted.map(flow => flow.client.close()));
      const connection = id ? await this.get(id) : await this.requireConnection();
      this.cache.delete(connection.id);
      for (const [flowId, flow] of this.pending) if (flow.connectionId === connection.id) { this.pending.delete(flowId); await flow.client.close(); }
      this.changed(connection.id);
      try { await this.records.delete(connection.id === "github" ? "connection" : "github_connection", connection.id); }
      finally { this.changed(connection.id); }
      return this.status();
    });
    this.queue = result.catch(() => {}); return result;
  }
  async request(route, { token, raw = false, method = "GET", body, connectionId, repository: name, chatCompany, signal } = {}) {
    if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) throw fail("Invalid GitHub API route");
    const routeRepository = /^\/repos\/([^/?]+\/[^/?]+)/.exec(route)?.[1];
    if (route === "/graphql" && !name && !token) throw fail("A repository is required for scoped GitHub GraphQL requests");
    const connection = token ? null : await this.requireConnection({ connectionId, repository: routeRepository || name, chatCompany });
    const auth = token || connection.token;
    const response = await this.fetch(`${this.config.apiBase}${route}`, {
      method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      headers: { accept: "application/vnd.github+json", "content-type": "application/json", authorization: `Bearer ${auth}`, "x-github-api-version": "2022-11-28", "user-agent": "agent-code-web" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), redirect: "error",
    });
    if (response.status === 401) {
      if (connection) {
        // A slow rejected request must not overwrite a newly reconnected token,
        // edited scope or deletion. Share the mutation queue and compare inside it.
        const invalidate = this.queue.then(async () => {
          const current = await this.get(connection.id).catch(() => null);
          if (current?.token === connection.token) await this.put({ ...current, token: null, loginState: "disconnected", error: "GitHub access expired or was revoked. Reconnect this account.", revision: (current.revision || 0) + 1 });
        });
        this.queue = invalidate.catch(() => {}); await invalidate;
      }
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
    const result = this.queue.then(async () => {
      if (this.closed) throw fail("Relay is stopping. Retry after it restarts.", 503);
      if (input.token !== undefined || input.method !== undefined) throw fail("Use browser sign-in to connect GitHub.");
      const old = input.id ? await this.get(input.id) : null;
      const existing = [...this.pending.values()].find(flow => flow.connectionId === old?.id);
      if (existing) return { id: existing.id, connection: this.public(old) };
      if (this.pending.size >= 3) throw fail("Finish or cancel an existing GitHub sign-in first.", 429);
      if (old && input.revision !== (old.revision || 0)) throw fail("GitHub connection changed. Reload before signing in.", 409);
      const connection = { ...old, id: old?.id || `github_${randomUUID()}`, name: old?.name || "New GitHub account", ...companyScope(old || {}), token: null, loginState: "starting", error: null, revision: (old?.revision || 0) + 1 };
      await this.put(connection);
      const flow = { id: randomUUID(), connectionId: connection.id, client: this.loginFactory(), code: null };
      this.pending.set(flow.id, flow);
      flow.task = this.completeDevice(flow, connection);
      return { id: flow.id, connection: this.public(connection) };
    });
    this.queue = result.catch(() => {}); return result;
  }
  async pollDevice(id) {
    const flow = this.pending.get(id);
    if (!flow) throw fail("GitHub sign-in is no longer pending. Refresh the connection.", 404);
    return { pending: true, interval: 2, connection: this.public(await this.get(flow.connectionId)) };
  }
  async completeDevice(flow, connection) {
    try {
      const token = await flow.client.start(code => { if (this.pending.get(flow.id) === flow) flow.code = code; });
      const commit = this.queue.then(async () => {
        if (this.pending.get(flow.id) !== flow || this.closed) return;
        const current = await this.get(connection.id);
        await this.connectUnlocked({ id: current.id, revision: current.revision, name: current.login ? current.name : undefined, ...companyScope(current), token }, { stillActive: () => this.pending.get(flow.id) === flow && !this.closed });
        const saved = await this.get(current.id);
        if (!connection.login) await this.put({ ...saved, name: saved.login });
        this.pending.delete(flow.id);
      });
      this.queue = commit.catch(() => {}); await commit;
    } catch (error) {
      const finish = this.queue.then(async () => {
        if (this.pending.get(flow.id) !== flow) return;
        this.pending.delete(flow.id);
        const current = await this.get(connection.id);
        await this.put({ ...current, token: null, loginState: "disconnected", error: error instanceof GitHubLoginError ? new GitHubLoginError(error.code).message : error.statusCode === 409 ? "You signed in to a different GitHub account. Add it as a new connection instead." : "GitHub sign-in could not finish. Check the connection and try again." });
      });
      this.queue = finish.catch(() => {}); await finish.catch(() => {});
    } finally { await flow.client.close().catch(() => {}); }
  }
  async cancelDevice(id) {
    const flow = this.pending.get(id);
    if (!flow) throw fail("GitHub sign-in is no longer pending.", 404);
    // Invalidate before queued network completion can persist a late credential.
    this.pending.delete(id);
    const closing = flow.client.close();
    const result = this.queue.then(async () => {
      await closing;
      const connection = await this.get(flow.connectionId);
      await this.put({ ...connection, token: null, loginState: "disconnected", error: new GitHubLoginError("cancelled").message });
      return this.status();
    });
    this.queue = result.catch(() => {}); return result;
  }
  async close() {
    this.closed = true;
    await this.queue;
    const flows = [...this.pending.values()];
    for (const flow of flows) await this.cancelDevice(flow.id).catch(() => {});
    await Promise.all(flows.map(flow => flow.task));
  }
  async update(input) {
    if (input.token !== undefined || input.method !== undefined || input.expiresAt !== undefined) throw fail("Use browser sign-in to connect GitHub.");
    if (!input.id) throw fail("Sign in to GitHub before choosing company access.");
    if ([...this.pending.values()].some(flow => flow.connectionId === input.id)) throw fail("Finish or cancel sign-in before editing this connection.", 409);
    this.changed(input.id);
    return this.connect(input);
  }
}
