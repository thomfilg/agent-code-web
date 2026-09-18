import test from "node:test";
import assert from "node:assert/strict";
import { previewTarget, previewAddress, previewState, previewOpenUrl } from "../public/app-preview.js";

test("preview targets preserve arbitrary allowed port and local path/query/hash", () => {
  for (const port of [1024, 8081, 65535]) assert.deepEqual(previewTarget(String(port), "/app?a=1#tab"), { port, path: "/app?a=1#tab" });
  assert.deepEqual(previewTarget(3000, "/a/../hello world"), { port: 3000, path: "/hello%20world" });
  for (const port of [0, 80, 1023, 65536, "3000\n", "3e3", " 3000", "3000.0", "3000/", null]) assert.throws(() => previewTarget(port));
  assert.equal(previewTarget(3000, "/" + "a".repeat(4095)).path.length, 4096);
  for (const path of ["", "https://evil.test/", "//evil.test/", "/\\evil", "/\nfoo", "/\x7f", "/__relay_preview/bootstrap", "/other/../__relay_preview/probe", "/%00bad", "/%5Cbad", "/%7f", "/" + "a".repeat(4096), "/" + "é".repeat(1000)]) assert.throws(() => previewTarget(3000, path));
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
