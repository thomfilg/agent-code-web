import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, rm, lstat, readdir } from "node:fs/promises";
import { parseLoginOptions, parseLoginToolResult, smokeDeployedLogin, loginViewports } from "../scripts/smoke-deployed-login.mjs";

const host = "d20atclccf8cku.cloudfront.net";
const result = value => ({ content: [{ type: "text", text: `### Result\n${JSON.stringify(value)}\n### Ran Playwright code\nPRIVATE CODE\n### Page\nPRIVATE OAUTH URL` }] });
async function fixture(t, { legacy = false, googleText = "Error 400: redirect_uri_mismatch", email = false, failAt, malformed = false, cleanupFail = false, wrongEntry = false, entryHost = host, closeEvent = true, closeDelay = 0 } = {}) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "deployed-login-test-")); t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const calls = [], closed = [], files = [], network = [], clicks = []; let config, width, height, currentHost = entryHost;
  const page = {
    locator: selector => { assert.equal(selector, "#google-sign-in"); return { waitFor: async () => {}, isVisible: async () => true, isEnabled: async () => true, click: async () => { clicks.push(selector); currentHost = "accounts.google.com"; } }; },
    waitForFunction: async () => {}, waitForURL: async check => { assert.equal(check(new URL("https://accounts.google.com/PRIVATE?state=PRIVATE")), true); },
    url: () => `https://${currentHost}/PRIVATE?state=PRIVATE`,
    screenshot: async ({ path: filename }) => { assert.ok(path.isAbsolute(filename)); assert.equal(currentHost, host); files.push(filename); await writeFile(filename, "fixture-png"); },
    evaluate: async callback => vm.runInNewContext(`(${callback})()`, {
      innerWidth: width, innerHeight: height, AbortSignal, location: { origin: `https://${currentHost}` },
      getComputedStyle: () => ({ visibility: "visible" }),
      document: { documentElement: { scrollWidth: width }, body: { scrollWidth: width, innerText: googleText }, querySelector: selector => {
        assert.equal(selector, "input[type=email]"); return email ? { getBoundingClientRect: () => ({ width: 100, height: 40 }) } : null;
      } },
      fetch: async (url, options) => { network.push(url); assert.equal(url, `https://${host}/api/chats`); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); return { status: wrongEntry ? 200 : 401, body: { cancel: async () => {} } }; },
    }),
  };
  const client = { connect: async () => { if (failAt === "connect") throw Error("PRIVATE CONNECT"); },
    listTools: async () => ({ tools: [legacy ? "browser_run_code" : "browser_run_code_unsafe", "browser_resize", "browser_navigate", "browser_close"].map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      if (name === "browser_close") { closed.push("browser"); if (cleanupFail) throw Error("PRIVATE CLOSE"); return { content: [] }; }
      if (failAt === name) return { isError: true, content: [{ type: "text", text: "PRIVATE URL TOKEN SNAPSHOT" }] };
      if (name === "browser_resize") { width = args.width; height = args.height; }
      if (name === "browser_navigate") assert.equal(args.url, `https://${host}/`);
      if (name.startsWith("browser_run_code")) {
        // Execute the complete emitted tool source with precisely the unsafe
        // tool's limited VM globals. In particular global URL is not supplied.
        const value = await vm.runInNewContext(`(${args.code})(page)`, { page });
        return malformed ? result({ ...value, privateSecret: "PRIVATE" }) : result(value);
      }
      return { content: [] };
    }, close: async () => { closed.push("client"); if (cleanupFail) throw Error("PRIVATE CLIENT CLOSE"); } };
  const transport = { close: async () => { closed.push("transport"); if (closeEvent) { if (closeDelay) setTimeout(() => transport.onclose?.(), closeDelay); else transport.onclose?.(); } } };
  return { outputRoot, clientFactory: () => client, transportFactory: value => { config = value; return transport; }, calls, closed, files, network, clicks, get config() { return config; } };
}
test("default performs no IO/network/browser creation and flags never admit profiles, cookies or arbitrary origins", async () => {
  const receipt = await smokeDeployedLogin(parseLoginOptions([]), { clientFactory: () => assert.fail(), transportFactory: () => assert.fail() });
  assert.equal(receipt.dryRun, true); assert.equal(receipt.deploymentIdentityVerified, false); assert.equal(receipt.authenticatedAccessVerified, false);
  assert.deepEqual(parseLoginOptions(["--run", "--check-google-redirect"]), { run: true, checkGoogleRedirect: true });
  for (const args of [["--check-google-redirect"], ["--run", "--run"], ["--origin", "https://private"], ["--cookie-file", "/private"], ["--profile", "/private"]]) assert.throws(() => parseLoginOptions(args));
  await assert.rejects(smokeDeployedLogin({ checkGoogleRedirect: true }));
});
test("full official unsafe-tool VM sequence checks all viewports, private screenshots and anonymous denial without initiation", async t => {
  const f = await fixture(t), receipt = await smokeDeployedLogin({ run: true }, f);
  assert.deepEqual(receipt.entries.map(({ width, height }) => [width, height]), loginViewports);
  assert.ok(receipt.entries.every(entry => entry.anonymousChatsStatus === 401 && entry.noHorizontalOverflow));
  assert.equal(receipt.google, null); assert.deepEqual(f.closed, ["browser", "client", "transport"]);
  assert.ok(Object.values(receipt.cleanup).every(Boolean)); assert.equal(f.files.length, 3);
  const directory = path.dirname(receipt.screenshotsDirectory);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700); assert.deepEqual(await readdir(directory), ["screenshots"]);
  for (const file of f.files) assert.equal((await lstat(file)).mode & 0o777, 0o600);
  for (const flag of ["--headless", "--isolated", "--snapshot-mode", "--image-responses"]) assert.ok(f.config.args.includes(flag));
  assert.equal(f.config.env.HOME, path.join(directory, "home")); assert.equal(f.config.stderr, "pipe");
  assert.ok(f.calls.filter(call => call.name.startsWith("browser_run_code")).every(call => !call.args.code.includes(".click(")));
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|state=|accounts\.google/);
});
test("legacy tool fallback and optional Google initiation report mismatch without URLs, page text or login-success claims", async t => {
  const f = await fixture(t, { legacy: true }), receipt = await smokeDeployedLogin({ run: true, checkGoogleRedirect: true }, f);
  assert.deepEqual(receipt.google, { hostname: "accounts.google.com", redirectUriMismatch: true, googleError400: true, visibleEmailField: false, providerReached: true, loginVerified: false });
  assert.equal(f.files.length, 3); assert.equal(f.calls.filter(call => call.name === "browser_run_code").length, 4);
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|state=|redirect_uri_mismatch|Error 400/);
  const code = f.calls.at(-2).args.code; assert.ok(code.includes(".split('/')[2]")); assert.doesNotMatch(code, /\.fill\(|\.type\(|new URL\(/);
});
test("Google email entry is distinct from authenticated success and never gets filled", async t => {
  const f = await fixture(t, { googleText: "Sign in", email: true }), receipt = await smokeDeployedLogin({ run: true, checkGoogleRedirect: true }, f);
  assert.equal(receipt.google.visibleEmailField, true); assert.equal(receipt.google.redirectUriMismatch, false); assert.equal(receipt.google.loginVerified, false);
});
test("unexpected initial entry origin fails before fetching, screenshotting or clicking", async t => {
  for (const entryHost of ["foreign.invalid", `${host}.foreign.invalid`, `${host}:444`]) {
    const f = await fixture(t, { entryHost });
    await assert.rejects(smokeDeployedLogin({ run: true, checkGoogleRedirect: true }, f), { phase: "entry-1600" });
    assert.deepEqual(f.network, []); assert.deepEqual(f.files, []); assert.deepEqual(f.clicks, []);
    assert.deepEqual(f.closed, ["browser", "client", "transport"]);
  }
});
test("malformed/MCP-private data cannot escape or produce false receipts, and all failures close exact resources", async t => {
  for (const mode of [{ failAt: "connect" }, { failAt: "browser_run_code_unsafe" }, { malformed: true }, { wrongEntry: true }]) {
    const f = await fixture(t, mode);
    await assert.rejects(smokeDeployedLogin({ run: true }, f), error => {
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE|state=|TOKEN/); assert.ok(error.cleanup.transportClosed); return true;
    }); assert.deepEqual(f.closed, ["browser", "client", "transport"]);
  }
  for (const value of [{ isError: true, content: [{ type: "text", text: "PRIVATE" }] }, { content: [] }, result("PRIVATE"), result(["PRIVATE"]),
    { content: [{ type: "text", text: "### Result\n{\"a\":1}\n### Result\n{\"a\":2}" }] }, { content: [{ type: "text", text: "### Result\n" + "A".repeat(131073) }] }]) {
    assert.throws(() => parseLoginToolResult(value), error => !/PRIVATE/.test(error.message + JSON.stringify(error)));
  }
});
test("cleanup failure remains explicit and cannot conceal primary failure", async t => {
  for (const failAt of [undefined, "browser_navigate"]) {
    const f = await fixture(t, { cleanupFail: true, failAt });
    await assert.rejects(smokeDeployedLogin({ run: true }, f), error => {
      assert.equal(error.category, failAt ? "failed" : "cleanup-unconfirmed"); assert.equal(error.phase, failAt ? "entry-1600" : "cleanup");
      assert.equal(error.cleanup.browserClosed, false); assert.equal(error.cleanup.clientClosed, false); assert.equal(error.cleanup.transportClosed, true); return true;
    }); assert.deepEqual(f.closed, ["browser", "client", "transport"]);
  }
});
test("already cancelled does not create resources, active stalled MCP is bounded and all cleanup attempted", async t => {
  await assert.rejects(smokeDeployedLogin({ run: true }, { signal: AbortSignal.abort(), clientFactory: () => assert.fail() }), { category: "cancelled-or-deadline" });
  const f = await fixture(t), client = f.clientFactory(), original = client.callTool;
  client.callTool = (value, ...rest) => value.name === "browser_resize" ? new Promise(() => {}) : original(value, ...rest);
  await assert.rejects(smokeDeployedLogin({ run: true }, { ...f, callTimeoutMs: 10 }), { category: "cancelled-or-deadline" });
  assert.deepEqual(f.closed, ["browser", "client", "transport"]);
});
test("resolved transport close is insufficient without observed child close; delayed close is awaited", async t => {
  const f = await fixture(t, { closeEvent: false });
  await assert.rejects(smokeDeployedLogin({ run: true }, { ...f, cleanupTimeoutMs: 10 }), error => {
    assert.equal(error.category, "cleanup-unconfirmed"); assert.equal(error.cleanup.transportClosed, false);
    assert.equal(error.cleanup.privateTransientFilesRemoved, false); return true;
  });
  const [directory] = await readdir(f.outputRoot); assert.deepEqual((await readdir(path.join(f.outputRoot, directory))).sort(), ["home", "mcp", "screenshots"]);
  const delayed = await fixture(t, { closeDelay: 10 }), receipt = await smokeDeployedLogin({ run: true }, { ...delayed, cleanupTimeoutMs: 100 });
  assert.equal(receipt.cleanup.transportClosed, true); assert.equal(receipt.cleanup.privateTransientFilesRemoved, true);
});
