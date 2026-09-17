import { terminateWorker } from "./worker-process.mjs";

// Read-only, worker-local identity/fingerprint of the one native credential
// file. Bytes never leave the worker and are never returned to the browser.
// The native logout RPC performs the removal, not this inspector.
export async function codexAuthFileState({ home, nativeHome }) {
  const fs = await import("node:fs/promises"), { constants } = await import("node:fs"), path = await import("node:path"), { createHash } = await import("node:crypto");
  const valid = value => typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) && path.normalize(value) === value && value !== "/" && !/[\x00-\x1f\x7f\\]/.test(value);
  if (process.platform !== "linux" || !valid(home) || !valid(nativeHome) || nativeHome !== path.join(home, "codex")) throw new Error("Native sign-out requires this Linux worker's private Codex profile");
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const identity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].map(String);
  const version = stat => [...identity(stat), stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changed = () => { throw new Error("Native credentials changed during inspection. Refresh /logout."); };
  const openProfile = async () => {
    const handles = [];
    try {
      let current = await fs.open("/", directoryFlags); handles.push(current);
      for (const part of nativeHome.split("/").filter(Boolean)) { current = await fs.open(`/proc/self/fd/${current.fd}/${part}`, directoryFlags); handles.push(current); }
      return { handle: current, anchors: await Promise.all(handles.map(async handle => identity(await handle.stat({ bigint: true })))), close: async () => { for (const handle of handles.reverse()) await handle.close(); } };
    } catch (error) { for (const handle of handles.reverse()) await handle.close(); throw error; }
  };
  let profile, file;
  try {
    profile = await openProfile();
    try { file = await fs.open(`/proc/self/fd/${profile.handle.fd}/auth.json`, fileFlags); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let evidence = null;
    if (file) {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size < 0n || before.size > 256n * 1024n) throw new Error("Native credentials must be one ordinary file under 256 KiB, without hard links");
      const content = Buffer.alloc(Number(before.size) + 1); let offset = 0;
      while (offset < content.length) { const { bytesRead } = await file.read(content, offset, content.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      if (offset !== Number(before.size) || !same(version(before), version(await file.stat({ bigint: true })))) changed();
      evidence = [version(before), createHash("sha256").update(content.subarray(0, offset)).digest("hex")];
    }
    const current = await openProfile();
    try {
      if (!same(profile.anchors, current.anchors)) changed();
      const after = await fs.lstat(`/proc/self/fd/${current.handle.fd}/auth.json`, { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (Boolean(after) !== Boolean(file) || after && !same(evidence[0], version(after))) changed();
    } finally { await current.close(); }
    return { present: Boolean(file), revision: createHash("sha256").update(JSON.stringify([nativeHome, profile.anchors, evidence])).digest("hex") };
  } catch (error) {
    if (error.code) throw new Error("The native credential path is linked, inaccessible or changed; sign-out is unavailable");
    throw error;
  } finally { await file?.close(); await profile?.close(); }
}

export async function inspectCodexAuthFile(executor, input, check = () => {}) {
  check();
  if (!executor || executor.metadata?.backend !== "ec2") { const result = await codexAuthFileState(input); check(); return result; }
  const request = { home: executor.runtimeHome, nativeHome: `${executor.runtimeHome}/codex` };
  if (input.home !== request.home || input.nativeHome !== request.nativeHome) throw new Error("The native credential profile does not match this worker");
  return new Promise((resolve, reject) => {
    const script = `const inspect = (${codexAuthFileState.toString()}); let data=''; for await (const chunk of process.stdin) { data+=chunk; if (data.length>16000) throw new Error('Request too large'); } try { process.stdout.write(JSON.stringify({result:await inspect(JSON.parse(data))})); } catch { process.stdout.write(JSON.stringify({error:true})); }`;
    let child;
    try { child = executor.spawn("node", ["--input-type=module", "-e", script], { cwd: executor.workspace, env: { PATH: executor.environmentPath || "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { check(); reject(new Error("The private credential inspector could not start")); return; }
    let output = "", settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { check(); if (error) throw error; if (typeof value?.present !== "boolean" || !/^[a-f0-9]{64}$/.test(value?.revision || "")) throw new Error("Invalid credential inspection response"); resolve(value); } catch (failure) { reject(failure); }
    };
    const timer = setTimeout(() => { void terminateWorker(child); finish(new Error("Private credential inspection timed out")); }, 10000);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 2000) { void terminateWorker(child); finish(new Error("Private credential inspection exceeded its limit")); } });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.once("error", () => finish(new Error("The private credential inspector could not start")));
    child.once("close", code => { if (code !== 0) return finish(new Error("Private credential inspection stopped")); try { const result = JSON.parse(output); finish(result.error ? new Error("The native credential path could not be safely inspected") : null, result.result); } catch { finish(new Error("Invalid credential inspection response")); } });
    child.stdin.end(JSON.stringify(request));
  });
}
