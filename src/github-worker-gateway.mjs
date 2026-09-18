import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { CapabilityBroker } from "./capabilities.mjs";
import { companyForChat } from "../public/company-scope.js";

const PREFIX = "/gateway/github/git/", MAX_REQUEST = 32 * 1024 * 1024, MAX_RESPONSE = 256 * 1024 * 1024;
const fail = (statusCode = 403) => Object.assign(new Error("GitHub worker access is unavailable. Resume the chat or reconnect GitHub."), { statusCode });
const owner = value => value ?? null;
const connectionKey = (ownerId, id) => JSON.stringify([owner(ownerId), id]);
const tokenHash = token => createHash("sha256").update(token).digest("hex");
const publicRepo = repo => ({ id: repo.id, fullName: repo.fullName });
function selection(chat) {
  if (!chat || chat.archived || chat.workflowState === "archived" || !Array.isArray(chat.repositories) || chat.repositories.length > 100) throw fail();
  const seen = new Set();
  const repositories = chat.repositories.map(repo => {
    if (!Number.isSafeInteger(repo.id) || repo.id <= 0 || seen.has(repo.id) ||
      typeof repo.fullName !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.fullName) ||
      repo.fullName.split("/").some(part => part === "." || part === "..") || typeof repo.githubConnectionId !== "string") throw fail();
    seen.add(repo.id);
    return { id: repo.id, fullName: repo.fullName, githubConnectionId: repo.githubConnectionId, branch: repo.branch, defaultBranch: repo.defaultBranch };
  });
  return { ownerId: owner(chat.ownerId), company: companyForChat(chat), repositories };
}
function endpoint(origin) {
  let url; try { url = new URL(origin); } catch { throw fail(400); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw fail(400);
  return url.origin;
}
function gitEnvironment(origin, repositories, token) {
  const root = `${endpoint(origin)}${PREFIX}`;
  const entries = [
    [`http.${root}.extraHeader`, ""], // Clear inherited HTTP headers in this scope.
    [`http.${root}.extraHeader`, `Authorization: Bearer ${token}`],
    [`http.${root}.followRedirects`, "false"],
    [`http.${root}.sslVerify`, "true"],
    ["credential.helper", ""],
    ...repositories.map(repo => [`url.${root}${repo.id}.git.insteadOf`, `https://github.com/${repo.fullName}.git`]),
  ];
  return Object.fromEntries([["GIT_CONFIG_COUNT", String(entries.length)], ["GIT_TERMINAL_PROMPT", "0"],
    ...entries.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])]);
}
function bearer(request) {
  if (request.headers.origin || request.rawHeaders?.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === "authorization").length !== 1) throw fail(401);
  const match = /^Bearer (cap_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || "");
  if (!match) throw fail(401);
  return match[1];
}
async function requestBody(request, signal) {
  const encoding = request.headers["content-encoding"];
  if (encoding && encoding !== "gzip" && encoding !== "identity") throw fail(415);
  if (request.headers["content-length"] && (!/^\d+$/.test(request.headers["content-length"]) || Number(request.headers["content-length"]) > MAX_REQUEST)) throw fail(413);
  const chunks = []; let bytes = 0;
  const abort = () => request.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of request) {
      if (signal.aborted) throw fail(403);
      bytes += chunk.length; if (bytes > MAX_REQUEST) throw fail(413);
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (encoding !== "gzip") return buffer;
    try { return gunzipSync(buffer, { maxOutputLength: MAX_REQUEST }); } catch { throw fail(413); }
  } finally { signal.removeEventListener("abort", abort); }
}

