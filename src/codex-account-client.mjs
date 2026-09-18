import { constants } from "node:fs";
import { mkdtemp, mkdir, open, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JsonRpcProcess } from "./json-rpc-process.mjs";

const messages = {
  startup_timeout: "Starting Codex sign-in took too long. Try again.",
  startup_failed: "The server could not start Codex sign-in. Try again or contact the Relay administrator.",
  code_timeout: "Timed out waiting for a Codex sign-in code. Try again.",
  code_failed: "Could not get a Codex sign-in code. Try again.",
  device_disabled: "Device-code sign-in is disabled for this account. Enable it in ChatGPT security settings or ask your workspace administrator.",
  unsupported_response: "This server's Codex version could not complete sign-in. Contact the Relay administrator.",
  verification_timeout: "Codex account verification timed out. Reconnect and try again.",
  account_unavailable: "Codex did not provide a signed-in account. Reconnect and try again.",
  credentials_unavailable: "The server could not safely read Codex credentials. Reconnect or contact the Relay administrator.",
  credentials_invalid: "Codex returned credentials that this server could not verify. Reconnect or contact the Relay administrator.",
  authentication: "Codex authentication could not be completed. Try signing in again.",
};
export class CodexAccountError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : "authentication";
    super(messages[safeCode]); this.code = safeCode;
  }
}
const failure = () => new CodexAccountError("authentication");
const timeout = error => /timed out after \d+ms$/.test(error?.message || "");

