const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
export class OrderedFieldPreferences {
  constructor(records, { kind, label, defaults, validate }) { Object.assign(this, { records, kind, label, defaults, validate }); this.locks = new Map(); }
  async get(scope, guard = async () => {}) {
    await guard(); const saved = await this.records.get(this.kind, scope); await guard();
    return { scope, revision: saved?.revision || 0, items: this.validate(saved ? saved.items : this.defaults) };
  }
  async save(scope, input, guard = async () => {}) {
    if (input?.scope !== scope || !Number.isSafeInteger(input.revision) || input.revision < 0) throw conflict(`The ${this.label.toLowerCase()} account changed. Reload before saving.`);
    const items = this.validate(input.items), previous = this.locks.get(scope) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const current = await this.get(scope, guard);
      if (current.revision !== input.revision) throw conflict(`${this.label} settings changed in another tab. Reload before saving.`);
      const result = { scope, revision: current.revision + 1, items };
      await guard(); await this.records.put(this.kind, scope, result); await guard(); return result;
    });
    this.locks.set(scope, task);
    try { return await task; } finally { if (this.locks.get(scope) === task) this.locks.delete(scope); }
  }
}
