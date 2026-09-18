import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { spawnWorker } from "./worker-process.mjs";

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
  constructor({ chat, store, config, gatewayOrigin }) {
    this.workspace = chat.workspace;
    this.runtimeHome = store.runtimeHome(chat.id);
    this.gatewayOrigin = gatewayOrigin;
    this.config = config;
    this.metadata = { backend: "local", isolation: config.processIsolation };
  }

  spawn(command, args, options) {
    return spawnWorker(command, args, { ...options, isolation: this.config.processIsolation });
  }

  // Chrome keeps its native renderer sandbox. Mapping the launcher to UID 0
  // inside the CLI PID namespace would force disabling that sandbox.
  spawnBrowser(command, args, options) {
    return spawnWorker(command, args, { ...options, isolation: "none" });
  }

  mkdir(directory) {
    return mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

class LocalBackend {
  constructor({ store, config, gatewayOrigin }) {
    this.store = store;
    this.config = config;
    this.gatewayOrigin = gatewayOrigin;
  }

  async acquire(chat) {
    return new LocalExecutor({ chat, store: this.store, config: this.config, gatewayOrigin: this.gatewayOrigin });
  }

  async sleep() {}
  async destroy() {}
}

class Ec2Executor {
  constructor({ backend, chat, instance, host }) {
    this.backend = backend;
    this.chat = chat;
    this.instance = instance;
    this.host = host;
    this.workspace = `${backend.config.ec2.remoteRoot}/chats/${chat.id}/workspace`;
    this.runtimeHome = `${backend.config.ec2.remoteRoot}/chats/${chat.id}/runtime-home`;
    this.heartbeat = `${backend.config.ec2.remoteRoot}/.heartbeat`;
    this.gatewayOrigin = backend.config.ec2.gatewayOrigin;
    this.metadata = { backend: "ec2", instanceId: instance.InstanceId, host };
  }

  async prepare() {
    const chatRoot = path.posix.dirname(this.workspace);
    const marker = `${chatRoot}/.workspace-seeded`;
    await this.backend.sshCapture(this.host, `install -d -m 700 ${shellQuote(this.workspace)} ${shellQuote(this.runtimeHome)} && touch ${shellQuote(this.heartbeat)}`, this.instance.InstanceId);
    const seeded = await this.backend.sshCapture(this.host, `test -f ${shellQuote(marker)} && printf ready || true`, this.instance.InstanceId);
    if (seeded === "ready") {
      for (const repo of this.chat.repositories || []) {
        if (!/^[A-Za-z0-9_.-]+--[A-Za-z0-9_.-]+$/.test(repo.directory)) throw new Error("Invalid repository directory");
        const target = `${this.workspace}/${repo.directory}`;
        const exists = await this.backend.sshCapture(this.host, `test -e ${shellQuote(target)} && printf ready || true`, this.instance.InstanceId);
        if (exists !== "ready") await this.#uploadWorkspace(marker, repo.directory);
      }
      return;
    }
    await this.#uploadWorkspace(marker);
  }

  spawn(command, args, options = {}) {
    const setupPath = options.env?.PATH?.startsWith(`${this.runtimeHome}/`) ? options.env.PATH : this.backend.config.ec2.remotePath;
    const env = { ...(options.env || {}), PATH: this.environmentPath || setupPath };
    const assignments = Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`)).join(" ");
    const inner = [
      `cd ${shellQuote(options.cwd || this.workspace)} || exit 1`,
      `touch ${shellQuote(this.heartbeat)}`,
      `(while sleep 20; do touch ${shellQuote(this.heartbeat)}; done) &`,
      "heartbeat_pid=$!",
      "trap 'kill \"$heartbeat_pid\" 2>/dev/null || true' EXIT HUP INT TERM",
      `env -i ${assignments} ${shellQuote(command)} ${args.map(shellQuote).join(" ")}`,
    ].join("\n");
    const remote = `exec /bin/sh -c ${shellQuote(inner)}`;
    return spawn(this.backend.config.ec2.sshBin, [...this.backend.sshArgs(this.host, this.instance.InstanceId), remote], {
      stdio: options.stdio || ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  }

  mkdir(directory) {
    return this.backend.sshCapture(this.host, `install -d -m 700 ${shellQuote(directory)} && touch ${shellQuote(this.heartbeat)}`, this.instance.InstanceId).then(() => undefined);
  }

  #uploadWorkspace(marker, directory = ".") {
    return new Promise((resolve, reject) => {
      const tar = spawn("tar", ["-C", this.chat.workspace, "-cf", "-", "--", directory], { stdio: ["ignore", "pipe", "pipe"] });
      const remote = `tar -xf - -C ${shellQuote(this.workspace)} && touch ${shellQuote(marker)} ${shellQuote(this.heartbeat)}`;
      const ssh = spawn(this.backend.config.ec2.sshBin, [...this.backend.sshArgs(this.host, this.instance.InstanceId), remote], { stdio: ["pipe", "ignore", "pipe"] });
      tar.stdout.pipe(ssh.stdin);
      let errors = "";
      tar.stderr.on("data", (chunk) => { errors += chunk; });
      ssh.stderr.on("data", (chunk) => { errors += chunk; });
      let tarCode;
      let sshCode;
      const finish = () => {
        if (tarCode === undefined || sshCode === undefined) return;
        if (tarCode === 0 && sshCode === 0) resolve();
        else reject(new Error(`workspace upload failed (tar=${tarCode}, ssh=${sshCode}): ${errors.slice(-4_000)}`));
      };
      tar.once("error", reject);
      ssh.once("error", reject);
      tar.once("exit", (code) => { tarCode = code; finish(); });
      ssh.once("exit", (code) => { sshCode = code; finish(); });
    });
  }
}

export class Ec2Backend {
  constructor({ store, config, commandRunner = runCapture }) {
    this.store = store;
    this.config = config;
    this.commandRunner = commandRunner;
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

  sshCapture(host, remoteCommand, instanceId) {
    return this.commandRunner(this.config.ec2.sshBin, [...this.sshArgs(host, instanceId), remoteCommand], { timeoutMs: 60_000 });
  }

  async acquire(chat) {
    let instance = await this.#find(chat.id);
    if (!instance) instance = await this.#create(chat.id);
    if (instance.State?.Name === "stopping") {
      await this.#aws("ec2", "wait", "instance-stopped", "--instance-ids", instance.InstanceId);
      instance.State.Name = "stopped";
    }
    if (instance.State?.Name === "stopped") {
      await this.#aws("ec2", "start-instances", "--instance-ids", instance.InstanceId);
    }
    await this.#aws("ec2", "wait", "instance-running", "--instance-ids", instance.InstanceId);
    instance = await this.#describe(instance.InstanceId, chat.id);
    const host = this.config.ec2.usePublicIp ? instance.PublicIpAddress : instance.PrivateIpAddress;
    if (!host) throw new Error(`EC2 instance ${instance.InstanceId} has no ${this.config.ec2.usePublicIp ? "public" : "private"} IP`);
    await mkdir(path.dirname(this.config.ec2.sshKnownHosts), { recursive: true, mode: 0o700 });
    await this.#waitForSsh(host, instance.InstanceId);
    const executor = new Ec2Executor({ backend: this, chat, instance, host });
    await executor.prepare();
    return executor;
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
    const instance = await this.#find(chat.id);
    if (!instance) return;
    await this.#aws("ec2", "terminate-instances", "--instance-ids", instance.InstanceId);
  }

  async #find(chatId) {
    if (!/^chat_[a-f0-9]{32}$/.test(chatId)) throw new Error("Invalid EC2 chat identifier");
    const output = await this.#aws(
      "ec2", "describe-instances",
      "--filters",
      `Name=tag:AgentWebChat,Values=${chatId}`,
      `Name=tag:AgentRelayDeployment,Values=${this.config.ec2.deployment}`,
      "Name=tag:ManagedBy,Values=agent-relay",
      "Name=instance-state-name,Values=pending,running,stopping,stopped",
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

  async #create(chatId) {
    const ec2 = this.config.ec2;
    const image = JSON.parse(await this.#aws("ec2", "describe-images", "--image-ids", ec2.amiId, "--query", "Images[0]", "--output", "json"));
    const imageTags = Object.fromEntries((image?.Tags || []).map(({ Key, Value }) => [Key, Value]));
    if (image?.ImageId !== ec2.amiId || image.State !== "available" || image.Architecture !== "x86_64" ||
        imageTags.ManagedBy !== "agent-relay" || imageTags.AgentRelayDeployment !== ec2.deployment ||
        imageTags.AgentRelayWorkerKey !== ec2.keyName || imageTags.CodexVersion !== "0.154.0" || imageTags.ClaudeVersion !== "2.1.222") {
      throw new Error("Worker AMI must be a verified image baked for this deployment, SSH key, and pinned CLI versions");
    }
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
      "--instance-type", this.config.ec2.instanceType,
      "--network-interfaces", JSON.stringify([{ DeviceIndex: 0, SubnetId: ec2.subnetId, Groups: [ec2.securityGroupId], AssociatePublicIpAddress: false, DeleteOnTermination: true }]),
      "--key-name", this.config.ec2.keyName,
      "--block-device-mappings", blockDevice,
      "--metadata-options", "HttpTokens=required,HttpEndpoint=disabled",
      "--instance-initiated-shutdown-behavior", "stop",
      "--tag-specifications", JSON.stringify(["instance", "volume"].map(ResourceType => ({ ResourceType, Tags }))),
      "--query", "Instances[0]", "--output", "json",
    );
    const instance = JSON.parse(output);
    if (!/^i-[a-f0-9]{8,17}$/.test(instance?.InstanceId || "")) throw new Error("EC2 launch did not return a valid worker ID");
    return this.#describe(instance.InstanceId, chatId);
  }

  async #waitForSsh(host, instanceId) {
    const deadline = Date.now() + this.config.ec2.sshReadyTimeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        await this.sshCapture(host, "test -f /opt/agent-web/READY && test -f /opt/agent-web/IMAGE_FINALIZED && test \"$(codex --version)\" = 'codex-cli 0.154.0' && test \"$(claude --version)\" = '2.1.222 (Claude Code)'", instanceId);
        return;
      } catch (error) {
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

export function createWorkerBackend({ store, config, gatewayOrigin, commandRunner }) {
  if (config.workerBackend === "ec2") return new Ec2Backend({ store, config, commandRunner });
  return new LocalBackend({ store, config, gatewayOrigin });
}
