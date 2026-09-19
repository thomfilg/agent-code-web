// Appended to browser-worker.mjs only in an explicitly disposable image probe.
// This diagnostic never starts a provider or reads a saved browser profile.
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, chmod } from "node:fs/promises";

const digest = value => createHash("sha256").update(value).digest("hex");
const proof = (secret, challenge) => createHmac("sha256", secret).update(challenge).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validProbeBinding(binding) {
  return binding?.schema === 2 && /^[a-f0-9-]{36}$/.test(binding.verificationId || "") &&
    /^i-[a-f0-9]{8,17}$/.test(binding.workerId || "") && hex(binding.imageIdentityHash) && hex(binding.continuityChallenge);
}
export async function processStartTicks(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid diagnostic process");
  // comm may contain spaces or ')'; starttime is field22 after its last ')'.
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const tick = value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
  if (!/^\d+$/.test(tick || "")) throw new Error("Invalid diagnostic process identity");
  return tick;
}

export async function createHibernationProbe({ socket, binding, browser, startTicks = processStartTicks }) {
  if (!validProbeBinding(binding)) throw new Error("Invalid diagnostic binding");
  const memory = randomBytes(32).toString("hex"), instanceHash = digest(randomBytes(32));
  const used = new Set(); let requests = 0, closed = false, server;
  try {
    await browser.start();
    await browser.evaluate(`window.__relayHibernationMemory = ${JSON.stringify(randomBytes(32).toString("hex"))}`);
    const nodeStartTicks = await startTicks(process.pid), chromeStartTicks = await startTicks(browser.child.pid);
    server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/state") { response.writeHead(404).end(); return; }
      try {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error(); }
        const input = JSON.parse(body);
        if (!hex(input.challenge) || input.verificationId !== binding.verificationId || input.workerId !== binding.workerId || input.imageIdentityHash !== binding.imageIdentityHash || used.has(input.challenge) || used.size >= 16) {
          response.writeHead(409).end(); return;
        }
        // Reserve before awaiting Chrome: concurrent/replayed challenges cannot
        // increment the counter twice. A failed outcome is not replayed.
        used.add(input.challenge);
        const browserMemory = await browser.evaluate("window.__relayHibernationMemory");
        if (!hex(browserMemory) || await startTicks(process.pid) !== nodeStartTicks || await startTicks(browser.child.pid) !== chromeStartTicks) throw new Error();
        const bootHash = digest(await readFile("/proc/sys/kernel/random/boot_id", "utf8"));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ schema: 2, verificationId: binding.verificationId, workerId: binding.workerId, imageIdentityHash: binding.imageIdentityHash,
          instanceHash, nodePid: process.pid, chromePid: browser.child.pid, nodeStartTicks, chromeStartTicks, bootHash, requests: ++requests,
          memoryHash: digest(memory), browserMemoryHash: digest(browserMemory), challengeHash: digest(input.challenge),
          challengeProof: proof(memory, input.challenge), browserChallengeProof: proof(browserMemory, input.challenge),
          continuityProof: proof(memory, binding.continuityChallenge), browserContinuityProof: proof(browserMemory, binding.continuityChallenge) }));
      } catch { if (!response.headersSent) response.writeHead(503); response.end(); }
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    await chmod(socket, 0o600);
    return { close: async () => { if (closed) return; closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await browser.stop(); } };
  } catch (error) {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await browser.stop(); throw error;
  }
}

if (process.argv[2] === "--hibernation-probe") {
  const socket = process.argv[1], binding = JSON.parse(process.argv[3] || "null");
  if (!/^\/opt\/agent-web\/hibernate-probe-[a-f0-9-]{36}\.sock$/.test(socket || "") || !validProbeBinding(binding) || !socket.includes(binding.verificationId)) throw new Error("Invalid fixture socket or binding");
  const probe = await createHibernationProbe({ socket, binding, browser: new ChromeBrowser() });
  const shutdown = async () => { await probe.close(); process.exit(0); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}
