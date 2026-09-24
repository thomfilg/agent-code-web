import assert from "node:assert/strict";
import test from "node:test";
import { CodexApprovals } from "../src/codex-approvals.mjs";
import { CodexFeedback } from "../src/codex-feedback.mjs";
import { CodexLogout } from "../src/codex-logout.mjs";
import { desktopBinding } from "../src/desktop-handoff.mjs";

test("native consent and saved locators cannot cross named accounts even if a native session ID is reused", () => {
  const config = { codex: { authMode: "gateway" }, workerBackend: "local" };
  const base = { id: "chat-fixture", ownerId: "owner-fixture", agent: "codex", agentSessionId: "same-thread", workspace: "/fixture", repositories: [] };
  const services = [CodexApprovals, CodexFeedback, CodexLogout].map(Service => new Service(null, config));
  const bindings = [...services.map(service => chat => service.binding(chat)), chat => desktopBinding(chat, config)];
  for (const binding of bindings) {
    assert.equal(binding(base), binding({ ...base, agentAccountId: null }), "legacy review bindings remain stable");
    assert.notEqual(binding(base), binding({ ...base, agentAccountId: "personal" }));
    assert.notEqual(binding({ ...base, agentAccountId: "personal" }), binding({ ...base, agentAccountId: "company" }));
  }
});
