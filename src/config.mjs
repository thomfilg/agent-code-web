import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function integer(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

function choice(env, name, fallback, values) {
  const value = env[name] || fallback;
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return value;
}

export function isLoopbackHost(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(host);
}

export function loadConfig(env = process.env) {
  const host = env.AGENT_WEB_HOST || "127.0.0.1";
  const authToken = env.AGENT_WEB_AUTH_TOKEN || "";
  if (!isLoopbackHost(host) && !authToken) {
    throw new Error("AGENT_WEB_AUTH_TOKEN is required when AGENT_WEB_HOST is not loopback");
  }

  const isolationDefault = os.platform() === "linux" ? "namespace" : "none";
  const workerBackend = choice(env, "AGENT_WORKER_BACKEND", "local", ["local", "ec2"]);
  const codexAuthMode = choice(env, "CODEX_AUTH_MODE", "gateway", ["gateway", "host"]);
  const claudeAuthMode = choice(env, "CLAUDE_AUTH_MODE", "gateway", ["gateway", "host"]);
  const ec2GatewayOrigin = (env.AGENT_EC2_GATEWAY_ORIGIN || "").replace(/\/$/, "");
  if (workerBackend === "ec2" && !ec2GatewayOrigin) {
    throw new Error("AGENT_EC2_GATEWAY_ORIGIN is required when AGENT_WORKER_BACKEND=ec2");
  }
  if (workerBackend === "ec2" && !ec2GatewayOrigin.startsWith("https://") && !boolean(env, "AGENT_EC2_ALLOW_INSECURE_GATEWAY", false)) {
    throw new Error("AGENT_EC2_GATEWAY_ORIGIN must use HTTPS (or explicitly set AGENT_EC2_ALLOW_INSECURE_GATEWAY=1 for a private-network POC)");
  }
  if (workerBackend === "ec2" && (codexAuthMode === "host" || claudeAuthMode === "host")) {
    throw new Error("EC2 workers require gateway auth mode; host CLI credentials must not be baked into worker images");
  }
  return {
    appRoot: APP_ROOT,
    publicDir: path.join(APP_ROOT, "public"),
    host,
    port: integer(env, "AGENT_WEB_PORT", 8787, { max: 65_535 }),
    authToken,
    cookieSecure: boolean(env, "AGENT_COOKIE_SECURE", false),
    publicOrigin: env.AGENT_WEB_PUBLIC_URL || "",
    database: {
      mode: choice(env, "AGENT_DATABASE_MODE", env.DATABASE_URL ? "postgres" : "embedded", ["postgres", "embedded", "memory"]),
      url: env.DATABASE_URL || "",
      tls: boolean(env, "AGENT_DATABASE_TLS", true),
      directory: path.resolve(env.AGENT_CONTROL_DIR || path.join(os.homedir(), ".local/share/agent-code-web")),
      encryptionKey: env.AGENT_ENCRYPTION_KEY || "",
      port: integer(env, "AGENT_DATABASE_PORT", 55438, { min: 1024, max: 65535 }),
    },
    github: {
      clientId: env.GITHUB_OAUTH_CLIENT_ID || "",
      localConnection: boolean(env, "AGENT_GITHUB_LOCAL_CONNECT", isLoopbackHost(host)),
      apiBase: "https://api.github.com",
    },
    idleTimeoutMs: integer(env, "AGENT_IDLE_TIMEOUT_MS", 300_000, { min: 100, max: 86_400_000 }),
    dataDir: path.resolve(APP_ROOT, env.AGENT_DATA_DIR || "data"),
    workspaceSource: env.AGENT_WORKSPACE_SOURCE || "",
    workerBackend,
    enableMock: boolean(env, "AGENT_ENABLE_MOCK", false),
    chromeBin: env.AGENT_CHROME_BIN || "google-chrome",
    processIsolation: choice(env, "AGENT_PROCESS_ISOLATION", isolationDefault, ["namespace", "none"]),
    sessionCapabilityTtlMs: integer(env, "AGENT_CAPABILITY_TTL_MS", 3_600_000, {
      min: 10_000,
      max: 86_400_000,
    }),
    maxBodyBytes: integer(env, "AGENT_MAX_BODY_BYTES", 1_048_576, { min: 1_024, max: 10_485_760 }),
    codex: {
      bin: env.CODEX_BIN || "codex",
      model: env.CODEX_MODEL || "gpt-5.6-sol",
      effort: env.CODEX_EFFORT || "high",
      authMode: codexAuthMode,
      providerKey: env.OPENAI_API_KEY || "",
      upstreamBaseUrl: (env.OPENAI_BASE_URL_UPSTREAM || "https://api.openai.com").replace(/\/$/, ""),
    },
    claude: {
      bin: env.CLAUDE_BIN || "claude",
      model: env.CLAUDE_MODEL || "opus",
      effort: env.CLAUDE_EFFORT || "high",
      authMode: claudeAuthMode,
      providerKey: env.ANTHROPIC_API_KEY || "",
      upstreamBaseUrl: (env.ANTHROPIC_BASE_URL_UPSTREAM || "https://api.anthropic.com").replace(/\/$/, ""),
    },
    ec2: {
      awsBin: env.AWS_BIN || "aws",
      profile: env.AWS_PROFILE || "default",
      region: env.AWS_REGION || "us-east-1",
      amiId: env.AGENT_EC2_AMI_ID || "",
      instanceType: env.AGENT_EC2_INSTANCE_TYPE || "t3.medium",
      subnetId: env.AGENT_EC2_SUBNET_ID || "",
      securityGroupId: env.AGENT_EC2_SECURITY_GROUP_ID || "",
      keyName: env.AGENT_EC2_KEY_NAME || "",
      sshBin: env.SSH_BIN || "ssh",
      sshUser: env.AGENT_EC2_SSH_USER || "ubuntu",
      sshPrivateKey: env.AGENT_EC2_SSH_PRIVATE_KEY || "",
      usePublicIp: boolean(env, "AGENT_EC2_USE_PUBLIC_IP", false),
      remoteRoot: env.AGENT_EC2_REMOTE_ROOT || "/opt/agent-web",
      remotePath: env.AGENT_EC2_REMOTE_PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      gatewayOrigin: ec2GatewayOrigin,
      volumeGb: integer(env, "AGENT_EC2_VOLUME_GB", 20, { min: 8, max: 16_384 }),
      rootDevice: env.AGENT_EC2_ROOT_DEVICE || "/dev/sda1",
      sshReadyTimeoutMs: integer(env, "AGENT_EC2_SSH_READY_TIMEOUT_MS", 180_000, { min: 10_000, max: 900_000 }),
    },
  };
}

export { APP_ROOT };
