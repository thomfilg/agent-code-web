import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { temporaryDirectory } from "./helpers.mjs";
import { provisionWorkerKey } from "../deploy/aws/worker-key.mjs";

test("worker transport key survives a container process restart without exposing stale copies", async t => {
  const root = await temporaryDirectory(t), directory = path.join(root, "transport");
  const first = await provisionWorkerKey(directory, "first key");
  const second = await provisionWorkerKey(directory, "replacement key");
  assert.equal(first, second);
  assert.equal(await readFile(second, "utf8"), "replacement key");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(second)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["worker-key"]);
});
