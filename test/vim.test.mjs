import test from "node:test";
import assert from "node:assert/strict";
import { createAgentWebServer } from "../src/server.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { webCommands } from "../public/web-commands.js";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("Vim is a real web control for all providers and never becomes model input", () => {
  for (const agent of ["codex", "claude", "mock"]) {
    assert(webCommands(agent).some(command => command.name === "vim"));
    for (const command of ["/vim", "/vim on", "/vim off", "/vim invalid"]) assert.throws(() => messageCommand(agent, command), /web composer/);
  }
});

test("the pinned Vim library and styles are served locally through exact allowlisted paths with no worker", async t => {
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root), adapterFactory: () => { throw new Error("Vim assets must not start a worker"); } });
  const { url } = await app.start(); t.after(() => app.stop());
  for (const file of ["codemirror.js", "codemirror.css", "codemirror-dialog.css", "codemirror-dialog.js", "codemirror-searchcursor.js", "codemirror-matchbrackets.js", "codemirror-vim.js"]) {
    const response = await fetch(`${url}/vendor/${file}`); assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), file.endsWith(".css") ? /text\/css/ : /text\/javascript/); assert((await response.text()).length > 100);
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  }
  assert.equal((await fetch(`${url}/vendor/package.json`)).status, 404); assert.equal(app.store.list().length, 0);
});
