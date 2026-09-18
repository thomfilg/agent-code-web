import test from "node:test";
import assert from "node:assert/strict";
import { previewTarget, previewAddress, previewState, previewOpenUrl, waitForPreviewLaunch } from "../public/app-preview.js";

test("preview targets preserve arbitrary allowed port and local path/query/hash", () => {
  for (const port of [1024, 8081, 65535]) assert.deepEqual(previewTarget(String(port), "/app?a=1#tab"), { port, path: "/app?a=1#tab" });
  assert.deepEqual(previewTarget(3000, "/a/../hello world"), { port: 3000, path: "/hello%20world" });
  for (const port of [0, 80, 1023, 65536, "3000\n", "3e3", " 3000", "3000.0", "3000/", null]) assert.throws(() => previewTarget(port));
  assert.equal(previewTarget(3000, "/" + "a".repeat(4095)).path.length, 4096);
  for (const path of ["", "https://evil.test/", "//evil.test/", "/\\evil", "/\nfoo", "/\x7f", "/__relay_preview/bootstrap", "/other/../__relay_preview/probe", "/%00bad", "/%5Cbad", "/%7f", "/" + "a".repeat(4096), "/" + "é".repeat(1000)]) assert.throws(() => previewTarget(3000, path));
});

test("worker preparation polling retains one job and exact target until a trusted launch is returned", async () => {
  const id = "warm_11111111-2222-4333-8444-555555555555", target = { port: 8081, path: "/app?q=1#tab" }, calls = [];
  let progress = 0;
  const result = await waitForPreviewLaunch({ target, signal: new AbortController().signal, current: () => true, pending: () => progress++, wait: async () => {},
    request: async body => { calls.push(body); return calls.length < 3 ? { warming: { id, status: "pending", retryAfterMs: 1000 } } : { url: "https://relay.example/app-preview/open?launch=ready" }; } });
  assert.equal(progress, 2); assert.equal(result, "https://relay.example/app-preview/open?launch=ready");
  assert.deepEqual(calls, [target, { ...target, warmingId: id }, { ...target, warmingId: id }]);
});

test("warming cancellation/stale identity stop polling; malformed status never becomes a launch", async () => {
  const id = "warm_11111111-2222-4333-8444-555555555555", target = { port: 8081, path: "/" };
  for (const stale of [false, true]) {
    const controller = new AbortController(); let calls = 0, current = true;
    await assert.rejects(waitForPreviewLaunch({ target, signal: controller.signal, current: () => current, pending: () => {},
      request: async () => { calls++; return { warming: { id, status: "pending", retryAfterMs: 1000 } }; },
      wait: async () => { if (stale) current = false; else controller.abort(); } }));
    assert.equal(calls, 1);
  }
  for (const warming of [{ id, status: "ready", retryAfterMs: 1000 }, { id: "private malformed", status: "pending", retryAfterMs: 1000 }, { id, status: "pending", retryAfterMs: 0 }]) {
    await assert.rejects(waitForPreviewLaunch({ target, signal: new AbortController().signal, current: () => true, pending: () => {}, request: async () => ({ warming }) }));
  }
});

test("individual warming requests have their own short timeout", async () => {
  await assert.rejects(waitForPreviewLaunch({ target: { port: 3000, path: "/" }, signal: new AbortController().signal, current: () => true, pending: () => {}, requestTimeoutMs: 10,
    request: async (_body, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })) }));
});

test("only HTTP worker loopback seeds a remote app target", () => {
  assert.deepEqual(previewAddress("http://127.0.0.1:8081/app?q=yes#anchor"), { port: 8081, path: "/app?q=yes#anchor" });
  assert.deepEqual(previewAddress("http://[::1]:65535/"), { port: 65535, path: "/" });
  for (const url of ["https://localhost:3000/", "http://localhost/", "http://user@localhost:3000/", "http://evil.test:3000/", "file:///tmp/a"]) assert.equal(previewAddress(url), null);
});

test("status is bound to selected port and safe ready hostname; unready never carries a link", () => {
  const value = { id: "fixture", status: "ready", port: 8081, hostname: "d123.cloudfront.net", retryable: false, canRevoke: true };
  assert.equal(previewState({ preview: value }, 8081, "https://relay.example").hostname, value.hostname);
  for (const hostname of ["relay.example", "localhost", "example.local", "127.0.0.1", "0x7f.1", "evil.test/path", "evil.test\n"]) assert.throws(() => previewState({ preview: { ...value, hostname } }, 8081, "https://relay.example"));
  for (const patch of [{ port: 3000 }, { status: "authenticated" }, { id: "" }, { canRevoke: 1 }, { retryable: undefined }]) assert.throws(() => previewState({ preview: { ...value, ...patch } }, 8081, "https://relay.example"));
  for (const status of ["none", "pending", "revoking", "deleted", "error", "unavailable"]) assert.equal(previewState({ preview: { ...value, status } }, 8081, "https://relay.example").hostname, null);
});

test("launch accepts only the trusted Relay launch document with one opaque intent", () => {
  const origin = "https://relay.example", good = origin + "/app-preview/open?launch=opaque_123-abc";
  assert.equal(previewOpenUrl(good, origin), good);
  assert.equal(previewOpenUrl("http://localhost:8787/app-preview/open?launch=local", "http://localhost:8787"), "http://localhost:8787/app-preview/open?launch=local");
  for (const url of ["https://preview.cloudfront.net/app-preview/open?launch=a", "https://relay.example.evil.test/app-preview/open?launch=a", "http://relay.example/app-preview/open?launch=a", "https://relay.example:444/app-preview/open?launch=a", "https://user@relay.example/app-preview/open?launch=a", origin + "/wrong?launch=a", origin + "/app-preview/open?launch=", good + "&launch=b", good + "&redirect=https://evil.test", good + "#state", origin + "/app-preview/open?launch=a%0A", origin + "/app-preview/open?launch=" + "a".repeat(257)]) assert.throws(() => previewOpenUrl(url, origin));
});
