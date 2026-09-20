import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRecords } from "../src/database.mjs";
import { ChatStore } from "../src/store.mjs";
import { leaseAuthority, leaseIdentity, leaseRequest, scopedKind, seedLeaseScope } from "./fixtures/worker-lease-scope.mjs";
import { temporaryDirectory } from "./helpers.mjs";

async function fixture(overrides = {}) {
  const records = new MemoryRecords(); await seedLeaseScope(records);
  const authority = leaseAuthority(records, overrides), binding = await authority.prepare(leaseIdentity), claim = await authority.claim(binding, "controller-a");
  return { records, authority, binding, claim };
}
const denied = promise => assert.rejects(promise, /Worker lease:/);

test("opaque lease is issued only after persisted generation and authorizer returns no credential or scope secrets", async () => {
  const { records, authority, binding, claim } = await fixture();
  const issued = await authority.issue(binding, "controller-a"), row = await records.workerAttemptGet(claim.attemptId);
  assert.equal(row.value.generation, 1); assert.equal(row.value.leases["shared-chrome"].id, issued.id);
  assert.ok(!JSON.stringify(row).includes(issued.credential)); assert.match(issued.credential, /^[A-Za-z0-9_-]{43}$/);
  for (const action of ["launch", "inspect", "attach", "input", "endInput", "ackOutput", "status", "terminate"]) {
    const result = await authority.authorize(leaseRequest(issued, { action }));
    assert.deepEqual(Object.keys(result).sort(), ["expiresAt", "generation", "id"]);
    assert.equal(result.id, issued.id); assert.ok(result.expiresAt > Date.now() && result.expiresAt <= Date.now() + 60000);
  }
  for (const patch of [{ action: "renew" }, { processId: "other-process" }, { lease: "wrong" }]) await denied(authority.authorize(leaseRequest(issued, patch)));
  for (const key of Object.keys(leaseIdentity)) await denied(authority.authorize(leaseRequest(issued, { identity: { ...leaseIdentity, [key]: "foreign" } })));
});

