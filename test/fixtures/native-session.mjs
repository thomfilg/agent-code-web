import { MemoryRecords } from "../../src/database.mjs";
import { NativeSessionCheckpoints } from "../../src/native-session-checkpoints.mjs";
import { seedLeaseScope, leaseIdentity } from "./worker-lease-scope.mjs";
import { nativeId } from "./native-session-data.mjs";
export { nativeId, nativeRow, nativeBundle } from "./native-session-data.mjs";
export async function nativeFixture(records = new MemoryRecords()) {
  await seedLeaseScope(records);
  const account = await records.get("agent-account", leaseIdentity.accountId);
  await records.put("agent-account", account.id, { ...account, subject: "synthetic-user" });
  const chat = { ...await records.get("chat", leaseIdentity.chatId), agentSessionId: nativeId };
  await records.put("chat", chat.id, chat);
  return { records, chat, service: new NativeSessionCheckpoints({ records }) };
}
