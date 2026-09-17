import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { newId, nowIso } from "./utils.mjs";
import { runtimeWorkflowPatch } from "../public/chat-organization.js";

function restored(chat) {
  chat = { ...chat, archived: chat.archived ?? chat.workflowState === "archived" };
  return { pinned: false, customGroupId: null, workflowState: "idle", ...chat,
    ...runtimeWorkflowPatch(chat, "stopped"), status: "stopped", pendingRequest: null, idleDeadlineAt: null,
    queuePaused: Boolean(chat.queuedMessages?.length) || Boolean(chat.queuePaused) };
}

function clone(value) {
  return structuredClone(value);
}

export class ChatStore {
  #chats = new Map();
  #writes = new Map();

  constructor(dataDir, records = null) {
    this.dataDir = dataDir;
    this.chatsDir = path.join(dataDir, "chats");
    this.records = records;
  }

  async initialize() {
    await mkdir(this.chatsDir, { recursive: true, mode: 0o700 });
    if (this.records) {
      for (const chat of await this.records.list("chat")) {
        chat.status = "stopped";
        chat.statusDetail = "Ready to resume";
        chat.pendingRequest = null;
        chat.idleDeadlineAt = null;
        this.#chats.set(chat.id, restored(chat));
      }
    }
    const entries = await readdir(this.chatsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("chat_")) continue;
      if (this.#chats.has(entry.name)) continue;
      try {
        const chat = JSON.parse(await readFile(this.chatFile(entry.name), "utf8"));
        chat.status = "stopped";
        chat.statusDetail = "Control plane restarted";
        chat.pendingRequest = null;
        this.#chats.set(chat.id, restored(chat));
        await this.#persist(chat.id);
      } catch (error) {
        console.warn(`Skipping unreadable chat ${entry.name}: ${error.message}`);
      }
    }
  }

  chatDir(id) {
    this.assertId(id);
    return path.join(this.chatsDir, id);
  }

  chatFile(id) {
    return path.join(this.chatDir(id), "chat.json");
  }

  workspaceDir(id) {
    return path.join(this.chatDir(id), "workspace");
  }

  runtimeHome(id) {
    return path.join(this.chatDir(id), "runtime-home");
  }

  assertId(id) {
    if (!/^chat_[a-f0-9]{32}$/.test(id)) throw new Error("invalid chat id");
  }

  list() {
    return [...this.#chats.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  get(id) {
    const chat = this.#chats.get(id);
    return chat ? clone(chat) : null;
  }

  async create({ title, agent, source = "", repositories = [], environmentId = null, environmentName = null, autoTitle = true, model = null, effort = null, modelSelectionSet = false, ownerId = null, agentAccountId = null }, prepare = null) {
    const id = newId("chat");
    const timestamp = nowIso();
    const chat = {
      id,
      ownerId,
      revision: 1,
      title,
      agent,
      agentAccountId,
      model,
      effort,
      modelSelectionSet,
      mode: "accept_edits",
      source,
      repositories,
      environmentId,
      environmentName,
      autoTitle,
      pinned: false,
      customGroupId: null,
      workflowState: "idle",
      stateOrigin: "runtime",
      stateDetail: "Ready for another message",
      archived: false,
      awaitingUser: false,
      pullRequests: [],
      gitBranches: [],
      workspaceReady: false,
      workspace: this.workspaceDir(id),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      idleDeadlineAt: null,
      status: "stopped",
      statusDetail: "Not started",
      runtimeMetadata: null,
      agentSessionId: null,
      pendingRequest: null,
      messages: [],
    };
    await mkdir(this.runtimeHome(id), { recursive: true, mode: 0o700 });
    try {
      // A persistent fork is not visible or addressable until its independent
      // files and private native history are ready. No half-built sidebar row.
      if (prepare) Object.assign(chat, await prepare(clone(chat)));
      this.#chats.set(id, chat);
      await this.#persist(id);
      return clone(chat);
    } catch (error) {
      this.#chats.delete(id);
      await this.records?.delete("chat", id).catch(() => {});
      await rm(this.chatDir(id), { recursive: true, force: true });
      throw error;
    }
  }

  async update(id, patch) {
    const current = this.#chats.get(id);
    if (!current) return null;
    const changes = typeof patch === "function" ? patch(clone(current)) : patch;
    const next = { ...current, ...changes, id, revision: (current.revision || 0) + 1, updatedAt: nowIso() };
    this.#chats.set(id, next);
    await this.#persist(id);
    return clone(next);
  }

  async appendMessage(id, message) {
    const current = this.#chats.get(id);
    if (!current) return null;
    const timestamp = nowIso();
    const nextMessage = {
      id: message.id || newId("msg"),
      createdAt: message.createdAt || timestamp,
      ...message,
    };
    const next = {
      ...current,
      revision: (current.revision || 0) + 1,
      messages: [...current.messages, nextMessage],
      lastActivityAt: timestamp,
      updatedAt: timestamp,
    };
    this.#chats.set(id, next);
    await this.#persist(id);
    return clone(nextMessage);
  }

  async remove(id) {
    this.assertId(id);
    if (!this.#chats.has(id)) return false;
    this.#chats.delete(id);
    await this.#writes.get(id);
    if (this.records) await this.records.delete("chat", id);
    if (this.records) await this.records.delete("native-fork", id);
    if (this.records) await this.records.delete("native-agents", id);
    if (this.records) await this.records.delete("native-import", id);
    if (this.records) await this.records.delete("native-approvals", id);
    if (this.records) await this.records.delete("native-feedback", id);
    if (this.records) await this.records.delete("native-logout", id);
    if (this.records) await this.records.delete("desktop-handoff", id);
    await rm(this.chatDir(id), { recursive: true, force: true });
    return true;
  }

  async #persist(id) {
    const previous = this.#writes.get(id) || Promise.resolve();
    const operation = previous.then(async () => {
      const chat = this.#chats.get(id);
      if (!chat) return;
      if (this.records) { await this.records.put("chat", id, chat); return; }
      const file = this.chatFile(id);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(chat, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    });
    this.#writes.set(id, operation.catch(() => {}));
    await operation;
  }
}
