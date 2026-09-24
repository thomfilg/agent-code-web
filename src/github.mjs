import { createHash, randomUUID } from "node:crypto";
import { GitHubLogin, GitHubLoginError } from "./github-login.mjs";
import { companyForChat } from "../public/company-scope.js";
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const listingChanged = () => fail("GitHub connection changed while loading repositories. Refresh the list.", 409);
export const GITHUB_PERMISSIONS = Object.freeze(["repositories", "workflows"]);
const normalizePermissions = (value, fallback = ["repositories"]) => {
  if (value === undefined) value = fallback;
  if (!Array.isArray(value) || value.some(permission => typeof permission !== "string" || !GITHUB_PERMISSIONS.includes(permission))) throw fail("Choose only the GitHub permissions shown by Relay.");
  return ["repositories", ...new Set(value.filter(permission => permission !== "repositories"))];
};
const permissionScopes = permissions => permissions.includes("workflows") ? ["workflow"] : [];
const oauthScopes = value => {
  const scopes = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return [...new Set(scopes.filter(scope => typeof scope === "string").map(scope => scope.trim()).filter(Boolean))].sort();
};
const grantedPermissions = scopes => ["repositories", ...(scopes.includes("workflow") ? ["workflows"] : [])];
const rejectLegacyScope = input => {
  if (["companies", "organization", "allowUnassigned"].some(key => Object.hasOwn(input, key))) throw fail("GitHub repository access follows your GitHub permissions. Reload Relay to use the current account settings.");
};
const repoName = name => {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) || name.split("/").some(part => part === "." || part === "..")) throw fail("Invalid GitHub repository name");
  return name;
};

function repository(repo) {
  return { id: repo.id, fullName: repo.full_name, name: repo.name, private: repo.private, defaultBranch: repo.default_branch, description: repo.description || "", archived: repo.archived || false };
}

