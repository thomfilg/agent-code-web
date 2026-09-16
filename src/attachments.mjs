import { randomUUID } from "node:crypto";
import { mkdir, lstat, writeFile } from "node:fs/promises";
import path from "node:path";

export class Attachments {
  constructor(records, store) { Object.assign(this, { records, store }); }
  async upload(chatId, input, workspaceContext = undefined) {
    if (!this.store.get(chatId)) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    return this.#create(chatId, input, workspaceContext);
  }
  async #create(chatId, input, workspaceContext) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw new Error("Choose a file with a valid name");
    if (typeof input.data !== "string" || input.data.length > 7 * 1024 * 1024 || input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error("Invalid file encoding");
    const data = Buffer.from(input.data, "base64");
    if (data.length > 5 * 1024 * 1024) throw new Error("Maximum file size is 5 MB");
    const name = path.basename(input.name).replace(/[\x00-\x1f\x7f]/g, "_");
    const attachment = { id: `file_${randomUUID()}`, chatId, name, mime: String(input.mime || "application/octet-stream").slice(0, 150), size: data.length, data: input.data, createdAt: new Date().toISOString(), ...(workspaceContext ? { workspaceContext } : {}) };
    await this.records.put("attachment", attachment.id, attachment);
    return this.public(attachment);
  }
  async importTranscript(targetId, messages) {
    this.store.assertId(targetId);
    const result = [], paths = [];
    for (const message of messages) {
      const attachments = [];
      for (const input of message.attachments || []) {
        if (input.copied) { attachments.push({ copied: true, name: input.name, mime: input.mime }); continue; }
        const file = await this.#create(targetId, input); attachments.push(file);
        if (input.previousPath) paths.push({ id: file.id, previousPath: input.previousPath });
      }
      result.push({ ...message, ...(message.attachments ? { attachments } : {}) });
    }
    return { messages: result, paths };
  }
  public({ data, workspaceContext, ...attachment }) {
    // Message lists need only the reference/range. Keep potentially large
    // selected text in the private attachment record and fetch it on preview.
    if (!workspaceContext) return attachment;
    const { selectedText, ...reference } = workspaceContext;
    return { ...attachment, workspaceContext: reference };
  }
  async uploadWorkspace(chatId, { workspaceContext, ...input }) {
    // Called only after the workspace reader verifies containment and the
    // selected version. Ordinary uploads cannot supply trusted path metadata.
    return this.upload(chatId, input, workspaceContext);
  }
  async selectApp(chatId, appReference) {
    if (!this.store.get(chatId)) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    // Only the native picker calls this method after validating current native
    // permissions. Ordinary file uploads cannot supply appReference metadata.
    const attachment = { id: `file_${randomUUID()}`, chatId, name: appReference.name, mime: "application/x-relay-app-reference", size: 0, data: "", createdAt: new Date().toISOString(), appReference };
    await this.records.put("attachment", attachment.id, attachment);
    return this.public(attachment);
  }
  async forkMessages(sourceId, targetId, messages) {
    this.store.assertId(targetId);
    if (sourceId === targetId) throw new Error("Choose an independent attachment destination");
    const copied = new Map(), paths = [];
    const result = [];
    for (const message of messages) {
      const attachments = [];
      for (const reference of message.attachments || []) {
        if (reference.copied && !reference.id) { attachments.push(reference); continue; }
        let file = copied.get(reference.id);
        if (!file) {
          const [original] = await this.resolve(sourceId, [reference.id]);
          file = { ...original, id: `file_${randomUUID()}`, chatId: targetId, ...(original.appReference ? { appReference: { ...original.appReference, inactive: true } } : {}) };
          await this.records.put("attachment", file.id, file);
          copied.set(reference.id, file);
        }
        attachments.push(this.public(file));
        if (reference.path && !paths.some(entry => entry.previousPath === reference.path)) paths.push({ id: file.id, previousPath: reference.path });
      }
      result.push({ ...message, ...(message.attachments ? { attachments } : {}) });
    }
    return { messages: result, paths };
  }
  async resolve(chatId, ids = []) {
    if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length) throw new Error("Attach up to 10 different files per message");
    const files = [];
    for (const id of ids) {
      if (typeof id !== "string" || !/^file_[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid attachment");
      const file = await this.records.get("attachment", id);
      if (!file || file.chatId !== chatId) throw new Error("Attachment not found in this chat");
      files.push(file);
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) throw new Error("Attachments exceed 20 MB per message");
    if (files.reduce((sum, file) => sum + Buffer.byteLength(file.workspaceContext?.selectedText || ""), 0) > 200000) throw new Error("Selected workspace text exceeds 200,000 bytes per message");
    return files;
  }
  async materialize(chat, executor, files) {
    const directory = path.join(executor?.runtimeHome || this.store.runtimeHome(chat.id), "uploads");
    const result = [];
    for (const file of files) {
      if (file.appReference) { result.push(this.public(file)); continue; }
      const name = `${randomUUID()}-${file.name.replace(/[^\w.-]/g, "_")}`;
      const target = path.join(directory, name);
      if (executor?.metadata?.backend === "ec2") {
        await new Promise((resolve, reject) => {
          const child = executor.spawn("/bin/sh", ["-c", 'umask 077; test ! -L "$1" && mkdir -p -- "$1" && set -C && base64 -d > "$2"', "relay-upload", directory, target],
            { cwd: executor.runtimeHome, env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "ignore", "pipe"] });
          const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Attachment transfer timed out")); }, 30000);
          child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(file.data);
          child.once("error", error => { clearTimeout(timer); reject(error); });
          child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Attachment transfer failed")); });
        });
      } else {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if ((await lstat(directory)).isSymbolicLink()) throw new Error("Unsafe attachment directory");
        await writeFile(target, Buffer.from(file.data, "base64"), { flag: "wx", mode: 0o600 });
      }
      result.push({ ...this.public(file), path: target });
    }
    return result;
  }
  async removeChat(chatId) {
    for (const file of await this.records.list("attachment")) if (file.chatId === chatId) await this.records.delete("attachment", file.id);
  }
}
