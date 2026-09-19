// Environment templates are single-company. Agent-account allowlists intentionally
// use company-scope.js instead; never broaden this check to match those allowlists.
export function environmentCompany(environment = {}) {
  if (environment.allowUnassigned === true || !Array.isArray(environment.companies) || environment.companies.length !== 1) return null;
  const company = environment.companies[0];
  if (typeof company !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(company)) return null;
  if (environment.companyId !== undefined && environment.companyId !== company) return null;
  return company;
}

export function environmentAllows(environment, company) {
  return !environment?.scopeNeedsReview && Boolean(company) && environmentCompany(environment) === company;
}
