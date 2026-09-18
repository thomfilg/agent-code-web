import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceSettings } from "../public/workspace-settings.js";
import { GitHubAccounts } from "../public/github-accounts.js";

function documentFixture(t) {
  const previousOption = globalThis.Option; globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  t.after(() => { if (previousOption === undefined) delete globalThis.Option; else globalThis.Option = previousOption; });
  const previous = globalThis.document, nodes = new Map();
  globalThis.document = { querySelector: selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: "", textContent: "", open: false, replaceChildren() {}, append() {} });
    return nodes.get(selector);
  } };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return globalThis.document;
}
const snapshot = label => ({
  "/api/companies": { companies: [] },
  "/api/github": { connected: true, login: label, repositoryAccess: "github", connections: [{ id: label, revision: 1, connected: true, repositoryAccess: "github" }] },
  "/api/environments": { environments: [{ id: label }], software: [] },
  "/api/preferences": { preferences: { repositories: [{ fullName: `${label}/repo` }] } },
  "/api/mcps": { connections: [{ id: label }] },
  "/api/agent-accounts": { accounts: [{ id: label, companies: [label] }] },
});
function settings(api) {
  return Object.assign(Object.create(WorkspaceSettings.prototype), { api, state: { config: { features: { agentAccounts: true } } }, selected: [], repositories: [], repositoryRequest: 0, renderEnvironments() {}, renderRepositories() {} });
}

for (const delayedRoute of ["/api/github", "/api/agent-accounts"]) {
  test(`a stale settings load delayed at ${delayedRoute} cannot overwrite newer account/repository state`, async t => {
    documentFixture(t);
    const gate = Promise.withResolvers(); let current = snapshot("old"), delay = true;
    const workspace = settings(async route => {
      const result = structuredClone(current[route]);
      if (delay && route === delayedRoute) { delay = false; await gate.promise; }
      return result;
    });
    const old = workspace.load();
    current = snapshot("new"); assert.equal(await workspace.load(), true);
    workspace.repositories = [{ fullName: "new/repo" }];
    const request = workspace.repositoryRequest;
    gate.resolve(); assert.equal(await old, false);
    assert.equal(workspace.github.login, "new");
    assert.deepEqual(workspace.accounts, current["/api/agent-accounts"].accounts);
    assert.deepEqual(workspace.environments, [{ id: "new" }]);
    assert.deepEqual(workspace.mcps, [{ id: "new" }]);
    assert.deepEqual(workspace.repositories, [{ fullName: "new/repo" }]);
    assert.equal(workspace.repositoryRequest, request);
  });
}

test("a superseded GitHub refresh cannot commit settings even without a newer settings load", async t => {
  documentFixture(t);
  const gate = Promise.withResolvers(), data = snapshot("old"); let current = true;
  const workspace = settings(async route => { if (route === "/api/agent-accounts") await gate.promise; return data[route]; });
  const pending = workspace.load({ validWhile: () => current });
  current = false; gate.resolve(); assert.equal(await pending, false);
  assert.equal(workspace.github, undefined); assert.equal(workspace.accounts, undefined);
  assert.equal(workspace.repositoryRequest, 0);
});

test("GitHub refresh does not reload repositories after a superseded workspace load", async t => {
  const document = documentFixture(t); document.querySelector("#new-chat-page").hidden = false;
  let repositoryLoads = 0, checks = 0;
  const accounts = Object.assign(Object.create(GitHubAccounts.prototype), {
    refreshRequest: 0, connections: [], render() {},
    api: async route => snapshot("new")[route],
    settings: { state: {}, branchCache: new Map(), load: async ({ validWhile }) => { assert.equal(validWhile(), true); checks++; return false; }, loadRepositories: async () => { repositoryLoads++; } },
  });
  await accounts.refresh(); assert.equal(checks, 1); assert.equal(repositoryLoads, 0);
});

test("environment suggestions include agent scopes and selected repo companies without granting them", t => {
  documentFixture(t); let offered;
  const workspace = Object.assign(Object.create(WorkspaceSettings.prototype), {
    state: { config: { workerBackend: "local" }, chats: [] },
    environments: [], mcps: [], software: [], accounts: [{ companies: ["agent-company"], allowUnassigned: false }],
    selected: [{ fullName: "Repo-Company/project" }], github: { connections: [{ repositoryAccess: "github", login: "not-an-access-scope" }] },
    environmentCompanies: { set: (record, known) => { offered = { record: structuredClone(record), known }; } },
    renderEnvironmentMcps() {}, renderVariables() {},
  });
  workspace.editEnvironment(null);
  assert.deepEqual(offered.known, ["agent-company", "repo-company"]);
  assert.equal(workspace.draft.companies, undefined); assert.equal(workspace.draft.allowUnassigned, undefined);
  assert.deepEqual(offered.record, workspace.draft);
});

test("opening a conversation waits for a newer startup load instead of using missing preferences", async t => {
  const document = documentFixture(t); document.querySelector("#new-chat-page").hidden = false;
  document.querySelector("#agent-select").options = [];
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  let generation = 0, calls = 0, repositoryReads = 0, finished = false;
  const workspace = settings(async route => {
    calls++; const current = generation, data = snapshot(current ? "new" : "old");
    data["/api/preferences"].preferences = { repositories: [] };
    await (current ? second : first).promise; return data[route];
  });
  Object.assign(workspace, { modelPicker: {}, renderAccounts() {}, updateModels() {}, renderSelected() {}, loadRepositories() { repositoryReads++; assert.equal(this.github.login, "new"); } });
  const opening = workspace.openNew().then(() => { finished = true; });
  const stale = workspace.loading; generation = 1; const startup = workspace.load();
  first.resolve(); assert.equal(await stale, false); assert.equal(finished, false);
  second.resolve(); await startup; await opening;
  assert.equal(repositoryReads, 1); assert.equal(calls, 10, "Await existing replacement, without a third fetch round");
  assert.equal(document.querySelector("#create-chat-error").textContent, "");
  assert.equal(document.querySelector("#repository-picker .repository-picker-dropdown").open, false);
});

test("opening before config is loaded fails safely before any settings requests", async t => {
  documentFixture(t); let calls = 0;
  const workspace = settings(async () => { calls++; }); workspace.state.config = null;
  await assert.rejects(() => workspace.openNew(), /still loading/);
  assert.equal(calls, 0);
});
