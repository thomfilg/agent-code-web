import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { DEFAULT_SYNTAX_THEME, SYNTAX_THEMES, SYNTAX_MODES, validateSyntaxTheme, syntaxLanguage, syntaxTokens, syntaxStyle, canHighlight } from "../public/syntax-theme.js";
import { SyntaxThemePreferences } from "../src/syntax-theme.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { webCommands } from "../public/web-commands.js";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("syntax themes and language/asset names are allowlisted and never sent as agent input", () => {
  for (const theme of SYNTAX_THEMES) assert.equal(validateSyntaxTheme(theme.id), theme.id);
  for (const value of [undefined, null, [], {}, "constructor", "__proto__", "url(https://other.invalid)"]) assert.throws(() => validateSyntaxTheme(value), { statusCode: 400 });
  for (const value of [null, {}, "__proto__", "../../auth", "https://other.invalid"]) assert.equal(syntaxLanguage(value), null);
  assert.equal(syntaxLanguage("JS").mode, "text/javascript");
  assert.equal(syntaxStyle("keyword injected onclick=alert(1)"), "syntax-keyword");
  for (const agent of ["codex", "claude", "mock"]) {
    assert(webCommands(agent).some(item => item.name === "theme"));
    for (const text of ["/theme", "/theme paper-light"]) assert.throws(() => messageCommand(agent, text), /web composer/);
  }
});

test("the pinned tokenizer supports every advertised grammar and retains exact tabs, CRLF and literal markup", async () => {
  const context = vm.createContext({});
  vm.runInContext(await readFile(new URL("../node_modules/codemirror/addon/runmode/runmode-standalone.js", import.meta.url), "utf8"), context);
  vm.runInContext(await readFile(new URL("../node_modules/codemirror/addon/mode/simple.js", import.meta.url), "utf8"), context);
  for (const name of SYNTAX_MODES) vm.runInContext(await readFile(new URL(`../node_modules/codemirror/mode/${name}/${name}.js`, import.meta.url), "utf8"), context);
  for (const name of "js ts jsx tsx json html xml css scss less py sh sql yml toml diff go rust rb c cpp java cs kt md".split(" ")) {
    const { mode } = syntaxLanguage(name); assert.notEqual(context.CodeMirror.getMode({}, mode).name, "null", name);
    assert(Array.isArray(syntaxTokens(context.CodeMirror, "const a = 2;\n# fixture\n<tag />", mode)), name);
  }
  const source = '// literal\r\nconst value = "<img src=x onerror=alert(1)>😀";\r\n\treturn value + 42;\n';
  const tokens = syntaxTokens(context.CodeMirror, source, "text/javascript");
  assert(tokens.some(([, , style]) => style === "syntax-keyword")); assert(tokens.some(([, , style]) => style === "syntax-string"));
  let offset = 0, rebuilt = "";
  for (const [start, end] of tokens) { assert(start >= offset); rebuilt += source.slice(offset, start) + source.slice(start, end); offset = end; }
  rebuilt += source.slice(offset); assert.equal(rebuilt, source);
  assert.equal(canHighlight("x".repeat(4001)), false); assert.equal(canHighlight("x\n".repeat(40001)), false);
  assert.equal(syntaxTokens(context.CodeMirror, "x".repeat(80001), "text/javascript"), null);
  assert.throws(() => syntaxTokens(context.CodeMirror, "const a=1;\n".repeat(7000), "text/javascript"), /token limit/);
});

test("syntax preferences persist by account with independent storage, revision checks and revocation guards", async () => {
  const records = new MemoryRecords(), settings = new SyntaxThemePreferences(records);
  const initial = await settings.get("first"); assert.equal(initial.theme, DEFAULT_SYNTAX_THEME);
  const input = { ...initial, theme: "paper-light" };
  const results = await Promise.allSettled([settings.save("first", input), settings.save("first", input)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.statusCode, 409);
  assert.equal((await new SyntaxThemePreferences(records).get("first")).theme, "paper-light");
  assert.equal((await settings.get("second")).theme, DEFAULT_SYNTAX_THEME);
  await assert.rejects(settings.save("second", input), /account changed/);
  await assert.rejects(settings.save("first", { ...input, revision: 1 }, async () => { throw Error("Revoked"); }), /Revoked/);
  assert.equal((await settings.get("first")).revision, 1);
  for (const kind of ["statusline", "tab-title", "keymap"]) assert.equal(await records.get(kind, "first"), null);
});

test("theme HTTP settings enforce auth, origin, account and schema without worker or native configuration access", async t => {
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "theme-fixture" }), records: new MemoryRecords(), adapterFactory: () => { throw Error("Theme must not start a worker"); } });
  const { url } = await app.start(); t.after(() => app.stop());
  const call = (route, { cookie, body, method, origin } = {}) => fetch(`${url}${route}`, { method: method || (body ? "POST" : "GET"), headers: { authorization: "Bearer theme-fixture", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(`${url}/api/syntax-theme`)).status, 401);
  const shared = await (await call("/api/syntax-theme")).json(); assert.equal(shared.scope, "shared");
  assert.equal((await call("/api/syntax-theme", { method: "PATCH", origin: "https://other.invalid", body: { ...shared, theme: "plain" } })).status, 403);
  const register = async username => { const response = await call("/api/browser-account/register", { body: { username, password: "private-syntax-theme-fixture-password" } }); assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0]; };
  const first = await register("first-theme-user"), second = await register("second-theme-user");
  const initial = await (await call("/api/syntax-theme", { cookie: first })).json(), update = { ...initial, theme: "high-contrast" };
  assert.equal((await call("/api/syntax-theme", { cookie: first, method: "PATCH", body: update })).status, 200);
  assert.equal((await call("/api/syntax-theme", { cookie: second, method: "PATCH", body: update })).status, 409);
  assert.equal((await call("/api/syntax-theme", { cookie: first, method: "PATCH", body: { ...update, revision: 1, theme: "<script>" } })).status, 400);
  assert.equal((await (await call("/api/syntax-theme", { cookie: second })).json()).theme, DEFAULT_SYNTAX_THEME);
  assert.equal((await (await call("/api/syntax-theme")).json()).theme, DEFAULT_SYNTAX_THEME);
  await call("/api/browser-account", { cookie: first, method: "DELETE" });
  assert.equal((await call("/api/syntax-theme", { cookie: first, method: "PATCH", body: { ...update, revision: 1 } })).status, 409);
  for (const asset of ["runmode", "simple", ...SYNTAX_MODES]) { const response = await fetch(`${url}/vendor/syntax-${asset}.js`); assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /javascript/); }
  assert.equal((await fetch(`${url}/vendor/syntax-secret.js`)).status, 404);
  assert.equal(app.store.list().length, 0);
});
