import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
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
    await this.backend.sshCapture(this.host, `install -d -m 700 ${shellQuote(this.workspace)} ${shellQuote(this.runtimeHome)} && touch ${shellQuote(this.heartbeat)}`);
    const seeded = await this.backend.sshCapture(this.host, `test -f ${shellQuote(marker)} && printf ready || true`);
    if (seeded === "ready") return;
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
    return spawn(this.backend.config.ec2.sshBin, [...this.backend.sshArgs(this.host), remote], {
      stdio: options.stdio || ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  }

  mkdir(directory) {
    return this.backend.sshCapture(this.host, `install -d -m 700 ${shellQuote(directory)} && touch ${shellQuote(this.heartbeat)}`).then(() => undefined);
  }

  #uploadWorkspace(marker) {
    return new Promise((resolve, reject) => {
      const tar = spawn("tar", ["-C", this.chat.workspace, "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"] });
      const remote = `tar -xf - -C ${shellQuote(this.workspace)} && touch ${shellQuote(marker)} ${shellQuote(this.heartbeat)}`;
      const ssh = spawn(this.backend.config.ec2.sshBin, [...this.backend.sshArgs(this.host), remote], { stdio: ["pipe", "ignore", "pipe"] });
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
      AGENT_EC2_SUBNET_ID: config.ec2.subnetId,
      AGENT_EC2_SECURITY_GROUP_ID: config.ec2.securityGroupId,
      AGENT_EC2_KEY_NAME: config.ec2.keyName,
      AGENT_EC2_SSH_PRIVATE_KEY: config.ec2.sshPrivateKey,
    };
    const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`EC2 backend is missing: ${missing.join(", ")}`);
  }

  awsArgs(...args) {
    return ["--profile", this.config.ec2.profile, "--region", this.config.ec2.region, ...args];
  }

  sshArgs(host) {
    return [
      "-T",
      "-i", this.config.ec2.sshPrivateKey,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      `${this.config.ec2.sshUser}@${host}`,
    ];
  }

  sshCapture(host, remoteCommand) {
    return this.commandRunner(this.config.ec2.sshBin, [...this.sshArgs(host), remoteCommand], { timeoutMs: 60_000 });
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
    instance = await this.#describe(instance.InstanceId);
    const host = this.config.ec2.usePublicIp ? instance.PublicIpAddress : instance.PrivateIpAddress;
    if (!host) throw new Error(`EC2 instance ${instance.InstanceId} has no ${this.config.ec2.usePublicIp ? "public" : "private"} IP`);
    await this.#waitForSsh(host);
    const executor = new Ec2Executor({ backend: this, chat, instance, host });
    await executor.prepare();
    return executor;
  }

  async sleep(chat) {
    const instance = await this.#find(chat.id);
    if (!instance || instance.State?.Name === "stopped") return;
    await this.#aws("ec2", "stop-instances", "--instance-ids", instance.InstanceId);
    await this.#aws("ec2", "wait", "instance-stopped", "--instance-ids", instance.InstanceId);
  }

  async destroy(chat) {
    const instance = await this.#find(chat.id);
    if (!instance) return;
    await this.#aws("ec2", "terminate-instances", "--instance-ids", instance.InstanceId);
  }

  async #find(chatId) {
    const output = await this.#aws(
      "ec2", "describe-instances",
      "--filters",
      `Name=tag:AgentWebChat,Values=${chatId}`,
      "Name=instance-state-name,Values=pending,running,stopping,stopped",
      "--query", "Reservations[0].Instances[0]",
      "--output", "json",
    );
    return output && output !== "null" ? JSON.parse(output) : null;
  }

  async #describe(instanceId) {
    const output = await this.#aws(
      "ec2", "describe-instances", "--instance-ids", instanceId,
      "--query", "Reservations[0].Instances[0]", "--output", "json",
    );
    const instance = output && output !== "null" ? JSON.parse(output) : null;
    if (!instance) throw new Error(`EC2 instance disappeared: ${instanceId}`);
    return instance;
  }

  async #create(chatId) {
    const tags = `ResourceType=instance,Tags=[{Key=Name,Value=agent-web-${chatId.slice(-12)}},{Key=AgentWebChat,Value=${chatId}},{Key=ManagedBy,Value=agent-web-poc}]`;
    const volumeTags = `ResourceType=volume,Tags=[{Key=AgentWebChat,Value=${chatId}},{Key=ManagedBy,Value=agent-web-poc}]`;
    const blockDevice = JSON.stringify([{
      DeviceName: this.config.ec2.rootDevice,
      Ebs: { VolumeSize: this.config.ec2.volumeGb, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true },
    }]);
    const output = await this.#aws(
      "ec2", "run-instances",
      "--image-id", this.config.ec2.amiId,
      "--instance-type", this.config.ec2.instanceType,
      "--subnet-id", this.config.ec2.subnetId,
      "--security-group-ids", this.config.ec2.securityGroupId,
      "--key-name", this.config.ec2.keyName,
      "--block-device-mappings", blockDevice,
      "--metadata-options", "HttpTokens=required,HttpEndpoint=enabled",
      "--instance-initiated-shutdown-behavior", "stop",
      "--tag-specifications", tags, volumeTags,
      "--query", "Instances[0]", "--output", "json",
    );
    return JSON.parse(output);
  }

  async #waitForSsh(host) {
    const deadline = Date.now() + this.config.ec2.sshReadyTimeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        await this.sshCapture(host, "command -v codex >/dev/null && command -v claude >/dev/null");
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
