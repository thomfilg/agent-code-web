import { spawn } from "node:child_process";
import { closeSync } from "node:fs";

// This process is the detached session/group leader. Keep its PID allocated
// after the command exits so explicit cleanup cannot target a reused group ID.
// No credentials/specs/output are written to disk or logs.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});
process.on("disconnect", () => {});
setInterval(() => {}, 60000);
const send = message => { if (process.connected) process.send(message, () => {}); };
const closePipes = () => { for (const fd of [0, 1, 2]) { try { closeSync(fd); } catch {} } };
process.once("message", spec => {
  let child;
  try { child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["inherit", "inherit", "inherit"] }); }
  catch { send({ type: "launchFailed" }); closePipes(); return; }
  child.once("spawn", () => send({ type: "ready", pid: child.pid, anchorPid: process.pid }));
  child.once("error", () => { send({ type: "launchFailed" }); closePipes(); });
  child.once("exit", (code, signal) => { send({ type: "commandExit", code, signal }); closePipes(); });
});
