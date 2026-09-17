import { repositoryGroup } from "./chat-organization.js";

const validCompany = value => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(value);
export function companyForChat(chat = {}) {
  const group = repositoryGroup(chat);
  return group.fullName ? group.company.toLowerCase() : null;
}

// A blank legacy scope is NOT an all-company grant. Keep the saved credential,
// but require the user to select companies before it can reach their workers.
export function companyScope(record = {}) {
  const values = Array.isArray(record.companies) ? record.companies : record.organization ? [record.organization] : [];
  const companies = [...new Set(values.filter(value => typeof value === "string").map(value => value.trim().toLowerCase()).filter(validCompany))].sort();
  return { companies, allowUnassigned: record.allowUnassigned === true };
}
export function normalizeCompanyScope(input, previous = {}) {
  let values = input.companies;
  if (values === undefined) values = input.organization === undefined ? companyScope(previous).companies : input.organization ? [input.organization] : [];
  if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== "string" || !validCompany(value.trim().toLowerCase()))) throw Object.assign(new Error("Companies must be a list of GitHub owners, such as 12-apps, thomfilg or g2i"), { statusCode: 400 });
  const companies = [...new Set(values.map(value => value.trim().toLowerCase()))].sort();
  const allowUnassigned = input.allowUnassigned ?? previous.allowUnassigned ?? false;
  if (typeof allowUnassigned !== "boolean") throw Object.assign(new Error("Unassigned-chat access must be true or false"), { statusCode: 400 });
  return { companies, allowUnassigned };
}
export function scopeAllows(record, company) {
  const scope = companyScope(record);
  return company ? scope.companies.includes(company.toLowerCase()) : scope.allowUnassigned;
}
export function scopesOverlap(a, b) {
  const first = companyScope(a), second = companyScope(b);
  return first.allowUnassigned && second.allowUnassigned || first.companies.some(company => second.companies.includes(company));
}
export function scopeLabel(record) {
  const { companies, allowUnassigned } = companyScope(record);
  return [...companies, ...(allowUnassigned ? ["Unassigned chats"] : [])].join(", ") || "No companies selected";
}
