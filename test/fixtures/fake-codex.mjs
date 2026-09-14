#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let pendingTurn = null;

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOs: "linux" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_fixture" } } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  } else if (message.method === "turn/start") {
    pendingTurn = { threadId: message.params.threadId, turnId: "turn_fixture" };
    send({ id: message.id, result: { turn: { id: pendingTurn.turnId, status: "inProgress", items: [] } } });
    send({ method: "item/started", params: { ...pendingTurn, startedAtMs: Date.now(), item: { id: "cmd_fixture", type: "commandExecution", command: "printf fixture", commandActions: [], cwd: process.cwd(), status: "inProgress" } } });
    send({ method: "item/commandExecution/requestApproval", id: 900, params: { ...pendingTurn, itemId: "cmd_fixture", command: "printf fixture", cwd: process.cwd(), reason: "Fixture approval" } });
  } else if (message.id === 900 && message.result?.decision) {
    send({ method: "serverRequest/resolved", params: { threadId: pendingTurn.threadId, requestId: 900 } });
    send({ method: "item/completed", params: { ...pendingTurn, completedAtMs: Date.now(), item: { id: "cmd_fixture", type: "commandExecution", command: "printf fixture", commandActions: [], cwd: process.cwd(), status: "completed", aggregatedOutput: "fixture output", exitCode: 0, durationMs: 1 } } });
    send({ method: "item/agentMessage/delta", params: { ...pendingTurn, itemId: "agent_fixture", delta: "hello " } });
    send({ method: "item/agentMessage/delta", params: { ...pendingTurn, itemId: "agent_fixture", delta: "world" } });
    send({ method: "item/completed", params: { ...pendingTurn, completedAtMs: Date.now(), item: { id: "agent_fixture", type: "agentMessage", text: "hello world" } } });
    send({ method: "turn/completed", params: { threadId: pendingTurn.threadId, turn: { id: pendingTurn.turnId, status: "completed", items: [] } } });
    pendingTurn = null;
  }
});
