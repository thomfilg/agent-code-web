import { constants } from "node:fs";
import { mkdtemp, mkdir, open, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonRpcProcess } from "./json-rpc-process.mjs";

const failure = () => new Error("Codex authentication could not be completed. Enable device-code sign-in in your ChatGPT security settings (or ask your workspace administrator), then reconnect.");

// Only the controller uses this private, temporary native profile. The durable
// copy is an encrypted database record, not a host CLI or a worker auth.json.
export class CodexAccountClient {
  constructor(config, { rpcFactory = options => new JsonRpcProcess(options) } = {}) {
    this.config = config; this.rpcFactory = rpcFactory;
  }
  async start(auth = null) {
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
      await this.rpc.request("initialize", { clientInfo: { name: "agent_relay_account", version: "1.0" }, capabilities: { experimentalApi: true } });
      this.rpc.notify("initialized", {});
      return this;
    } catch { await this.close(); throw failure(); }
  }
  async login() {
    let loginId, early = [];
    const completed = new Promise((resolve, reject) => {
      this.loginFailure = () => reject(failure());
      const accept = params => { if (params.loginId === loginId) params.success ? resolve() : reject(failure()); };
      this.rpc.on("notification", message => {
        if (message.method !== "account/login/completed") return;
        if (loginId) accept(message.params); else early.push(message.params);
      });
      this.acceptLogin = value => { loginId = value; early.forEach(accept); early = []; };
    });
    completed.catch(() => {});
    try {
      const flow = await this.rpc.request("account/login/start", { type: "chatgptDeviceCode" });
      const url = new URL(flow.verificationUrl);
      if (flow.type !== "chatgptDeviceCode" || typeof flow.loginId !== "string" || !flow.loginId || flow.loginId.length > 200 ||
          url.origin !== "https://auth.openai.com" || url.pathname !== "/codex/device" || url.search || url.hash || url.username || url.password ||
          typeof flow.userCode !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(flow.userCode)) throw failure();
      this.loginId = flow.loginId; this.acceptLogin(flow.loginId);
      return { verificationUrl: url.href, userCode: flow.userCode, completed };
    } catch { this.loginFailure(); throw failure(); }
  }
  async snapshot({ refresh = false } = {}) {
    try {
      const { account } = await this.rpc.request("account/read", { refreshToken: refresh }, 15000);
      if (account?.type !== "chatgpt") throw failure();
      const file = await open(path.join(this.home, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw failure();
        const buffer = Buffer.alloc(262145);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 262144) throw failure();
        raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally { await file.close(); }
      const tokens = raw.tokens;
      for (const key of ["id_token", "access_token", "refresh_token", "account_id"]) {
        if (typeof tokens?.[key] !== "string" || !tokens[key] || tokens[key].length > 64000) throw failure();
      }
      if (tokens.account_id.length > 500) throw failure();
      // The native OAuth client has verified this token. Bind both the user
      // and workspace, not just the workspace shared by multiple members.
      const subject = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8")).sub;
      if (typeof subject !== "string" || !subject || subject.length > 500) throw failure();
      return { auth: { auth_mode: "chatgpt", OPENAI_API_KEY: null,
        tokens: Object.fromEntries(["id_token", "access_token", "refresh_token", "account_id"].map(key => [key, tokens[key]])),
        ...(typeof raw.last_refresh === "string" ? { last_refresh: raw.last_refresh } : {}) },
        subject,
        email: typeof account.email === "string" ? account.email.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 254) : null,
        plan: typeof account.planType === "string" ? account.planType.slice(0, 80) : null };
    } catch { throw failure(); }
  }
  async cancel() {
    if (this.loginId) await this.rpc.request("account/login/cancel", { loginId: this.loginId }, 5000).catch(() => {});
  }
  async close() {
    this.loginFailure?.(); this.loginFailure = null;
    try { await this.rpc?.stop(); }
    finally { if (this.directory) { await rm(this.directory, { recursive: true, force: true }); this.directory = null; } }
  }
}
