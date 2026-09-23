const runtimeRoot = typeof process.env.XDG_RUNTIME_DIR === "string" && /^\/run\/user\/\d+$/.test(process.env.XDG_RUNTIME_DIR)
  ? process.env.XDG_RUNTIME_DIR : "/opt/agent-web";
export const WORKER_SUPERVISOR_ROOT = `${runtimeRoot}/agent-relay-worker`;
export const WORKER_SUPERVISOR_SOCKET = `${WORKER_SUPERVISOR_ROOT}/process.sock`;
export const WORKER_SUPERVISOR_CONTROL_SOCKET = `${WORKER_SUPERVISOR_ROOT}/control.sock`;
export const WORKER_SUPERVISOR_CODE = "/opt/agent-web/supervisor-code";
