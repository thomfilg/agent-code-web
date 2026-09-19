// This function is serialized verbatim into the SSH command. Keep it standalone:
// only fixed code goes into argv; all per-chat arguments/environment use stdin.
async function remoteWorkerMain() {
  const { spawn } = await import("node:child_process");
  const { utimes } = await import("node:fs/promises");
  const { constants } = await import("node:os");
  let header = Buffer.alloc(0), worker, heartbeat, stopping = false, initializing = false, stopCode;
  const fail = () => { process.stderr.write("Remote worker launcher failed\n"); stop(1); };
  const stop = code => {
    if (stopping) return;
    stopping = true; stopCode = code; clearInterval(heartbeat); clearTimeout(deadline);
    if (worker?.pid) {
      try { process.kill(-worker.pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-worker.pid, "SIGKILL"); } catch {} process.exit(code); }, 2000);
    } else process.exit(code);
  };
  const deadline = setTimeout(fail, 15000);
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) process.on(signal, () => stop(128 + constants.signals[signal]));
  process.stdout.on("error", () => stop(1)); process.stderr.on("error", () => stop(1));
  process.stdin.on("error", fail);
  process.stdin.on("end", () => { if (!worker && !initializing && !stopping) fail(); });
  const readHeader = async chunk => {
    header = Buffer.concat([header, chunk]);
    const newline = header.indexOf(10);
    if (newline < 0) { if (header.length > 16 * 1024 * 1024) fail(); return; }
    initializing = true; process.stdin.pause(); process.stdin.off("data", readHeader); clearTimeout(deadline);
    try {
      if (newline > 16 * 1024 * 1024) throw Error();
      const request = JSON.parse(header.subarray(0, newline));
      if (typeof request.command !== "string" || !request.command || !Array.isArray(request.args) || !request.args.every(arg => typeof arg === "string") ||
          typeof request.cwd !== "string" || !request.cwd.startsWith("/") || typeof request.heartbeat !== "string" || !request.heartbeat.startsWith("/") ||
          !request.env || Array.isArray(request.env) || Object.entries(request.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")) throw Error();
      const touch = () => { const now = new Date(); return utimes(request.heartbeat, now, now); };
      await touch();
      if (stopping) return;
      worker = spawn(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      worker.once("error", fail);
      worker.stdin.on("error", () => {});
      worker.stdout.pipe(process.stdout); worker.stderr.pipe(process.stderr);
      worker.once("close", (code, signal) => {
        clearInterval(heartbeat); stopping = true;
        // Normal exits drain buffered SSH output. Explicit termination retains
        // the bounded two-second deadline even when a consumer is stalled.
        process.exitCode = stopCode ?? code ?? (128 + (constants.signals[signal] || 1));
        process.stdin.destroy();
      });
      heartbeat = setInterval(() => { void touch().catch(fail); }, 20000);
      const remainder = header.subarray(newline + 1); header = null;
      if (remainder.length) worker.stdin.write(remainder);
      process.stdin.pipe(worker.stdin); process.stdin.resume();
    } catch { fail(); }
  };
  process.stdin.on("data", readHeader);
}

export const SSH_WORKER_LAUNCHER = `(${remoteWorkerMain.toString()})().catch(() => { process.stderr.write("Remote worker launcher failed\\n"); process.exit(1); });`;

export function sshWorkerRequest({ command, args, cwd, env, heartbeat }) {
  // Normalize like child_process.spawn's environment, without serializing any
  // inherited controller environment or undefined settings into the request.
  return JSON.stringify({ command, args, cwd, heartbeat, env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])) }) + "\n";
}
