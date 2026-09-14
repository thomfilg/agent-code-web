import path from "node:path";
import { SOFTWARE_CATALOG } from "./environments.mjs";
import { terminateWorker } from "./worker-process.mjs";

export function captureWorker(executor, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = executor.spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { terminateWorker(child).catch(() => {}); reject(new Error("Software setup timed out")); }, 600000);
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-12000); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-12000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(output || `Software setup exited ${code}`)); });
  });
}

export async function prepareSoftware(executor, environment, onProgress) {
  const software = environment?.software || [];
  // Revisions get separate prefixes: removed packages must not leak into the
  // next environment configuration via an old PATH.
  const prefix = path.posix.join(executor.runtimeHome, `software-${environment?.id || "default"}-${environment?.revision || 1}`);
  const binPath = `${prefix}/bin${software.includes("python") ? `:${prefix}/python/bin` : ""}`;
  const basePath = executor.backend?.config.ec2.remotePath || process.env.PATH;
  const env = { PATH: `${binPath}:${basePath}`, HOME: executor.runtimeHome, LANG: "C.UTF-8", CI: "1", npm_config_update_notifier: "false" };
  await executor.mkdir(`${prefix}/bin`);
  for (const id of software) {
    const item = SOFTWARE_CATALOG.find(item => item.id === id);
    if (!item) throw new Error(`Unknown software: ${id}`);
    await onProgress(`Preparing ${item.name}…`);
    const packages = { node: "node@22", pnpm: "pnpm@10", yarn: "yarn@1", typescript: "typescript@5" };
    if (id === "docker") {
      if (executor.metadata?.backend !== "ec2") throw new Error("Docker requires a dedicated EC2 worker; the control-plane Docker socket is never exposed.");
      try { await captureWorker(executor, "sudo", ["-n", "/usr/local/sbin/agent-web-enable-docker"], { cwd: executor.runtimeHome, env }); }
      catch { throw new Error("Docker capability is missing from this worker image. Rebuild it with the updated worker-cloud-init.yaml."); }
      executor.capabilityVariables = { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONFIG: `${executor.runtimeHome}/docker-config` };
      await executor.mkdir(executor.capabilityVariables.DOCKER_CONFIG);
    } else if (packages[id]) {
      // A private prefix prevents one environment from modifying another or the host.
      const marker = `${prefix}/.installed-${id}`;
      const check = await captureWorker(executor, "/bin/sh", ["-c", 'test -f "$1" && printf ready || true', "software-check", marker], { cwd: executor.workspace, env });
      if (check !== "ready") {
        await captureWorker(executor, "npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", packages[id]], { cwd: executor.workspace, env });
        await captureWorker(executor, "touch", [marker], { cwd: executor.workspace, env });
      }
    } else if (id === "python") {
      await captureWorker(executor, "python3", ["-m", "venv", "--copies", `${prefix}/python`], { cwd: executor.runtimeHome, env: { ...env, PATH: basePath } });
    } else if (id === "jq") {
      const platform = await captureWorker(executor, "uname", ["-s"], { cwd: executor.runtimeHome, env });
      const arch = await captureWorker(executor, "uname", ["-m"], { cwd: executor.runtimeHome, env });
      const target = { "Linux/x86_64": "linux-amd64", "Linux/aarch64": "linux-arm64", "Darwin/x86_64": "macos-amd64", "Darwin/arm64": "macos-arm64" }[`${platform}/${arch}`];
      if (!target) throw new Error(`jq installation is not supported on ${platform}/${arch}`);
      const existing = await captureWorker(executor, "/bin/sh", ["-c", 'test -x "$1" && printf ready || true', "jq-check", `${prefix}/bin/jq`], { cwd: executor.runtimeHome, env });
      if (existing !== "ready") {
        await captureWorker(executor, "curl", ["--fail", "--location", "--silent", "--show-error", "--proto", "=https", "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-" + target, "--output", `${prefix}/bin/jq.download`], { cwd: executor.runtimeHome, env });
        await captureWorker(executor, "chmod", ["700", `${prefix}/bin/jq.download`], { cwd: executor.runtimeHome, env });
        await captureWorker(executor, "mv", [`${prefix}/bin/jq.download`, `${prefix}/bin/jq`], { cwd: executor.runtimeHome, env });
      }
    }
    try { await captureWorker(executor, "/bin/sh", ["-c", item.check], { cwd: executor.workspace, env }); }
    catch { throw new Error(`${item.name} setup failed. Check this server's base tools (Node/npm, Python 3 with venv, curl) or rebuild the cloud worker image.`); }
  }
  executor.environmentPath = env.PATH;
}
