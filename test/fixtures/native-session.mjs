import { MemoryRecords } from "../../src/database.mjs";
import { NativeSessionCheckpoints } from "../../src/native-session-checkpoints.mjs";
import { seedLeaseScope, leaseIdentity } from "./worker-lease-scope.mjs";
export const nativeId = "11111111-1111-4111-8111-111111111111";
export const nativeRow = (type, payload) => JSON.stringify({ timestamp: "2026-09-19T12:00:00.000Z", type, payload }) + "\n";
export const nativeBundle = (tail = "") => ({ version: 1, threadId: nativeId, goal: null, files: [{ id: nativeId,
  data: Buffer.from(nativeRow("session_meta", { id: nativeId, timestamp: "2026-09-19T12:00:00.000Z" })
    + nativeRow("response_item", { type: "reasoning", encrypted_content: "private-opaque-fixture", summary: [] })
    + nativeRow("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Original native instruction" }] }) + tail).toString("base64") }] });
export async function nativeFixture(records = new MemoryRecords()) {
  await seedLeaseScope(records);
  const account = await records.get("agent-account", leaseIdentity.accountId);
  await records.put("agent-account", account.id, { ...account, subject: "synthetic-user" });
  const chat = { ...await records.get("chat", leaseIdentity.chatId), agentSessionId: nativeId };
  await records.put("chat", chat.id, chat);
  return { records, chat, service: new NativeSessionCheckpoints({ records }) };
}
