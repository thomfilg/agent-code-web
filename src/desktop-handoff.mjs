import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { companyForChat } from "../public/company-scope.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const absolute = value => typeof value === "string" && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value) && path.isAbsolute(value) && path.normalize(value) === value;
const conflict = () => Object.assign(new Error("The native session changed or is unavailable. Refresh the desktop handoff; nothing was opened or copied."), { statusCode: 409 });

// Cache only a native locator, never a transcript, configuration or credentials.
// Any owner, company, workspace, session, backend or profile change invalidates it.
export function desktopBinding(chat, config) {
  return createHash("sha256").update(JSON.stringify([
    chat.id, chat.ownerId || null, companyForChat(chat), chat.environmentId || null,
    chat.agent, chat.agentSessionId || null, chat.workspace, config.workerBackend,
    chat.runtimeMetadata || null, config.codex.authMode,
    config.codex.authMode === "host" ? process.env.CODEX_HOME || path.join(os.homedir(), ".codex") : null,
  ])).digest("hex");
}

export async function inspectDesktopSession(adapter, check = () => {}) {
  check();
  const { rpc, threadId, nativeHome, nativeAuthMode, workspace } = adapter;
  if (!rpc || !UUID.test(threadId || "") || adapter.intentionalStop || adapter.sharedParent || !absolute(nativeHome) || !absolute(workspace)
    || !["host", "gateway"].includes(nativeAuthMode) || adapter.config.codex.authMode !== nativeAuthMode) throw conflict();
  let result;
  try { result = await rpc.request("thread/read", { threadId, includeTurns: false }, 10000); }
  catch { check(); throw conflict(); }
  check();
  if (adapter.rpc !== rpc || adapter.threadId !== threadId || adapter.nativeHome !== nativeHome || adapter.workspace !== workspace
    || adapter.nativeAuthMode !== nativeAuthMode || adapter.config.codex.authMode !== nativeAuthMode || adapter.intentionalStop) throw conflict();
  const thread = result?.thread;
  if (thread?.id !== threadId || thread.ephemeral || thread.cwd !== workspace || !absolute(thread.path)
    || !["sessions", "archived_sessions"].some(directory => thread.path.startsWith(path.join(nativeHome, directory) + path.sep))) throw conflict();
  // Empty threads may not have a rollout yet. Native thread/read reports their
  // missing path; do not manufacture a saved chat or send a turn to create one.
  return { threadId, workspace, profile: nativeHome, backend: adapter.executor?.metadata?.backend || "local", authMode: nativeAuthMode, checkedAt: new Date().toISOString() };
}

export function desktopInfo(chat, snapshot, { awake = false, busy = false } = {}) {
  const threadId = UUID.test(chat.agentSessionId || "") ? chat.agentSessionId : null;
  const valid = snapshot && snapshot.threadId === threadId && threadId && absolute(snapshot.workspace) && absolute(snapshot.profile)
    && ["host", "gateway"].includes(snapshot.authMode) && ["local", "ec2"].includes(snapshot.backend) && Number.isFinite(Date.parse(snapshot.checkedAt));
  const info = { threadId, source: valid ? awake ? "connected" : "saved" : "unknown", busy, checkedAt: valid ? snapshot.checkedAt : null,
    workspace: valid ? snapshot.workspace : null, profile: valid ? snapshot.profile : null,
    backend: valid ? snapshot.backend : null, privateProfile: valid ? snapshot.authMode === "gateway" : null, url: null };
  if (!threadId) info.reason = "This chat has no saved native Codex session to open yet. Send your actual task first; /app does not create a replacement chat.";
  else if (!valid) info.reason = "The saved session's native location has not been verified. After your next real message in Relay, refresh here while the worker is awake. Opening this panel never starts a worker or sends a prompt.";
  else if (info.privateProfile) info.reason = "This session uses a private Relay worker profile. A local desktop link cannot select that profile or transfer its gateway access. No history or credentials have been copied. Continue in Relay until an explicit private-profile desktop connection is supported.";
  else if (info.backend !== "local") info.reason = "This session belongs to a remote worker. Local chat links do not select a remote host. Connect the owning host in the desktop app, using the correct account and profile, then select the existing chat there. Relay does not expose a public app-server port or transfer credentials.";
  else {
    info.url = `codex://threads/${threadId}`;
    info.reason = "Open this same saved session in the desktop app on the worker's computer, using the exact Codex profile below. Being signed in to the same account on another computer does not make local sessions available there.";
  }
  return info;
}
