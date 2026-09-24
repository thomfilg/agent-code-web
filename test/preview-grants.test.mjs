import test from "node:test";
import assert from "node:assert/strict";
import { PreviewGrants, PreviewGrantError } from "../src/preview-grants.mjs";

const base = { ownerId: "owner-a", sessionId: "session-a", chatId: "chat-a", hostname: "preview-a.example.test", port: 3000, runtimeGeneration: 1 };
const denied = action => assert.throws(action, error => error instanceof PreviewGrantError && error.message === "Preview access is unavailable.");
function fixture(t, options = {}) {
  const state = { now: 1000, bindings: new Map(), hook: null, calls: 0 };
  const store = new PreviewGrants({ now: () => state.now, ...options,
    isCurrent: saved => {
      state.calls++;
      if (state.hook) return state.hook(saved);
      const expected = state.bindings.get(saved.hostname);
      return Boolean(expected && Object.keys(base).every(key => saved[key] === expected[key]));
    },
  });
  t.after(() => store.close());
  const allow = (patch = {}) => { const value = { ...base, ...patch }; state.bindings.set(value.hostname, { ...value }); return value; };
  const issue = (patch = {}) => { const value = allow(patch); return { value, ...store.issueTicket(value) }; };
  const grant = (patch = {}) => { const issued = issue(patch); return { value: issued.value, ...store.exchangeTicket(issued.ticket, issued.value.hostname) }; };
  return { store, state, allow, issue, grant };
}

test("one-time bootstrap tickets become distinct nonrenewable session grants", t => {
  const f = fixture(t), issued = f.issue();
  assert.match(issued.ticket, /^pbt_[A-Za-z0-9_-]{43}$/); assert.equal(issued.expiresAt, 61000);
  const result = f.store.exchangeTicket(issued.ticket, base.hostname);
  assert.match(result.grant, /^psg_[A-Za-z0-9_-]{43}$/); assert.notEqual(result.grant, issued.ticket);
  const lease = f.store.authorize(result.grant, base.hostname);
  assert.deepEqual(lease.binding, base); assert.equal(lease.expiresAt, 301000); assert.equal(lease.signal.aborted, false);
  denied(() => f.store.exchangeTicket(issued.ticket, base.hostname));
  f.state.now += 10000;
  assert.equal(f.store.authorize(result.grant, base.hostname), lease); assert.equal(lease.expiresAt, result.expiresAt);
  assert.equal(f.store.size, 1);
});

test("binding is copied/frozen and contains no arbitrary caller-owned objects", t => {
  const f = fixture(t), input = f.allow(), { ticket } = f.store.issueTicket(input);
  input.hostname = "wrong.example.test"; input.port = 9000; input.runtimeGeneration = 9;
  const result = f.store.exchangeTicket(ticket, base.hostname), lease = f.store.authorize(result.grant, base.hostname);
  assert.ok(Object.isFrozen(lease)); assert.ok(Object.isFrozen(lease.binding)); assert.deepEqual(lease.binding, base);
  assert.throws(() => { lease.binding.port = 9999; }, TypeError);
  assert.equal(lease.signal.abort, undefined);
  assert.equal(JSON.stringify(f.store), "{}", "store exposes no token, binding or digest fields");
});

test("wrong hosts fail without consuming a valid ticket or retargeting its grant", t => {
  const f = fixture(t), { ticket } = f.issue();
  for (const host of ["other.example.test", "Preview-a.example.test", "https://preview-a.example.test", "preview-a.example.test:443", "preview-a.example.test.", "preview-a.example.test/", "user@preview-a.example.test", undefined]) {
    denied(() => f.store.exchangeTicket(ticket, host));
  }
  const { grant } = f.store.exchangeTicket(ticket, base.hostname);
  for (const host of ["other.example.test", "PREVIEW-A.EXAMPLE.TEST", "https://preview-a.example.test", "preview-a.example.test:443"]) denied(() => f.store.authorize(grant, host));
  assert.deepEqual(f.store.authorize(grant, base.hostname).binding, base);
});