export class GitHubConnection {
  constructor({ records, config, companies = null, fetchImpl = fetch, loginFactory = () => new GitHubLogin({ executable: config.cliPath || "gh" }), onChange = () => {} }) {
    this.companies = companies;
    this.records = records; this.config = config; this.fetch = fetchImpl;
    this.loginFactory = loginFactory;
    this.onChange = onChange;
    this.cache = new Map(); this.pending = new Map(); this.queue = Promise.resolve(); this.connectionGeneration = 0;
    this.ready = this.recover();
  }
  async recover() {
    for (const record of await this.records.list("github_connection")) if (["starting", "pending"].includes(record.loginState)) {
      const connected = Boolean(record.token && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()));
      await this.put({ ...record, loginState: connected ? "connected" : "disconnected", error: connected ? "The new GitHub sign-in was interrupted; the previous credential is still connected." : "Relay restarted before sign-in finished. Reconnect to get a new code." });
    }
  }
  async connections() {
    await this.ready;
    const legacy = await this.records.get("connection", "github");
    return [...(legacy ? [{ ...legacy, id: "github" }] : []), ...await this.records.list("github_connection")];
  }
  public(connection) {
    const { token, companies, organization, allowUnassigned, scopeNeedsReview, ...value } = connection;
    const flow = [...this.pending.values()].find(flow => flow.connectionId === connection.id);
    const requestedPermissions = normalizePermissions(value.requestedPermissions);
    const verifiedScopes = oauthScopes(value.grantedScopes);
    return { ...value, requestedPermissions, grantedPermissions: verifiedScopes.length ? grantedPermissions(verifiedScopes) : [], permissionsVerified: Boolean(verifiedScopes.length), name: value.name || value.login || "GitHub", revision: value.revision || 0, repositoryAccess: "github", ...(this.companies ? { companyId: value.companyId || null, scopeNeedsReview: !value.companyId } : {}), connected: Boolean(token && (!value.expiresAt || Date.parse(value.expiresAt) > Date.now())), ...(flow ? { signIn: { id: flow.id, state: flow.code ? "pending" : "starting", permissions: flow.permissions, ...flow.code } } : {}) };
  }
  async get(id) {
    await this.ready;
    if (id !== "github" && !/^github_[a-f0-9-]{36}$/.test(id || "")) throw fail("Choose a saved GitHub connection", 404);
    const record = await this.records.get(id === "github" ? "connection" : "github_connection", id);
    if (!record) throw fail("GitHub connection not found", 404);
    return { ...record, id };
  }
  changed(id) { this.connectionGeneration++; try { this.onChange(id); } catch { /* Notifications cannot break durable saves. */ } }
  async put(connection) {
    this.changed(connection.id);
    try { await this.records.put(connection.id === "github" ? "connection" : "github_connection", connection.id, connection); }
    finally { this.cache.delete(connection.id); this.changed(connection.id); }
  }
  async status() {
    const connections = (await this.connections()).map(connection => this.public(connection)), active = connections.filter(connection => connection.connected);
    return { connections, connected: Boolean(active.length), login: active.length === 1 ? active[0].login : active.length ? `${active.length} connections` : null, expiresAt: active.length === 1 ? active[0].expiresAt : null, expired: Boolean(connections.length && !active.length), localAvailable: false, oauthAvailable: true, repositoryAccess: "github" };
  }
  async requireConnection({ connectionId, repository: name, chatCompany } = {}) {
    if (name) repoName(name);
    const candidates = connectionId ? [await this.get(connectionId)] : await this.connections();
    // Repository owners are not Relay companies. One selected company account
    // can contain both personal and organization repositories.
    const company = chatCompany?.toLowerCase();
    const active = candidates.filter(connection => this.public(connection).connected && (!this.companies || (connection.companyId && (!company || connection.companyId === company))));
    if (this.companies && !active.length && candidates.some(connection => this.public(connection).connected)) throw fail("Choose the GitHub connection assigned to this company. Assign unlinked accounts on the GitHub connections page.", 403);
    if (!active.length) throw fail("Connect GitHub to continue. Your saved connection is missing or expired.", 401);
    // Company selection chooses the credential; GitHub still decides which
    // repositories that credential can access. Never borrow another company's.
    if (active.length !== 1) throw fail("Multiple GitHub connections match. Select the intended connection for this repository.", 409);
    if (this.companies) await this.companies.get(active[0].companyId);
    return active[0];
  }
  async companyForConnection(input, old) {
    if (!this.companies) return undefined;
    const companyId = input.companyId ?? old?.companyId;
    await this.companies.get(companyId);
    if ((await this.connections()).some(connection => connection.id !== old?.id && connection.companyId === companyId)) throw fail("This company already has a GitHub connection. Reconnect or remove that connection first.", 409);
    return companyId;
  }
  connect(input) {
    const result = this.queue.then(() => this.connectUnlocked(input)); this.queue = result.catch(() => {}); return result;
  }
  async connectUnlocked(input, { stillActive = () => true } = {}) {
    let { method, token, expiresAt } = input;
    const old = input.id ? await this.get(input.id) : null;
    const requestedPermissions = normalizePermissions(input.permissions ?? old?.requestedPermissions);
    if (old && input.revision !== (old.revision || 0)) throw fail("GitHub connection changed. Reload before saving.", 409);
    const companyId = await this.companyForConnection(input, old);
    const name = String(input.name ?? old?.name ?? "GitHub").trim();
    if (!name || name.length > 80) throw fail("Connection name must contain 1–80 characters");
    if (method) throw fail("Use Sign in to GitHub. Server credentials are never imported.", 400);
    if (token === undefined && old) {
      await this.put({ ...old, name, ...(companyId ? { companyId } : {}), revision: (old.revision || 0) + 1 });
      return { ...await this.status(), connection: this.public(await this.get(old.id)) };
    }
    if (typeof token !== "string" || token.length < 10 || token.length > 1000 || /\s/.test(token)) throw fail("Enter a valid GitHub access token");
    const response = await this.request("/user", { token, raw: true });
    const account = await response.json();
    if (!Number.isSafeInteger(account.id) || account.id <= 0 || typeof account.login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account.login)) throw fail("GitHub returned an invalid account identity. Try signing in again.", 502);
    if (old?.accountId && old.accountId !== account.id) throw fail("You signed in to a different GitHub account. Add it as a new connection instead.", 409);
    const detectedExpiry = response.headers.get("github-authentication-token-expiration");
    const grantedScopes = oauthScopes(response.headers.get("x-oauth-scopes"));
    if (requestedPermissions.includes("workflows") && grantedScopes.length && !grantedScopes.includes("workflow")) throw fail("GitHub did not grant workflow access. Sign in again and approve the Workflows permission.", 403);
    const dates = [detectedExpiry, expiresAt].filter(Boolean).map(date => Date.parse(date));
    if (dates.some(date => !Number.isFinite(date) || date <= Date.now())) throw fail("The token expiry must be in the future");
    const connection = {
      id: old?.id || `github_${randomUUID()}`, name, ...(companyId ? { companyId } : {}), revision: (old?.revision || 0) + 1,
      login: account.login, accountId: account.id, token, loginState: "connected", error: null,
      requestedPermissions, grantedScopes,
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
  async request(route, { token, raw = false, method = "GET", body, connectionId, repository: name, chatCompany, signal, expectedConnection } = {}) {
    if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) throw fail("Invalid GitHub API route");
    const routeRepository = /^\/repos\/([^/?]+\/[^/?]+)/.exec(route)?.[1];
    if (route === "/graphql" && !name && !token) throw fail("A repository is required for scoped GitHub GraphQL requests");
    const connection = token ? null : await this.requireConnection({ connectionId, repository: routeRepository || name, chatCompany });
    if (expectedConnection && (!connection || connection.id !== expectedConnection.id || connection.token !== expectedConnection.token || (connection.revision || 0) !== (expectedConnection.revision || 0))) throw listingChanged();
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
    await this.queue;
    const connections = (await this.connections()).filter(connection => this.public(connection).connected && (!this.companies || connection.companyId)), result = [], validations = [];
    const generation = this.connectionGeneration;
    for (const account of connections) {
      const tokenHash = createHash("sha256").update(account.token).digest("hex");
      const assertCurrent = async () => {
        await this.queue;
        const current = await this.get(account.id).catch(() => null);
        if (this.connectionGeneration !== generation || !current || !this.public(current).connected || (current.revision || 0) !== (account.revision || 0) || current.token !== account.token) throw listingChanged();
        return current;
      };
      validations.push(assertCurrent);
      await assertCurrent();
      let cached = this.cache.get(account.id);
      if (refresh || !cached || cached.revision !== account.revision || cached.tokenHash !== tokenHash || cached.until < Date.now()) {
        const repos = [];
        for (let page = 1; ; page++) {
          await assertCurrent();
          const chunk = await this.request(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, { connectionId: account.id, expectedConnection: account });
          await assertCurrent();
          repos.push(...chunk.map(repository));
          if (chunk.length < 100) break;
        }
        await assertCurrent();
        cached = { revision: account.revision, tokenHash, repos, until: Date.now() + 300000 }; this.cache.set(account.id, cached);
      }
      const current = await assertCurrent();
      result.push(...cached.repos.map(repo => ({ ...repo, githubConnectionId: account.id, connectionName: current.name || current.login, ...(current.companyId ? { companyId: current.companyId } : {}) })));
    }
    for (const validate of validations) await validate();
    if (this.connectionGeneration !== generation) throw listingChanged();
    const q = query.trim().toLowerCase();
    return result.filter(repo => repo.fullName.toLowerCase().includes(q));
  }
  async branches(name, connectionId, chatCompany) {
    repoName(name);
    if (this.companies && chatCompany) await this.companies.get(chatCompany);
    const branches = [];
    for (let page = 1; ; page++) {
      const chunk = await this.request(`/repos/${name}/branches?per_page=100&page=${page}`, { connectionId, chatCompany });
      branches.push(...chunk.map(branch => branch.name));
      if (chunk.length < 100) break;
    }
    return branches;
  }
  async resolveSelections(selections, { company } = {}) {
    if (!Array.isArray(selections) || !selections.length || selections.length > 100) throw fail("Select between 1 and 100 repositories");
    const primary = await this.requireConnection({ connectionId: selections[0]?.githubConnectionId, repository: repoName(selections[0]?.fullName), chatCompany: company });
    const chatCompany = company ?? (this.companies ? primary.companyId : undefined);
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
      resolved.push({ ...repository(repo), githubConnectionId: connectionId, ...(this.companies ? { companyId: chatCompany } : {}), branch, empty: repo.size === 0, cloneUrl: `https://github.com/${repo.full_name}.git`, directory: `${repo.full_name.replace("/", "--")}--${repo.id}` });
    }
    return resolved;
  }
  async tokenForRepository(repo, chat) { return (await this.requireConnection({ connectionId: repo.githubConnectionId, repository: repo.fullName, ...(chat ? { chatCompany: companyForChat(chat) } : {}) })).token; }
  async beginDevice(input = {}) {
    rejectLegacyScope(input);
    const result = this.queue.then(async () => {
      if (this.closed) throw fail("Relay is stopping. Retry after it restarts.", 503);
      if (input.token !== undefined || input.method !== undefined) throw fail("Use browser sign-in to connect GitHub.");
      const old = input.id ? await this.get(input.id) : null;
      const permissions = normalizePermissions(input.permissions, old?.requestedPermissions);
      const existing = [...this.pending.values()].find(flow => flow.connectionId === old?.id);
      if (existing) return { id: existing.id, connection: this.public(old) };
      if (this.pending.size >= 3) throw fail("Finish or cancel an existing GitHub sign-in first.", 429);
      if (old && input.revision !== (old.revision || 0)) throw fail("GitHub connection changed. Reload before signing in.", 409);
      const companyId = await this.companyForConnection(input, old);
      const connection = { ...old, id: old?.id || `github_${randomUUID()}`, ...(companyId ? { companyId } : {}), name: old?.name || "New GitHub account", token: old?.token || null, loginState: "starting", error: null, revision: (old?.revision || 0) + 1 };
      await this.put(connection);
      const flow = { id: randomUUID(), connectionId: connection.id, client: this.loginFactory(), code: null, permissions };
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
      const token = await flow.client.start(code => { if (this.pending.get(flow.id) === flow) flow.code = code; }, { scopes: permissionScopes(flow.permissions) });
      const commit = this.queue.then(async () => {
        if (this.pending.get(flow.id) !== flow || this.closed) return;
        const current = await this.get(connection.id);
        await this.connectUnlocked({ id: current.id, revision: current.revision, name: current.login ? current.name : undefined, token, permissions: flow.permissions }, { stillActive: () => this.pending.get(flow.id) === flow && !this.closed });
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
        const connected = Boolean(current.token && (!current.expiresAt || Date.parse(current.expiresAt) > Date.now()));
        await this.put({ ...current, loginState: connected ? "connected" : "disconnected", error: error instanceof GitHubLoginError ? new GitHubLoginError(error.code).message : error.statusCode ? error.message : "GitHub sign-in could not finish. Check the connection and try again." });
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
      const connected = Boolean(connection.token && (!connection.expiresAt || Date.parse(connection.expiresAt) > Date.now()));
      await this.put({ ...connection, loginState: connected ? "connected" : "disconnected", error: connected ? null : new GitHubLoginError("cancelled").message });
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
    rejectLegacyScope(input);
    if (input.token !== undefined || input.method !== undefined || input.expiresAt !== undefined) throw fail("Use browser sign-in to connect GitHub.");
    if (!input.id) throw fail("Sign in to GitHub before editing the connection.");
    if ([...this.pending.values()].some(flow => flow.connectionId === input.id)) throw fail("Finish or cancel sign-in before editing this connection.", 409);
    this.changed(input.id);
    return this.connect(input);
  }
}
