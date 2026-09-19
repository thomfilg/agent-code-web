// Local protocol-only fixture. Browser memory is synthetic, never an image
// acceptance claim; the Node process and Unix connection lifetime are real.
import { createHibernationProbe } from "../../deploy/aws/hibernation-probe-worker.mjs";
const browser = { child: { pid: process.pid }, memory: null,
  start: async () => {}, stop: async () => {},
  async evaluate(code) { if (code.includes(" = ")) this.memory = JSON.parse(code.split(" = ")[1]); return this.memory; },
};
const probe = await createHibernationProbe({ socket: process.argv[2], binding: JSON.parse(process.argv[3]), browser });
process.stdout.write("ready\n");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await probe.close(); process.exit(0); });
