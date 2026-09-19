import { validatePrompts, promptProject, promptProjectKey } from "../public/saved-prompts-model.js";
import { companyForChat } from "../public/company-scope.js";

const conflict = () => Object.assign(new Error("Saved prompts changed in another tab or account. Reload the library; your editor text is kept."), { statusCode: 409 });
export function knownPromptProjects(chats, savedProjects, companies) {
  const allowed = new Set(companies.map(company => company.id)), projects = new Map();
  for (const chat of [...chats, ...savedProjects.map(record => record.selection)]) {
    if (!chat?.repositories?.[0]) continue;
    try {
      const project = promptProject({ companyId: companyForChat(chat), repository: chat.repositories[0].fullName });
      if (allowed.has(project.companyId)) projects.set(promptProjectKey(project), project);
    } catch { /* Legacy or incomplete selections are not project grants. */ }
  }
  return [...projects.values()].sort((a, b) => promptProjectKey(a).localeCompare(promptProjectKey(b)));
}
export class SavedPrompts {
  constructor(records) { this.records = records; }
  async get(scope, projects, guard = async () => {}) {
    await guard(); const saved = await this.records.get("saved-prompts", scope); await guard();
    return { scope, revision: saved?.revision || 0, items: validatePrompts(saved?.items || []), projects };
  }
  async save(scope, input, projects, guard = async () => {}) {
    if (input?.scope !== scope || !Number.isSafeInteger(input.revision) || input.revision < 0) throw conflict();
    const items = validatePrompts(input.items), known = new Set(projects.map(promptProjectKey));
    let result;
    try { result = await this.records.savedPromptsCompareAndSwap(scope, input.revision, previous => {
      for (const item of items) {
        const old = previous?.items?.find(value => value.id === item.id);
        // Keep an existing orphaned binding editable/removable, but do not
        // manufacture a new grant or silently broaden it to all projects.
        const retained = new Set((old?.projects || []).map(promptProjectKey));
        if (item.projects.some(project => !known.has(promptProjectKey(project)) && !retained.has(promptProjectKey(project)))) {
          throw Object.assign(new Error("A selected project is no longer available. Choose one of your existing projects."), { statusCode: 400 });
        }
      }
      return items;
    }, guard); }
    catch (error) {
      if ([400, 409].includes(error.statusCode)) throw error;
      throw Object.assign(new Error("The prompt library could not be saved. Your editor text is kept; reload before retrying."), { statusCode: 503 });
    }
    await guard(); return { ...result, projects };
  }
}
