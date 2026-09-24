import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { spawnWorker } from "./worker-process.mjs";
import { SSH_WORKER_LAUNCHER, sshWorkerRequest } from "./ssh-worker-launcher.mjs";
import { assertWorkerImage } from "./worker-image.mjs";
import { hibernationAdmission, hibernationUnavailableError, workerHibernationAcceptance,
  workerHibernationAcceptanceId, workerHibernationCandidate } from "./worker-suspension.mjs";
import { workerImageTags } from "./worker-image.mjs";
import { WORKER_SUPERVISOR_CODE } from "./worker-supervisor-paths.mjs";
import { workerSupervisorFiles, workerSupervisorShell, workerSupervisorUnit, workerSupervisorVersion } from "./worker-supervisor-service.mjs";
import { RemoteBrowserAttemptCoordinator } from "./remote-browser-attempt.mjs";
import { ReconnectableBrowserProcess } from "./reconnectable-browser-process.mjs";
import { ReconnectableAgentProcess } from "./reconnectable-agent-process.mjs";
import { createSshWorkerProcessTransport } from "./ssh-worker-process-transport.mjs";
import { createHash, randomUUID } from "node:crypto";
import { validateWorkerInstanceType } from "./worker-instances.mjs";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function runCapture(command, args, { input = null, env = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code ?? signal}: ${stderr.slice(-4_000).trim()}`));
    });
    if (input !== null) child.stdin.end(input);
  });
}

class LocalExecutor {
  constructor({ chat, store, config, gatewayOrigin, browserTransport }) {
    this.workspace = chat.workspace;
    this.runtimeHome = store.runtimeHome(chat.id);
    this.gatewayOrigin = gatewayOrigin;
    this.config = config;
    this.chat = chat;
    this.browserTransport = browserTransport;
    this.metadata = { backend: "local", isolation: config.processIsolation };
    this.acquisitionReceipt = { mutation: "inspected", worker: { backend: "local" } };
  }

  spawn(command, args, options) {
    return spawnWorker(command, args, { ...options, isolation: this.config.processIsolation });
  }

  spawnAgent(command, args, options) {
    return this.spawn(command, args, options);
  }

  // Chrome keeps its native renderer sandbox. Mapping the launcher to UID 0
  // inside the CLI PID namespace would force disabling that sandbox.
  spawnBrowser(command, args, options) {
    if (this.browserTransport) return this.browserTransport.spawnBrowser(this.chat, command, args, options);
    return spawnWorker(command, args, { ...options, isolation: "none" });
  }

  mkdir(directory) {
    return mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

class LocalBackend {
  constructor({ store, config, gatewayOrigin, browserTransport }) {
    this.store = store;
    this.config = config;
    this.gatewayOrigin = gatewayOrigin;
    this.browserTransport = browserTransport;
  }

  async acquire(chat) {
    return new LocalExecutor({ chat, store: this.store, config: this.config, gatewayOrigin: this.gatewayOrigin, browserTransport: this.browserTransport });
  }

  async sleep() {}
  async destroy() {}
}

export class Ec2Executor {
  constructor({ backend, chat, instance, host, supervisorAvailable = false }) {
    this.backend = backend;
    this.chat = chat;
    this.instance = instance;
    this.host = host;
    this.workspace = `${backend.config.ec2.remoteRoot}/chats/${chat.id}/workspace`;
    this.runtimeHome = `${backend.config.ec2.remoteRoot}/chats/${chat.id}/runtime-home`;
    this.heartbeat = `${backend.config.ec2.remoteRoot}/.heartbeat`;
    this.gatewayOrigin = backend.config.ec2.gatewayOrigin;
    this.supervisorAvailable = supervisorAvailable;
    this.metadata = { backend: "ec2", instanceId: instance.InstanceId, instanceType: instance.InstanceType, host, imageId: instance.ImageId,
      ...(typeof instance.LaunchTime === "string" && Number.isFinite(Date.parse(instance.LaunchTime)) ? { launchTime: instance.LaunchTime } : {}) };
  }

  async prepare(check = () => {}) {
    const chatRoot = path.posix.dirname(this.workspace);
    const marker = `${chatRoot}/.workspace-seeded`;
    check(); await this.backend.sshCapture(this.host, `install -d -m 700 ${shellQuote(this.workspace)} ${shellQuote(this.runtimeHome)} && touch ${shellQuote(this.heartbeat)}`, this.instance.InstanceId);
    check();
    const seeded = await this.backend.sshCapture(this.host, `test -f ${shellQuote(marker)} && printf ready || true`, this.instance.InstanceId);
    check();
    if (seeded === "ready") {
      for (const repo of this.chat.repositories || []) {
        if (!/^[A-Za-z0-9_.-]+--[A-Za-z0-9_.-]+$/.test(repo.directory)) throw new Error("Invalid repository directory");
        const target = `${this.workspace}/${repo.directory}`;
        const exists = await this.backend.sshCapture(this.host, `test -e ${shellQuote(target)} && printf ready || true`, this.instance.InstanceId);
        check();
        if (exists !== "ready") await this.#uploadWorkspace(marker, repo.directory);
      }
      if (this.supervisorAvailable) await this.#prepareSupervisor(check);
      return;
    }
    await this.#uploadWorkspace(marker);
    if (this.supervisorAvailable) await this.#prepareSupervisor(check);
  }

  spawn(command, args, options = {}) {
    const { env, stdio } = this.#remoteOptions(options);
    // Never put account tokens, gateway capabilities or native MCP arguments in
    // the controller's SSH argv. The fixed launcher consumes one private frame,
    // then hands the remaining stream to the CLI unchanged.
    const remote = `exec /usr/bin/node --input-type=module -e ${shellQuote(SSH_WORKER_LAUNCHER)}`;
    const child = spawn(this.backend.config.ec2.sshBin, [...this.backend.sshArgs(this.host, this.instance.InstanceId), remote], {
      stdio: ["pipe", ...stdio.slice(1)],
      detached: process.platform !== "win32",
    });
    child.stdin.on("error", () => {});
    child.stdin.write(sshWorkerRequest({ command, args, cwd: options.cwd || this.workspace, env, heartbeat: this.heartbeat }));
    if (stdio[0] === "ignore") child.stdin.end();
    return child;
  }

  async spawnBrowser(command, args, options = {}) {
    if (!this.supervisorReady) return this.spawn(command, args, options);
    const { env, stdio } = this.#remoteOptions(options);
    if (stdio.some(value => value !== "pipe")) throw new Error("Reconnectable browser transport requires piped stdio");
    const context = await this.browserCoordinator.open(this.chat);
    const child = new ReconnectableBrowserProcess(context, 3000, this.backend.controllerLifetime);
    await child.start({ command, args, cwd: options.cwd || this.workspace, env });
    return child;
  }

  spawnAgent(command, args, options = {}) {
    if (!this.supervisorReady) return this.spawn(command, args, options);
    const { env, stdio } = this.#remoteOptions(options);
    if (stdio.some(value => value !== "pipe")) throw new Error("Reconnectable native-agent transport requires piped stdio");
    const context = this.browserCoordinator.open(this.chat, "native-agent");
    return new ReconnectableAgentProcess(context, { command, args, cwd: options.cwd || this.workspace, env }, this.backend.controllerLifetime,
      { recoverOnly: options.recoverOnly === true });
  }

  async stopRetainedAgent() {
    if (!this.supervisorReady) throw new Error("Reconnectable native-agent cleanup is unavailable");
    const child = this.spawnAgent("/usr/bin/false", [], { cwd: this.workspace, env: {}, stdio: ["pipe", "pipe", "pipe"], recoverOnly: true });
    await child.ready;
    await child.terminateRemote();
  }

  #remoteOptions(options) {
    const setupPath = options.env?.PATH?.startsWith(`${this.runtimeHome}/`) ? options.env.PATH : this.backend.config.ec2.remotePath;
    const env = { ...(options.env || {}), PATH: this.environmentPath || setupPath };
    const stdio = options.stdio || ["pipe", "pipe", "pipe"];
    if (!Array.isArray(stdio) || stdio.length !== 3 || !["pipe", "ignore"].includes(stdio[0])) throw new Error("Remote workers require pipe or ignored stdin");
    return { env, stdio };
  }

  mkdir(directory) {
    return this.backend.sshCapture(this.host, `install -d -m 700 ${shellQuote(directory)} && touch ${shellQuote(this.heartbeat)}`, this.instance.InstanceId).then(() => undefined);
  }

  async machineHealth() {
    // Fixed allowlisted probe: no environment, argv, cookies or command lines
    // are read or returned. The response is only aggregate host telemetry.
    const script = `const os=require("node:os"),fs=require("node:fs"),sample=()=>os.cpus().reduce((a,v)=>{const z=Object.values(v.times);return{i:a.i+v.times.idle,t:a.t+z.reduce((n,m)=>n+m,0)}},{i:0,t:0});let d=null,p=null;try{const s=fs.statfsSync(${JSON.stringify(this.workspace)});d={usedPercent:Math.round((1-Number(s.bavail)/Number(s.blocks||1))*100),freeBytes:Number(s.bavail)*Number(s.bsize)}}catch{}try{p=fs.readdirSync("/proc").filter(x=>/^\\d+$/.test(x)).length}catch{}const a=sample();setTimeout(()=>{const b=sample(),c=os.cpus(),t=os.totalmem(),f=os.freemem();process.stdout.write(JSON.stringify({cpu:{usedPercent:Math.round((1-(b.i-a.i)/((b.t-a.t)||1))*100)},cpuCount:c.length,load:os.loadavg().map(x=>Number(x.toFixed(2))),ram:{usedBytes:t-f,totalBytes:t,usedPercent:Math.round((1-f/t)*100)},disk:d,processCount:p}))},100)`;
    const output = await this.backend.sshCapture(this.host, `/usr/bin/node -e ${shellQuote(script)}`, this.instance.InstanceId, { timeoutMs: 5_000 });
    const result = JSON.parse(output);
    if (!Number.isFinite(result?.cpu?.usedPercent) || !Number.isSafeInteger(result?.cpuCount) || !Array.isArray(result?.load) || !Number.isFinite(result?.ram?.usedPercent)) throw new Error("Worker health response was invalid");
    return result;
  }

  async #prepareSupervisor(check) {
    const active = workerSupervisorShell("systemctl --user is-active --quiet agent-relay-worker-supervisor.service && printf active || true");
    check();
    let installed = false;
    if (await this.backend.sshCapture(this.host, active, this.instance.InstanceId) !== "active") {
      check(); await this.#uploadSupervisorCode(); check();
      const unit = Buffer.from(workerSupervisorUnit).toString("base64");
      const install = workerSupervisorShell(`test -d \"$XDG_RUNTIME_DIR\" && install -d -m 700 /home/agent/.config/systemd/user && printf %s ${shellQuote(unit)} | base64 -d > /home/agent/.config/systemd/user/agent-relay-worker-supervisor.service && chmod 600 /home/agent/.config/systemd/user/agent-relay-worker-supervisor.service && systemctl --user daemon-reload && systemctl --user enable --now agent-relay-worker-supervisor.service && systemctl --user is-active --quiet agent-relay-worker-supervisor.service`);
      await this.backend.sshCapture(this.host, install, this.instance.InstanceId); check();
      installed = true;
    }
    const readStatus = async () => {
      let status, statusFailure;
      for (let attempt = 0; attempt < 20; attempt++) {
        check();
        try { status = await this.#supervisorControl({ action: "status" }); statusFailure = null; break; }
        catch (error) { statusFailure = error; if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      if (statusFailure) throw new Error("EC2 worker supervisor did not open its control socket");
      return status;
    };
    let status = await readStatus();
    // v3 images predate lease-driven heartbeat refresh. Upgrade an idle daemon
    // in place before admitting a native process; never restart one that claims
    // retained work, because that would destroy its exact process identity.
    if (status?.leaseHeartbeat !== true) {
      if (status?.configured) throw new Error("EC2 worker supervisor requires an explicit Stop before its watchdog-safe upgrade");
      if (!installed) await this.#uploadSupervisorCode();
      const unit = Buffer.from(workerSupervisorUnit).toString("base64");
      const upgrade = workerSupervisorShell(`test -d \"$XDG_RUNTIME_DIR\" && install -d -m 700 /home/agent/.config/systemd/user && printf %s ${shellQuote(unit)} | base64 -d > /home/agent/.config/systemd/user/agent-relay-worker-supervisor.service && chmod 600 /home/agent/.config/systemd/user/agent-relay-worker-supervisor.service && systemctl --user daemon-reload && systemctl --user restart agent-relay-worker-supervisor.service && systemctl --user is-active --quiet agent-relay-worker-supervisor.service`);
      await this.backend.sshCapture(this.host, upgrade, this.instance.InstanceId); check();
      status = await readStatus();
    }
    let receipt;
    try { receipt = typeof status === "string" ? JSON.parse(status) : status; } catch { throw new Error("EC2 worker supervisor returned an invalid status receipt"); }
    if (receipt?.protocol !== "relay-worker-supervisor/1" || receipt.version !== workerSupervisorVersion || receipt.leaseHeartbeat !== true
      || typeof receipt.configured !== "boolean" || typeof receipt.daemonInstanceId !== "string") throw new Error("EC2 worker supervisor failed its startup check");
    const rawBootId = await this.backend.sshCapture(this.host, "cat /proc/sys/kernel/random/boot_id", this.instance.InstanceId);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(rawBootId)) throw new Error("EC2 worker returned an invalid boot identity");
    const bootId = createHash("sha256").update(rawBootId).digest("hex");
    this.metadata.bootId = bootId;
    if (this.acquisitionReceipt?.worker) this.acquisitionReceipt.worker.bootId = bootId;
    this.browserCoordinator = new RemoteBrowserAttemptCoordinator({ records: this.backend.store.records,
      deploymentId: this.backend.config.ec2.deployment, workerId: this.instance.InstanceId, bootId,
      controllerId: this.backend.controllerId, legacyOwnerId: this.backend.legacyOwnerId,
      control: request => this.#supervisorControl(request), connect: async ({ identity, credential }) =>
        createSshWorkerProcessTransport({ sshBin: this.backend.config.ec2.sshBin,
          sshArgs: this.backend.sshArgs(this.host, this.instance.InstanceId), expectedIdentity: identity, lease: credential }).connect() });
    this.supervisorReady = true;
  }

  #supervisorControl(request) {
    return this.backend.sshCapture(this.host, workerSupervisorShell(`exec /usr/bin/node ${WORKER_SUPERVISOR_CODE}/worker-supervisor-control.mjs`), this.instance.InstanceId,
      { input: JSON.stringify(request) }).then(output => {
        try { return JSON.parse(output); } catch { throw new Error("EC2 worker supervisor returned an invalid control receipt"); }
      });
  }

  #uploadSupervisorCode() {
    return new Promise((resolve, reject) => {
      const source = path.join(this.backend.config.appRoot, "src");
      const remote = `install -d -m 700 ${WORKER_SUPERVISOR_CODE} && tar -xf - -C ${WORKER_SUPERVISOR_CODE}`;
      let tar, ssh;
      try {
        tar = spawn("tar", ["-C", source, "-cf", "-", "--", ...workerSupervisorFiles], { stdio: ["ignore", "pipe", "pipe"] });
        ssh = spawn(this.backend.config.ec2.sshBin, [...this.backend.sshArgs(this.host, this.instance.InstanceId), remote], { stdio: ["pipe", "ignore", "pipe"] });
      } catch {
        const error = new Error("worker supervisor upload failed before transport started");
        if (!tar) { reject(error); return; }
        tar.stdout.resume(); tar.stderr.resume(); tar.once("error", () => {}); tar.once("close", () => reject(error)); tar.kill("SIGKILL"); return;
      }
      let tarCode, sshCode, failed = false;
      const stop = child => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
      const failUpload = () => { if (failed) return; failed = true; tar.stdout.unpipe(ssh.stdin); ssh.stdin.destroy(); stop(tar); stop(ssh); };
      const timer = setTimeout(failUpload, 60000); timer.unref();
      tar.stderr.resume(); ssh.stderr.resume(); tar.stdout.on("error", failUpload); ssh.stdin.on("error", failUpload); tar.once("error", failUpload); ssh.once("error", failUpload);
      const finish = () => {
        if (tarCode === undefined || sshCode === undefined) return;
        clearTimeout(timer);
        if (!failed && tarCode === 0 && sshCode === 0) resolve();
        else reject(new Error(`worker supervisor upload failed (tar=${tarCode}, ssh=${sshCode})`));
      };
      tar.once("close", code => { tarCode = code; if (code !== 0) failUpload(); finish(); });
      ssh.once("close", code => { sshCode = code; if (code !== 0) failUpload(); finish(); });
      tar.stdout.pipe(ssh.stdin);
    });
  }

  #uploadWorkspace(marker, directory = ".") {
    return new Promise((resolve, reject) => {
      const remote = `tar -xf - -C ${shellQuote(this.workspace)} && touch ${shellQuote(marker)} ${shellQuote(this.heartbeat)}`;
      let tar, ssh;
      try {
        const sshArgs = [...this.backend.sshArgs(this.host, this.instance.InstanceId), remote];
        tar = spawn("tar", ["-C", this.chat.workspace, "-cf", "-", "--", directory], { stdio: ["ignore", "pipe", "pipe"] });
        ssh = spawn(this.backend.config.ec2.sshBin, sshArgs, { stdio: ["pipe", "ignore", "pipe"] });
      } catch {
        const error = new Error("workspace upload failed before transport started; check worker configuration");
        if (!tar) { reject(error); return; }
        // A synchronous second-spawn failure still owns an archive process.
        tar.stdout.resume(); tar.stderr.resume();
        tar.once("error", () => {});
        tar.once("close", () => reject(error));
        tar.kill("SIGKILL");
        return;
      }
      let tarCode, sshCode, failure = false, killTimer;
      const terminate = child => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
      const fail = () => {
        if (failure) return;
        failure = true;
        tar.stdout.unpipe(ssh.stdin);
        ssh.stdin.destroy();
        terminate(tar); terminate(ssh);
        killTimer = setTimeout(() => {
          for (const child of [tar, ssh]) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 2000);
        killTimer.unref();
      };
      const timer = setTimeout(fail, 180000);
      // A closed SSH pipe must reject this upload, never become an unhandled
      // EPIPE on the controller. Drain diagnostics without retaining private
      // filenames or arbitrary subprocess output in application errors.
      tar.stderr.resume(); ssh.stderr.resume();
      tar.stdout.on("error", fail); ssh.stdin.on("error", fail);
      tar.once("error", fail); ssh.once("error", fail);
      const finish = () => {
        if (tarCode === undefined || sshCode === undefined) return;
        clearTimeout(timer); clearTimeout(killTimer);
        if (!failure && tarCode === 0 && sshCode === 0) resolve();
        else reject(new Error(`workspace upload failed (tar=${tarCode}, ssh=${sshCode}); check worker connectivity and retry`));
      };
      tar.once("close", (code) => { tarCode = code; if (code !== 0) fail(); finish(); });
      ssh.once("close", (code) => { sshCode = code; if (code !== 0) fail(); finish(); });
      tar.stdout.pipe(ssh.stdin);
    });
  }
}

