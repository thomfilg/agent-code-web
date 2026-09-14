import { randomUUID } from "node:crypto";
import { SORT_OPTIONS, workflowPatch } from "../public/chat-organization.js";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export class ChatOrganization {
  constructor({ records, store, changed = () => {} }) { this.records = records; this.store = store; this.changed = changed; this.queue = Promise.resolve(); }
  // Group membership and group deletion must not interleave in this single control plane.
  mutate(fn) { const operation = this.queue.then(fn); this.queue = operation.catch(() => {}); return operation; }
  async listGroups() { return (await this.records.list("chat-group")).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); }
  saveGroup(input, id = null) {
    return this.mutate(async () => {
      const old = id ? await this.records.get("chat-group", id) : null;
      if (id && !old) throw fail("Group not found", 404);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 80) throw fail("Group name must contain 1–80 characters");
      if ((await this.listGroups()).some(group => group.id !== id && group.name.toLowerCase() === name.toLowerCase())) throw fail("A group with this name already exists", 409);
      const group = { id: id || `group_${randomUUID()}`, name, createdAt: old?.createdAt || new Date().toISOString() };
      await this.records.put("chat-group", group.id, group);
      this.changed();
      return group;
    });
  }
  removeGroup(id) {
    return this.mutate(async () => {
      if (!await this.records.get("chat-group", id)) throw fail("Group not found", 404);
      for (const chat of this.store.list().filter(chat => chat.customGroupId === id)) await this.store.update(chat.id, { customGroupId: null });
      await this.records.delete("chat-group", id);
      this.changed();
    });
  }
  patchChat(id, input, manager) {
    return this.mutate(async () => {
      const chat = this.store.get(id);
      if (!chat) throw fail("Chat not found", 404);
      const patch = {};
      if (Object.hasOwn(input, "workflowState")) throw fail("Chat states are detected automatically from the agent and GitHub");
      for (const key of Object.keys(input)) if (!["pinned", "customGroupId", "archived", "title"].includes(key)) throw fail(`Cannot change ${key} here`);
      if (Object.hasOwn(input, "pinned")) {
        if (typeof input.pinned !== "boolean") throw fail("Pinned must be true or false");
        patch.pinned = input.pinned;
      }
      if (Object.hasOwn(input, "customGroupId")) {
        if (input.customGroupId !== null && (typeof input.customGroupId !== "string" || !await this.records.get("chat-group", input.customGroupId))) throw fail("Choose an existing group", 404);
        patch.customGroupId = input.customGroupId;
      }
      if (Object.hasOwn(input, "archived")) {
        if (typeof input.archived !== "boolean") throw fail("Archived must be true or false");
        if (manager.isBusy(id)) throw fail("Stop the working agent before archiving", 409);
        if (input.archived) await manager.stop(id, "archived");
        patch.archived = input.archived;
      }
      if (Object.hasOwn(input, "title")) {
        if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 120) throw fail("Title must contain 1–120 characters");
        patch.title = input.title.trim(); patch.autoTitle = false;
      }
      const updated = await this.store.update(id, current => ({ ...patch, ...workflowPatch({ ...current, ...patch }) }));
      manager.publishChat(updated);
      return updated;
    });
  }
  async preferences() { return (await this.records.get("preferences", "sidebar")) || { sort: "updated_desc", collapsed: [] }; }
  savePreferences(input) {
    return this.mutate(async () => {
      const old = await this.preferences();
      if (input.sort !== undefined && !SORT_OPTIONS.some(([id]) => id === input.sort)) throw fail("Invalid chat sort order");
      if (input.collapsed !== undefined && (!Array.isArray(input.collapsed) || input.collapsed.length > 1000 || input.collapsed.some(key => typeof key !== "string" || key.length > 600))) throw fail("Invalid collapsed groups");
      const value = { sort: input.sort ?? old.sort, collapsed: input.collapsed ?? old.collapsed };
      await this.records.put("preferences", "sidebar", value);
      this.changed();
      return value;
    });
  }
}
