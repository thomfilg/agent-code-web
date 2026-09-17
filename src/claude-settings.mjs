import { spawnWorker, terminateWorker } from "./worker-process.mjs";

export const CLAUDE_PERMISSION_MODES = Object.freeze({ auto: "auto", acceptEdits: "accept_edits", plan: "plan", default: "default", dontAsk: "dont_ask" });

// Only identify requested keys here. The native CLI still parses and executes
// the original command, including validation and partial-success reporting.
export function claudeConfigRequest(text) {
  const match = /^\/(config|settings|autocompact)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const argument = (match[2] || "").trim();
  if (!argument || argument === "--help") return { mutate: false, values: {} };
  // This native control writes the same private settings file. Leave its
  // token-size parsing, precedence and persistence to the installed CLI.
  if (match[1] === "autocompact") return { mutate: true, values: {} };
  const words = []; let word = "", quote = "", escape = false;
  for (const character of argument) {
    if (escape) { word += character; escape = false; }
    else if (character === "\\") escape = true;
    else if (quote) { if (character === quote) quote = ""; else word += character; }
    else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) { if (word) words.push(word); word = ""; }
    else word += character;
  }
  if (quote || escape) return { mutate: true, values: {} };
  if (word) words.push(word);
  const values = {};
  for (const token of words) { const entry = /^(model|permissionMode)=(.*)$/.exec(token); if (entry) values[entry[1]] = entry[2]; }
  return { mutate: true, values };
}

export function claudeSettingsChanges(before, after, request) {
  const result = {};
  if (before.model !== after.model || request.values.model === after.model) result.model = after.model;
  if (before.permissionMode !== after.permissionMode || request.values.permissionMode === after.permissionMode) result.mode = CLAUDE_PERMISSION_MODES[after.permissionMode];
  return result;
}

// Serializable worker-side reader. It returns two non-secret fields only,
// never raw settings, permissions rules, hooks, environment or credentials.
export async function readPrivateClaudeSettings(runtimeHome, filename = "settings.json") {
  const fs = await import("node:fs/promises"), path = await import("node:path"), { constants } = await import("node:fs");
  if (!["settings.json", ".claude.json"].includes(filename)) throw Error("Invalid private profile file");
  const profile = path.join(runtimeHome, "claude"), filepath = path.join(profile, filename);
  const empty = { model: "default", permissionMode: "default" };
  if (await fs.realpath(runtimeHome) !== path.resolve(runtimeHome)) throw Error("Private runtime path is linked");
  try { if ((await fs.lstat(profile)).isSymbolicLink() || await fs.realpath(profile) !== path.resolve(profile)) throw Error("Private profile path is linked"); }
  catch (error) { if (error.code === "ENOENT") return empty; throw error; }
  let file;
  try { file = await fs.open(filepath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === "ENOENT") return empty; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw Error("Invalid private settings file");
    // Bound the read even if another process grows the file after stat().
    const buffer = Buffer.alloc(stat.size + 1); let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes !== stat.size) throw Error("Settings changed during inspection");
    const data = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("Invalid private settings object");
    const after = await file.stat(), current = await fs.lstat(filepath);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.ino !== current.ino || after.dev !== current.dev || current.isSymbolicLink() || await fs.realpath(profile) !== path.resolve(profile)) throw Error("Settings changed during inspection");
    // MCP toggles write .claude.json. Validate the private file, but never
    // return its account metadata, auth configuration or project settings.
    if (filename === ".claude.json") return empty;
    const model = data.model == null ? "default" : data.model, permissionMode = data.permissions?.defaultMode || "default";
    if (typeof model !== "string" || model.length > 150 || !/^[\w.\[\]-]+$/.test(model)) throw Error("Invalid native model setting");
    if (!["auto", "acceptEdits", "plan", "default", "dontAsk"].includes(permissionMode)) throw Error("Invalid native permission setting");
    return { model, permissionMode };
  } finally { await file.close(); }
}

export async function inspectClaudeSettings({ runtimeHome, executor, isolation, signal, filename = "settings.json" }) {
  signal?.throwIfAborted();
  if (!executor || executor.metadata?.backend === "local") {
    const result = await readPrivateClaudeSettings(runtimeHome, filename); signal?.throwIfAborted(); return result;
  }
  const script = `(${readPrivateClaudeSettings.toString()})(process.argv[1],process.argv[2]).then(value => process.stdout.write(JSON.stringify(value))).catch(() => { process.stderr.write("Cannot safely inspect this private Claude profile"); process.exitCode = 1; });`;
  return new Promise((resolve, reject) => {
    const child = (executor.spawn?.bind(executor) || spawnWorker)("node", ["-e", script, runtimeHome, filename], { cwd: runtimeHome, env: { PATH: executor.environmentPath || process.env.PATH, HOME: runtimeHome, LANG: "C.UTF-8" }, isolation, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(value); };
    const abort = () => { void terminateWorker(child); finish(Error("Claude settings inspection interrupted")); };
    const timer = setTimeout(() => { void terminateWorker(child); finish(Error("Claude settings inspection timed out")); }, 5000);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    child.stderr.resume(); child.stdout.on("data", chunk => {
      if (settled) return;
      if (output.length + chunk.length > 4096) { abort(); return; }
      output += chunk;
    });
    child.once("error", () => finish(Error("Could not start Claude settings inspection")));
    child.once("close", code => {
      if (code !== 0) return finish(Error("Cannot safely inspect this private Claude profile"));
      try {
        const value = JSON.parse(output);
        if (typeof value.model !== "string" || value.model.length > 150 || !/^[\w.\[\]-]+$/.test(value.model) || !Object.hasOwn(CLAUDE_PERMISSION_MODES, value.permissionMode)) throw Error("Invalid settings response");
        finish(null, { model: value.model, permissionMode: value.permissionMode });
      } catch { finish(Error("Invalid Claude settings inspection response")); }
    });
  });
}
