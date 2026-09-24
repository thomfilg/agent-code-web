export const PROMPT_LIMIT = 100;
export const PROMPT_TEXT_LIMIT = 20000;
export const PROMPT_LIBRARY_BYTES = 500000;
const fail = message => Object.assign(new Error(message), { statusCode: 400 });
export function promptProject(value) {
  if (!value || typeof value.companyId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(value.companyId)
    || typeof value.repository !== "string" || !/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(value.repository)) throw fail("Choose a valid company and primary repository.");
  return { companyId: value.companyId, repository: value.repository.toLowerCase() };
}
export const promptProjectKey = value => JSON.stringify([value.companyId, value.repository.toLowerCase()]);
export const promptAvailable = (prompt, project) => prompt.availability === "all" || Boolean(project && prompt.projects.some(value => promptProjectKey(value) === promptProjectKey(project)));
export function validatePrompts(items) {
  if (!Array.isArray(items) || items.length > PROMPT_LIMIT) throw fail(`Save up to ${PROMPT_LIMIT} prompts.`);
  const ids = new Set();
  const result = items.map(item => {
    if (!item || Object.keys(item).some(key => !["id", "text", "availability", "projects"].includes(key))
      || typeof item.id !== "string" || !/^prompt_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item.id) || ids.has(item.id)) throw fail("Each saved prompt needs a unique valid ID.");
    ids.add(item.id);
    if (typeof item.text !== "string" || !item.text.trim() || item.text.length > PROMPT_TEXT_LIMIT || item.text.includes("\0")) throw fail(`Enter a prompt of up to ${PROMPT_TEXT_LIMIT.toLocaleString("en-US")} characters.`);
    if (!["all", "projects"].includes(item.availability) || !Array.isArray(item.projects) || item.projects.length > 50
      || item.availability === "all" && item.projects.length || item.availability === "projects" && !item.projects.length) throw fail("Choose all projects or at least one selected project.");
    const projects = item.projects.map(promptProject);
    if (new Set(projects.map(promptProjectKey)).size !== projects.length) throw fail("Choose each project only once.");
    return { id: item.id, text: item.text, availability: item.availability, projects };
  });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > PROMPT_LIBRARY_BYTES) throw fail("The saved-prompt library is too large. Shorten or remove some prompts.");
  return result;
}
