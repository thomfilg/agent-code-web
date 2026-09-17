import { validateBindings } from "../public/key-bindings.js";
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
export class KeymapPreferences {
  constructor(records) { this.records = records; this.locks = new Map(); }
  async get(scope, guard = async () => {}) {
    await guard(); const stored = await this.records.get("keymap", scope); await guard();
    return { scope, revision: stored?.revision || 0, bindings: validateBindings(stored?.bindings || {}) };
  }
  async save(scope, input, guard = async () => {}) {
    if (input?.scope !== scope || !Number.isSafeInteger(input.revision) || input.revision < 0) throw conflict("The shortcut account changed. Reload /keymap before saving.");
    const bindings = validateBindings(input.bindings);
    const previous = this.locks.get(scope) || Promise.resolve(), task = previous.catch(() => {}).then(async () => {
      const current = await this.get(scope, guard);
      if (current.revision !== input.revision) throw conflict("Shortcuts changed in another tab. Reload before saving; your draft is still shown.");
      const result = { scope, revision: current.revision + 1, bindings };
      await guard(); await this.records.put("keymap", scope, result); await guard(); return result;
    });
    this.locks.set(scope, task);
    try { return await task; } finally { if (this.locks.get(scope) === task) this.locks.delete(scope); }
  }
}
