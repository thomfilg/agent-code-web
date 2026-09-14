import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ChatStore } from "../src/store.mjs";
import { prepareWorkspace } from "../src/workspace.mjs";
import { temporaryDirectory } from "./helpers.mjs";

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`git exited ${code}`)));
  });
}

test("chat state and independent Git workspace persist across store restarts", async (t) => {
  const root = await temporaryDirectory(t);
  const source = path.join(root, "source");
  await mkdir(source);
  await git(["init", "--quiet"], source);
  await writeFile(path.join(source, "README.md"), "committed workspace\n");
  await git(["add", "README.md"], source);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"], source);

  const store = new ChatStore(path.join(root, "data"));
  await store.initialize();
  const chat = await store.create({ title: "Persistent", agent: "mock", source });
  await prepareWorkspace({ destination: chat.workspace, source });
  await store.appendMessage(chat.id, { role: "user", kind: "message", text: "hello" });
  assert.equal(await readFile(path.join(chat.workspace, "README.md"), "utf8"), "committed workspace\n");

  const restarted = new ChatStore(path.join(root, "data"));
  await restarted.initialize();
  assert.equal(restarted.get(chat.id).messages[0].text, "hello");
  assert.equal(restarted.get(chat.id).status, "stopped");
});

test("repository URLs with embedded credentials are rejected", async (t) => {
  const root = await temporaryDirectory(t);
  await assert.rejects(
    prepareWorkspace({ destination: path.join(root, "workspace"), source: "https://user:secret@example.test/repo.git" }),
    /credentials are not allowed/,
  );
});