test("named account, registered company, single environment and revisions are revalidated from storage on every action", async () => {
  const changes = [
    ["agent-account", leaseIdentity.accountId, { status: "disconnected" }], ["agent-account", leaseIdentity.accountId, { revision: 2 }],
    ["agent-account", leaseIdentity.accountId, { ownerId: `user_${"f".repeat(32)}` }], ["agent-account", leaseIdentity.accountId, { auth: null }],
    ["agent-account-disconnection", leaseIdentity.accountId, { id: leaseIdentity.accountId, ownerId: leaseIdentity.ownerId }],
    ["chat", leaseIdentity.chatId, { archived: true }], ["chat", leaseIdentity.chatId, { status: "stopping" }],
    ["chat", leaseIdentity.chatId, { agentAccountId: "account_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    ["chat", leaseIdentity.chatId, { runtimeMetadata: { instanceId: "i-bbbbbbbbbbbbbbbbb" } }],
    ["chat", leaseIdentity.chatId, { repositories: [{ fullName: "foreign/repo", companyId: "foreign" }] }],
    [scopedKind("company"), "acme", { revision: 2 }], [scopedKind("environment"), "env-fixture", { revision: 2 }],
    [scopedKind("environment"), "env-fixture", { companies: ["acme", "foreign"] }], [scopedKind("environment"), "env-fixture", { archived: true }],
  ];
  for (const [kind, id, patch] of changes) {
    const { records, authority, binding } = await fixture(); const issued = await authority.issue(binding, "controller-a");
    await records.put(kind, id, { ...await records.get(kind, id), ...patch });
    await denied(authority.authorize(leaseRequest(issued))); await denied(authority.renew(binding, "controller-a", issued.id)); await denied(authority.issue(binding, "controller-a"));
  }
});

test("authority never falls back to anonymous owners, another account or another owner's same-named settings", async () => {
  const { records, authority, binding } = await fixture(), issued = await authority.issue(binding, "controller-a");
  for (const patch of [{ ownerId: "anonymous" }, { accountId: "none" }, { provider: "mock" }, { provider: "claude" }]) await denied(authority.prepare({ ...leaseIdentity, ...patch }));
  await records.put("environment", "env-fixture", await records.get(scopedKind("environment"), "env-fixture"));
  await records.delete(scopedKind("environment"), "env-fixture");
  await denied(authority.authorize(leaseRequest(issued))); await denied(authority.prepare(leaseIdentity));
});

test("concurrent issuance has one CAS winner; explicit controller takeover permanently fences the old holder", async () => {
  const { records, authority, binding, claim } = await fixture();
  const issued = await Promise.allSettled([authority.issue(binding, "controller-a"), authority.issue(binding, "controller-a")]);
  assert.equal(issued.filter(result => result.status === "fulfilled").length, 1);
  const first = issued.find(result => result.status === "fulfilled").value;
  const a2 = leaseAuthority(records), a3 = leaseAuthority(records), row = await records.workerAttemptGet(claim.attemptId);
  const attempts = await Promise.allSettled([a2.takeover(binding, "controller-b", { expectedRevision: row.revision }), a3.takeover(binding, "controller-c", { expectedRevision: row.revision })]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  await denied(authority.issue(binding, "controller-a")); await denied(authority.renew(binding, "controller-a", first.id));
  await denied(authority.authorize(leaseRequest(first)));
  const index = attempts.findIndex(result => result.status === "fulfilled"), next = await [a2, a3][index].issue(binding, ["controller-b", "controller-c"][index]);
  assert.equal(next.generation, 2); assert.equal(next.claim.controllerEpoch, 2);
  await denied(leaseAuthority(records).issue(binding, next.claim.controllerId));
});

test("renew is explicit, persisted and scope checked; worker status never extends a deadline", async () => {
  const { records, authority, binding, claim } = await fixture(), issued = await authority.issue(binding, "controller-a");
  const first = await authority.authorize(leaseRequest(issued));
  assert.equal(first.expiresAt, issued.expiresAt);
  const renewed = await authority.renew(binding, "controller-a", issued.id);
  assert.equal(renewed.id, issued.id); assert.equal(renewed.generation, issued.generation); assert.ok(renewed.expiresAt >= issued.expiresAt);
  const row = await records.workerAttemptGet(claim.attemptId);
  await records.workerAttemptTransaction({ attemptId: claim.attemptId, expectedRevision: row.revision, scope: binding.scope }, ({ value }) => ({
    ...value, leases: { ...value.leases, "shared-chrome": { ...value.leases["shared-chrome"], expiresAt: Date.now() - 1 } },
  }));
  await denied(authority.renew(binding, "controller-a", issued.id)); await denied(authority.authorize(leaseRequest(issued)));
});

test("browser and native-agent leases rotate independently while takeover and revoke fence both", async () => {
  const invalidated = [];
  const processIds = ["shared-chrome", "native-agent"];
  const { records, authority, binding, claim } = await fixture({ processIds, invalidateLease: (id, processId) => invalidated.push({ id, processId }) });
  assert.deepEqual(binding.processIds, ["native-agent", "shared-chrome"]);

  const browser = await authority.issue(binding, "controller-a", "shared-chrome");
  const native = await authority.issue(binding, "controller-a", "native-agent");
  assert.equal((await authority.authorize(leaseRequest(browser))).id, browser.id);
  assert.equal((await authority.authorize(leaseRequest(native, { processId: "native-agent" }))).id, native.id);

  const replacement = await authority.issue(binding, "controller-a", "shared-chrome");
  assert.deepEqual(invalidated, [{ id: browser.id, processId: "shared-chrome" }]);
  await denied(authority.authorize(leaseRequest(browser)));
  assert.equal((await authority.authorize(leaseRequest(replacement))).id, replacement.id);
  assert.equal((await authority.authorize(leaseRequest(native, { processId: "native-agent" }))).id, native.id);
  const renewedNative = await authority.renew(binding, "controller-a", native.id, "native-agent");
  assert.equal(renewedNative.id, native.id);

  const row = await records.workerAttemptGet(claim.attemptId), replacementAuthority = leaseAuthority(records, {
    processIds, invalidateLease: (id, processId) => invalidated.push({ id, processId }),
  });
  const takeover = await replacementAuthority.takeover(binding, "controller-b", { expectedRevision: row.revision });
  assert.equal(takeover.controllerEpoch, 2);
  assert.deepEqual(invalidated.slice(1), [
    { id: native.id, processId: "native-agent" },
    { id: replacement.id, processId: "shared-chrome" },
  ]);
  await denied(authority.authorize(leaseRequest(replacement)));
  await denied(authority.authorize(leaseRequest(native, { processId: "native-agent" })));

  const nextBrowser = await replacementAuthority.issue(binding, "controller-b", "shared-chrome");
  const nextNative = await replacementAuthority.issue(binding, "controller-b", "native-agent");
  const released = await replacementAuthority.release(binding, "controller-b", nextBrowser.id, "shared-chrome");
  assert.equal(released.released, true);
  assert.deepEqual(invalidated.slice(3), [
    { id: nextBrowser.id, processId: "shared-chrome" },
  ]);
  await denied(replacementAuthority.authorize(leaseRequest(nextBrowser)));
  assert.equal((await replacementAuthority.authorize(leaseRequest(nextNative, { processId: "native-agent" }))).id, nextNative.id);
  const reopenedBrowser = await replacementAuthority.issue(binding, "controller-b", "shared-chrome");
  assert.equal(reopenedBrowser.generation, 6);
  await replacementAuthority.revoke(binding, reopenedBrowser.id);
  assert.deepEqual(invalidated.slice(4), [
    { id: nextNative.id, processId: "native-agent" },
    { id: reopenedBrowser.id, processId: "shared-chrome" },
  ]);
  await denied(replacementAuthority.authorize(leaseRequest(reopenedBrowser)));
  await denied(replacementAuthority.authorize(leaseRequest(nextNative, { processId: "native-agent" })));
});

test("process release resumes an exact pending invalidation after its acknowledgement is lost", async () => {
  const attempts = []; let loseAcknowledgement = true;
  const { records, authority, binding, claim } = await fixture({ processIds: ["shared-chrome", "native-agent"],
    invalidateLease: (id, processId) => {
      attempts.push({ id, processId });
      if (loseAcknowledgement) { loseAcknowledgement = false; throw Error("synthetic lost acknowledgement"); }
    } });
  const browser = await authority.issue(binding, "controller-a", "shared-chrome");
  await denied(authority.release(binding, "controller-a", browser.id, "shared-chrome"));
  const pending = await records.workerAttemptGet(claim.attemptId);
  assert.equal(pending.value.leases["shared-chrome"], undefined);
  assert.deepEqual(pending.value.pendingInvalidations, [{ processId: "shared-chrome", id: browser.id }]);
  assert.equal((await authority.release(binding, "controller-a", browser.id, "shared-chrome")).released, true);
  assert.deepEqual(attempts, [
    { id: browser.id, processId: "shared-chrome" },
    { id: browser.id, processId: "shared-chrome" },
  ]);
  assert.deepEqual((await records.workerAttemptGet(claim.attemptId)).value.pendingInvalidations, []);
});

test("commit failure never emits a credential; uncertain committed issuance fences the previous token", async () => {
  const { records, authority, binding, claim } = await fixture(), first = await authority.issue(binding, "controller-a");
  const transaction = records.workerAttemptTransaction.bind(records);
  records.workerAttemptTransaction = async () => { throw new Error("PRIVATE STORAGE DETAIL"); };
  await assert.rejects(authority.issue(binding, "controller-a"), error => error.code === "STORAGE_FAILURE" && !error.message.includes("PRIVATE"));
  assert.equal((await records.workerAttemptGet(claim.attemptId)).value.generation, 1);
  records.workerAttemptTransaction = async (...args) => { await transaction(...args); throw new Error("PRIVATE COMMIT ACK LOST"); };
  await denied(authority.issue(binding, "controller-a"));
  records.workerAttemptTransaction = transaction;
  assert.equal((await records.workerAttemptGet(claim.attemptId)).value.generation, 2);
  await denied(authority.authorize(leaseRequest(first)));
});

test("read-only authorization rechecks a raced renewal instead of spuriously expiring its unchanged credential", async () => {
  const { records, authority, binding } = await fixture(), issued = await authority.issue(binding, "controller-a");
  const transaction = records.workerAttemptTransaction.bind(records), entered = Promise.withResolvers(), gate = Promise.withResolvers(); let first = true;
  records.workerAttemptTransaction = async (...args) => { if (first) { first = false; entered.resolve(); await gate.promise; } return transaction(...args); };
  const pending = authority.authorize(leaseRequest(issued)); await entered.promise;
  const renewed = await authority.renew(binding, "controller-a", issued.id); gate.resolve();
  const accepted = await pending; assert.equal(accepted.id, issued.id); assert.equal(accepted.expiresAt, renewed.expiresAt);
});

test("revocation tombstone and failed invalidation stay fail closed, with an explicit retry after account deletion or reboot", async () => {
  const invalidated = []; let fail = false, boot = "b".repeat(64);
  const { records, authority, binding, claim } = await fixture({ bootForWorker: () => boot, invalidateLease: id => { if (fail) throw Error("PRIVATE"); invalidated.push(id); } });
  const first = await authority.issue(binding, "controller-a"); fail = true;
  await denied(authority.issue(binding, "controller-a"));
  const replacementId = Object.values((await records.workerAttemptGet(claim.attemptId)).value.leases)[0].id;
  await denied(authority.authorize(leaseRequest(first))); await denied(authority.issue(binding, "controller-a"));
  await records.delete("agent-account", leaseIdentity.accountId); boot = "c".repeat(64);
  await denied(authority.revoke(binding));
  assert.equal((await records.workerAttemptGet(claim.attemptId)).value.status, "revoked");
  fail = false; assert.deepEqual(await authority.revoke(binding), { revoked: true }); assert.deepEqual(invalidated, [first.id, replacementId]);
  boot = "b".repeat(64); await seedLeaseScope(records);
  await denied(leaseAuthority(records).claim(binding, "controller-z"));
  await denied(leaseAuthority(records).takeover(binding, "controller-z", { expectedRevision: (await records.workerAttemptGet(claim.attemptId)).revision }));
});

test("transport ledger CAS checks controller epoch and lease under the same lock, and rejects async or throwing transitions", async () => {
  const { records, authority, binding } = await fixture(), issued = await authority.issue(binding, "controller-a");
  const request = { ...issued.claim, processId: "shared-chrome" };
  assert.deepEqual(await records.workerTransportGet(request), { revision: 0, value: null });
  const one = await records.workerTransportTransaction({ ...request, expectedRevision: 0 }, () => ({ committedOutputSeq: 1, privateChunks: ["synthetic"] }));
  assert.equal(one.revision, 1);
  await denied(records.workerTransportTransaction({ ...request, expectedRevision: 0 }, () => ({})));
  await denied(records.workerTransportTransaction({ ...request, expectedRevision: 1 }, async () => ({})));
  await assert.rejects(records.workerTransportTransaction({ ...request, expectedRevision: 1 }, ({ value }) => { value.committedOutputSeq = 999; throw Error("fixture"); }));
  assert.equal((await records.workerTransportGet(request)).value.committedOutputSeq, 1);
  const row = await records.workerAttemptGet(request.attemptId), next = leaseAuthority(records);
  await next.takeover(binding, "controller-b", { expectedRevision: row.revision }); await next.issue(binding, "controller-b");
  await denied(records.workerTransportGet(request)); await denied(records.workerTransportTransaction({ ...request, expectedRevision: 1 }, () => ({})));
});

test("failed ChatStore persistence cannot authorize an account selected only in its advanced in-memory cache", async t => {
  const { records, authority } = await fixture(), directory = await temporaryDirectory(t), store = new ChatStore(directory, records);
  await store.initialize(); const alternate = "account_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const put = records.put.bind(records); records.put = async (kind, ...args) => { if (kind === "chat") throw Error("fixture write failed"); return put(kind, ...args); };
  await assert.rejects(store.update(leaseIdentity.chatId, { agentAccountId: alternate }));
  assert.equal(store.get(leaseIdentity.chatId).agentAccountId, alternate);
  assert.equal((await records.get("chat", leaseIdentity.chatId)).agentAccountId, leaseIdentity.accountId);
  await denied(authority.prepare({ ...leaseIdentity, accountId: alternate }));
  assert.equal((await authority.prepare(leaseIdentity)).identity.accountId, leaseIdentity.accountId);
});
