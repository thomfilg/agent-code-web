import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { SSH_WORKER_LAUNCHER, sshWorkerRequest } from "../src/ssh-worker-launcher.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

async function fixture(t, script, { env = {}, args = [] } = {}) {
  const root = await temporaryDirectory(t), heartbeat = path.join(root, ".heartbeat");
  await writeFile(heartbeat, "");
  const child = spawn(process.execPath, ["--input-type=module", "-e", SSH_WORKER_LAUNCHER], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, CONTROLLER_SECRET: "never-inherit-me" } });
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
  child.stdin.on("error", () => {});
  const done = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
  const header = sshWorkerRequest({ command: process.execPath, args: ["-e", script, ...args], cwd: root, env, heartbeat });
  return { child, header, done, root, heartbeat, stdout: () => stdout };
}

test("SSH bootstrap preserves coalesced binary stdin and isolates the native environment", async t => {
  const data = Buffer.from([0, 255, 10, 13, 128, 42]), token = "fixture-account-access-token";
  const run = await fixture(t, "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({data:Buffer.concat(chunks).toString('hex'),env:process.env,cwd:process.cwd(),args:process.argv.slice(1)}));});", { env: { TOKEN: token, EMPTY: "", UNDEFINED: undefined }, args: ["config.private=fixture-mcp-capability"] });
  assert.ok(run.child.spawnargs.every(arg => !arg.includes(token) && !arg.includes("fixture-mcp-capability")));
  run.child.stdin.end(Buffer.concat([Buffer.from(run.header), data]));
  const result = await run.done;
  assert.equal(result.code, 0); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { data: data.toString("hex"), env: { TOKEN: token, EMPTY: "" }, cwd: run.root, args: ["config.private=fixture-mcp-capability"] });
  assert.ok((await stat(run.heartbeat)).mtimeMs > 0);
});

test("SSH bootstrap handles split header and a live bidirectional CLI stream", async t => {
  const run = await fixture(t, "process.stdout.write('ready\\n');process.stdin.on('data',c=>process.stdout.write(c));");
  run.child.stdin.write(run.header.slice(0, 7));
  run.child.stdin.write(run.header.slice(7));
  await waitFor(() => run.stdout() === "ready\n");
  run.child.stdin.write("one\n"); await waitFor(() => run.stdout().includes("one\n"));
  run.child.stdin.end("two\n");
  assert.deepEqual(await run.done, { code: 0, signal: null, stdout: "ready\none\ntwo\n", stderr: "" });
});

test("SSH bootstrap propagates exit status and drains large stdout/stderr", async t => {
  const run = await fixture(t, "process.stdout.write('x'.repeat(200000));process.stderr.write('y'.repeat(200000));process.exitCode=23;");
  run.child.stdin.end(run.header);
  const result = await run.done;
  assert.equal(result.code, 23); assert.equal(result.stdout, "x".repeat(200000)); assert.equal(result.stderr, "y".repeat(200000));
});

test("SSH bootstrap errors never echo malformed payloads or native launch arguments", async t => {
  for (const invalid of ["{\"token\":\"private-fixture\"\n", JSON.stringify({ command: "private-fixture", args: [], env: {}, cwd: "/", heartbeat: "/missing-fixture-heartbeat" }) + "\n", "", "x".repeat(16 * 1024 * 1024 + 1)]) {
    const run = await fixture(t, ""); run.child.stdin.end(invalid);
    const result = await run.done;
    assert.equal(result.code, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /^Remote worker launcher failed\n$/);
  }
});

test("SSH bootstrap shutdown terminates the native process group", async t => {
  const run = await fixture(t, "const fs=require('node:fs');fs.writeFileSync('native-pid',String(process.pid));setInterval(()=>{},1000);");
  run.child.stdin.write(run.header);
  const pid = await waitFor(async () => { try { return Number(await readFile(path.join(run.root, "native-pid"), "utf8")); } catch {} });
  run.child.kill("SIGTERM");
  assert.equal((await run.done).code, 143);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("SSH output transport failure stops the native worker instead of leaving an orphan", async t => {
  const run = await fixture(t, "const fs=require('node:fs');fs.writeFileSync('native-pid',String(process.pid));setInterval(()=>process.stdout.write('frame\\n'),20);");
  run.child.stdin.write(run.header);
  const pid = await waitFor(async () => { try { return Number(await readFile(path.join(run.root, "native-pid"), "utf8")); } catch {} });
  run.child.stdout.destroy();
  assert.equal((await run.done).code, 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
