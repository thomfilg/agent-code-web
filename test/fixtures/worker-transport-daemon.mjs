import { WorkerProcessSupervisor } from "../../src/worker-process-supervisor.mjs";

// Synthetic worker-owned process for the controller-exit acceptance test. No
// account credentials, native agents, network listeners or persistent profiles.
let generation = 1;
const supervisor = await new WorkerProcessSupervisor({
  socketPath: process.env.FIXTURE_SOCKET,
  expectedIdentity: JSON.parse(process.env.FIXTURE_IDENTITY),
  authorize: ({ lease }) => {
    if (lease !== `lease-${generation}`) throw Error("synthetic private denial");
    return { id: lease, generation, expiresAt: Date.now() + 30000 };
  },
}).listen();
process.on("message", async message => {
  if (message.type === "generation") { generation = message.generation; process.send({ type: "generation", generation }); }
  if (message.type === "close") {
    try { await supervisor.close(); process.send({ type: "closed" }); process.disconnect(); }
    catch { process.send({ type: "close-denied" }); }
  }
  if (message.type === "cleanup") {
    for (const entry of supervisor.processes.values()) {
      await supervisor.terminate(entry);
      while (!entry.exitRecorded) {
        supervisor.acknowledge(entry, entry.outputSeq); supervisor.drain(entry);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      supervisor.acknowledge(entry, entry.outputSeq);
    }
    await supervisor.close(); process.send({ type: "cleaned" }); process.disconnect();
  }
});
process.send({ type: "ready" });
