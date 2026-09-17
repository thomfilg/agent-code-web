// App references are native UserInput.mention entries, not filesystem paths or
// MCP configuration. Never use the unscoped app/list/updated notification as an
// authorization source: it contains no thread ID.
const text = (value, limit) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit) : "";
const appId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const failure = message => Object.assign(new Error(message), { statusCode: 409 });

export class CodexApps {
  constructor(request, thread) { this.request = request; this.thread = thread; }

  async list() {
    const threadId = this.thread();
    if (!threadId) throw failure("Connect this chat's native session before choosing an app");
    const installed = await this.request("app/installed", { threadId, forceRefresh: true });
    if (!Array.isArray(installed?.apps)) throw new Error("The installed Codex CLI did not return app permissions");
    const permissions = new Map(), seen = new Set();
    for (const entry of installed.apps) {
      if (!appId(entry?.id)) continue;
      // Ambiguous duplicate IDs must not inherit the more permissive result.
      permissions.set(entry.id, seen.has(entry.id) ? null : entry); seen.add(entry.id);
    }
    const apps = new Map(), cursors = new Set();
    let cursor = null, truncated = false;
    for (let page = 0; page < 4; page++) {
      const result = await this.request("app/list", { threadId, cursor, limit: 50, forceRefetch: page === 0 });
      if (!Array.isArray(result?.data)) throw new Error("The installed Codex CLI did not return an app list");
      for (const entry of result.data.slice(0, 50)) {
        if (!appId(entry?.id) || !text(entry.name, 160).trim()) continue;
        const permission = permissions.get(entry.id);
        const name = text(entry.name, 160).trim();
        const app = { id: entry.id, name, description: text(entry.description, 1200),
          token: `$${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || entry.id}`,
          accessible: entry.isAccessible === true, enabled: entry.isEnabled === true && permission?.enabled === true,
          callable: entry.isAccessible === true && entry.isEnabled === true && permission?.enabled === true && permission?.callable === true };
        // A duplicate catalog ID is also ambiguous; do not offer it for use.
        apps.set(entry.id, apps.has(entry.id) ? { ...app, callable: false } : app);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
      if (typeof cursor !== "string" || cursor.length > 4000 || cursors.has(cursor)) throw new Error("Codex returned an invalid app-list cursor");
      cursors.add(cursor);
      if (page === 3) truncated = true;
    }
    if (threadId !== this.thread()) throw failure("The native session changed; reopen the app picker");
    return { threadId, apps: [...apps.values()], truncated };
  }

  async select(id, expectedThreadId) {
    if (!appId(id) || !expectedThreadId || expectedThreadId !== this.thread()) throw failure("The native session changed; reopen the app picker");
    const catalog = await this.list();
    const app = catalog.apps.find(entry => entry.id === id);
    if (!app?.callable) throw failure("This app is no longer accessible and callable in this chat. Refresh the app picker.");
    return { ...app, threadId: catalog.threadId };
  }

  async mentions(references) {
    if (!references.length) return [];
    if (references.length > 10 || references.some(reference => !appId(reference.id))) throw new Error("Invalid app references");
    const catalog = await this.list();
    return [...new Set(references.map(reference => reference.id))].map(id => {
      const app = catalog.apps.find(entry => entry.id === id);
      if (!app?.callable) throw failure("A selected app is no longer accessible and callable. Remove its reference or reconnect it before retrying.");
      return { type: "mention", name: app.name, path: `app://${app.id}` };
    });
  }
}

export function appReferencesForTurn(chat, files, company) {
  const references = files.filter(file => file.appReference).map(file => file.appReference);
  if (references.some(reference => chat.agent !== "codex" || reference.inactive || reference.threadId !== chat.agentSessionId || reference.company !== company || reference.ownerId !== (chat.ownerId || null))) {
    throw failure("An app reference belongs to a different session or company. Remove it and choose the app again in this chat.");
  }
  return references.map(({ id }) => ({ id }));
}
