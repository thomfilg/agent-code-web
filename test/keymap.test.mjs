import test from "node:test";
import assert from "node:assert/strict";
import { KEY_ACTIONS, normalizeBinding, validateBindings, eventBinding, boundAction } from "../public/key-bindings.js";
import { KeymapPreferences } from "../src/keymap.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { MessageHistory } from "../public/message-history.js";
import { messageCommand } from "../src/message-command.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("web shortcuts normalize alternative modifiers/keys and protect text editing and browser controls", () => {
  assert.equal(normalizeBinding(" Shift-Meta-Enter "), "meta-shift-enter"); assert.equal(normalizeBinding("alt-arrowup"), "alt-up");
  assert.equal(eventBinding({ key: "K", metaKey: true, shiftKey: true }), "meta-shift-k"); assert.equal(eventBinding({ key: "?", altKey: true, shiftKey: true }), "alt-shift-slash");
  for (const input of ["ctrl-c", "meta-v", "meta-shift-r", "ctrl-l", "alt-left", "escape", "tab", "f5", "ctrl-ctrl-k", "k", "shift-k", "ctrl-k ctrl-n", {}, "a".repeat(65)]) assert.throws(() => normalizeBinding(input));
  for (const event of [{ key: "Enter", isComposing: true }, { key: "Enter", keyCode: 229 }, { key: "Enter", getModifierState: key => key === "AltGraph" }, { key: "Dead" }]) assert.equal(eventBinding(event), null);
});

test("keymap keeps defaults, permits unbinding/restoration and composer precedence while rejecting same-context collisions", () => {
  const bindings = validateBindings({ composer: { send: ["ctrl-enter"], history_previous: ["ctrl-k"], history_next: [] } });
  assert.equal(boundAction(bindings, { key: "Enter", ctrlKey: true }, "composer"), "send"); assert.equal(boundAction(bindings, { key: "Enter" }, "composer"), null);
  assert.equal(boundAction(bindings, { key: "k", ctrlKey: true }, "composer"), "history_previous"); assert.equal(boundAction(bindings, { key: "k", ctrlKey: true }, "global"), "new_chat");
  assert.equal(boundAction(bindings, { key: "ArrowDown" }, "composer"), null); assert.equal(boundAction({}, { key: "ArrowDown" }, "composer"), "history_next");
  for (const bad of [{ composer: { send: ["shift-enter"] } }, { global: { focus_composer: ["ctrl-k"] } }, { composer: { send: ["ctrl-enter", "CTRL-enter"] } }, { global: { new_chat: ["shift-enter"] } }, { composer: { unknown: [] } }, { terminal: {} }, [], JSON.parse('{"global":{"__proto__":[]}}')]) assert.throws(() => validateBindings(bad));
  assert.equal(KEY_ACTIONS.length, 7);
  for (const agent of ["codex", "claude", "mock"]) assert.throws(() => messageCommand(agent, "/keymap arbitrary"), /web control/);
});

test("remapped history retains boundary behavior, edited history and restoration of the unsent draft", () => {
  const input = { value: "Draft", selectionStart: 0, selectionEnd: 0, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const history = new MessageHistory({ input, state: { active: { messages: [{ role: "user", text: "First" }, { role: "user", text: "Second" }] } }, onChange() {} });
  history.select("chat"); input.value = "Draft"; let prevented = false;
  const event = { key: "p", altKey: true, preventDefault() { prevented = true; } };
  assert.equal(history.keydown(event, "history_previous"), true); assert.equal(input.value, "Second"); assert.equal(prevented, true);
  input.value = "Edited second"; input.setSelectionRange(3, 3); prevented = false;
  assert.equal(history.keydown(event, "history_previous"), false); assert.equal(prevented, false);
  input.setSelectionRange(input.value.length, input.value.length); assert.equal(history.keydown(event, "history_next"), true); assert.equal(input.value, "Draft");
});

test("keymap records stay account-scoped, persist across service reload and reject stale concurrent saves", async () => {
  const records = new MemoryRecords(), keymaps = new KeymapPreferences(records), bindings = { composer: { send: ["ctrl-enter"] } };
  assert.deepEqual(await keymaps.get("first"), { scope: "first", revision: 0, bindings: {} });
  const input = { scope: "first", revision: 0, bindings }, results = await Promise.allSettled([keymaps.save("first", input), keymaps.save("first", input)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(results.find(result => result.status === "rejected").reason.statusCode, 409);
  assert.deepEqual((await new KeymapPreferences(records).get("first")).bindings, bindings); assert.deepEqual((await keymaps.get("second")).bindings, {});
  await assert.rejects(keymaps.save("second", input), /account changed/); await assert.rejects(keymaps.save("first", { ...input, revision: 1 }, async () => { throw new Error("Session revoked"); }), /revoked/);
  assert.equal((await keymaps.get("first")).revision, 1); assert.deepEqual((await keymaps.save("first", { scope: "first", revision: 1, bindings: {} })).bindings, {});
});

test("keymap HTTP persistence enforces authentication, origin, account scope and no worker/model actions", async t => {
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "keymap-fixture" }), adapterFactory: () => { throw new Error("Keymap must never start a worker"); } });
  const { url } = await app.start(); t.after(() => app.stop());
  const call = (pathname, { cookie, body, method, origin } = {}) => fetch(`${url}${pathname}`, { method: method || (body ? "POST" : "GET"), headers: { authorization: "Bearer keymap-fixture", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(`${url}/api/keymap`)).status, 401);
  const shared = await (await call("/api/keymap")).json(); assert.equal(shared.scope, "shared");
  assert.equal((await call("/api/keymap", { method: "PATCH", origin: "https://other.invalid", body: { ...shared, bindings: {} } })).status, 403);
  const register = async username => { const response = await call("/api/browser-account/register", { body: { username, password: "private-keymap-fixture-password" } }); assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0]; };
  const first = await register("first-user"), second = await register("second-user");
  const current = await (await call("/api/keymap", { cookie: first })).json(); assert.notEqual(current.scope, "shared");
  const input = { ...current, bindings: { global: { new_chat: ["alt-k"] } } };
  assert.equal((await call("/api/keymap", { cookie: first, method: "PATCH", body: input })).status, 200);
  assert.equal((await call("/api/keymap", { cookie: second, method: "PATCH", body: input })).status, 409);
  assert.deepEqual((await (await call("/api/keymap", { cookie: second })).json()).bindings, {}); assert.deepEqual((await (await call("/api/keymap")).json()).bindings, {});
  await call("/api/browser-account", { cookie: first, method: "DELETE" });
  assert.equal((await call("/api/keymap", { cookie: first, method: "PATCH", body: { ...input, revision: 1 } })).status, 409);
  assert.equal(app.store.list().length, 0);
});
