import { WorkerProcessTransport } from "../../src/worker-process-transport.mjs";

const client = await new WorkerProcessTransport({ socketPath: process.env.FIXTURE_SOCKET,
  expectedIdentity: JSON.parse(process.env.FIXTURE_IDENTITY), lease: "lease-1" }).connect();
const receipt = await client.launch("child", JSON.parse(process.env.FIXTURE_SPEC));
client.on("output", frame => {
  if (frame.channel !== "stdout") return;
  // Deliberately no output acknowledgement: the next controller must replay it.
  process.send({ type: "output", receipt, frame: { ...frame, data: frame.data.toString() } }, () => process.exit(0));
});
await client.attach(receipt, 0);
await client.writeInput(1, Buffer.from("increment\n"));
