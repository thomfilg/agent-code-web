import { terminateWorker } from "./worker-process.mjs";

// Runs unchanged on the actual worker. This is a read-only preflight and
// fingerprint, not a sandbox for native import or for imported executable code.
export async function codexImportFileState({ workspace, home, codexHome, source, includeHome = false }) {
  const fs = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const path = await import("node:path");
  const { createHash } = await import("node:crypto");
  const valid = value => typeof value === "string" && value.length <= 4096 && !/[\x00-\x1f\x7f\\]/.test(value) && path.isAbsolute(value) && path.normalize(value) === value && value !== "/";
  if (process.platform !== "linux") throw new Error("Import file inspection requires a Linux worker");
  if (!valid(workspace) || !valid(home) || typeof includeHome !== "boolean" || !["claude-code", "cursor"].includes(source)) throw new Error("Invalid native import scope");
  if (includeHome && (!valid(codexHome) || !codexHome.startsWith(`${home}/`))) throw new Error("Imports require a native profile inside this worker's private home");
  const deadline = Date.now() + 30000, maxFiles = 50000, maxBytes = 2 * 1024 * 1024 * 1024;
  let files = 0, bytes = 0;
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const leafFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fdPath = handle => `/proc/self/fd/${handle.fd}`;
  const version = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  const identity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].map(String);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changed = () => { throw Object.assign(new Error("Import files changed while being inspected. Refresh and review again."), { name: "ImportFilesChangedError" }); };
  const budget = () => { if (files > maxFiles || bytes > maxBytes || Date.now() > deadline) throw new Error("Import inspection exceeds its file, size or time limit"); };
  const records = [], pending = [], scheduled = new Set(), anchors = new Map();
  const add = (file, mode = "content") => {
    if (!valid(file)) throw new Error("Invalid import file reference");
    if (mode === "content" && pending.some(item => item.mode === "content" && (item.file === file || file.startsWith(`${item.file}/`)))) return;
    const key = `${mode}:${file}`;
    if (!scheduled.has(key)) { if (scheduled.size >= 250) throw new Error("Too many local import references"); scheduled.add(key); pending.push({ file, mode }); }
  };
  const scoped = file => file === workspace || file.startsWith(`${workspace}/`) || includeHome && (file === home || file.startsWith(`${home}/`));
  const addReference = (value, base) => {
    if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value)) throw new Error("Invalid local marketplace reference");
    let file;
    if (value.startsWith("file:")) {
      const url = new URL(value);
      if (url.protocol !== "file:" || url.hostname && url.hostname !== "localhost" || url.search || url.hash) throw new Error("Invalid local marketplace URL");
      file = decodeURIComponent(url.pathname);
    } else if (value.startsWith("~/")) file = path.join(home, value.slice(2));
    else if (value.startsWith("~")) throw new Error("A marketplace cannot reference another user's home");
    else file = path.resolve(base, value);
    if (!valid(file) || !scoped(file)) throw new Error("A local marketplace points outside this chat's workspace or private profile");
    add(file);
  };
  const marketplaceReferences = (json, filename) => {
    if (!json || typeof json !== "object" || Array.isArray(json)) return;
    const config = path.basename(filename);
    const entries = config === "known_marketplaces.json" ? Object.values(json) : config === "marketplace.json" ? json.plugins || [] : Object.values(json.extraKnownMarketplaces || {});
    if (!Array.isArray(entries) || entries.length > 200) throw new Error("Too many marketplace definitions to inspect");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.installLocation != null) addReference(entry.installLocation, workspace);
      const origin = entry.source;
      // Plugin entries resolve relative to their marketplace; configured
      // marketplace locations resolve relative to the selected workspace.
      const base = config === "marketplace.json" ? path.dirname(path.dirname(filename)) : workspace;
      if (typeof origin === "string" && !/^(?:(?:https?|ssh|git):\/\/|[^/]+@[^:]+:)/.test(origin)) addReference(origin, base);
      if (origin && typeof origin === "object") {
        if (origin.path != null && (!origin.source || ["directory", "file"].includes(origin.source))) addReference(origin.path, base);
        if (typeof origin.url === "string" && origin.url.startsWith("file:")) addReference(origin.url, base);
      }
    }
  };
  const openAbsolute = async (file, directory = false) => {
    const handles = []; let handle;
    try {
      handle = await fs.open("/", directoryFlags); handles.push(handle);
      const parts = file.split("/").filter(Boolean);
      for (let index = 0; index < parts.length; index++) {
        handle = await fs.open(`${fdPath(handle)}/${parts[index]}`, index < parts.length - 1 || directory ? directoryFlags : leafFlags); handles.push(handle);
      }
      return { handle, close: async () => { for (const item of handles.reverse()) await item.close(); } };
    } catch (error) { for (const item of handles.reverse()) await item.close(); throw error; }
  };
  const validateAnchor = async root => {
    const opened = await openAbsolute(root, true);
    try { const stat = await opened.handle.stat({ bigint: true }); anchors.set(root, identity(stat)); }
    finally { await opened.close(); }
  };
  const sourceDirectory = source === "claude-code" ? ".claude" : ".cursor";
  try {
    await validateAnchor(workspace);
    if (includeHome) { await validateAnchor(home); await validateAnchor(codexHome); }
    for (const name of [sourceDirectory, ...(source === "claude-code" ? ["CLAUDE.md", ".claude.json", ".mcp.json"] : [".cursorrules"]), "AGENTS.md", ".agents", ".codex"]) add(path.join(workspace, name));
    if (includeHome) {
      for (const name of [sourceDirectory, ...(source === "claude-code" ? [".claude.json", ".mcp.json"] : []), ".agents"]) add(path.join(home, name));
      for (const name of ["AGENTS.md", "config.toml", "hooks.json", "agents", "skills", "plugins", "memories", "external_agent_session_imports.json"]) add(path.join(codexHome, name));
      // Existing native rollouts and databases can change during read-only RPCs.
      // Inspect their identities and links, without hashing unrelated chat bodies
      // or turning their normal appends into a changed import configuration.
      for (const name of ["sessions", "archived"]) add(path.join(codexHome, name), "shape");
      add(path.join(codexHome, ".tmp"), "transient");
      const root = await openAbsolute(codexHome, true);
      try {
        for (const entry of await fs.readdir(fdPath(root.handle))) if (/^(?:state_|goals_|memories_|queue_|logs_).*\.sqlite(?:-shm|-wal)?$/.test(entry)) add(path.join(codexHome, entry), "shape");
      } finally { await root.close(); }
    }
    const walk = async (handle, file, mode, depth = 0) => {
      budget(); if (depth > 64) throw new Error("Import setup directories are too deeply nested");
      const before = await handle.stat({ bigint: true });
      if (before.isDirectory()) {
        // Native Git scratch children can appear/disappear during inspection.
        // Retry only this transient safety walk, never a source/configuration
        // review or an import. Every successful scan still requires a stable
        // directory version, and new links/special files are still rejected.
        for (let attempt = 0; ; attempt++) {
          budget(); const start = await handle.stat({ bigint: true });
          try {
            const names = (await fs.readdir(fdPath(handle))).sort();
            if (names.length + files > maxFiles) throw new Error("Import inspection exceeds its file limit");
            for (const name of names) {
              if (!name || /[\x00-\x1f\x7f\\]/.test(name)) throw new Error("Import setup contains an unsupported filename");
              let child;
              try { child = await fs.open(`${fdPath(handle)}/${name}`, leafFlags); await walk(child, path.join(file, name), mode, depth + 1); }
              catch (error) { if (error.code === "ENOENT") changed(); throw error; }
              finally { await child?.close(); }
            }
            const after = await handle.stat({ bigint: true });
            if (!same(identity(before), identity(after)) || !same(version(start), version(after))) changed();
            if (mode !== "transient" || depth === 0) records.push([file, "directory", identity(after)]);
            return;
          } catch (error) {
            if (mode !== "transient" || attempt >= 2 || error.name !== "ImportFilesChangedError") throw error;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
      }
      if (!before.isFile() || before.nlink !== 1n) throw new Error("Import setup must use ordinary files, not devices, sockets or hard links");
      files++; budget();
      if (mode !== "content") { if (mode === "shape") records.push([file, "file", identity(before)]); return; }
      if (before.size > 512n * 1024n * 1024n || before.size < 0n) throw new Error("An import file exceeds the 512 MiB inspection limit");
      const parseJson = /\/(?:settings(?:\.local)?|known_marketplaces|marketplace)\.json$/.test(file);
      const gitMetadata = /\/(?:\.git|commondir)$|\/objects\/info\/alternates$|\/(?:\.git|[^/]+\.git)\/config$/.test(file);
      if ((parseJson || gitMetadata) && before.size > 8n * 1024n * 1024n) throw new Error("Marketplace metadata exceeds the 8 MiB inspection limit");
      const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024), chunks = []; let offset = 0;
      while (true) {
        const read = await handle.read(buffer, 0, buffer.length, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead; bytes += read.bytesRead; budget();
        if (offset > Number(before.size)) changed();
        const chunk = buffer.subarray(0, read.bytesRead); hash.update(chunk);
        if (parseJson || gitMetadata) chunks.push(Buffer.from(chunk));
      }
      const after = await handle.stat({ bigint: true });
      if (offset !== Number(before.size) || !same(version(before), version(after))) changed();
      records.push([file, "file", version(after), hash.digest("hex")]);
      if (gitMetadata) {
        const contents = Buffer.concat(chunks).toString("utf8");
        if (/^gitdir\s*:/im.test(contents) || /\[(?:include|includeIf)(?:\s|\])/i.test(contents) || /\/(?:commondir|alternates)$/.test(file) && contents.trim()) throw new Error("Local marketplace Git metadata redirects outside the inspected files. Use a self-contained source.");
      }
      if (parseJson) {
        let json; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* Native import reports invalid JSON as an import error. */ }
        if (json) marketplaceReferences(json, file);
      }
    };
    for (let index = 0; index < pending.length; index++) {
      const { file, mode } = pending[index]; let opened;
      try {
        opened = await openAbsolute(file);
        const before = await opened.handle.stat({ bigint: true });
        await walk(opened.handle, file, mode);
        const current = await openAbsolute(file);
        try { if (!same(identity(before), identity(await current.handle.stat({ bigint: true })))) changed(); }
        finally { await current.close(); }
      } catch (error) {
        if (!opened && error.code === "ENOENT") records.push([file, "missing"]);
        else throw error;
      } finally { await opened?.close(); }
    }
    for (const [root, before] of anchors) {
      const current = await openAbsolute(root, true);
      try { if (!same(before, identity(await current.handle.stat({ bigint: true })))) changed(); }
      finally { await current.close(); }
    }
    records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { revision: createHash("sha256").update(JSON.stringify(records)).digest("hex"), files, bytes };
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(error.code)) throw new Error("Import setup contains a symbolic link or replaced directory. Use ordinary files inside the scoped workspace/profile.");
    if (["EACCES", "EPERM"].includes(error.code)) throw new Error("Import setup contains files the worker cannot inspect");
    if (["ENOENT", "ESTALE"].includes(error.code)) changed();
    if (error.code) throw new Error("Import file inspection could not finish safely");
    throw error;
  }
}

