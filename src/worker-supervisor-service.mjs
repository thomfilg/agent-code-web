import { WORKER_SUPERVISOR_CODE } from "./worker-supervisor-paths.mjs";

export const workerSupervisorVersion = "v1";
export const workerSupervisorFiles = [
  "worker-process-anchor.mjs",
  "worker-process-supervisor.mjs",
  "worker-transport-wire.mjs",
  "worker-supervisor-paths.mjs",
  "worker-supervisor-daemon.mjs",
  "worker-supervisor-daemon-cli.mjs",
  "worker-supervisor-control.mjs",
  "worker-supervisor-bridge.mjs",
  "worker-supervisor-service.mjs",
];
export const workerSupervisorUnit = `[Unit]
Description=Agent Relay worker-owned process supervisor
After=default.target

[Service]
Type=simple
WorkingDirectory=/opt/agent-web
ExecStart=/usr/bin/node ${WORKER_SUPERVISOR_CODE}/worker-supervisor-daemon-cli.mjs
Restart=on-failure
RestartSec=2
KillMode=control-group
TimeoutStopSec=5
UMask=0077
NoNewPrivileges=yes
RuntimeDirectory=agent-relay-worker
RuntimeDirectoryMode=0700

[Install]
WantedBy=default.target
`;

export const workerSupervisorShell = command => `export HOME=/home/agent XDG_RUNTIME_DIR=/run/user/$(id -u); ${command}`;