// Only the controller uses this private, temporary native profile. The durable
// copy is an encrypted database record, not a host CLI or a worker auth.json.
export class CodexAccountClient {
  constructor(config, { rpcFactory = options => new JsonRpcProcess(options), accountReadyTimeoutMs = 15000, accountReadyRetryMs = 100 } = {}) {
    Object.assign(this, { config, rpcFactory, accountReadyTimeoutMs, accountReadyRetryMs });
  }
  async start(auth = null) {
    this.loginCompleted = false; this.closed = false;
    this.directory = await mkdtemp(path.join(os.tmpdir(), "relay-codex-login-"));
    this.home = path.join(this.directory, "codex");
    try {
      await mkdir(this.home, { mode: 0o700 });
      if (auth) await writeFile(path.join(this.home, "auth.json"), JSON.stringify(auth), { mode: 0o600, flag: "wx" });
      this.rpc = this.rpcFactory({ command: this.config.codex.bin,
        args: ["app-server", "-c", 'cli_auth_credentials_store="file"'],
        isolation: this.config.processIsolation, requestTimeoutMs: 15000,
        spawnOptions: { cwd: this.directory, env: { PATH: process.env.PATH, HOME: this.directory, CODEX_HOME: this.home, LANG: "C.UTF-8", NO_COLOR: "1" } } });
      // Never publish native errors, stderr, URLs or protocol output to logs.
      this.rpc.on("error", () => this.loginFailure?.());
      this.rpc.on("exit", () => this.loginFailure?.());
      this.rpc.on("request", message => this.rpc.respondError(message.id, -32601, "Authentication only"));
      this.rpc.start();
      // Native startup can exceed the ordinary RPC deadline on a busy host.
      // Keep this bounded, but separate it from quick account/status requests.
      await this.rpc.request("initialize", { clientInfo: { name: "agent_relay_account", version: "1.0" }, capabilities: { experimentalApi: true } }, 60000);
      this.rpc.notify("initialized", {});
      return this;
    } catch (error) { await this.close(); throw new CodexAccountError(timeout(error) ? "startup_timeout" : "startup_failed"); }
  }
  async login() {
    this.loginCompleted = false;
    let loginId, early = [];
    const completed = new Promise((resolve, reject) => {
      this.loginFailure = () => reject(failure());
      const accept = params => {
        if (params.loginId !== loginId) return;
        if (params.success === true) { this.loginCompleted = true; resolve(); }
        else reject(failure());
      };
      this.rpc.on("notification", message => {
        if (message.method !== "account/login/completed") return;
        if (loginId) accept(message.params); else early.push(message.params);
      });
      this.acceptLogin = value => { loginId = value; early.forEach(accept); early = []; };
    });
    completed.catch(() => {});
    try {
      const flow = await this.rpc.request("account/login/start", { type: "chatgptDeviceCode" }, 60000);
      let url;
      try { url = new URL(flow.verificationUrl); } catch { throw new CodexAccountError("unsupported_response"); }
      if (flow.type !== "chatgptDeviceCode" || typeof flow.loginId !== "string" || !flow.loginId || flow.loginId.length > 200 ||
          url.origin !== "https://auth.openai.com" || url.pathname !== "/codex/device" || url.search || url.hash || url.username || url.password ||
          typeof flow.userCode !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(flow.userCode)) throw new CodexAccountError("unsupported_response");
      this.loginId = flow.loginId; this.acceptLogin(flow.loginId);
      return { verificationUrl: url.href, userCode: flow.userCode, completed };
    } catch (error) {
      this.loginFailure();
      if (error instanceof CodexAccountError) throw error;
      const disabled = /device[- ]code.*(?:disabled|not enabled|not allowed)|(?:enable|allow).*device[- ]code/i.test(error?.message || "");
      throw new CodexAccountError(timeout(error) ? "code_timeout" : disabled ? "device_disabled" : "code_failed");
    }
  }
  async snapshot({ refresh = false } = {}) {
    let stage = "account_unavailable";
    try {
      // The native app-server can announce successful device consent before
      // reloading its account cache. In 0.154.0, account/read may briefly return
      // null even though auth.json has already been written. Only retry this
      // specific transition after matching native success; a file or another
      // account type must never establish consent on its own.
      const deadline = this.loginCompleted ? Date.now() + this.accountReadyTimeoutMs : null;
      let account, firstRead = true;
      for (;;) {
        if (this.closed) throw new CodexAccountError("account_unavailable");
        const remaining = deadline === null ? 15000 : deadline - Date.now();
        if (remaining <= 0) throw new CodexAccountError("verification_timeout");
        ({ account } = await this.rpc.request("account/read", { refreshToken: firstRead && refresh }, Math.min(15000, remaining)));
        firstRead = false;
        if (account?.type === "chatgpt") break;
        if (account !== null || !this.loginCompleted) throw new CodexAccountError("account_unavailable");
        await delay(Math.min(this.accountReadyRetryMs, Math.max(0, deadline - Date.now())));
      }
      stage = "credentials_unavailable";
      const file = await open(path.join(this.home, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw new CodexAccountError(stage);
        const buffer = Buffer.alloc(262145);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 262144) throw new CodexAccountError(stage);
        stage = "credentials_invalid";
        raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally { await file.close(); }
      const tokens = raw.tokens;
      for (const key of ["id_token", "access_token", "refresh_token", "account_id"]) {
        if (typeof tokens?.[key] !== "string" || !tokens[key] || tokens[key].length > 64000) throw new CodexAccountError(stage);
      }
      if (tokens.account_id.length > 500) throw new CodexAccountError(stage);
      // The native OAuth client has verified this token. Bind both the user
      // and workspace, not just the workspace shared by multiple members.
      const subject = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8")).sub;
      if (typeof subject !== "string" || !subject || subject.length > 500) throw new CodexAccountError(stage);
      return { auth: { auth_mode: "chatgpt", OPENAI_API_KEY: null,
        tokens: Object.fromEntries(["id_token", "access_token", "refresh_token", "account_id"].map(key => [key, tokens[key]])),
        ...(typeof raw.last_refresh === "string" ? { last_refresh: raw.last_refresh } : {}) },
        subject,
        email: typeof account.email === "string" ? account.email.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 254) : null,
        plan: typeof account.planType === "string" ? account.planType.slice(0, 80) : null };
    } catch (error) {
      if (error instanceof CodexAccountError) throw new CodexAccountError(error.code);
      throw new CodexAccountError(stage === "account_unavailable" && timeout(error) ? "verification_timeout" : stage);
    }
  }
  async cancel() {
    if (this.loginId) await this.rpc.request("account/login/cancel", { loginId: this.loginId }, 5000).catch(() => {});
  }
  async close() {
    this.closed = true;
    this.loginFailure?.(); this.loginFailure = null;
    try { await this.rpc?.stop(); }
    finally { if (this.directory) { await rm(this.directory, { recursive: true, force: true }); this.directory = null; } }
  }
}
