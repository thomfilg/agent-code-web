import { constants } from "node:fs";
import { mkdtemp, mkdir, open, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { timingSafeEqual } from "node:crypto";
import { ClaudeControlChannel } from "./claude-mcp.mjs";
import { spawnWorker, terminateWorker } from "./worker-process.mjs";

const messages = {
  startup: "The server could not start Claude sign-in. Try again or contact the Relay administrator.",
  timeout: "Starting Claude sign-in took too long. Try again.",
  code: "Paste the complete code from this account's Claude sign-in page, including the part after #.",
  authentication: "Claude sign-in could not be verified. Reconnect this account.",
  expired: "Claude access expired. Reconnect this account; no other credentials were used.",
  temporary: "Claude is temporarily unavailable. Try this action again.",
};
export class ClaudeAccountError extends Error {
  constructor(code = "authentication") { const key = Object.hasOwn(messages, code) ? code : "authentication"; super(messages[key]); this.code = key; }
}
const validText = (value, limit = 64000) => typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x20\x7f]/.test(value);
const safeLabel = (value, limit) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, limit) : null;
export async function readClaudeAuth(filename) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw new ClaudeAccountError();
    const buffer = Buffer.alloc(262145), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 262144) throw new ClaudeAccountError();
    const oauth = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")).claudeAiOauth;
    if (!validText(oauth?.accessToken) || !validText(oauth?.refreshToken) || !Number.isSafeInteger(oauth.expiresAt) ||
      !Array.isArray(oauth.scopes) || oauth.scopes.length > 50 || !oauth.scopes.every(scope => validText(scope, 100)) || !oauth.scopes.includes("user:inference")) throw new ClaudeAccountError();
    return { claudeAiOauth: { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt,
      scopes: oauth.scopes, ...(Number.isSafeInteger(oauth.refreshTokenExpiresAt) ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt } : {}),
      ...(validText(oauth.clientId, 200) ? { clientId: oauth.clientId } : {}),
      subscriptionType: safeLabel(oauth.subscriptionType, 80), rateLimitTier: safeLabel(oauth.rateLimitTier, 80) } };
  } finally { await file.close(); }
}