test("malformed, guessed, cross-store and wrong-kind tokens all use the same denial", t => {
  const f = fixture(t), other = fixture(t), { ticket } = f.issue(), { grant } = f.store.exchangeTicket(ticket, base.hostname);
  for (const value of [null, {}, [], 1, "", "PRIVATE-TOKEN", `pbt_${"A".repeat(42)}`, `pbt_${"A".repeat(44)}`, `pbt_${"A".repeat(43)}\n`, `psg_${"A".repeat(43)}`]) {
    denied(() => f.store.exchangeTicket(value, base.hostname)); denied(() => f.store.authorize(value, base.hostname));
  }
  denied(() => f.store.exchangeTicket(grant, base.hostname)); denied(() => f.store.authorize(ticket, base.hostname));
  denied(() => other.store.authorize(grant, base.hostname));
});

test("invalid or non-plain bindings cannot be minted and never expose inputs", t => {
  const f = fixture(t), invalid = [null, [], new Date(), { ...base, privateToken: "PRIVATE-SECRET" },
    ...["ownerId", "sessionId", "chatId"].flatMap(key => ["", "x".repeat(257), {}, "owner-a\n", "owner-a\r", "owner-a\u2028", "owner-a\u2029"].map(value => ({ ...base, [key]: value }))),
    ...[0, 80, 1023, 65536, 3000.5, "3000", NaN].map(port => ({ ...base, port })),
    ...["localhost", "a.localhost", "a.local", "127.0.0.1", "::1", "[::1]", "169.254.169.254", "127.1", "0x7f.1", "0177.0.0.1", "127.000.000.001", "0x7f000001", "2130706433", "%31%32%37.1", "https://a.test", "*.a.test", "A.test", "a..test", "a-.test", "-a.test", `${"a".repeat(64)}.test`].map(hostname => ({ ...base, hostname })),
    ...[-1, NaN, {}, "", "x".repeat(257)].map(runtimeGeneration => ({ ...base, runtimeGeneration })),
  ];
  let getterRead = false;
  invalid.push(Object.defineProperty({ ...base }, "ownerId", { get() { getterRead = true; throw Error("PRIVATE-SECRET"); } }));
  const symbol = { ...base }; symbol[Symbol("PRIVATE")] = true; invalid.push(symbol);
  for (const value of invalid) denied(() => f.store.issueTicket(value));
  assert.equal(getterRead, false); assert.equal(f.store.size, 0);
});

test("fixed unprivileged ports and opaque numeric/string generations retain exact type", t => {
  const f = fixture(t);
  for (const [port, runtimeGeneration] of [[1024, 0], [65535, "runtime-uuid"], [3000, Number.MAX_SAFE_INTEGER]]) {
    const current = f.grant({ port, runtimeGeneration }), lease = f.store.authorize(current.grant, base.hostname);
    assert.equal(lease.binding.port, port); assert.equal(lease.binding.runtimeGeneration, runtimeGeneration);
  }
});

test("controller authority is required at issuance, exchange and every authorization", t => {
  const f = fixture(t); denied(() => f.store.issueTicket(base));
  for (const field of Object.keys(base)) {
    const first = f.issue();
    f.state.bindings.get(base.hostname)[field] = field === "port" ? 3001 : field === "runtimeGeneration" ? 2 : "wrong-value";
    denied(() => f.store.exchangeTicket(first.ticket, base.hostname));
    const current = f.grant(), lease = f.store.authorize(current.grant, base.hostname);
    f.state.bindings.get(base.hostname)[field] = field === "port" ? 3001 : field === "runtimeGeneration" ? "1" : "wrong-value";
    denied(() => f.store.authorize(current.grant, base.hostname)); assert.equal(lease.signal.aborted, true);
  }
});

