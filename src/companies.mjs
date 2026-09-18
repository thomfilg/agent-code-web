import { companyScope } from "../public/company-scope.js";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export const validCompanyId = value => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(value);

// A Relay company has its own stable key; it is not a GitHub organization.
// Renaming it must never retarget credentials or move existing conversations.
export function connectionCompany(record = {}) {
  if (record.companyId !== undefined) return validCompanyId(record.companyId) ? record.companyId : null;
  const scope = companyScope(record);
  return scope.companies.length === 1 && !scope.allowUnassigned ? scope.companies[0] : null;
}

export class Companies {
  constructor(records) { this.records = records; this.queue = Promise.resolve(); this.ready = this.initialize(); }
  async initialize() {
    // Seed names only, never duplicate or assign a credential. Ambiguous legacy
    // connections stay saved and require an explicit single-company selection.
    const existing = new Set((await this.records.list("company")).map(company => company.id));
    const records = (await Promise.all(["environment", "mcp", "github_connection", "connection"].map(kind => this.records.list(kind)))).flat();
    for (const id of new Set(records.flatMap(record => [...companyScope(record).companies, record.companyId]).filter(validCompanyId))) {
      if (!existing.has(id)) await this.records.put("company", id, { id, name: id, revision: 1, createdAt: new Date().toISOString() });
    }
  }
  async list() { await this.ready; return (await this.records.list("company")).sort((a, b) => a.name.localeCompare(b.name)); }
  async get(id) {
    await this.ready;
    const company = validCompanyId(id) && await this.records.get("company", id);
    if (!company) throw fail("Choose a registered company. Add it on the Companies page first.", 400);
    return company;
  }
  save(input, id = null) {
    const result = this.queue.then(async () => {
      await this.ready;
      const old = id ? await this.get(id) : null;
      if (old && input.revision !== old.revision) throw fail("This company changed in another tab. Reload before saving.", 409);
      const key = id || String(input.id || "").trim().toLowerCase(), name = String(input.name || "").trim();
      if (!validCompanyId(key)) throw fail("Use a short company identifier containing lowercase letters, numbers and hyphens.");
      if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw fail("Company name must contain 1–80 characters.");
      if (old && input.id !== undefined && input.id !== id) throw fail("The company identifier cannot be changed.");
      const all = await this.list();
      if (!old && all.some(company => company.id === key)) throw fail("This company is already registered.", 409);
      if (all.some(company => company.id !== key && company.name.toLowerCase() === name.toLowerCase())) throw fail("A company with this name already exists.", 409);
      const company = { id: key, name, revision: (old?.revision || 0) + 1, createdAt: old?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      await this.records.put("company", key, company); return company;
    });
    this.queue = result.catch(() => {}); return result;
  }
  async connectionScope(input, old = {}) {
    if (input.allowUnassigned === true || (Array.isArray(input.companies) && input.companies.length > 1)) throw fail("Each connection belongs to exactly one company. Only agent accounts can be used across companies.");
    const id = input.companyId ?? (input.companies !== undefined || input.organization !== undefined ? connectionCompany(input) : connectionCompany(old));
    await this.get(id);
    return { companyId: id, companies: [id], allowUnassigned: false };
  }
}