// Native Claude owns PKCE and initial token exchange. A fresh controller-only
// profile cannot inherit a host login, hooks, MCP servers or repository config.
export class ClaudeAccountClient {
  constructor(config, { spawn = spawnWorker, fetchImpl = fetch, timeoutMs = 60000, now = Date.now } = {}) {
    Object.assign(this, { config, spawn, fetchImpl, timeoutMs, now }); this.children = new Set(); this.abort = new AbortController();
  }
  async start(auth = null) {
    this.directory = await mkdtemp(path.join(os.tmpdir(), "relay-claude-login-"));
    this.home = path.join(this.directory, "claude");
    try {
      await mkdir(this.home, { mode: 0o700 });
      if (auth) await writeFile(path.join(this.home, ".credentials.json"), JSON.stringify(auth), { flag: "wx", mode: 0o600 });
      this.env = { PATH: process.env.PATH, HOME: this.directory, CLAUDE_CONFIG_DIR: this.home, LANG: "C.UTF-8", NO_COLOR: "1", BROWSER: "/bin/true" };
      return this;
    } catch { await this.close(); throw new ClaudeAccountError("startup"); }
  }
  launch(args) {
    const child = this.spawn(this.config.claude.bin, args, { cwd: this.directory, env: this.env, isolation: this.config.processIsolation, stdio: ["pipe", "pipe", "pipe"] });
    this.children.add(child); child.once("close", () => this.children.delete(child)); child.stdin.on("error", () => {});
    return child;
  }
  async login() {
    const ready = Promise.withResolvers(), completed = Promise.withResolvers(); completed.promise.catch(() => {});
    this.completion = completed; let output = "", published = false;
    const timer = setTimeout(() => ready.reject(new ClaudeAccountError("timeout")), this.timeoutMs);
    try {
      const child = this.loginProcess = this.launch(["auth", "login", "--claudeai"]);
      child.on("error", () => { ready.reject(new ClaudeAccountError("startup")); completed.reject(new ClaudeAccountError()); });
      child.once("close", code => { code === 0 ? completed.resolve() : completed.reject(new ClaudeAccountError()); if (!published) ready.reject(new ClaudeAccountError("startup")); });
      const collect = chunk => {
        if (published) return;
        output += chunk.toString();
        if (output.length > 65536) { ready.reject(new ClaudeAccountError("startup")); return; }
        const match = /https:\/\/[^\s\x1b]+/.exec(output);
        if (!match || !/\s/.test(output.slice(match.index + match[0].length))) return;
        try {
          const url = new URL(match[0]);
          if (!(["https://claude.com/cai/oauth/authorize", "https://claude.ai/oauth/authorize"].includes(`${url.origin}${url.pathname}`)) || url.username || url.password || url.hash ||
            url.searchParams.get("redirect_uri") !== "https://platform.claude.com/oauth/code/callback" || url.searchParams.get("code_challenge_method") !== "S256" ||
            url.searchParams.get("response_type") !== "code" || !validText(url.searchParams.get("state"), 200) || !validText(url.searchParams.get("client_id"), 200)) throw new ClaudeAccountError();
          this.state = url.searchParams.get("state"); published = true; output = "";
          this.clientId = url.searchParams.get("client_id");
          ready.resolve({ verificationUrl: url.href, inputRequired: true, completed: completed.promise });
        } catch { ready.reject(new ClaudeAccountError("startup")); }
      };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      return await ready.promise;
    } finally { clearTimeout(timer); }
  }
  async submitCode(value) {
    if (!this.state || this.codeSubmitted || !this.loginProcess?.stdin.writable) throw new ClaudeAccountError("code");
    if (typeof value !== "string" || value.length > 4096) throw new ClaudeAccountError("code");
    const code = value.trim(), parts = code.split("#");
    if (parts.length !== 2 || !validText(parts[0], 2048) || !validText(parts[1], 200) || Buffer.byteLength(parts[1]) !== Buffer.byteLength(this.state) ||
      !timingSafeEqual(Buffer.from(parts[1]), Buffer.from(this.state))) throw new ClaudeAccountError("code");
    // The native manual-code handler does not compare the supplied state;
    // bind it here before writing to that specific pending process's stdin.
    this.codeSubmitted = true;
    await new Promise((resolve, reject) => this.loginProcess.stdin.write(`${code}\n`, error => error ? reject(new ClaudeAccountError()) : resolve()));
  }
  async initialize() {
    if (this.initialized) return this.initialized;
    const child = this.launch(["--print", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}']);
    child.on("error", () => {}); child.stderr.on("data", () => {});
    const channel = new ClaudeControlChannel(child, this.timeoutMs), lines = readline.createInterface({ input: child.stdout });
    lines.on("line", line => { if (line.length > 262144) return; try { channel.accept(JSON.parse(line)); } catch {} });
    try { this.initialized = await channel.request("initialize"); return this.initialized; }
    catch { throw new ClaudeAccountError(); }
    finally { channel.close(); lines.close(); await terminateWorker(child); }
  }
  async snapshot({ refresh = false, onCredentials = async () => {} } = {}) {
    try {
      let auth = await readClaudeAuth(path.join(this.home, ".credentials.json"));
      if (this.clientId) auth.claudeAiOauth.clientId = this.clientId;
      if (refresh || auth.claudeAiOauth.expiresAt < this.now() + 300000) {
        auth = await this.refresh(auth);
        // The provider may rotate its refresh token before profile verification.
        // Checkpoint it under the existing identity; deliver no access until
        // the new bearer has independently verified that identity below.
        await onCredentials(auth);
      }
      if (auth.claudeAiOauth.expiresAt <= this.now()) throw new ClaudeAccountError("expired");
      const response = await this.request("https://api.anthropic.com/api/oauth/profile", { headers: { Authorization: `Bearer ${auth.claudeAiOauth.accessToken}`, "Content-Type": "application/json", "Cache-Control": "no-cache" }, redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new ClaudeAccountError();
      const profile = await this.readResponse(response);
      if (!validText(profile.account?.uuid, 200) || !validText(profile.organization?.uuid, 200)) throw new ClaudeAccountError();
      return { auth, subject: profile.account.uuid, accountIdentity: profile.organization.uuid, email: safeLabel(profile.account.email, 254), plan: auth.claudeAiOauth.subscriptionType };
    } catch (error) { throw error instanceof ClaudeAccountError ? error : new ClaudeAccountError(); }
  }
  async request(url, options) {
    let response;
    try { response = await this.fetchImpl(url, { ...options, signal: AbortSignal.any([this.abort.signal, options.signal]) }); }
    catch { throw new ClaudeAccountError("temporary"); }
    if (response.status === 429 || response.status >= 500) { await response.body?.cancel().catch(() => {}); throw new ClaudeAccountError("temporary"); }
    return response;
  }
  async readResponse(response) {
    const decoder = new TextDecoder(); let text = "", bytes = 0;
    try { for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 262144) throw new ClaudeAccountError(); text += decoder.decode(chunk, { stream: true }); } return JSON.parse(text + decoder.decode()); }
    catch (error) { if (error instanceof ClaudeAccountError || error instanceof SyntaxError) throw error; throw new ClaudeAccountError("temporary"); }
    finally { await response.body?.cancel().catch(() => {}); }
  }
  async refresh(auth) {
    // The native SDK delegates renewal to its host; initialize/auth status do
    // not renew. Match the installed CLI's refresh grant, never send its
    // refresh token to an agent worker or an arbitrary configured endpoint.
    const oauth = auth.claudeAiOauth;
    const clientId = oauth.clientId || this.clientId || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
    const response = await this.request("https://platform.claude.com/v1/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: clientId, scope: oauth.scopes.join(" ") }), redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new ClaudeAccountError("expired");
    const result = await this.readResponse(response);
    const scopes = typeof result.scope === "string" && result.scope.length <= 5000 ? result.scope.split(" ").filter(Boolean) : [];
    if (!validText(result.access_token) || result.refresh_token !== undefined && !validText(result.refresh_token) || !Number.isSafeInteger(result.expires_in) || result.expires_in <= 0 || result.expires_in > 31536000 ||
      scopes.length > 50 || !scopes.every(scope => validText(scope, 100)) || !scopes.includes("user:inference")) throw new ClaudeAccountError();
    const refreshed = { claudeAiOauth: { ...oauth, accessToken: result.access_token, refreshToken: result.refresh_token || oauth.refreshToken, expiresAt: this.now() + result.expires_in * 1000,
      scopes, clientId,
      ...(Number.isSafeInteger(result.refresh_token_expires_in) && result.refresh_token_expires_in > 0 ? { refreshTokenExpiresAt: this.now() + result.refresh_token_expires_in * 1000 } : {}) } };
    await writeFile(path.join(this.home, ".credentials.json"), JSON.stringify(refreshed), { mode: 0o600 });
    return refreshed;
  }
  async models() { const { models } = await this.initialize(); if (!Array.isArray(models) || models.length > 100) throw new ClaudeAccountError(); return models; }
  async cancel() { this.abort.abort(); this.completion?.reject(new ClaudeAccountError()); await terminateWorker(this.loginProcess); }
  async close() {
    this.abort.abort(); this.completion?.reject(new ClaudeAccountError()); this.state = null;
    await Promise.all([...this.children].map(child => terminateWorker(child)));
    if (this.directory) { await rm(this.directory, { recursive: true, force: true }); this.directory = null; }
  }
}
