import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function provisionWorkerKey(directory, key) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const target = path.join(directory, "worker-key");
  const staging = path.join(directory, `.worker-key-${randomUUID()}`);
  try {
    await writeFile(staging, key, { mode: 0o600, flag: "wx" });
    await rename(staging, target);
  } finally {
    await unlink(staging).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  return target;
}
