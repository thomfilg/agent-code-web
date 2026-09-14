// Shared by the browser and control plane. Runtime status and workflow state are distinct.
export const CHAT_STATES = [
  ["working", "Working"], ["asking_question", "Asking question"], ["idle", "Idle"],
  ["pr_open", "PR open"], ["pr_merged", "PR merged"], ["archived", "Archived"],
];
export const SORT_OPTIONS = [
  ["updated_desc", "Last updated · newest"], ["updated_asc", "Last updated · oldest"],
  ["created_desc", "Created · newest"], ["created_asc", "Created · oldest"],
  ["state", "State · working first"],
];
export function repositoryGroup(chat) {
  const selected = chat.repositories?.[0]?.fullName;
  const legacy = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/#?]+?)(?:\.git)?\/?$/.exec(chat.source || "")?.[1];
  const fullName = selected || legacy;
  if (fullName) {
    const [company, repository] = fullName.split("/");
    return { company, repository, fullName };
  }
  return { company: "Personal", repository: chat.source ? chat.source.replace(/\/$/, "").split("/").at(-1) : "No repository", fullName: null };
}
export function stateLabel(state) { return CHAT_STATES.find(([id]) => id === state)?.[1] || "Idle"; }
export function compareChats(sort = "updated_desc") {
  return (a, b) => {
    let difference;
    if (sort === "state") difference = CHAT_STATES.findIndex(([id]) => id === (a.workflowState || "idle")) - CHAT_STATES.findIndex(([id]) => id === (b.workflowState || "idle"));
    else {
      const field = sort.startsWith("created_") ? "createdAt" : "updatedAt";
      difference = String(a[field]).localeCompare(String(b[field])) * (sort.endsWith("_asc") ? 1 : -1);
    }
    return difference || String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id);
  };
}
export function groupChats(chats, groups, sort) {
  const ordered = [...chats].sort(compareChats(sort));
  const pinned = ordered.filter(chat => chat.pinned);
  const custom = groups.map(group => ({ ...group, chats: [] }));
  const companies = new Map();
  for (const chat of ordered.filter(chat => !chat.pinned)) {
    const group = custom.find(group => group.id === chat.customGroupId);
    if (group) { group.chats.push(chat); continue; }
    const identity = repositoryGroup(chat);
    const companyKey = identity.company.toLowerCase();
    if (!companies.has(companyKey)) companies.set(companyKey, { name: identity.company, repositories: new Map() });
    const repos = companies.get(companyKey).repositories;
    const repoKey = identity.repository.toLowerCase();
    if (!repos.has(repoKey)) repos.set(repoKey, { name: identity.repository, chats: [] });
    repos.get(repoKey).chats.push(chat);
  }
  return { pinned, custom, companies: [...companies.values()].sort((a, b) => a.name.localeCompare(b.name)).map(company => ({ ...company, repositories: [...company.repositories.values()].sort((a, b) => a.name.localeCompare(b.name)) })) };
}

export function runtimeWorkflowPatch(chat, status) {
  if (["starting", "running"].includes(status)) {
    return { workflowState: "working", stateOrigin: "runtime", resumeState: ["pr_open", "pr_merged"].includes(chat.workflowState) ? chat.workflowState : chat.resumeState || "idle" };
  }
  if (["idle", "stopped", "error"].includes(status) && chat.stateOrigin === "runtime") {
    return { workflowState: chat.resumeState || "idle", stateOrigin: "runtime", pendingRequest: null };
  }
  return {};
}