// This broker is intentionally independent of model-provider capabilities.
// No worker-controlled URL, credential, company or connection ID is accepted.
export class GitHubWorkerGateway {
  constructor({ store, servicesFor, ttlMs = 300000, fetchImpl = fetch, now = Date.now }) {
    this.store = store; this.servicesFor = servicesFor; this.fetch = fetchImpl;
    this.broker = new CapabilityBroker({ ttlMs, now });
    this.entries = new Map(); this.generations = new Map(); this.connectionEpochs = new Map(); this.active = 0; this.closed = false;
  }
  revokeChat(chatId) {
    this.generations.set(chatId, (this.generations.get(chatId) || 0) + 1);
    const entry = this.entries.get(chatId);
    if (entry) { this.entries.delete(chatId); for (const controller of entry.controllers) controller.abort(); }
    this.broker.revokeChat(chatId);
  }
  revokeConnection(ownerId, connectionId) {
    const key = connectionKey(ownerId, connectionId);
    this.connectionEpochs.set(key, (this.connectionEpochs.get(key) || 0) + 1);
    for (const [id, entry] of this.entries) if (entry.snapshot.ownerId === owner(ownerId) && entry.connections.has(connectionId)) this.revokeChat(id);
  }
  shutdown() { this.closed = true; for (const id of this.entries.keys()) this.revokeChat(id); }
  sameChat(entry) {
    try { return !this.closed && entry.validWhile() === true && this.generations.get(entry.chatId) === entry.generation && JSON.stringify(selection(this.store.get(entry.chatId))) === entry.fingerprint; }
    catch { return false; }
  }
  async runtime(chatId, origin, { validWhile = () => true } = {}) {
    this.revokeChat(chatId);
    const chat = this.store.get(chatId), snapshot = selection(chat), generation = this.generations.get(chatId);
    if (!snapshot.repositories.length) return { token: null, environmentVariables: {}, repositories: [] };
    endpoint(origin);
    const { github } = await this.servicesFor(chat);
    const entry = { chatId, snapshot, fingerprint: JSON.stringify(snapshot), generation, validWhile, github, connections: new Map(), controllers: new Set() };
    for (const repo of snapshot.repositories) {
      await github.queue;
      const epoch = this.connectionEpochs.get(connectionKey(snapshot.ownerId, repo.githubConnectionId)) || 0;
      const record = await github.requireConnection({ connectionId: repo.githubConnectionId, repository: repo.fullName, chatCompany: snapshot.company });
      if (!this.sameChat(entry)) throw fail();
      entry.connections.set(record.id, { revision: record.revision || 0, tokenHash: tokenHash(record.token), epoch });
    }
    await this.assertConnections(entry);
    if (!this.sameChat(entry)) throw fail();
    this.entries.set(chatId, entry);
    const token = this.broker.issue({ chatId, provider: "github-worker", renewable: true, validWhile: () => this.sameChat(entry) });
    return { token, environmentVariables: gitEnvironment(origin, snapshot.repositories, token), repositories: snapshot.repositories.map(publicRepo) };
  }
  entry(token) {
    const grant = this.broker.validate(token, "github-worker"), entry = grant && this.entries.get(grant.chatId);
    if (!entry || !this.sameChat(entry)) throw fail(401);
    return entry;
  }
  async assertConnections(entry) {
    await entry.github.queue;
    for (const repo of entry.snapshot.repositories) {
      const expected = entry.connections.get(repo.githubConnectionId);
      const record = await entry.github.requireConnection({ connectionId: repo.githubConnectionId, repository: repo.fullName, chatCompany: entry.snapshot.company });
      if (!expected || expected.revision !== (record.revision || 0) || expected.tokenHash !== tokenHash(record.token) || expected.epoch !== (this.connectionEpochs.get(connectionKey(entry.snapshot.ownerId, record.id)) || 0)) throw fail();
    }
    if (!this.sameChat(entry)) throw fail();
  }
  async listRepositories(token) {
    const entry = this.entry(token); await this.assertConnections(entry); this.entry(token);
    return entry.snapshot.repositories.map(publicRepo);
  }
  async withRepository(token, repositoryId, callback) {
    const entry = this.entry(token), repo = entry.snapshot.repositories.find(value => value.id === repositoryId);
    if (!repo) throw fail(403);
    if (entry.controllers.size >= 2 || this.active >= 4) throw fail(429);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 120000); timeout.unref();
    entry.controllers.add(controller); this.active++;
    const assertCurrent = async () => {
      if (controller.signal.aborted || this.entry(token) !== entry) throw fail();
      await this.assertConnections(entry);
      if (controller.signal.aborted || this.entry(token) !== entry) throw fail();
    };
    try {
      await assertCurrent();
      const identity = await entry.github.request(`/repos/${repo.fullName}`, { connectionId: repo.githubConnectionId, chatCompany: entry.snapshot.company, signal: controller.signal });
      if (identity.id !== repo.id || identity.full_name?.toLowerCase() !== repo.fullName.toLowerCase()) throw fail();
      await assertCurrent();
      const result = await callback({ github: entry.github, repository: { ...repo }, connectionId: repo.githubConnectionId, chatCompany: entry.snapshot.company, signal: controller.signal, assertCurrent });
      await assertCurrent(); return result;
    } catch (error) {
      throw fail([400, 401, 403, 404, 409, 413, 415, 429, 502].includes(error?.statusCode) ? error.statusCode : 502);
    } finally { clearTimeout(timeout); controller.abort(); entry.controllers.delete(controller); this.active--; }
  }
  async handle(request, response, url) {
    if (!url.pathname.startsWith(PREFIX)) return false;
    try {
      // Reject normalization ambiguities and every operation outside smart HTTP.
      const match = /^\/gateway\/github\/git\/([1-9]\d*)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (!match || request.url !== url.pathname + url.search || !Number.isSafeInteger(Number(match[1]))) throw fail(404);
      const [, id, operation] = match, token = bearer(request);
      let service;
      if (operation === "info/refs") {
        if (request.method !== "GET" || !/^\?service=git-(upload|receive)-pack$/.test(url.search)) throw fail(400);
        service = url.search.slice("?service=".length);
      } else {
        service = operation;
        if (request.method !== "POST" || url.search || request.headers["content-type"] !== `application/x-${service}-request`) throw fail(400);
      }
      const gitProtocol = request.headers["git-protocol"];
      if (gitProtocol && !/^version=[12]$/.test(gitProtocol)) throw fail(400);
      await this.withRepository(token, Number(id), async ({ github, repository, connectionId, chatCompany, signal: grantSignal, assertCurrent }) => {
        const disconnected = new AbortController(), signal = AbortSignal.any([grantSignal, disconnected.signal]);
        const onClose = () => { if (!response.writableFinished) disconnected.abort(); };
        response.once("close", onClose);
        try {
        const body = request.method === "POST" ? await requestBody(request, signal) : undefined;
        await assertCurrent();
        const connection = await github.requireConnection({ connectionId, repository: repository.fullName, chatCompany });
        await assertCurrent();
        const upstream = await this.fetch(`https://github.com/${repository.fullName}.git/${operation}${url.search}`, {
          method: request.method, redirect: "error", signal,
          headers: { authorization: `Basic ${Buffer.from(`x-access-token:${connection.token}`).toString("base64")}`, "user-agent": "agent-code-web",
            ...(body !== undefined ? { "content-type": `application/x-${service}-request` } : {}), ...(gitProtocol ? { "git-protocol": gitProtocol } : {}) },
          ...(body !== undefined ? { body } : {}),
        });
        await assertCurrent();
        const expectedType = `application/x-${service}-${operation === "info/refs" ? "advertisement" : "result"}`;
        if (upstream.status !== 200 || upstream.headers.get("content-type")?.split(";")[0] !== expectedType || !upstream.body) {
          await upstream.body?.cancel(); throw fail(upstream.status === 401 || upstream.status === 403 ? 403 : 502);
        }
        response.writeHead(200, { "content-type": expectedType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        let bytes = 0;
        const bound = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; done(bytes > MAX_RESPONSE ? fail(413) : null, chunk); } });
        await pipeline(Readable.fromWeb(upstream.body), bound, response, { signal });
        } finally { response.removeListener("close", onClose); }
      });
    } catch (error) {
      if (response.headersSent) response.destroy();
      else { response.writeHead([400, 401, 403, 404, 409, 413, 415, 429, 502].includes(error?.statusCode) ? error.statusCode : 502, { "content-type": "text/plain", "cache-control": "no-store" }); response.end("GitHub worker request denied. Resume the chat or reconnect GitHub.\n"); }
    }
    return true;
  }
}
