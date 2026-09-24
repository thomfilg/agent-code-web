import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

// Test-only OCI executor. No daemon, host directory mounts, provider credentials
// or production worker settings. The caller must supply a verified runc binary.
export async function createOciWorker(runc) {
  if (!path.isAbsolute(runc) || process.getuid?.() === 0) throw Error("Rootless fixture requires an explicit runtime and an ordinary host user");
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-oci-worker-"));
  const bundle = path.join(root, "bundle"), rootfs = path.join(bundle, "rootfs"), state = path.join(root, "state");
  const id = `relay-fixture-${randomUUID()}`, marker = { id, uid: process.getuid(), root };
  await writeFile(path.join(root, "fixture.json"), JSON.stringify(marker), { mode: 0o600 });
  for (const name of [bundle, rootfs, state, ...["bin", "usr/bin", "workspace", "runtime-home", "proc", "dev", "sys", "tmp", "fixtures"].map(name => path.join(rootfs, name))]) await mkdir(name, { recursive: true, mode: 0o700 });
  const base = ["--root", state, "--rootless", "true"], env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  const command = (args, options = {}) => execFileSync(runc, [...base, ...args], { env, encoding: "utf8", timeout: 10000, ...options });
  const put = async (source, target) => {
    if (!target.startsWith("/") || target.split("/").includes("..")) throw Error("Invalid fixture destination");
    const dest = path.join(rootfs, target);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
    await copyFile(await realpath(source), dest); await chmod(dest, 0o755);
  };
  const binary = async (source, target) => {
    await put(source, target);
    const dependencies = execFileSync("/usr/bin/ldd", [source], { env, encoding: "utf8" });
    for (const line of dependencies.split("\n")) {
      const file = line.match(/(?:=>\s+)?(\/[^\s]+)\s+\(/)?.[1];
      if (!file) continue;
      if (!/^\/(?:usr\/)?lib(?:64)?\//.test(file)) throw Error("Unexpected fixture binary dependency");
      await put(file, file);
    }
  };
  let processHandle, closed, deleted = false;
  const waitClosed = async () => {
    if (!closed) return;
    let timer;
    try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("OCI fixture process did not close; retaining its directory")), 10000); })]); }
    finally { clearTimeout(timer); }
  };
  const assertOwnership = async () => {
    const stat = await lstat(root), saved = JSON.parse(await readFile(path.join(root, "fixture.json"), "utf8"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || await realpath(root) !== root || JSON.stringify(saved) !== JSON.stringify(marker)) throw Error("OCI fixture cleanup ownership changed");
  };
  try {
    await binary(process.execPath, "/bin/node");
    await binary("/usr/bin/env", "/usr/bin/env");
    command(["spec", "--rootless"], { cwd: bundle });
    const spec = JSON.parse(await readFile(path.join(bundle, "config.json"), "utf8"));
    spec.root = { path: "rootfs", readonly: false };
    spec.process = { ...spec.process, terminal: false, cwd: "/workspace", args: ["/bin/node", "-e", "process.stdout.write('OCI_READY\\n');setInterval(()=>{},1000)"],
      env: ["PATH=/bin:/usr/bin", "HOME=/runtime-home", "LANG=C.UTF-8"], noNewPrivileges: true,
      capabilities: { bounding: [], effective: [], inheritable: [], permitted: [], ambient: [] } };
    spec.linux.resources = {};
    // runc's generated rootless template may inherit host networking. This
    // fixture explicitly requires its own network namespace with no interfaces
    // configured by the harness, not access to the controller's network.
    spec.linux.namespaces = spec.linux.namespaces.filter(namespace => namespace.type !== "network");
    spec.linux.namespaces.push({ type: "network" });
    // The generated template also binds host /sys read-only. This minimal Node
    // fixture needs no host directories at all, including sysfs topology.
    spec.mounts = spec.mounts.filter(mount => mount.type !== "cgroup" && mount.destination !== "/sys/fs/cgroup"
      && mount.type !== "bind" && !mount.options?.includes("bind") && !mount.options?.includes("rbind"));
    await writeFile(path.join(bundle, "config.json"), JSON.stringify(spec), { mode: 0o600 });
    processHandle = spawn(runc, [...base, "run", "--keep", "--bundle", bundle, id], { env, stdio: ["ignore", "pipe", "pipe"] });
    closed = once(processHandle, "close"); closed.catch(() => {});
    await new Promise((resolve, reject) => {
      let output = "", error = "";
      const timer = setTimeout(() => reject(Error("OCI fixture startup timed out")), 10000);
      processHandle.stdout.on("data", chunk => { output += chunk; if (output.includes("OCI_READY\n")) { clearTimeout(timer); resolve(); } });
      processHandle.stderr.on("data", chunk => { error = (error + chunk).slice(-3000); });
      processHandle.once("error", failure => { clearTimeout(timer); reject(failure); });
      processHandle.once("close", code => { clearTimeout(timer); reject(Error(`OCI fixture exited ${code}: ${error}`)); });
    });
  } catch (error) {
    try { command(["kill", id, "KILL"]); } catch {}
    await waitClosed().catch(() => {});
    try { command(["delete", id]); } catch {}
    // Keep failed setup evidence; do not remove a container whose state is unclear.
    error.message += ` (fixture ${root})`; throw error;
  }
  const inspect = () => JSON.parse(command(["state", id]));
  const worker = {
    id, root, rootfs, state, inspect, runtimeHome: "/runtime-home", workspace: "/workspace", environmentPath: "/bin:/usr/bin",
    async put(source, destination) { if (deleted) throw Error("OCI fixture was deleted"); await put(source, destination); },
    async installBinary(source, destination) { if (deleted) throw Error("OCI fixture was deleted"); await assertOwnership(); await binary(source, destination); },
    enableLoopback() {
      if (deleted) throw Error("OCI fixture was deleted");
      const current = inspect();
      if (current.id !== id || current.bundle !== bundle || current.status !== "running" || !Number.isSafeInteger(current.pid) || current.pid <= 1) throw Error("OCI fixture namespace ownership changed");
      // Enter only this verified fixture's user/network namespaces. Keep host
      // mount namespace solely to run public ip; never use host networking.
      // Rootless user mappings deny setgroups; retain the caller's mapped
      // identity instead of asking nsenter to reset supplementary groups.
      const args = ["--target", String(current.pid), "--user", "--net", "--preserve-credentials", "/usr/bin/ip"];
      const ip = tail => execFileSync("/usr/bin/nsenter", [...args, ...tail], { env, encoding: "utf8", timeout: 5000 });
      ip(["link", "set", "lo", "up"]);
      return { links: JSON.parse(ip(["-j", "link", "show"])), routes: ip(["route", "show"]).trim() };
    },
    spawn(commandName, args, options = {}) {
      if (deleted) throw Error("OCI fixture was deleted");
      const { cwd = worker.workspace, env: childEnv = {}, ...rest } = options;
      const envArgs = Object.entries(childEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
      return spawn(runc, [...base, "exec", "--cwd", cwd, ...envArgs, id, commandName === "node" ? "/bin/node" : commandName, ...args],
        { ...rest, env, detached: true });
    },
    async mkdir(directory) {
      const child = worker.spawn("node", ["-e", "require('node:fs').mkdirSync(process.argv[1],{recursive:true,mode:448})", directory], { stdio: ["ignore", "pipe", "pipe"] });
      const result = await once(child, "close"); if (result[0] !== 0) throw Error("OCI fixture mkdir failed");
    },
    async delete() {
      if (deleted) return;
      const current = inspect();
      if (current.id !== id || current.bundle !== bundle) throw Error("OCI fixture ownership changed");
      if (current.status !== "stopped") command(["kill", id, "KILL"]);
      await waitClosed();
      command(["delete", id]);
      let absent = false;
      try { inspect(); } catch (error) { absent = /does not exist/.test(String(error.stderr)); }
      if (!absent) throw Error("OCI fixture deletion was not confirmed");
      deleted = true;
      await assertOwnership();
      await rm(bundle, { recursive: true });
    },
    async cleanup() {
      await worker.delete();
      await assertOwnership();
      await rm(root, { recursive: true });
    },
  };
  return worker;
}
