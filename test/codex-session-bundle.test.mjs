import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, stat, symlink } from "node:fs/promises";
import path from "node:path";
import * as zlib from "node:zlib";
import { captureSessionBundle, installSessionBundle, readSessionBytes, validateSessionBundle, workerSessionIO } from "../src/codex-session-bundle.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const ids = ["11111111-1111-7111-8111-111111111111", "22222222-2222-7222-8222-222222222222", "33333333-3333-7333-8333-333333333333", "44444444-4444-7444-8444-444444444444"];
const row = (type, payload) => `${JSON.stringify({ timestamp: "2026-09-15T16:00:00.000Z", type, payload })}\n`;
const header = (id, parent, size) => row("session_meta", { id, timestamp: "2026-09-15T16:00:00.000Z", history_mode: "paginated", ...(parent ? { forked_from_id: parent, forked_from_ordinal_exclusive: 3, history_base: { thread_id: parent, end_ordinal_exclusive: 3, end_byte_offset: size } } : {}) });
const message = text => row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });

function lineage() {
  const original = Buffer.from(header(ids[0]) + message("Café 🍺 — preserve exact UTF-8 bytes") + row("response_item", { type: "reasoning", encrypted_content: "opaque-fixture", summary: [] }));
  const branch = Buffer.from(header(ids[1], ids[0], original.length) + message("First branch"));
  const leaf = Buffer.from(header(ids[2], ids[1], branch.length));
  return { original, branch, leaf };
}

async function captureFixture() {
  const { original, branch, leaf } = lineage(), reads = [];
  const files = new Map([[ids[0], Buffer.concat([original, Buffer.from(message("Never copy this later source message"))])], [ids[1], Buffer.concat([branch, Buffer.from(message("Not in the nested fork"))])], [ids[2], leaf]]);
  const goal = { threadId: ids[2], objective: "Carry this native goal", status: "active", tokenBudget: 10000 };
  const bundle = await captureSessionBundle({ threadId: ids[2], goal, readThread: async id => { reads.push(id); return { id, path: id }; }, readBytes: async id => files.get(id) });
  return { bundle, reads, original, branch, leaf };
}

test("native fork bundles contain only required ancestors and stop at exact byte boundaries", async () => {
  const { bundle, reads, original, branch, leaf } = await captureFixture();
  assert.deepEqual(reads, [ids[2], ids[1], ids[0]]);
  const files = validateSessionBundle(bundle);
  assert.deepEqual(files.get(ids[0]).bytes, original); assert.deepEqual(files.get(ids[1]).bytes, branch); assert.deepEqual(files.get(ids[2]).bytes, leaf);
  assert.match(files.get(ids[0]).bytes.toString(), /opaque-fixture/);
  assert.doesNotMatch(JSON.stringify(bundle.files.map(file => Buffer.from(file.data, "base64").toString())), /Never copy|Not in the nested/);
  assert.equal(bundle.goal.status, "active"); assert.equal(bundle.goal.tokenBudget, 10000);
});

test("native bundles reject missing/unrelated history, corrupt encoding, wrong IDs and boundaries", async () => {
  const { bundle } = await captureFixture();
  const alter = edit => { const bad = structuredClone(bundle); edit(bad); return bad; };
  assert.throws(() => validateSessionBundle(alter(b => b.files.pop())), /boundary|missing/);
  assert.throws(() => validateSessionBundle(alter(b => b.files.push({ id: ids[3], data: Buffer.from(header(ids[3])).toString("base64") }))), /unrelated/);
  assert.throws(() => validateSessionBundle(alter(b => b.files[0].id = "../../auth.json")), /ID/);
  assert.throws(() => validateSessionBundle(alter(b => b.files[0].data += "\n")), /encoding/);
  assert.throws(() => validateSessionBundle(alter(b => b.files[0].id = ids[3])), /identity/);
  assert.throws(() => validateSessionBundle(alter(b => b.files[2].data = Buffer.concat([Buffer.from(b.files[2].data, "base64"), Buffer.from(message("extra"))]).toString("base64"))), /boundary/);
  assert.throws(() => validateSessionBundle(alter(b => b.goal.threadId = ids[0])), /goal/);
  assert.throws(() => validateSessionBundle(alter(b => b.goal.tokenBudget = -1)), /goal budget/);
  assert.throws(() => validateSessionBundle(bundle, ids[0]), /bundle/);
});

test("native import is credential-free, idempotent, private, and refuses overwrite or symlink destinations", async t => {
  const root = await temporaryDirectory(t), home = path.join(root, "profile");
  const { bundle } = await captureFixture();
  const filename = await installSessionBundle(home, bundle);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(home), ["sessions"]);
  assert.deepEqual(await readFile(filename), Buffer.from(bundle.files[0].data, "base64"));
  assert.equal(await installSessionBundle(home, bundle), filename);
  await writeFile(filename, message("legitimate later continuation"), { flag: "a" });
  await installSessionBundle(home, bundle);
  assert.match(await readFile(filename, "utf8"), /legitimate later continuation/);
  await writeFile(filename, header(ids[2]) + message("Do not replace me"));
  await assert.rejects(installSessionBundle(home, bundle), /Refusing to replace/);
  assert.match(await readFile(filename, "utf8"), /Do not replace me/);
  const unsafe = path.join(root, "unsafe"); await symlink(home, unsafe);
  await assert.rejects(installSessionBundle(unsafe, bundle), /symlink/);
  await assert.rejects(installSessionBundle("/", bundle), /private/);
  assert.ok(!(await readdir(path.dirname(filename))).some(name => name.startsWith(".import-")));
});

test("native session reads are bounded and support compressed rollouts without following file symlinks", async t => {
  const root = await temporaryDirectory(t), filename = path.join(root, "fixture.jsonl");
  const { original } = lineage(); await writeFile(filename, Buffer.concat([original, Buffer.from(message("after boundary"))]));
  assert.deepEqual(await readSessionBytes(filename, original.length), original);
  await assert.rejects(readSessionBytes(filename, -1), /boundary/);
  await assert.rejects(readSessionBytes(filename, original.length * 100), /shorter/);
  await symlink(filename, path.join(root, "linked.jsonl")); await assert.rejects(readSessionBytes(path.join(root, "linked.jsonl")));
  if (zlib.zstdCompressSync) {
    const compressed = path.join(root, "fixture.jsonl.zst"); await writeFile(compressed, zlib.zstdCompressSync(original));
    assert.deepEqual(await readSessionBytes(compressed), original);
  }
});

test("worker-side transfer uses the same validation without inheriting controller credentials", async t => {
  const root = await temporaryDirectory(t), { bundle } = await captureFixture();
  const home = path.join(root, "remote-codex"); const executions = [];
  const executor = { runtimeHome: root, spawn: (command, args, options) => { executions.push(options); return spawn(command, args, options); } };
  const installed = await workerSessionIO(executor, { action: "install", home, bundle });
  const read = await workerSessionIO(executor, { action: "read", path: installed.path });
  assert.equal(read.data, bundle.files[0].data);
  assert.deepEqual(Object.keys(executions[0].env).sort(), ["HOME", "LANG", "PATH"]);
  await assert.rejects(workerSessionIO(executor, { action: "read", path: path.join(root, "auth.json") }), /Unsupported native session file/);
  await assert.rejects(workerSessionIO(null, { action: "unrecognized", home, bundle }), /Unknown native transfer operation/);
});
