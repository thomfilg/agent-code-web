import { DEFAULT_SYNTAX_THEME, validateSyntaxTheme } from "../public/syntax-theme.js";
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
export class SyntaxThemePreferences {
  constructor(records) { this.records = records; this.locks = new Map(); this.label = "Syntax theme"; }
  async get(scope, guard = async () => {}) {
    await guard(); const saved = await this.records.get("syntax-theme", scope); await guard();
    return { scope, revision: saved?.revision || 0, theme: validateSyntaxTheme(saved ? saved.theme : DEFAULT_SYNTAX_THEME) };
  }
  async save(scope, input, guard = async () => {}) {
    if (input?.scope !== scope || !Number.isSafeInteger(input.revision) || input.revision < 0) throw conflict("The syntax-theme account changed. Reload before saving.");
    const theme = validateSyntaxTheme(input.theme), previous = this.locks.get(scope) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const current = await this.get(scope, guard);
      if (current.revision !== input.revision) throw conflict("Syntax-theme settings changed in another tab. Reload before saving.");
      const result = { scope, revision: current.revision + 1, theme };
      await guard(); await this.records.put("syntax-theme", scope, result); await guard(); return result;
    });
    this.locks.set(scope, task);
    try { return await task; } finally { if (this.locks.get(scope) === task) this.locks.delete(scope); }
  }
}