export class Ec2Backend {
  constructor({ store, config, commandRunner = runCapture, legacyOwnerId = null }) {
    this.store = store;
    this.config = config;
    this.commandRunner = commandRunner;
    this.legacyOwnerId = legacyOwnerId;
    this.controllerId = randomUUID(); this.controllerLifetime = randomUUID();
    const required = {
      AGENT_EC2_AMI_ID: config.ec2.amiId,
      AGENT_EC2_DEPLOYMENT: config.ec2.deployment,
      AGENT_EC2_SUBNET_ID: config.ec2.subnetId,
      AGENT_EC2_SECURITY_GROUP_ID: config.ec2.securityGroupId,
      AGENT_EC2_KEY_NAME: config.ec2.keyName,
      AGENT_EC2_SSH_PRIVATE_KEY: config.ec2.sshPrivateKey,
    };
    const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`EC2 backend is missing: ${missing.join(", ")}`);
    if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(config.ec2.deployment)) throw new Error("Invalid AGENT_EC2_DEPLOYMENT");
    if (!/^[a-z_][a-z0-9_-]*$/.test(config.ec2.sshUser)) throw new Error("Invalid EC2 SSH user");
    if (!/^\/[A-Za-z0-9_/-]+$/.test(config.ec2.remoteRoot) || config.ec2.remoteRoot.includes("..") || config.ec2.remoteRoot === "/") throw new Error("Invalid EC2 remote root");
    if (config.ec2.usePublicIp) throw new Error("EC2 workers must use private addresses; public worker IPs are not supported");
    validateWorkerInstanceType(config.ec2.instanceType);
  }

  awsArgs(...args) {
    return [...(this.config.ec2.profile ? ["--profile", this.config.ec2.profile] : []), "--region", this.config.ec2.region, "--no-cli-pager", ...args];
  }

  sshArgs(host, instanceId) {
    if (isIP(host) !== 4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) throw new Error("EC2 worker SSH target must be a private IPv4 address");
    if (!/^i-[a-f0-9]{8,17}$/.test(instanceId || "")) throw new Error("SSH requires the verified worker instance ID");
    return [
      "-F", "/dev/null",
      "-T",
      "-i", this.config.ec2.sshPrivateKey,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${this.config.ec2.sshKnownHosts}`,
      "-o", `HostKeyAlias=${this.config.ec2.deployment}-${instanceId}`,
      "-o", "IdentitiesOnly=yes",
      "-o", "ForwardAgent=no",
      "-o", "ClearAllForwardings=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      `${this.config.ec2.sshUser}@${host}`,
    ];
  }

  sshCapture(host, remoteCommand, instanceId, options = {}) {
    return this.commandRunner(this.config.ec2.sshBin, [...this.sshArgs(host, instanceId), remoteCommand], { timeoutMs: 60_000, ...options });
  }

  async acquire(chat, { workspaceReady = Promise.resolve(), onStage = async () => {}, check = () => {}, onMutation = () => {}, action = "acquire", expectedWorker = null } = {}) {
    // Observe an early clone rejection while AWS/SSH is still in flight. The
    // same promise remains the mandatory join before any workspace upload.
    workspaceReady.catch(() => {});
    const stage = async (id, action) => {
      check(); await onStage(id, "running");
      try { check(); const value = await action(); check(); await onStage(id, "completed"); check(); return value; }
      catch (error) { try { await onStage(id, "failed"); } catch {} throw error; }
    };
    let instance, releaseAcquisition = async () => null, acquisitionMutation = "inspected";
    const mutated = (instanceId, mutation = "started", observed = null) => {
      // The closure owns one exact mutation target, never a later chat lookup.
      // Publish before further awaited admission checks, including cancellation.
      acquisitionMutation = mutation;
      let pending;
      releaseAcquisition = () => pending ||= this.#releaseAcquisition(instanceId, chat.id).catch(error => { pending = null; throw error; });
      onMutation({ instanceId, mutation, worker: { backend: "ec2", instanceId,
        ...(observed?.ImageId ? { imageId: observed.ImageId } : {}),
        ...(typeof observed?.LaunchTime === "string" && Number.isFinite(Date.parse(observed.LaunchTime)) ? { launchTime: observed.LaunchTime } : {}) },
        release: releaseAcquisition });
    };
    let acceptedImage;
    await stage("machine", async () => {
    instance = await this.#find(chat.id); check();
    if (action === "resume") {
      if (!instance || instance.InstanceId !== expectedWorker?.instanceId || instance.ImageId !== expectedWorker?.imageId
        || expectedWorker?.launchTime && instance.LaunchTime !== expectedWorker.launchTime
        || !["stopped", "stopping"].includes(instance.State?.Name) || instance.HibernationOptions?.Configured !== true) {
        throw new Error("EC2 resume worker identity changed; no replacement instance was started");
      }
    } else if (!instance) instance = await this.#create(chat.id, check, instanceId => mutated(instanceId, "created"), chat.workerInstanceType);
    // Existing/stopped workers retain their actual AMI, not necessarily the
    // currently configured one. A revoked marker denies new admission only;
    // sleep/destroy deliberately remain available for exact-owned cleanup.
    check(); acceptedImage = await this.#acceptedImage(instance.ImageId); check();
    if (this.config.idlePolicy === "hibernate" && !this.#hibernationEvidence(acceptedImage, instance).available) throw hibernationUnavailableError();
    if (instance.State?.Name === "stopping") {
      await this.#aws("ec2", "wait", "instance-stopped", "--instance-ids", instance.InstanceId);
      check();
      instance.State.Name = "stopped";
    }
    if (instance.State?.Name === "stopped") {
      instance = await this.#resizeStopped(instance, chat.id, chat.workerInstanceType || this.config.ec2.instanceType);
      mutated(instance.InstanceId, "started", instance);
      await this.#aws("ec2", "start-instances", "--instance-ids", instance.InstanceId);
      check();
    }
    await this.#aws("ec2", "wait", "instance-running", "--instance-ids", instance.InstanceId);
    check();
    instance = await this.#describe(instance.InstanceId, chat.id);
    check(); acceptedImage = await this.#acceptedImage(instance.ImageId); check();
    if (this.config.idlePolicy === "hibernate" && !this.#hibernationEvidence(acceptedImage, instance).available) throw hibernationUnavailableError();
    });
    const host = this.config.ec2.usePublicIp ? instance.PublicIpAddress : instance.PrivateIpAddress;
    if (!host) throw new Error(`EC2 instance ${instance.InstanceId} has no ${this.config.ec2.usePublicIp ? "public" : "private"} IP`);
    await stage("connection", async () => {
      await mkdir(path.dirname(this.config.ec2.sshKnownHosts), { recursive: true, mode: 0o700 });
      check(); await this.#waitForSsh(host, instance.InstanceId, check);
    });
    const executor = new Ec2Executor({ backend: this, chat, instance, host,
      supervisorAvailable: workerImageTags(acceptedImage).AgentRelaySupervisor === workerSupervisorVersion });
    executor.releaseAcquisition = releaseAcquisition;
    executor.acquisitionReceipt = { mutation: acquisitionMutation, worker: { backend: "ec2", instanceId: instance.InstanceId,
      imageId: instance.ImageId, ...(typeof instance.LaunchTime === "string" && Number.isFinite(Date.parse(instance.LaunchTime)) ? { launchTime: instance.LaunchTime } : {}) } };
    await workspaceReady; check();
    await stage("workspace", async () => {
    await executor.prepare(check);
    if (action === "resume" && expectedWorker?.bootId && executor.metadata.bootId !== expectedWorker.bootId) {
      throw new Error("EC2 worker rebooted instead of resuming the hibernated kernel; native continuity was refused");
    }
    // SSH readiness/workspace upload can take time; do not hand an executor
    // to provider credential delivery if acceptance was revoked meanwhile.
    await this.#acceptedImage(instance.ImageId);
    });
    return executor;
  }

  #hibernationEvidence(image, instance = null) {
    const tags = workerImageTags(image);
    return hibernationAdmission({
      backend: !instance || instance.HibernationOptions?.Configured === true,
      transport: tags.AgentRelaySupervisor === workerSupervisorVersion,
      image: tags.AgentRelayHibernation === workerHibernationCandidate
        && tags.AgentRelayHibernationAcceptance === workerHibernationAcceptance
        && workerHibernationAcceptanceId.test(tags.AgentRelayHibernationAcceptanceId || ""),
    });
  }

  async suspensionAdmission(chat) {
    const instance = await this.#find(chat.id);
    const image = await this.#acceptedImage(instance?.ImageId || this.config.ec2.amiId);
    return this.#hibernationEvidence(image, instance);
  }

  async hibernate(chat, expectedWorker = chat.workerLifecycle?.worker) {
    const instance = await this.#find(chat.id);
    if (!instance || instance.InstanceId !== expectedWorker?.instanceId || instance.ImageId !== expectedWorker?.imageId
      || expectedWorker?.launchTime && instance.LaunchTime !== expectedWorker.launchTime) {
      throw new Error("EC2 hibernation worker identity changed; no instance was mutated");
    }
    const image = await this.#acceptedImage(instance.ImageId);
    if (!this.#hibernationEvidence(image, instance).available) throw hibernationUnavailableError();
    if (instance.State?.Name !== "running") throw new Error("EC2 worker is not running at the hibernation boundary");
    await this.#aws("ec2", "stop-instances", "--hibernate", "--instance-ids", instance.InstanceId);
    await this.#aws("ec2", "wait", "instance-stopped", "--instance-ids", instance.InstanceId);
    const stopped = await this.#describe(instance.InstanceId, chat.id);
    if (stopped.State?.Name !== "stopped" || stopped.HibernationOptions?.Configured !== true) throw new Error("EC2 hibernation completion is unconfirmed");
    return { instanceId: stopped.InstanceId, hibernated: true };
  }

  async #releaseAcquisition(instanceId, chatId) {
    const instance = await this.#describe(instanceId, chatId);
    if (instance.State?.Name !== "stopped") {
      await this.#aws("ec2", "stop-instances", "--instance-ids", instanceId);
      await this.#aws("ec2", "wait", "instance-stopped", "--instance-ids", instanceId);
    }
    return { instanceId, stopped: true };
  }

  async sleep(chat) {
    const instance = await this.#find(chat.id);
    if (!instance) return null;
    if (instance.State?.Name !== "stopped") {
      await this.#aws("ec2", "stop-instances", "--instance-ids", instance.InstanceId);
      await this.#aws("ec2", "wait", "instance-stopped", "--instance-ids", instance.InstanceId);
    }
    return { instanceId: instance.InstanceId, stopped: true };
  }

  async destroy(chat) {
    const instance = await this.#find(chat.id, "pending,running,stopping,stopped,shutting-down");
    if (instance) {
      if (instance.State?.Name !== "shutting-down") await this.#aws("ec2", "terminate-instances", "--instance-ids", instance.InstanceId);
      await this.#aws("ec2", "wait", "instance-terminated", "--instance-ids", instance.InstanceId);
    }
    // Root volumes are launched with DeleteOnTermination, but the EC2 waiter
    // only proves the instance is gone. Verify storage too; retry cleanup if
    // an EBS volume outlives the worker instead of reporting false success.
    for (const volume of await this.#ownedVolumes(chat.id)) {
      if (volume.State === "available") await this.#aws("ec2", "delete-volume", "--volume-id", volume.VolumeId);
      else if (volume.State !== "deleting") throw new Error(`EC2 worker volume ${volume.VolumeId} is still ${volume.State}`);
      await this.#aws("ec2", "wait", "volume-deleted", "--volume-ids", volume.VolumeId);
    }
    if ((await this.#ownedVolumes(chat.id)).length) throw new Error("EC2 worker volumes remain after deletion");
  }

  async resize(chat, instanceType) {
    const desired = validateWorkerInstanceType(instanceType, this.config.ec2.instanceType);
    let instance = await this.#find(chat.id);
    if (!instance) return { instanceType: desired, resized: false, absent: true };
    if (instance.State?.Name === "stopping") {
      await this.#aws("ec2", "wait", "instance-stopped", "--instance-ids", instance.InstanceId);
      instance = await this.#describe(instance.InstanceId, chat.id);
    }
    if (instance.State?.Name !== "stopped") throw new Error("Stop the worker before changing its machine size");
    const resized = instance.InstanceType !== desired;
    if (resized) instance = await this.#resizeStopped(instance, chat.id, desired);
    return { instanceId: instance.InstanceId, instanceType: instance.InstanceType, resized };
  }

  async #resizeStopped(instance, chatId, desiredType) {
    const desired = validateWorkerInstanceType(desiredType, this.config.ec2.instanceType);
    if (instance.InstanceType === desired) return instance;
    if (instance.State?.Name !== "stopped") throw new Error("EC2 worker must be stopped before changing its machine size");
    await this.#aws("ec2", "modify-instance-attribute", "--instance-id", instance.InstanceId, "--instance-type", JSON.stringify({ Value: desired }));
    const changed = await this.#describe(instance.InstanceId, chatId);
    if (changed.State?.Name !== "stopped" || changed.InstanceType !== desired) throw new Error("EC2 did not confirm the requested worker machine size");
    return changed;
  }

  async #ownedVolumes(chatId) {
    const output = await this.#aws("ec2", "describe-volumes", "--filters",
      `Name=tag:AgentWebChat,Values=${chatId}`,
      `Name=tag:AgentRelayDeployment,Values=${this.config.ec2.deployment}`,
      "Name=tag:ManagedBy,Values=agent-relay", "--query", "Volumes", "--output", "json");
    const volumes = JSON.parse(output || "[]");
    if (!Array.isArray(volumes)) throw new Error("EC2 worker volume lookup returned invalid data");
    for (const volume of volumes) {
      const tags = Object.fromEntries((volume.Tags || []).map(({ Key, Value }) => [Key, Value]));
      if (!/^vol-[a-f0-9]{8,17}$/.test(volume.VolumeId || "") ||
          tags.AgentWebChat !== chatId || tags.AgentRelayDeployment !== this.config.ec2.deployment || tags.ManagedBy !== "agent-relay") {
        throw new Error("EC2 worker volume ownership does not match this deployment");
      }
    }
    return volumes;
  }

  async #find(chatId, states = "pending,running,stopping,stopped") {
    if (!/^chat_[a-f0-9]{32}$/.test(chatId)) throw new Error("Invalid EC2 chat identifier");
    const output = await this.#aws(
      "ec2", "describe-instances",
      "--filters",
      `Name=tag:AgentWebChat,Values=${chatId}`,
      `Name=tag:AgentRelayDeployment,Values=${this.config.ec2.deployment}`,
      "Name=tag:ManagedBy,Values=agent-relay",
      `Name=instance-state-name,Values=${states}`,
      "--query", "Reservations[].Instances[]",
      "--output", "json",
    );
    const instances = JSON.parse(output || "[]");
    if (!Array.isArray(instances) || instances.length > 1) throw new Error("EC2 worker lookup is ambiguous; refusing to mutate instances");
    return instances.length ? this.#assertWorker(instances[0], chatId) : null;
  }

  #assertWorker(instance, chatId) {
    const tags = Object.fromEntries((instance.Tags || []).map(({ Key, Value }) => [Key, Value]));
    const ec2 = this.config.ec2;
    if (!/^i-[a-f0-9]{8,17}$/.test(instance.InstanceId || "") || tags.ManagedBy !== "agent-relay" ||
        tags.AgentRelayDeployment !== ec2.deployment || tags.AgentWebChat !== chatId ||
        instance.SubnetId !== ec2.subnetId || instance.KeyName !== ec2.keyName ||
        instance.SecurityGroups?.length !== 1 || instance.SecurityGroups[0].GroupId !== ec2.securityGroupId ||
        instance.IamInstanceProfile || instance.PublicIpAddress || instance.MetadataOptions?.HttpEndpoint !== "disabled") {
      throw new Error("EC2 worker ownership or isolation does not match this deployment; refusing access or mutation");
    }
    return instance;
  }

  async #describe(instanceId, chatId) {
    const output = await this.#aws(
      "ec2", "describe-instances", "--instance-ids", instanceId,
      "--query", "Reservations[0].Instances[0]", "--output", "json",
    );
    const instance = output && output !== "null" ? JSON.parse(output) : null;
    if (!instance) throw new Error(`EC2 instance disappeared: ${instanceId}`);
    if (instance.InstanceId !== instanceId) throw new Error("EC2 worker lookup returned an unexpected instance");
    return this.#assertWorker(instance, chatId);
  }

  async #acceptedImage(imageId) {
    const ec2 = this.config.ec2;
    if (!/^ami-[a-f0-9]{8,17}$/.test(imageId || "")) throw new Error("Worker instance has no verifiable AMI identity");
    // AWS enforces self ownership; no reliance on an arbitrary tag as owner.
    const images = JSON.parse(await this.#aws("ec2", "describe-images", "--image-ids", imageId, "--owners", "self", "--query", "Images", "--output", "json"));
    if (!Array.isArray(images) || images.length !== 1) throw new Error("Worker AMI is not uniquely owned by this AWS account");
    return assertWorkerImage(images[0], { imageId, deployment: ec2.deployment, keyName: ec2.keyName });
  }

  async #create(chatId, check = () => {}, onMutation = () => {}, requestedInstanceType = null) {
    const ec2 = this.config.ec2;
    const acceptedImage = await this.#acceptedImage(ec2.amiId);
    if (this.config.idlePolicy === "hibernate" && !this.#hibernationEvidence(acceptedImage).available) throw hibernationUnavailableError();
    check();
    const Tags = [
      { Key: "Name", Value: `agent-relay-${chatId.slice(-12)}` }, { Key: "AgentWebChat", Value: chatId },
      { Key: "ManagedBy", Value: "agent-relay" }, { Key: "AgentRelayDeployment", Value: ec2.deployment },
    ];
    const blockDevice = JSON.stringify([{
      DeviceName: this.config.ec2.rootDevice,
      Ebs: { VolumeSize: this.config.ec2.volumeGb, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true },
    }]);
    const output = await this.#aws(
      "ec2", "run-instances",
      "--image-id", this.config.ec2.amiId,
      "--instance-type", validateWorkerInstanceType(requestedInstanceType, this.config.ec2.instanceType),
      "--network-interfaces", JSON.stringify([{ DeviceIndex: 0, SubnetId: ec2.subnetId, Groups: [ec2.securityGroupId], AssociatePublicIpAddress: false, DeleteOnTermination: true }]),
      "--key-name", this.config.ec2.keyName,
      "--block-device-mappings", blockDevice,
      "--metadata-options", "HttpTokens=required,HttpEndpoint=disabled",
      "--instance-initiated-shutdown-behavior", "stop",
      ...(this.config.idlePolicy === "hibernate" ? ["--hibernation-options", "Configured=true"] : []),
      "--tag-specifications", JSON.stringify(["instance", "volume"].map(ResourceType => ({ ResourceType, Tags }))),
      "--query", "Instances[0]", "--output", "json",
    );
    const instance = JSON.parse(output);
    if (!/^i-[a-f0-9]{8,17}$/.test(instance?.InstanceId || "")) throw new Error("EC2 launch did not return a valid worker ID");
    onMutation(instance.InstanceId);
    const described = await this.#describe(instance.InstanceId, chatId);
    if (described.ImageId !== ec2.amiId) throw new Error("New worker does not use the requested accepted AMI");
    return described;
  }

  async #waitForSsh(host, instanceId, check = () => {}) {
    const deadline = Date.now() + this.config.ec2.sshReadyTimeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      check();
      try {
        await this.sshCapture(host, "test -f /opt/agent-web/READY && test -f /opt/agent-web/IMAGE_FINALIZED && test \"$(codex --version)\" = 'codex-cli 0.154.0' && test \"$(claude --version)\" = '2.1.222 (Claude Code)'", instanceId);
        return;
      } catch (error) {
        check();
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
    throw new Error(`EC2 worker did not become SSH/CLI ready: ${lastError?.message || "timeout"}`);
  }

  #aws(...args) {
    return this.commandRunner(this.config.ec2.awsBin, this.awsArgs(...args), { timeoutMs: 300_000 });
  }
}

export function createWorkerBackend({ store, config, gatewayOrigin, commandRunner, browserTransport, legacyOwnerId = null }) {
  // Programmatic, local synthetic validation only. No configuration flag or
  // HTTP input can bypass the missing production service/cgroup admission.
  if (browserTransport && (config.workerBackend !== "local" || !config.enableMock || browserTransport.admission !== "local-validation"
    || typeof browserTransport.spawnBrowser !== "function")) throw new Error("Reconnectable browser transport is only admitted for explicit local validation");
  if (config.workerBackend === "ec2") return new Ec2Backend({ store, config, commandRunner, legacyOwnerId });
  return new LocalBackend({ store, config, gatewayOrigin, browserTransport });
}
