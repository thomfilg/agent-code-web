import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

// The deployer supplies this one controller-only secret through an ephemeral
// environment file. Never place it in the image, worker user-data or logs.
const encodedKey = process.env.AGENT_WORKER_SSH_KEY_BASE64;
delete process.env.AGENT_WORKER_SSH_KEY_BASE64;
if (process.env.AGENT_WORKER_BACKEND !== "ec2") throw new Error("The AWS controller requires isolated EC2 workers");
if (!encodedKey || encodedKey.length > 16384) throw new Error("Configure the controller worker transport key");
const key = Buffer.from(encodedKey, "base64").toString();
if (!key.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")) throw new Error("Invalid worker transport key format");
await mkdir("/tmp/relay-transport", { mode: 0o700, recursive: true });
await writeFile("/tmp/relay-transport/worker-key", key, { mode: 0o600, flag: "wx" });
process.env.AGENT_EC2_SSH_PRIVATE_KEY = "/tmp/relay-transport/worker-key";
process.env.HOME = "/var/lib/relay/control/home";
await mkdir(process.env.HOME, { mode: 0o700, recursive: true });
const child = spawn(process.execPath, ["src/server.mjs"], { stdio: "inherit", env: process.env });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.once("error", () => { console.error("Controller failed to start"); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
