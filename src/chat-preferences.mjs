import { companyForChat } from "../public/company-scope.js";
import { environmentAllows, environmentCompany } from "../public/environment-scope.js";

const fail = message => Object.assign(new Error(message), { statusCode: 400 });
const companyName = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,38}$/.test(value);
const repositoryName = value => typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value);
const projectId = (company, repository) => JSON.stringify([company, repository.toLowerCase()]);

// Deliberately excludes prompts, attachments, transcripts, source paths,
// credentials, browser access and runtime identifiers.
export function chatSelection(value = {}) {
  return {
    environmentId: typeof value.environmentId === "string" ? value.environmentId : null,
    agent: ["codex", "claude", "mock"].includes(value.agent) ? value.agent : null,
    agentAccountId: typeof value.agentAccountId === "string" ? value.agentAccountId : null,
    model: typeof value.model === "string" ? value.model : null,
    effort: typeof value.effort === "string" ? value.effort : null,
    repositories: (Array.isArray(value.repositories) ? value.repositories : []).slice(0, 100).map(repo => ({
      fullName: repo.fullName, branch: repo.branch,
      ...(repo.githubConnectionId ? { githubConnectionId: repo.githubConnectionId } : {}),
      ...(repo.companyId ? { companyId: repo.companyId } : {}),
    })),
  };
}

export async function rememberChatSelection(records, value, environment, now = new Date().toISOString()) {
  if (environment.scopeNeedsReview || !environmentCompany(environment)) throw fail("Choose an environment assigned to one company before remembering this selection");
  const selection = chatSelection(value);
  const company = companyForChat(selection) || (environment.companies?.length === 1 ? environment.companies[0] : null);
  if (!companyName(company)) return;
  if (selection.repositories.some(repo => companyForChat({ repositories: [repo] }) !== company) || !environmentAllows(environment, company)) throw fail("Keep remembered repositories and environment within one company");
  const record = { companyId: company, updatedAt: now, selection };
  // Separate keys avoid lost updates between different companies/projects.
  await records.put("new-chat-company", company, record);
  const primary = selection.repositories[0]?.fullName;
  if (repositoryName(primary)) await records.put("new-chat-project", projectId(company, primary), record);
}

export async function restoreChatSelection({ records, companies, environments, github, chats, agentAccounts, ownerId, namedAccounts, availableAgents }, { companyId, repository }) {
  if (!companyName(companyId) || repository && !repositoryName(repository)) throw fail("Choose a valid company and project");
  await companies.get(companyId);
  const saved = await records.get(repository ? "new-chat-project" : "new-chat-company", repository ? projectId(companyId, repository) : companyId);
  const latest = chats.filter(chat => !chat.archived && companyForChat(chat) === companyId && (!repository || chat.repositories?.[0]?.fullName?.toLowerCase() === repository.toLowerCase()))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const validSaved = saved?.companyId === companyId && (!repository || saved.selection?.repositories?.[0]?.fullName?.toLowerCase() === repository.toLowerCase());
  // Explicit unsent company drafts win on company switches. For a project,
  // a newer chat's actual options can supersede an older saved draft.
  const legacy = await records.get("preferences", "new-chat");
  const legacyMatches = legacy && companyForChat(legacy) === companyId && (!repository || legacy.repositories?.[0]?.fullName?.toLowerCase() === repository.toLowerCase());
  const source = validSaved && (!repository || !latest || saved.updatedAt >= latest.updatedAt) ? saved.selection : latest || (legacyMatches ? legacy : undefined);
  const selection = chatSelection(source), warnings = [];
  if (!source && !namedAccounts) selection.agent = availableAgents.find(agent => agent.enabled)?.id || null;
  const environmentList = await environments.list();
  const allowed = environmentList.filter(env => !env.archived && environmentAllows(env, companyId));
  selection.environmentId = allowed.find(env => env.id === selection.environmentId)?.id || (!source?.environmentId ? allowed[0]?.id : null) || null;
  if (source?.repositories?.length) {
    try {
      if (selection.repositories.some(repo => companyForChat({ repositories: [repo] }) !== companyId)) throw fail("Project contains repositories from another company");
      selection.repositories = chatSelection({ repositories: await github.resolveSelections(selection.repositories, { company: companyId }) }).repositories;
    } catch {
      selection.repositories = []; warnings.push("Saved repositories or branches are no longer available. Choose them again.");
    }
  }
  if (!availableAgents.some(agent => agent.enabled && agent.id === selection.agent)) {
    if (selection.agent) warnings.push("The saved agent is unavailable. Select a connected account.");
    selection.agent = null;
  }
  if (namedAccounts && ["codex", "claude"].includes(selection.agent)) {
    try { await agentAccounts.select(ownerId, selection.agentAccountId, selection); }
    catch { selection.agent = null; warnings.push("The saved agent account is unavailable. Select a connected account."); }
  }
  if (!selection.agent) { selection.agentAccountId = null; selection.model = null; selection.effort = null; }
  if (!selection.environmentId) warnings.push("The saved environment is unavailable. Choose an active environment for this company.");
  return { selection, companyId, found: Boolean(source), warnings };
}
