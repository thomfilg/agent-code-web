import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { GitHubWorkerGateway } from "../src/github-worker-gateway.mjs";
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

for (const persistence of ["file", "database"]) test(`legacy source-only ${persistence} chats restore without inventing GitHub selections`, async t => {
  const root = await temporaryDirectory(t), records = persistence === "database" ? new MemoryRecords() : null;
  const store = new ChatStore(root, records); await store.initialize();
  const variants = [undefined, null, {}, [null], [{ fullName: "company/incomplete" }],
    [{ id: 31, fullName: "company/old-selection" }], [{ id: 31, fullName: "company/old-selection", githubConnectionId: "" }]], ids = [];
  for (const repositories of variants) {
    const chat = await store.create({ agent: "codex", title: "Legacy source", source: path.join(root, "old-source"), ownerId: "original-owner" });
    if (repositories === undefined) delete chat.repositories;
    else chat.repositories = repositories;
    ids.push(chat.id);
    if (records) await records.put("chat", chat.id, chat);
    else await writeFile(store.chatFile(chat.id), JSON.stringify(chat));
  }
  const restarted = new ChatStore(root, records); await restarted.initialize();
  const gateway = new GitHubWorkerGateway({ store: restarted, servicesFor: () => { throw Error("Must not infer a GitHub connection"); } });
  t.after(() => gateway.shutdown());
  assert.deepEqual(restarted.get(ids[0]).repositories, []);
  assert.equal(restarted.get(ids[0]).ownerId, "original-owner");
  assert.equal(restarted.get(ids[0]).source, path.join(root, "old-source"));
  assert.deepEqual(await gateway.runtime(ids[0], "https://relay.example"), { token: null, environmentVariables: {}, repositories: [] });
  for (let index = 1; index < ids.length; index++) {
    assert.deepEqual(restarted.get(ids[index]).repositories, variants[index]);
    await assert.rejects(gateway.runtime(ids[index], "https://relay.example"), {
      statusCode: 403,
      message: "This chat's saved GitHub repository selection is incomplete or invalid. Select the repository and intended GitHub account again in a new chat.",
    });
  }
  assert.equal(gateway.entries.size, 0);
});
