import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { SSH_WORKER_LAUNCHER, sshWorkerRequest } from "../../src/ssh-worker-launcher.mjs";
import { operatorEnv } from "./ec2-native-transport.mjs";

const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
export function spawnGuestWorker({ options, directory, tunnel, command, args, cwd, env, stdio = ["pipe", "pipe", "pipe"], spawnImpl = spawn }) {
  if (!Array.isArray(stdio) || !["pipe", "ignore"].includes(stdio[0])) throw Error("Guest transport requires private stdin");
  const sshArgs = ["-F", "/dev/null", "-T", "-p", String(tunnel.port), "-i", options.sshKey,
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", `UserKnownHostsFile=${path.join(directory, "known_hosts")}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", `HostKeyAlias=native-${options.workerId}`, "-o", "StrictHostKeyChecking=yes",
    "ubuntu@127.0.0.1", `/usr/bin/node --input-type=module -e ${quote(SSH_WORKER_LAUNCHER)}`];
  const child = spawnImpl("ssh", sshArgs, { stdio: ["pipe", ...stdio.slice(1)], detached: true, env: operatorEnv() });
  child.stdin.on("error", () => {});
  child.stdin.write(sshWorkerRequest({ command, args, cwd, env, heartbeat: "/opt/agent-web/.heartbeat" }));
  if (stdio[0] === "ignore") child.stdin.end();
  return child;
}

// Small fixture control stream. Browser frames still use production BrowserProcess.
export class GuestSiteControl {
  constructor(child) {
    this.child = child; this.pending = new Map(); this.sequence = 0; this.failed = false;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.deadline = setTimeout(() => this.fail(), 30000);
    let bytes = 0;
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 262144) this.fail(); });
    child.stderr.on("data", () => {}); // Guest private diagnostics are never logged.
    const lines = this.lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      if (this.failed) return;
      try {
        const message = JSON.parse(line);
        if (message.event === "ready") { clearTimeout(this.deadline); this.resolveReady(message.value); }
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id); clearTimeout(pending.timeout);
          message.error ? pending.reject(Object.assign(Error("Guest fixture command failed"), {
            ...(["ownership", "scan-incomplete", "chrome-active"].includes(message.diagnostic) ? { guestSiteCode: message.diagnostic } : {}),
          })) : pending.resolve(message.value);
        }
      } catch { this.fail(); }
    });
    child.once("error", () => this.fail());
    child.once("close", () => this.fail()); // stdout may still contain the final cleanup receipt at exit.
  }
  fail() {
    this.failed = true;
    this.lines?.close(); this.child.stdout.pause();
    clearTimeout(this.deadline); this.rejectReady(Error("Guest fixture disconnected"));
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(Error("Guest fixture disconnected")); }
    this.pending.clear();
  }
  async command(action) {
    await this.ready;
    if (this.failed) throw Error("Guest fixture disconnected");
    if (!["status", "sandbox", "refresh", "stop"].includes(action)) throw Error("Unsupported fixture command");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(Error("Guest fixture command timed out")); }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.child.stdin.write(JSON.stringify({ id, action }) + "\n", error => { if (error) this.fail(); }); }
      catch { this.fail(); }
    });
  }
}

export function guestExecutor(root, spawnRemote, browserSource) {
  const safePath = "/usr/local/bin:/usr/bin:/bin";
  return { workspace: `${root}/workspace`, runtimeHome: `${root}/runtime-home`, environmentPath: safePath,
    metadata: { backend: "ec2", fixture: true },
    spawn(command, args, options = {}) {
      // The fixture does not expose arbitrary model, shell, installer or AWS
      // commands. SharedBrowsers uses the explicit baked Chrome --version and
      // the unchanged built-in-only browser-worker source.
      const version = command === "/usr/bin/google-chrome" && args.length === 1 && args[0] === "--version";
      const browser = typeof browserSource === "string" && command === "node" && args.length === 3 && args[0] === "--input-type=module" && args[1] === "-e" && args[2] === browserSource + "\nawait runBrowserWorker();";
      if (!version && !browser || options.cwd !== `${root}/workspace`) throw Error("Unexpected command in guest Chrome acceptance");
      return spawnRemote({ command: version ? command : "/usr/bin/node", args, cwd: options.cwd,
        env: { PATH: safePath, HOME: `${root}/runtime-home`, TMPDIR: `${root}/tmp`, LANG: "C.UTF-8", AGENT_CHROME_BIN: "/usr/bin/google-chrome" }, stdio: options.stdio });
    },
  };
}
