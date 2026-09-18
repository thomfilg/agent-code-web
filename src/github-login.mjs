import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const messages = {
  start: "GitHub sign-in could not start. Ask the Relay administrator to check the GitHub CLI and network, then retry.",
  timeout: "GitHub sign-in expired. Try again to get a new code.",
  denied: "GitHub sign-in was denied or could not finish. Try again.",
  cancelled: "GitHub sign-in cancelled. You can reconnect when ready.",
};
export class GitHubLoginError extends Error {
  constructor(code = "start") { super(messages[code] || messages.start); this.code = code in messages ? code : "start"; }
}

// Never inherit credentials, a keyring session, browser, git configuration or a
// global gh profile. --insecure-storage is deliberate: gh writes only inside
// this 0700 temporary profile; the controller seals the token and removes it.
export function githubLoginEnvironment(directory, env = process.env) {
  return {
    PATH: env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    HOME: directory, XDG_CONFIG_HOME: directory, GH_CONFIG_DIR: path.join(directory, "gh"),
    GH_BROWSER: "/bin/true", BROWSER: "/bin/true", GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1", TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export class GitHubLogin {
  constructor({ executable = "gh", spawnImpl = spawn, runImpl = run, directory = os.tmpdir(), timeoutMs = 900_000, startupTimeoutMs = 60_000 } = {}) {
    Object.assign(this, { executable, spawn: spawnImpl, run: runImpl, directory, timeoutMs, startupTimeoutMs });
    this.closed = false;
  }
  async start(onCode) {
    this.profile = await mkdtemp(path.join(this.directory, "relay-gh-login-"));
    await chmod(this.profile, 0o700);
    if (this.closed) { await this.cleanup(); throw new GitHubLoginError("cancelled"); }
    this.env = githubLoginEnvironment(this.profile);
    return new Promise((resolve, reject) => {
      let output = "", codeSent = false, settled = false;
      const finish = async (error, token) => {
        if (settled) return; settled = true; clearTimeout(this.timer); clearTimeout(this.startupTimer);
        await this.cleanup(); error ? reject(error) : resolve(token);
      };
      this.fail = reason => { this.failure = new GitHubLoginError(reason); void this.close(); };
      try { this.child = this.spawn(this.executable, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--insecure-storage"], { env: this.env, cwd: this.profile, stdio: ["ignore", "pipe", "pipe"] }); }
      catch { void finish(new GitHubLoginError()); return; }
      const consume = chunk => {
        output = (output + chunk.toString()).slice(-16_384);
        const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?![A-Z0-9-])/i.exec(output)?.[1];
        if (!codeSent && code) {
          codeSent = true; clearTimeout(this.startupTimer);
          // The host is fixed above. Never relay arbitrary CLI URLs or output.
          onCode({ userCode: code.toUpperCase(), verificationUrl: "https://github.com/login/device", expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() });
        }
      };
      this.child.stdout.on("data", consume); this.child.stderr.on("data", consume);
      this.child.once("error", () => { this.ended = true; void finish(new GitHubLoginError()); });
      this.child.once("close", async code => {
        this.ended = true;
        if (this.failure || this.closed) return finish(this.failure || new GitHubLoginError("cancelled"));
        if (code !== 0 || !codeSent) return finish(new GitHubLoginError(codeSent ? "denied" : "start"));
        try {
          const { stdout } = await this.run(this.executable, ["auth", "token", "--hostname", "github.com"], { env: this.env, cwd: this.profile, timeout: 10_000, maxBuffer: 8192 });
          const token = stdout.trim();
          if (this.closed) throw new GitHubLoginError("cancelled");
          if (!/^[A-Za-z0-9_]{10,1000}$/.test(token)) throw new GitHubLoginError("denied");
          await finish(null, token);
        } catch { await finish(new GitHubLoginError(this.closed ? "cancelled" : "denied")); }
      });
      this.timer = setTimeout(() => this.fail("timeout"), this.timeoutMs); this.timer.unref?.();
      this.startupTimer = setTimeout(() => this.fail("start"), this.startupTimeoutMs); this.startupTimer.unref?.();
    });
  }
  async cleanup() { if (this.profile) await rm(this.profile, { recursive: true, force: true }); }
  async close() {
    this.closed = true;
    if (this.child && !this.ended && this.child.exitCode === null && this.child.signalCode == null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000); timer.unref?.();
        this.child.once("close", () => { clearTimeout(timer); resolve(); });
        this.child.kill("SIGTERM");
      });
    }
    await this.cleanup();
  }
}
