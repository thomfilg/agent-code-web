import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { SSH_WORKER_LAUNCHER, sshWorkerRequest } from "../../src/ssh-worker-launcher.mjs";
import { nativeTarget } from "./ec2-native-guards.mjs";
import { NativeAcceptanceError, nativeFailure, readRemoteNativeFailure } from "./ec2-native-worker.mjs";

export const operatorEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off", AWS_CONFIG_FILE: path.join(process.env.HOME, ".aws/config"), AWS_SHARED_CREDENTIALS_FILE: path.join(process.env.HOME, ".aws/credentials") });
export const awsArgs = args => ["--profile", nativeTarget.profile, "--region", nativeTarget.region, "--no-cli-pager", ...args];
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;

export function runPrivate(command, args, { env = operatorEnv(), input, timeout = 65000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, killer, closed = false, stopped = false, bytes = 0;
    const chunks = [];
    const stop = () => {
      if (closed || stopped) return; stopped = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      killer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 2000);
    };
    try { child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], detached: true }); }
    catch { reject(Error("Private acceptance subprocess could not start")); return; }
    const finish = (code, signalName) => {
      if (closed) return; closed = true; clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener("abort", stop);
      if (stopped || code !== 0 || signalName) reject(Error("Private acceptance subprocess failed; output suppressed"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    child.once("error", () => finish(1)); child.once("close", finish);
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 1048576) stop(); else chunks.push(chunk); });
    child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 1048576) stop(); });
    child.stdin.on("error", () => {});
    timer = setTimeout(stop, timeout); signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdin.end(input);
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

export async function openNativeTunnel(target, directory, plugin, { run = runPrivate, signal, spawnImpl = spawn, reserve = reservePort,
  kill = (child, name) => process.kill(-child.pid, name), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!/^i-[a-f0-9]{8,17}$/.test(target.workerId || "")) throw new NativeAcceptanceError("ssm-tunnel", "invalid-request");
  const port = await reserve();
  // A verified wrapper also refuses the historical secret-in-argv contract.
  // Pinned AWS CLI 2.35.20 uses the env-name contract with this pinned plugin.
  const bin = path.join(directory, "bin"); await mkdir(bin, { mode: 0o700 });
  const wrapper = `#!/bin/sh\n[ "$1" = --version ] || [ "$1" = AWS_SSM_START_SESSION_RESPONSE ] || exit 64\nexec ${quote(plugin.binary)} "$@"\n`;
  await writeFile(path.join(bin, "session-manager-plugin"), wrapper, { flag: "wx", mode: 0o700 });
  const params = { host: [target.host], portNumber: ["22"], localPortNumber: [String(port)] };
  // Public, exact disposable-worker identity permits narrowly scoped recovery
  // if interruption prevents the local process from observing its session ID.
  const child = spawnImpl("aws", awsArgs(["ssm", "start-session", "--target", nativeTarget.controller, "--reason", `agent-relay-acceptance:${target.workerId}`, "--document-name", "AWS-StartPortForwardingSessionToRemoteHost", "--parameters", JSON.stringify(params)]),
    { env: { ...operatorEnv(), PATH: bin + ":" + process.env.PATH }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let sessionId, tail = "", ended = false, startupError = false, closing;
  const closed = new Promise(resolve => { child.once("close", () => { ended = true; resolve(); }); child.once("error", () => { startupError = true; ended = true; resolve(); }); });
  const consume = chunk => {
    tail = (tail + chunk.toString()).slice(-16384);
    const match = tail.match(/Starting session with SessionId:\s*([A-Za-z0-9_-]{10,200})/);
    if (match) sessionId = match[1];
  };
  child.stdout.on("data", consume); child.stderr.on("data", consume); child.stdin.on("error", () => {});
  const close = () => closing ||= (async () => {
    signal?.removeEventListener("abort", abort);
    if (!ended) { try { kill(child, "SIGINT"); } catch {} }
    const timer = setTimeout(() => { if (!ended) try { kill(child, "SIGKILL"); } catch {} }, 5000);
    await closed; clearTimeout(timer);
    // Explicitly terminate only the session this process created, not others
    // owned by the profile. Never claim server-side cleanup without its ID.
    if (!sessionId) { if (!startupError) throw Error("SSM session cleanup could not be confirmed"); return; }
    await run("aws", awsArgs(["ssm", "terminate-session", "--session-id", sessionId]));
  })();
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (signal?.aborted || ended) throw Error("Native SSM tunnel ended before readiness");
      if (sessionId && tail.includes(`Port ${port} opened`)) return { port, close };
      await sleep(250);
    }
    throw Error("Native SSM tunnel startup timed out");
  } catch (error) {
    let sessionClosed = false;
    try { await close(); sessionClosed = true; } catch { /* Keep the primary startup failure; report cleanup separately. */ }
    throw nativeFailure(error, "ssm-tunnel", { sessionCloseAttempted: true, sessionClosed });
  }
}

export async function nativeProbeOverSsh({ options, directory, tunnel, request, first = false, run = runPrivate, signal }) {
  const source = await readFile(new URL("./ec2-native-worker.mjs", import.meta.url), "utf8");
  const header = sshWorkerRequest({ command: "/usr/bin/node", args: ["--input-type=module", "-e", source, "--", "--relay-native-probe"], cwd: "/opt/agent-web",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" }, heartbeat: "/opt/agent-web/.heartbeat" });
  const args = ["-F", "/dev/null", "-T", "-p", String(tunnel.port), "-i", options.sshKey,
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", `UserKnownHostsFile=${path.join(directory, "known_hosts")}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", `HostKeyAlias=native-${options.workerId}`, "-o", `StrictHostKeyChecking=${first ? "accept-new" : "yes"}`,
    "ubuntu@127.0.0.1", `/usr/bin/node --input-type=module -e ${quote(SSH_WORKER_LAUNCHER)}`];
  // Only code is in SSH argv. The access token is in the input stream, not
  // the launcher header, host environment, SSM payload, disk or command log.
  const output = await run("ssh", args, { input: header + JSON.stringify(request), timeout: request.action === "run" ? 280000 : 60000, signal });
  let receipt;
  try { receipt = JSON.parse(output); } catch { throw new NativeAcceptanceError("ssh-receipt", "invalid-receipt"); }
  readRemoteNativeFailure(receipt, request);
  return receipt;
}
