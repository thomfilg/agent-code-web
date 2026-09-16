import { DEFAULT_STATUS_ITEMS, validateStatusItems } from "../public/status-line.js";
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
export class StatusLinePreferences {
  constructor(records) { this.records = records; this.locks = new Map(); }
  async get(scope, guard = async () => {}) {
    await guard(); const saved = await this.records.get("statusline", scope); await guard();
    return { scope, revision: saved?.revision || 0, items: validateStatusItems(saved ? saved.items : DEFAULT_STATUS_ITEMS) };
  }
  async save(scope, input, guard = async () => {}) {
    if (input?.scope !== scope || !Number.isSafeInteger(input.revision) || input.revision < 0) throw conflict("The status-line account changed. Reload before saving.");
    const items = validateStatusItems(input.items), previous = this.locks.get(scope) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const current = await this.get(scope, guard);
      if (current.revision !== input.revision) throw conflict("Status-line settings changed in another tab. Reload before saving.");
      const result = { scope, revision: current.revision + 1, items };
      await guard(); await this.records.put("statusline", scope, result); await guard(); return result;
    });
    this.locks.set(scope, task);
    try { return await task; } finally { if (this.locks.get(scope) === task) this.locks.delete(scope); }
  }
}
