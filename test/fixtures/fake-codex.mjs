#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let pendingTurn = null;
let turnCount = 0;
let goal = null;
let lastMode = "default";
let externalAccount, refreshRequest;
let backgroundTerminals = [{ processId: "100", command: "npm run dev TOKEN=fixture-secret", cwd: "/fixture/workspace" }, { processId: "200", command: "npm run test:watch", cwd: "/fixture/workspace" }];
function goalChanged() { send({ method: "thread/goal/updated", params: { threadId: "thr_fixture", goal } }); }
function continueGoal() {
  if (!goal || goal.status !== "active" || pendingTurn || lastMode === "plan") return;
  const turn = { threadId: "thr_fixture", turnId: `turn_goal_${++turnCount}` };
  send({ method: "turn/started", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "inProgress" } } });
  send({ method: "item/agentMessage/delta", params: { ...turn, delta: "Goal verified complete" } });
  goal = { ...goal, status: "complete", tokensUsed: 200 }; goalChanged();
  send({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } });
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: `${message.params.clientInfo.name}/0.154.0-fixture (private-host-never-expose)`, platformFamily: "unix", platformOs: "linux" } });
  } else if (message.method === "account/login/start") {
    if (message.params.type !== "chatgptAuthTokens" || !message.params.accessToken || message.params.refreshToken) return send({ id: message.id, error: { code: -32602, message: "Fixture requires only an external access token" } });
    externalAccount = message.params;
    send({ id: message.id, result: { type: "chatgptAuthTokens" } });
  } else if (message.method === "fixture/accountRefresh") {
    refreshRequest = message.id;
    send({ id: 901, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: message.params.previousAccountId } });
  } else if (message.id === 901 && !message.method) {
    send({ id: refreshRequest, ...(message.error ? { error: message.error } : { result: { fields: Object.keys(message.result).sort(), accountId: message.result.chatgptAccountId, hasAccess: Boolean(message.result.accessToken) } }) });
  } else if (message.method === "fixture/accountEcho") {
    send({ method: "error", params: { message: `Fixture echo: ${externalAccount.accessToken}` } });
    send({ id: message.id, result: externalAccount });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { model: "fixture-gpt", thread: { id: "thr_fixture" } } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  } else if (message.method === "thread/read") {
    send({ id: message.id, error: { code: -32602, message: "No descendant thread in this fixture" } });
  } else if (message.method === "thread/resume") {
    if (message.params.threadId === "thr_missing") send({ id: message.id, error: { code: -32602, message: "Fixture native history is missing" } });
    else send({ id: message.id, result: { thread: { id: message.params.threadId === "thr_wrong_identity" ? "thr_other" : message.params.threadId } } });
  } else if (message.method === "thread/settings/update") {
    send({ id: message.id, result: { settings: message.params } });
  } else if (message.method === "thread/backgroundTerminals/list") {
    send({ id: message.id, result: { data: backgroundTerminals, nextCursor: null } });
  } else if (message.method === "thread/backgroundTerminals/terminate") {
    backgroundTerminals = backgroundTerminals.filter(item => item.processId !== message.params.processId);
    send({ id: message.id, result: {} });
  } else if (message.method === "thread/backgroundTerminals/clean") {
    backgroundTerminals = []; send({ id: message.id, result: {} });
  } else if (message.method === "config/read") {
    send({ id: message.id, result: { config: { model: "fixture-gpt", sandbox_mode: "workspace-write", api_key: "never-expose", shell_environment_policy: { set: { SECRET: "never-expose" } }, mcp_servers: { private: { http_headers: { Authorization: "never-expose" } } } }, origins: { model: { name: { type: "user" } } } } });
  } else if (message.method === "configRequirements/read") {
    send({ id: message.id, result: { requirements: null } });
  } else if (message.method === "review/start") {
    const turn = pendingTurn = { threadId: message.params.threadId, turnId: `review_fixture_${++turnCount}` };
    send({ id: message.id, result: { turn: { id: turn.turnId, status: "inProgress" }, reviewThreadId: turn.threadId } });
    send({ method: "turn/started", params: { threadId: turn.threadId, turn: { id: `${turn.turnId}_inner`, status: "inProgress" } } });
    setTimeout(() => {
      if (pendingTurn !== turn) return;
      send({ method: "item/completed", params: { ...turn, item: { type: "exitedReviewMode", id: "review_result", review: "Native review completed without a normal prompt." } } });
      send({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } });
      pendingTurn = null;
    }, message.params.fixtureDelayMs || 0);
  } else if (message.method === "thread/compact/start") {
    const compactTurn = pendingTurn = { threadId: message.params.threadId, turnId: `compact_fixture_${++turnCount}` };
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId: compactTurn.threadId, turn: { id: compactTurn.turnId, status: "inProgress" } } });
    setTimeout(() => {
      if (pendingTurn !== compactTurn) return;
      pendingTurn = null;
      send({ method: "turn/completed", params: { threadId: compactTurn.threadId, turn: { id: compactTurn.turnId, status: "completed" } } });
    }, message.params.fixtureDelayMs || 0);
  } else if (message.method === "thread/goal/get") {
    send({ id: message.id, result: { goal } });
  } else if (message.method === "thread/goal/set") {
    goal = { threadId: "thr_fixture", tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null, ...goal, ...message.params }; goalChanged();
    send({ id: message.id, result: { goal } }); setImmediate(continueGoal);
  } else if (message.method === "thread/goal/clear") {
    goal = null; send({ method: "thread/goal/cleared", params: { threadId: "thr_fixture" } }); send({ id: message.id, result: {} });
  } else if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } } });
  } else if (message.method === "account/read") {
    send({ id: message.id, result: { account: { planType: "pro" } } });
  } else if (message.method === "skills/list") {
    send({ id: message.id, result: { data: [{ skills: [] }] } });
  } else if (message.method === "mcpServerStatus/list") {
    send({ id: message.id, result: { data: [{ name: "fixture", authStatus: "oAuth", tools: { example: {} } }] } });
  } else if (message.method === "turn/start") {
    lastMode = message.params.collaborationMode?.mode || "default";
    pendingTurn = { threadId: message.params.threadId, turnId: `turn_fixture_${++turnCount}` };
    send({ id: message.id, result: { turn: { id: pendingTurn.turnId, status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId: pendingTurn.threadId, turn: { id: pendingTurn.turnId, status: "inProgress" } } });
    if (message.params.input?.some(item => item.text === "title-progress-fixture")) {
      for (const patch of [{ threadId: "other-thread" }, { turnId: "old-turn" }, {}]) send({ method: "turn/plan/updated", params: {
        ...pendingTurn, ...patch, explanation: "private explanation never retained",
        plan: [{ step: "private completed step", status: "completed" }, { step: "private active step", status: "inProgress" }, { step: "private pending step", status: "pending" }],
      } });
    }
    send({ method: "item/started", params: { ...pendingTurn, startedAtMs: Date.now(), item: { id: "cmd_fixture", type: "commandExecution", command: "printf fixture", commandActions: [], cwd: process.cwd(), status: "inProgress" } } });
    send({ method: "item/commandExecution/requestApproval", id: 900, params: { ...pendingTurn, itemId: "cmd_fixture", command: "printf fixture", cwd: process.cwd(), reason: "Fixture approval" } });
  } else if (message.method === "turn/interrupt") {
    if (!pendingTurn || (pendingTurn.turnId !== message.params.turnId && `${pendingTurn.turnId}_inner` !== message.params.turnId)) return send({ id: message.id, error: { code: -32602, message: "Wrong turn ID" } });
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId: pendingTurn.threadId, turn: { id: pendingTurn.turnId, status: "interrupted" } } });
    pendingTurn = null;
  } else if (message.id === 900 && message.result?.decision && pendingTurn) {
    send({ method: "serverRequest/resolved", params: { threadId: pendingTurn.threadId, requestId: 900 } });
    send({ method: "item/completed", params: { ...pendingTurn, completedAtMs: Date.now(), item: { id: "cmd_fixture", type: "commandExecution", command: "printf fixture", commandActions: [], cwd: process.cwd(), status: "completed", aggregatedOutput: "fixture output", exitCode: 0, durationMs: 1 } } });
    send({ method: "item/agentMessage/delta", params: { ...pendingTurn, itemId: "agent_fixture", delta: "hello " } });
    send({ method: "item/agentMessage/delta", params: { ...pendingTurn, itemId: "agent_fixture", delta: "world" } });
    send({ method: "item/completed", params: { ...pendingTurn, completedAtMs: Date.now(), item: { id: "agent_fixture", type: "agentMessage", text: "hello world" } } });
    send({ method: "turn/completed", params: { threadId: pendingTurn.threadId, turn: { id: pendingTurn.turnId, status: "completed", items: [] } } });
    pendingTurn = null;
    setImmediate(continueGoal);
  }
});
