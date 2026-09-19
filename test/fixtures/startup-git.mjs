#!/usr/bin/env node
// No network: used only by parallel-startup tests with an isolated PATH entry.
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] !== "clone" || !args.at(-2)?.startsWith("https://github.com/fixture/")) process.exit(2);
await mkdir(`${args.at(-1)}/.git`, { recursive: true });
if (args.at(-2).endsWith("/descendants.git")) {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); process.stdout.write("ready\\n"); setInterval(()=>{},1000);'], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.once("data", async () => { await writeFile(`${args.at(-1)}/child.pid`, String(child.pid)); });
  child.stdout.pipe(process.stdout);
  setInterval(() => {}, 1000);
}
