import assert from "node:assert/strict";
import test from "node:test";
import { directBrowserLink } from "../public/browser-links.js";
const input = { chatId: `chat_${"a".repeat(32)}`, backend: "local", relayOrigin: "http://127.0.0.1:8787", address: "http://localhost:3000/future-drink/menu?tab=beer#cart" };

test("direct links preserve app port, path, query and fragment, with a chat-specific local origin", () => {
  assert.equal(directBrowserLink(input).url, `http://${input.chatId}.localhost:3000/future-drink/menu?tab=beer#cart`);
  assert.notEqual(directBrowserLink(input).url, directBrowserLink({ ...input, chatId: `chat_${"b".repeat(32)}` }).url);
});
test("local aliases are never advertised as remote-worker forwarding", () => {
  assert.equal(directBrowserLink({ ...input, backend: "ec2" }).url, undefined);
  assert.equal(directBrowserLink({ ...input, relayOrigin: "https://relay.example.com" }).url, undefined);
});
test("public sites and personal Chrome retain their real URLs, unsafe schemes and credentials are rejected", () => {
  assert.equal(directBrowserLink({ ...input, address: "https://example.com/path" }).url, "https://example.com/path");
  assert.equal(directBrowserLink({ ...input, mode: "personal", backend: "ec2" }).url, input.address);
  assert.equal(directBrowserLink({ ...input, address: "https://localhost:3000/path" }).url, "https://localhost:3000/path");
  for (const address of ["javascript:alert(1)", "file:///etc/passwd", "http://user:password@localhost:3000/"]) assert.equal(directBrowserLink({ ...input, address }).url, undefined);
});
