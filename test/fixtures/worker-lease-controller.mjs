// Separate synthetic controller process. Configuration travels over private IPC;
// no provider/profile credentials, network gateway, or application prompts.
import pg from "pg";
import { EncryptedRecords, RecordCipher } from "../../src/database.mjs";
import { WorkerLeaseAuthority } from "../../src/worker-lease-authority.mjs";
let records, authority;
process.on("message", async message => {
  try {
    if (message.action === "initialize") {
      records = new EncryptedRecords({ pool: new pg.Pool(message.connection), cipher: new RecordCipher(message.encryptionKey) });
      authority = new WorkerLeaseAuthority({ records, deploymentId: message.deploymentId, bootForWorker: () => message.bootId, invalidateLease: () => {}, ttlMs: 60000 });
      process.send({ id: message.id, result: { ready: true } }); return;
    }
    if (message.action === "close") { await records.close(); process.send({ id: message.id, result: { closed: true } }); process.disconnect(); return; }
    if (!["prepare", "claim", "takeover", "issue", "renew", "authorize", "revoke"].includes(message.action)) throw Error();
    const result = await authority[message.action](...message.args); process.send({ id: message.id, result });
  } catch (error) { process.send({ id: message.id, error: /^([A-Z_]+)$/.test(error?.code || "") ? error.code : "FIXTURE_FAILED" }); }
});