test("guard failures, exceptions and async guards fail closed without rejected-promise logging", async t => {
  const f = fixture(t);
  for (const hook of [() => false, () => undefined, () => 1, () => { throw Error("PRIVATE-GUARD"); }, async () => true, async () => { throw Error("PRIVATE-GUARD"); }]) {
    f.state.hook = hook; denied(() => f.store.issueTicket(base)); assert.equal(f.store.size, 0);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test("expiry denies at the exact ticket/grant deadline and a new instance restores nothing", t => {
  const f = fixture(t, { ticketTtlMs: 100, grantTtlMs: 200 });
  const a = f.issue(); f.state.now = a.expiresAt; denied(() => f.store.exchangeTicket(a.ticket, base.hostname));
  const b = f.grant(), lease = f.store.authorize(b.grant, base.hostname);
  f.state.now = b.expiresAt; denied(() => f.store.authorize(b.grant, base.hostname)); assert.equal(lease.signal.aborted, true);
  const c = f.grant(); f.store.close();
  const replacement = fixture(t); replacement.allow(); denied(() => replacement.store.authorize(c.grant, base.hostname));
});

test("live grant signals abort on real deadline without authorize/prune or traffic", async t => {
  const store = new PreviewGrants({ isCurrent: () => true, ticketTtlMs: 100, grantTtlMs: 25 }); t.after(() => store.close());
  const { ticket } = store.issueTicket(base), { grant } = store.exchangeTicket(ticket, base.hostname), lease = store.authorize(grant, base.hostname);
  let timer;
  try {
    await Promise.race([new Promise(resolve => lease.signal.addEventListener("abort", resolve, { once: true })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Preview expiry did not abort")), 1000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(lease.signal.aborted, true); assert.equal(store.size, 0);
});

test("owner/session/chat revocation aborts only exact owned bindings and consumes pending tickets", t => {
  for (const kind of ["owner", "session", "chat"]) {
    const f = fixture(t), first = f.grant(), lease = f.store.authorize(first.grant, base.hostname), pending = f.issue();
    const sibling = f.grant({ hostname: "sibling.example.test", sessionId: "session-b", chatId: "chat-b" });
    const siblingLease = f.store.authorize(sibling.grant, sibling.value.hostname);
    const foreign = f.grant({ hostname: "foreign.example.test", ownerId: "owner-b" });
    const foreignLease = f.store.authorize(foreign.grant, foreign.value.hostname);
    assert.equal(f.store.revokeSession("wrong-owner", base.sessionId), 0);
    assert.equal(f.store.revokeChat("wrong-owner", base.chatId), 0);
    if (kind === "owner") assert.equal(f.store.revokeOwner(base.ownerId), 3);
    if (kind === "session") assert.equal(f.store.revokeSession(base.ownerId, base.sessionId), 2);
    if (kind === "chat") assert.equal(f.store.revokeChat(base.ownerId, base.chatId), 2);
    assert.equal(lease.signal.aborted, true); assert.equal(siblingLease.signal.aborted, kind === "owner"); assert.equal(foreignLease.signal.aborted, false);
    denied(() => f.store.exchangeTicket(pending.ticket, base.hostname));
    assert.deepEqual(f.store.authorize(foreign.grant, foreign.value.hostname).binding, foreign.value);
  }
});

test("individual grant revocation and close synchronously abort signals, never revoke another token", t => {
  const f = fixture(t), a = f.grant(), b = f.grant(), c = f.issue();
  const one = f.store.authorize(a.grant, base.hostname), two = f.store.authorize(b.grant, base.hostname);
  assert.equal(f.store.revokeGrant(c.ticket), false); assert.equal(f.store.revokeGrant("PRIVATE"), false);
  assert.equal(f.store.revokeGrant(a.grant), true); assert.equal(f.store.revokeGrant(a.grant), false);
  assert.equal(one.signal.aborted, true); assert.equal(two.signal.aborted, false);
  f.store.close(); f.store.close(); assert.equal(two.signal.aborted, true); assert.equal(f.store.size, 0);
  denied(() => f.store.issueTicket(base)); denied(() => f.store.exchangeTicket(c.ticket, base.hostname)); denied(() => f.store.authorize(b.grant, base.hostname));
});

test("controller changes require explicit active-lease revocation; next authorization also rejects", t => {
  const f = fixture(t), current = f.grant(), lease = f.store.authorize(current.grant, base.hostname);
  f.state.bindings.get(base.hostname).runtimeGeneration++;
  assert.equal(lease.signal.aborted, false, "there is no invisible polling of controller state");
  f.store.revokeChat(base.ownerId, base.chatId); assert.equal(lease.signal.aborted, true);
  denied(() => f.store.authorize(current.grant, base.hostname));
});

test("capacities count tickets and grants; exchange reuses a slot; expiry/revocation release capacity", t => {
  const f = fixture(t, { maxEntries: 3, maxPerOwner: 2, ticketTtlMs: 100 });
  const a = f.issue(), b = f.issue(); denied(() => f.store.issueTicket(base));
  const { grant } = f.store.exchangeTicket(a.ticket, base.hostname); assert.equal(f.store.size, 2);
  f.issue({ ownerId: "owner-b", hostname: "other.example.test" });
  denied(() => f.store.issueTicket(f.allow({ ownerId: "owner-c", hostname: "third.example.test" })));
  assert.equal(f.store.revokeGrant(grant), true); f.issue({ ownerId: "owner-c", hostname: "third.example.test" });
  f.state.now = b.expiresAt; assert.equal(f.store.prune(), 0);
  assert.ok(f.issue().ticket);
});

test("reentrant guards cannot resurrect a revoked/closed entry or recursively mint", t => {
  for (const phase of ["issue", "exchange", "authorize"]) {
    const f = fixture(t), saved = f.allow(); let ticket, grant;
    if (phase !== "issue") ({ ticket } = f.store.issueTicket(saved));
    if (phase === "authorize") ({ grant } = f.store.exchangeTicket(ticket, base.hostname));
    f.state.hook = () => { f.store.revokeChat(base.ownerId, base.chatId); return true; };
    denied(() => phase === "issue" ? f.store.issueTicket(saved) : phase === "exchange" ? f.store.exchangeTicket(ticket, base.hostname) : f.store.authorize(grant, base.hostname));
    assert.equal(f.store.size, 0);
  }
  const f = fixture(t); f.state.hook = () => { f.store.close(); return true; }; denied(() => f.store.issueTicket(base));
  const recursive = fixture(t); recursive.state.hook = () => { recursive.store.issueTicket(base); return true; };
  denied(() => recursive.store.issueTicket(base)); assert.equal(recursive.store.size, 0);
});

test("abort listeners cannot remint during owner revocation", t => {
  const f = fixture(t), current = f.grant(), lease = f.store.authorize(current.grant, base.hostname); let blocked = false;
  lease.signal.addEventListener("abort", () => { denied(() => f.store.issueTicket(base)); blocked = true; }, { once: true });
  f.store.revokeOwner(base.ownerId); assert.equal(blocked, true); assert.equal(f.store.size, 0);
});

test("an abort listener cannot authorize a sibling while scoped revocation is in progress", t => {
  for (const action of [store => store.revokeOwner(base.ownerId), store => store.revokeSession(base.ownerId, base.sessionId), store => store.revokeChat(base.ownerId, base.chatId)]) {
    const f = fixture(t), first = f.grant(), sibling = f.grant();
    const one = f.store.authorize(first.grant, base.hostname), two = f.store.authorize(sibling.grant, base.hostname); let blocked = false;
    one.signal.addEventListener("abort", () => {
      assert.equal(two.signal.aborted, false, "sibling is still queued for synchronous revocation");
      denied(() => f.store.authorize(sibling.grant, base.hostname)); blocked = true;
    }, { once: true });
    action(f.store); assert.equal(blocked, true); assert.equal(two.signal.aborted, true); assert.equal(f.store.size, 0);
  }
});

test("invalid or regressing clocks abort all live grants with a fixed error", t => {
  for (const changed of [999, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(t), current = f.grant(), lease = f.store.authorize(current.grant, base.hostname);
    f.state.now = changed; denied(() => f.store.authorize(current.grant, base.hostname)); assert.equal(lease.signal.aborted, true); assert.equal(f.store.size, 0);
  }
});

test("constructor bounds memory/deadlines and requires a synchronous authority function", () => {
  for (const options of [{}, { isCurrent: true }, { isCurrent: () => true, now: 1 },
    ...[0, -1, 10001, 1.1].map(maxEntries => ({ isCurrent: () => true, maxEntries })),
    ...[0, -1, 1025].map(maxPerOwner => ({ isCurrent: () => true, maxPerOwner })),
    ...[0, 60001, "100"].map(ticketTtlMs => ({ isCurrent: () => true, ticketTtlMs })),
    ...[0, 300001, "100"].map(grantTtlMs => ({ isCurrent: () => true, grantTtlMs }))]) denied(() => new PreviewGrants(options));
});

test("independent tickets contain full random secrets and do not replace sibling sessions", t => {
  const f = fixture(t), values = new Set();
  for (let i = 0; i < 32; i++) values.add(f.issue().ticket);
  assert.equal(values.size, 32); assert.equal(f.store.size, 32);
  for (const token of values) assert.ok(f.store.exchangeTicket(token, base.hostname).grant);
  assert.equal(f.store.size, 32);
});