export async function inspectCodexImportFiles(executor, input, check = () => {}) {
  check();
  if (!executor || executor.metadata?.backend !== "ec2") {
    const result = await codexImportFileState(input); check(); return result.revision;
  }
  const request = { ...input, workspace: executor.workspace, home: executor.runtimeHome, codexHome: `${executor.runtimeHome}/codex` };
  return new Promise((resolve, reject) => {
    const script = `const inspect = (${codexImportFileState.toString()}); let data = ''; for await (const chunk of process.stdin) { data += chunk; if (data.length > 16000) throw new Error('Import request too large'); } try { process.stdout.write(JSON.stringify({ result: await inspect(JSON.parse(data)) })); } catch (error) { process.stdout.write(JSON.stringify({ error: error.code ? 'Import file inspection failed' : error.message })); }`;
    let child;
    try {
      child = executor.spawn("node", ["--input-type=module", "-e", script], { cwd: executor.workspace,
        env: { PATH: executor.environmentPath || "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
    } catch { check(); reject(new Error("The import inspector could not start")); return; }
    let output = "", settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { check(); if (error) throw error; if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid import inspection response"); resolve(value); }
      catch (failure) { reject(failure); }
    };
    const timer = setTimeout(() => { void terminateWorker(child); finish(new Error("Import file inspection timed out")); }, 35000);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 2000) { void terminateWorker(child); finish(new Error("Import inspection response exceeded its limit")); } });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.once("error", () => finish(new Error("The import inspector could not start")));
    child.once("close", code => {
      if (code !== 0) return finish(new Error("The import inspector stopped before completing"));
      try { const response = JSON.parse(output); if (response.error) finish(new Error(response.error)); else finish(null, response.result?.revision); }
      catch { finish(new Error("Invalid import inspection response")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
