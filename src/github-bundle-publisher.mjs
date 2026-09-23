import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const MAX_GITHUB_BUNDLE_BYTES = 8 * 1024 * 1024;
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const bundleText = value => typeof value === "string" && value.length <= Math.ceil(MAX_GITHUB_BUNDLE_BYTES / 3) * 4 &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);

const fixedError = () => Object.assign(new Error("The repository-scoped branch publication could not be confirmed. Inspect the remote branch before retrying."), { code: "publish-failed" });
const output = value => typeof value === "string" ? value.trim() : "";
const remoteHead = (value, expectedRef) => {
  const line = output(value);
  if (!line) return null;
  const match = /^([a-f0-9]{40})\t(refs\/heads\/[A-Za-z0-9_][A-Za-z0-9_./-]*)$/.exec(line);
  if (!match || match[2] !== expectedRef || line.includes("\n")) throw fixedError();
  return match[1];
};

export function decodeGitHubBundle(value) {
  if (!bundleText(value)) throw fixedError();
  const bundle = Buffer.from(value, "base64");
  if (!bundle.length || bundle.length > MAX_GITHUB_BUNDLE_BYTES || bundle.toString("base64") !== value) throw fixedError();
  return bundle;
}

/**
 * Publish one exact commit from a bounded Git bundle without returning the
 * selected provider credential to the worker. All repository/ref arguments
 * have already passed the MCP and saved-selection validators.
 */
export async function publishGitHubBundle({ repository, connection, branch, baseSha, headSha, expectedRemoteSha = null, bundleBase64,
  signal, assertCurrent = async () => {}, execute = exec, temporaryRoot = os.tmpdir(), remoteOverrideForTests = null }) {
  if (!repository?.fullName || !connection?.token || !sha(baseSha) || !sha(headSha) || expectedRemoteSha !== null && !sha(expectedRemoteSha)) throw fixedError();
  const bundle = decodeGitHubBundle(bundleBase64), directory = await mkdtemp(path.join(temporaryRoot, "relay-github-publish-"));
  const bare = path.join(directory, "repository.git"), bundlePath = path.join(directory, "objects.bundle"), askpass = path.join(directory, "askpass.sh");
  const testRemote = remoteOverrideForTests && path.resolve(remoteOverrideForTests);
  if (testRemote && !(testRemote + path.sep).startsWith(path.resolve(temporaryRoot) + path.sep)) throw fixedError();
  const ref = `refs/heads/${branch}`, remote = testRemote || `https://github.com/${repository.fullName}.git`;
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: directory, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS_REQUIRE: "force", GIT_ASKPASS: askpass, RELAY_GITHUB_PUBLISH_TOKEN: connection.token };
  const run = async args => {
    signal?.throwIfAborted();
    const result = await execute("git", args, { env, signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
    signal?.throwIfAborted(); await assertCurrent(); return result;
  };
  try {
    await mkdir(bare, { mode: 0o700 });
    await writeFile(bundlePath, bundle, { flag: "wx", mode: 0o600 });
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" x-access-token ;;\n  *Password*) printf "%s\\n" "$RELAY_GITHUB_PUBLISH_TOKEN" ;;\n  *) exit 1 ;;\nesac\n', { flag: "wx", mode: 0o700 });
    await assertCurrent();
    await run(["init", "--bare", "--quiet", bare]);
    await run(["-C", bare, "remote", "add", "origin", remote]);
    const before = remoteHead((await run(["-C", bare, "ls-remote", "--heads", "origin", ref])).stdout, ref);
    if (before !== expectedRemoteSha) throw fixedError();
    for (const required of new Set([baseSha, expectedRemoteSha].filter(Boolean))) {
      const fetched = output((await run(["-C", bare, "fetch", "--quiet", "--no-tags", "--depth=1", "--no-write-fetch-head", "origin", required])).stdout);
      if (fetched) throw fixedError();
    }
    await run(["-C", bare, "cat-file", "-e", `${baseSha}^{commit}`]);
    await run(["-C", bare, "bundle", "verify", bundlePath]);
    await run(["-C", bare, "bundle", "unbundle", bundlePath]);
    await run(["-C", bare, "cat-file", "-e", `${headSha}^{commit}`]);
    await run(["-C", bare, "merge-base", "--is-ancestor", baseSha, headSha]);
    if (expectedRemoteSha) await run(["-C", bare, "merge-base", "--is-ancestor", expectedRemoteSha, headSha]);
    const lease = `--force-with-lease=${ref}:${expectedRemoteSha || ""}`;
    await run(["-C", bare, "push", "--porcelain", lease, "origin", `${headSha}:${ref}`]);
    const after = remoteHead((await run(["-C", bare, "ls-remote", "--heads", "origin", ref])).stdout, ref);
    if (after !== headSha) throw fixedError();
    return { branch, baseSha, headSha, previousSha: before, operation: "published" };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw fixedError();
  } finally {
    env.RELAY_GITHUB_PUBLISH_TOKEN = "";
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
