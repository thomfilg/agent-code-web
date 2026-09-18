// Fixed disposable workspace fixture. No arbitrary paths or commands from input.
import { mkdir, writeFile, readFile, lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const publicRepository = "https://github.com/octocat/Hello-World.git";
export function workspaceIdentity(runId, remoteRoot = "/opt/agent-web/chats") {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId || "")) throw Error("Invalid workspace fixture identity");
  const chatId = `chat_${runId.replaceAll("-", "")}`;
  return { chatId, root: path.join(remoteRoot, chatId) };
}
export function credentialFreeGitConfig(config) {
  const entries = config.split("\0").filter(Boolean);
  if (entries.some(entry => !entry.includes("\n"))) return false;
  const values = entries.map(entry => { const n = entry.indexOf("\n"); return [entry.slice(0, n), entry.slice(n + 1)]; });
  const permitted = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates)|remote\.origin\.(?:url|fetch)|branch\.[\w./-]+\.(?:remote|merge))$/;
  return values.some(([key, value]) => key === "remote.origin.url" && value === publicRepository) &&
    values.every(([key, value]) => permitted.test(key) &&
      (!key.endsWith(".url") || value === publicRepository) && !/https?:\/\/[^/]+@/.test(value));
}
export async function workspaceProbe(request, { remoteRoot, execute = promisify(execFile) } = {}) {
  const { runId, action } = request || {}, { root } = workspaceIdentity(runId, remoteRoot);
  if (process.getuid() === 0 || !["create", "inspect", "cleanup"].includes(action)) throw Error("Invalid workspace fixture action");
  const owner = path.join(root, "workspace-acceptance-owner.json"), workspace = path.join(root, "workspace");
  if (action === "create") {
    await mkdir(root, { mode: 0o700 }); // Never adopt a stale/product workspace.
    await writeFile(owner, JSON.stringify({ runId, kind: "public-workspace-acceptance" }), { flag: "wx", mode: 0o600 });
    return { schema: 1, runId, created: true };
  }
  const info = await lstat(root), mark = await lstat(owner);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077 ||
      !mark.isFile() || mark.isSymbolicLink() || mark.nlink !== 1 || mark.uid !== process.getuid() || mark.mode & 0o077 ||
      await realpath(root) !== root || await readFile(owner, "utf8") !== JSON.stringify({ runId, kind: "public-workspace-acceptance" })) throw Error("Workspace fixture ownership changed");
  if (action === "cleanup") {
    await rm(root, { recursive: true, force: false });
    return { schema: 1, runId, cleanedUp: true };
  }
  const safeEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  const git = async args => (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: workspace, env: safeEnv, timeout: 10000, maxBuffer: 32768 })).stdout;
  const head = (await git(["rev-parse", "HEAD"])).trim();
  if (!/^[a-f0-9]{40}$/.test(head) || !credentialFreeGitConfig(await git(["config", "--local", "--null", "--list"]))) throw Error("Workspace fixture Git metadata failed");
  const sentinel = path.join(workspace, "relay-acceptance-sentinel.txt"), expected = `remote-${runId}\n`;
  if (request.phase === "first") await writeFile(sentinel, expected, { flag: "wx", mode: 0o600 });
  else if (request.phase !== "second") throw Error("Invalid workspace fixture phase");
  if (await readFile(sentinel, "utf8") !== expected) throw Error("Workspace fixture sentinel changed");
  return { schema: 1, runId, head, credentialFreeGitConfig: true, remoteSentinel: true };
}

if (process.argv[1] === "--relay-workspace-probe") {
  try { console.log(JSON.stringify(await workspaceProbe(JSON.parse(process.argv[2])))); }
  catch { console.error("Workspace fixture failed; private output suppressed"); process.exitCode = 1; }
}
