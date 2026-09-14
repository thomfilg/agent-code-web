import path from "node:path";
import { spawn } from "node:child_process";

function git(executor, cwd, args, allowDiffExit = false) {
  return new Promise((resolve, reject) => {
    const options = { cwd, env: { PATH: process.env.PATH || "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] };
    const argv = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-pager", ...args];
    const child = executor?.spawn ? executor.spawn("git", argv, options) : spawn("git", argv, options);
    let output = "", truncated = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Workspace diff timed out")); }, 10000);
    child.stdout.on("data", chunk => { const text = chunk.toString(); truncated ||= output.length + text.length > 500000; output += text.slice(0, Math.max(0, 500000 - output.length)); }); child.stderr.resume();
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 || (allowDiffExit && code === 1) ? resolve({ output: output.slice(0, 500000), truncated }) : reject(new Error("Workspace diff unavailable")); });
  });
}
export function diffFiles(diff, repository = "Workspace") {
  return diff.split(/(?=^diff --git )/m).filter(part => part.startsWith("diff --git ")).map(part => {
    const name = /^\+\+\+ b\/(.+)$/m.exec(part)?.[1] || /^--- a\/(.+)$/m.exec(part)?.[1] || /^diff --git a\/.* b\/(.+)$/m.exec(part)?.[1] || "File";
    return { filename: `${repository}/${name}`, additions: (part.match(/^\+(?!\+\+)/gm) || []).length, deletions: (part.match(/^-(?!--)/gm) || []).length,
      patch: part.slice(part.indexOf("@@") >= 0 ? part.indexOf("@@") : 0) };
  });
}
export async function snapshotChanges(chat, executor) {
  const files = []; let truncated = false, unavailable = false;
  let remaining = 1000000;
  const append = items => { for (const file of items) {
    if (remaining <= 0) { truncated = true; break; }
    if (file.patch.length > remaining) truncated = true;
    file.patch = file.patch.slice(0, remaining); remaining -= file.patch.length; files.push(file);
  } };
  for (const repo of chat.repositories?.length ? chat.repositories : [{ fullName: "Workspace", directory: "" }]) {
    if (remaining <= 0) { truncated = true; break; }
    if (repo.directory && path.basename(repo.directory) !== repo.directory) continue;
    const cwd = path.join(executor?.workspace || chat.workspace, repo.directory || "");
    try {
      let base = "HEAD";
      if (repo.defaultBranch) {
        try { base = (await git(executor, cwd, ["merge-base", "HEAD", `refs/remotes/origin/${repo.defaultBranch}`])).output.trim(); } catch {}
      }
      const diff = await git(executor, cwd, ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", base, "--"]).catch(() => ({ output: "", truncated: false }));
      append(diffFiles(diff.output, repo.fullName)); truncated ||= diff.truncated;
      const untracked = (await git(executor, cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).output.split("\0").filter(Boolean);
      for (const name of untracked.slice(0, 30)) {
        if (remaining <= 0) { truncated = true; break; }
        const added = await git(executor, cwd, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", name], true);
        append(diffFiles(added.output, repo.fullName)); truncated ||= added.truncated;
      }
      truncated ||= untracked.length > 30;
    } catch { unavailable = true; /* A read-only inspection failure must not turn a successful agent turn into an error. */ }
  }
  return { files, recordedAt: new Date().toISOString(), note: `Workspace snapshot after the last turn; includes branch, staged, unstaged and up to 30 untracked files per repository.${truncated ? " Some changes are truncated." : ""}${unavailable ? " Some repositories could not be inspected." : ""}` };
}
