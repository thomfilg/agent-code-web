// Test-only attachment to an exact supervisor-owned OCI fixture. This cannot
// create/delete containers or adopt arbitrary production workers.
import { spawn, execFileSync } from "node:child_process";
import { lstatSync, realpathSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const verifiedRuncHash = "177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f";
export function attachOciExecutor(descriptor) {
  const { runc, id, root, pid } = descriptor;
  if (!path.isAbsolute(runc || "") || !/^relay-fixture-[a-f0-9-]{36}$/.test(id || "")
    || !/^\/tmp\/relay-oci-worker-[a-zA-Z0-9]+$/.test(root || "") || !Number.isSafeInteger(pid) || pid <= 1
    || createHash("sha256").update(readFileSync(runc)).digest("hex") !== verifiedRuncHash) throw Error("Invalid owned OCI fixture descriptor");
  const bundle = path.join(root, "bundle"), rootfs = path.join(bundle, "rootfs"), state = path.join(root, "state");
  const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, base = ["--root", state, "--rootless", "true"];
  function validate() {
    const stat = lstatSync(root), markerPath = path.join(root, "fixture.json"), markerStat = lstatSync(markerPath);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)
      || !markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.uid !== process.getuid() || (markerStat.mode & 0o077)
      || realpathSync(root) !== root || realpathSync(rootfs) !== rootfs
      || marker.id !== id || marker.root !== root || marker.uid !== process.getuid()) throw Error("Owned OCI fixture marker changed");
    const current = JSON.parse(execFileSync(runc, [...base, "state", id], { env, encoding: "utf8", timeout: 5000 }));
    if (current.id !== id || current.bundle !== bundle || current.pid !== pid || current.status !== "running") throw Error("Owned OCI fixture runtime changed");
    for (const ns of ["pid", "mnt", "net", "user"]) if (readlinkSync(`/proc/${pid}/ns/${ns}`) === readlinkSync(`/proc/self/ns/${ns}`)) throw Error("OCI fixture inherited a host namespace");
    return current;
  }
  validate();
  return {
    id, rootfs, workspace: "/workspace", runtimeHome: "/runtime-home", environmentPath: "/bin:/usr/bin", validate,
    spawn(command, args, options = {}) {
      validate();
      const { cwd = "/workspace", env: childEnv = {}, ...rest } = options;
      const envArgs = Object.entries(childEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
      return spawn(runc, [...base, "exec", "--cwd", cwd, ...envArgs, id, command === "node" ? "/bin/node" : command, ...args], { ...rest, env, detached: true });
    },
  };
}
