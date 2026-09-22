import { pathToFileURL } from "node:url";
import { WorkerSupervisorDaemon } from "./worker-supervisor-daemon.mjs";

export async function runWorkerSupervisorDaemon() {
  const daemon = await new WorkerSupervisorDaemon({ heartbeat: "/opt/agent-web/.heartbeat" }).listen();
  const stop = async () => {
    let code = 0;
    try { await daemon.close(); }
    catch { code = 1; }
    process.exit(code);
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return daemon;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorkerSupervisorDaemon().catch(() => { process.exitCode = 1; });
}
