import { test, expect } from "@playwright/test";

const created = new WeakMap();
const source = 'const label = "<img src=x onerror=window.themeInjected=true>😀";\n\treturn label + 42;';
const fenced = (language, text) => `\`\`\`${language}\n${text}\n\`\`\``;
const messages = [{ id: "theme-answer", role: "assistant", text: [fenced("js", source), fenced("json", '{"answer": 42}'), fenced("html", '<b onclick="window.themeInjected=true">Literal</b>')].join("\n\n") }];
test.afterEach(async ({ page }) => { for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page, { busy = false, theme = "relay-dark", contents = messages } = {}) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: `Theme fixture ${Date.now()}` } })).json(); created.set(page, [chat.id]);
  let saved = { scope: "shared", revision: 0, theme, account: null };
  const calls = { actions: [], saves: [], errors: [] }; page.on("pageerror", error => calls.errors.push(error.message));
  const snapshot = { ...chat, revision: 99999, agent: "codex", status: busy ? "running" : "stopped", messages: contents };
  await page.route(`**/api/chats/${chat.id}`, route => { if (route.request().method() !== "GET") calls.actions.push("chat mutation"); return route.fulfill({ json: { chat: snapshot } }); });
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route("**/api/syntax-theme", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: saved });
    const input = route.request().postDataJSON(); calls.saves.push(input);
    if (input.scope !== saved.scope || input.revision !== saved.revision) return route.fulfill({ status: 409, json: { error: "Syntax-theme settings changed in another tab. Reload before saving." } });
    saved = { ...saved, theme: input.theme, revision: saved.revision + 1 }; return route.fulfill({ json: saved });
  });
  for (const tail of ["messages", "queue", "wake", "stop", "compact"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { calls.actions.push(tail); return route.fulfill({ json: {} }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, snapshot, calls, get saved() { return saved; }, set saved(value) { saved = value; } };
}
const close = page => page.locator("#controls-dialog").evaluate(dialog => dialog.close());
const block = page => page.locator('#messages code.language-js');
const color = locator => locator.evaluate(element => getComputedStyle(element).color);
async function open(page, busy) {
  if (busy !== undefined) { await page.locator("#message-input").fill("/theme"); await page.getByRole("button", { name: busy ? "Queue" : "Send message", exact: true }).click(); }
  else { await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#syntax-theme-button").click(); }
  await expect(page.locator("#controls-title")).toHaveText("Syntax theme"); await expect(page.locator("#controls-content [role=status]")).toContainText("Saved syntax theme loaded");
}
async function save(page) { await page.getByRole("button", { name: "Save syntax theme", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("saved and active"); }

test("real code highlighting keeps literal source/copy and previews isolated, with no Vim runtime or execution", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]); const f = await setup(page);
  for (const language of ["js", "json", "html"]) await expect(page.locator(`#messages code.language-${language}`)).toHaveAttribute("data-highlight", "ready");
  expect(await block(page).textContent()).toBe(`${source}\n`);
  expect(await color(block(page).locator(".syntax-keyword").first())).not.toBe(await color(block(page).locator(".syntax-string").first()));
  expect(await page.evaluate(() => Boolean(window.CodeMirror || window.themeInjected))).toBe(false);
  await expect(page.locator("#messages pre img")).toHaveCount(0);
  await page.locator("#messages .code-toolbar").first().getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${source}\n`);
  await page.getByRole("button", { name: "Open HTML preview ↗", exact: true }).click();
  await expect(page.locator("#preview-content iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page.frameLocator("#preview-content iframe").locator("b")).toHaveText("Literal");
  expect(await page.evaluate(() => Boolean(window.themeInjected))).toBe(false); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("themes preview without applying, save actual code/diff colors and persist while retaining the draft and files", async ({ page }) => {
  const f = await setup(page); await expect(block(page)).toHaveAttribute("data-highlight", "ready");
  const original = await color(block(page).locator(".syntax-keyword").first());
  await page.locator("#message-input").fill("Keep this draft"); await page.locator("#attachment-input").setInputFiles({ name: "theme.txt", mimeType: "text/plain", buffer: Buffer.from("Keep file") });
  await open(page); await expect(page.locator("#controls-content")).toContainText("shared by this Relay installation");
  await expect(page.locator(".theme-preview .syntax-code")).toHaveAttribute("data-highlight", "ready");
  const previewKeyword = page.locator(".theme-preview .syntax-keyword").first();
  const expected = { "Paper light": "paper-light", "High contrast": "high-contrast", Plain: "plain", "Relay dark": "relay-dark" };
  for (const [label, id] of Object.entries(expected)) {
    await page.getByRole("radio", { name: label, exact: true }).check();
    await expect(page.locator(".theme-preview")).toHaveAttribute("data-syntax-theme", id);
    expect(await color(block(page).locator(".syntax-keyword").first())).toBe(original);
    if (id === "plain") expect(await color(previewKeyword)).toBe(await color(page.locator(".theme-preview .syntax-code")));
  }
  await page.getByRole("radio", { name: "Paper light", exact: true }).check();
  const previewColor = await color(previewKeyword); expect(previewColor).not.toBe(original);
  await page.screenshot({ path: "test-results/syntax-theme-desktop.png" }); await save(page); await close(page);
  expect(await color(block(page).locator(".syntax-keyword").first())).toBe(previewColor);
  await expect(page.locator("#message-input")).toHaveValue("Keep this draft"); await expect(page.locator("#attachment-chips")).toContainText("theme.txt");
  await page.route(`**/api/chats/${f.chat.id}/changes`, route => route.fulfill({ json: { source: "Fixture", files: [{ filename: "example.js", patch: "@@ -1 +1 @@\n-old\n+new" }] } }));
  await page.getByRole("button", { name: "View changes", exact: true }).click(); await expect(page.locator("#diff-files .diff-line.added")).toHaveCSS("color", "rgb(17, 99, 41)");
  await expect(page.locator("#diff-files .diff-line.added .line-number")).toHaveCSS("color", "rgb(87, 96, 106)");
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "paper-light"); await expect(block(page)).toHaveAttribute("data-highlight", "ready");
  expect(await color(block(page).locator(".syntax-keyword").first())).toBe(previewColor); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("busy slash theme, cancel, plain and restore defaults never send/queue a prompt or stop work", async ({ page }) => {
  const f = await setup(page, { busy: true }); await open(page, true); await expect(page.locator("#message-input")).toHaveValue("");
  await page.getByRole("radio", { name: "Paper light", exact: true }).check(); await close(page); await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "relay-dark");
  await open(page); await page.getByRole("radio", { name: "Plain", exact: true }).check(); await save(page); await close(page); await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "plain"); await expect(block(page)).toHaveAttribute("data-highlight", "plain");
  await open(page); await page.getByRole("button", { name: "Restore default", exact: true }).click(); await save(page); await close(page);
  await expect(block(page)).toHaveAttribute("data-highlight", "ready"); await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "relay-dark");
  await page.locator("#message-input").fill("/theme paper-light"); await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator("#toasts")).toContainText("Use /theme without arguments"); await expect(page.locator("#message-input")).toHaveValue("/theme paper-light");
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("mobile picker preserves a stale-save choice and keeps close/save/errors visible", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page); await open(page);
  await page.getByRole("radio", { name: "High contrast", exact: true }).check(); f.saved = { ...f.saved, revision: 1 };
  await page.getByRole("button", { name: "Save syntax theme", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("another tab");
  await expect(page.getByRole("radio", { name: "High contrast", exact: true })).toBeChecked();
  await expect(page.getByLabel("Close controls dialog", { exact: true })).toBeInViewport(); await expect(page.getByRole("button", { name: "Save syntax theme", exact: true })).toBeInViewport();
  await expect(page.locator("#controls-content [role=status]")).toBeInViewport(); expect(await page.locator("#controls-dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/syntax-theme-mobile.png" });
  page.once("dialog", dialog => dialog.dismiss()); await page.getByRole("button", { name: "Reload syntax theme", exact: true }).click(); await expect(page.getByRole("radio", { name: "High contrast", exact: true })).toBeChecked();
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "Reload syntax theme", exact: true }).click(); await expect(page.getByRole("radio", { name: "Relay dark", exact: true })).toBeChecked();
  expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("failed reads retain slash input; delayed discovery cannot erase newer text or replace a newer dialog", async ({ page }) => {
  const f = await setup(page); let failed = true;
  await page.route("**/api/syntax-theme", route => failed ? route.fulfill({ status: 503, json: { error: "Fixture theme unavailable" } }) : route.fallback());
  await page.locator("#message-input").fill("/theme"); await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("unavailable"); await expect(page.locator("#message-input")).toHaveValue("/theme");
  await expect(page.getByRole("button", { name: "Save syntax theme", exact: true })).toBeDisabled(); failed = false; await close(page);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let delay = true;
  await page.route("**/api/syntax-theme", async route => { if (delay) { delay = false; entered.resolve(); await release.promise; } return route.fallback(); });
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await entered.promise; await close(page);
  await page.locator("#message-input").fill("A newer draft"); await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#keymap-button").click(); release.resolve();
  await expect(page.locator("#controls-title")).toHaveText("Keyboard shortcuts"); await expect(page.locator("#message-input")).toHaveValue("A newer draft"); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("late save acknowledgements cannot roll back newer themes or replace a newer panel", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  await page.route("**/api/syntax-theme", async route => {
    if (!first || route.request().method() !== "PATCH") return route.fallback(); first = false;
    f.saved = { ...f.saved, revision: 1, theme: route.request().postDataJSON().theme }; const response = structuredClone(f.saved); entered.resolve(); await release.promise; return route.fulfill({ json: response });
  });
  await open(page); await page.getByRole("radio", { name: "Paper light", exact: true }).check(); await page.getByRole("button", { name: "Save syntax theme", exact: true }).click(); await entered.promise;
  await close(page); await open(page); await page.getByRole("radio", { name: "High contrast", exact: true }).check(); await save(page);
  release.resolve(); await expect(page.locator("#toasts")).toContainText("original panel"); await expect(page.getByRole("radio", { name: "High contrast", exact: true })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "high-contrast"); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("large/unknown blocks stay intact and coloring does not load or interfere with the opt-in Vim editor", async ({ page }) => {
  const large = "const a = 1;\n".repeat(7000), unknown = '<script>window.themeInjected=true</script>';
  const f = await setup(page, { contents: [{ id: "theme-limits", role: "assistant", text: [fenced("js", large), fenced("unknown", unknown), fenced("typescript", 'const a: string = "literal";')].join("\n\n") }] });
  await expect(page.locator("#messages code.language-js")).toHaveAttribute("data-highlight", "size-limit"); expect(await page.locator("#messages code.language-js").textContent()).toBe(large);
  await expect(page.locator("#messages code.language-unknown")).toHaveAttribute("data-highlight", "plain"); expect(await page.locator("#messages code.language-unknown").textContent()).toBe(`${unknown}\n`);
  await expect(page.locator("#messages code.language-typescript")).toHaveAttribute("data-highlight", "ready"); expect(await page.evaluate(() => Boolean(window.CodeMirror || window.themeInjected))).toBe(false);
  await page.locator("#message-input").fill("one two three"); await page.getByLabel("Chat actions", { exact: true }).click(); await page.locator("#vim-button").click(); await expect(page.locator("#vim-mode")).toHaveText("VIM · NORMAL");
  const editor = page.getByLabel("Message (Vim editor)", { exact: true }); for (const key of "gg0dw") await editor.press(key);
  await expect(page.locator("#message-input")).toHaveValue("two three"); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("real private-account theme persists across reload without starting an agent or changing messages", async ({ page }) => {
  const username = `theme-owner-${Date.now()}`; const registered = await page.request.post("/api/browser-account/register", { data: { username, password: "isolated-theme-owner-password" } }); expect(registered.ok()).toBe(true);
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Private theme fixture" } })).json(); created.set(page, [chat.id]);
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title); await open(page); await expect(page.locator("#controls-content")).toContainText(`Saved for your Relay account: ${username}`);
  await page.getByRole("radio", { name: "Paper light", exact: true }).check(); await save(page); await close(page); await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "paper-light");
  const saved = await (await page.request.get("/api/syntax-theme")).json(); expect(saved.theme).toBe("paper-light"); expect(saved.account.username).toBe(username);
  const stored = (await (await page.request.get(`/api/chats/${chat.id}`)).json()).chat; expect(stored.status).toBe("stopped"); expect(stored.agentSessionId).toBeFalsy(); expect(stored.messages).toEqual([]);
});

test("a failed worker asset keeps source readable and Retry highlighting recovers real colors", async ({ page, context }) => {
  let fail = true, requests = 0;
  await context.route("**/vendor/syntax-javascript.js", route => { requests++; return fail ? route.abort("failed") : route.continue(); });
  const f = await setup(page); await expect(block(page)).toHaveAttribute("data-highlight", "unavailable"); expect(await block(page).textContent()).toBe(`${source}\n`);
  await open(page); await expect(page.locator(".theme-preview .syntax-code")).toHaveAttribute("data-highlight", "unavailable");
  await expect(page.locator(".theme-scroll")).toContainText("Highlighting unavailable"); fail = false;
  await page.getByRole("button", { name: "Retry highlighting", exact: true }).click();
  await expect(page.locator(".theme-preview .syntax-code")).toHaveAttribute("data-highlight", "ready"); await expect(block(page)).toHaveAttribute("data-highlight", "ready");
  expect(requests).toBeGreaterThanOrEqual(2); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("slow theme settings never block opening a chat, editing or attaching a file", async ({ page }) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route("**/api/syntax-theme", async route => { entered.resolve(); await release.promise; return route.fulfill({ json: { scope: "shared", revision: 0, theme: "paper-light", account: null } }); });
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Slow theme fixture" } })).json(); created.set(page, [chat.id]);
  try {
    await page.goto(`/#chat=${chat.id}`); await entered.promise; await expect(page.locator("#chat-title")).toHaveText(chat.title);
    await page.locator("#message-input").fill("Work while loading"); await page.locator("#attachment-input").setInputFiles({ name: "slow.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
    await expect(page.locator("#attachment-chips")).toContainText("slow.txt");
  } finally { release.resolve(); }
  await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "paper-light"); await expect(page.locator("#message-input")).toHaveValue("Work while loading");
});

test("an account discovered on focus invalidates an open old-account picker visibly", async ({ page }) => {
  const f = await setup(page); await open(page); await page.getByRole("radio", { name: "High contrast", exact: true }).check();
  f.saved = { scope: "new-theme-owner", revision: 0, theme: "paper-light", account: { id: "new-theme-owner", username: "New owner" } };
  await page.evaluate(() => dispatchEvent(new Event("focus"))); await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "paper-light");
  await expect(page.locator("#controls-content [role=status]")).toContainText("account changed"); await expect(page.getByRole("button", { name: "Save syntax theme", exact: true })).toBeDisabled();
  await close(page); await open(page); await expect(page.locator("#controls-content")).toContainText("New owner"); await expect(page.getByRole("radio", { name: "Paper light", exact: true })).toBeChecked(); expect(f.calls.saves).toEqual([]);
});

test("account changes reset colors immediately and discard another account's late save", async ({ page }) => {
  const f = await setup(page, { theme: "paper-light" }), entered = Promise.withResolvers(), release = Promise.withResolvers(), nextLoad = Promise.withResolvers(), releaseLoad = Promise.withResolvers(); let user = null;
  await page.route("**/api/syntax-theme", async route => {
    if (route.request().method() === "GET") { if (user) { nextLoad.resolve(); await releaseLoad.promise; } return route.fallback(); }
    const response = { ...f.saved, revision: 1, theme: route.request().postDataJSON().theme }; entered.resolve(); await release.promise; return route.fulfill({ json: response });
  });
  await page.route("**/api/browser-account", route => route.fulfill({ json: { user } }));
  await page.route("**/api/browser-account/login", route => { user = { id: "theme-user", username: "theme-user" }; f.saved = { scope: user.id, revision: 0, theme: "plain", account: user }; return route.fulfill({ json: { user } }); });
  await page.route("**/api/browser-connections", route => route.fulfill({ json: { connections: [] } }));
  await page.locator("#message-input").fill("Account-change draft"); await open(page); await page.getByRole("radio", { name: "High contrast", exact: true }).check();
  await page.getByRole("button", { name: "Save syntax theme", exact: true }).click(); await entered.promise; await close(page);
  await page.getByRole("button", { name: "Browser connections", exact: true }).click(); await page.getByLabel("Username", { exact: true }).fill("theme-user"); await page.getByLabel("Account password", { exact: true }).fill("fixture-only-password");
  await page.locator("#browser-account-form button[value=login]").click(); await nextLoad.promise; await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "relay-dark");
  releaseLoad.resolve(); await expect(page.locator("#browser-account-name")).toHaveText("Signed in as theme-user"); await page.locator("#browser-connections-close").click(); await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "plain");
  release.resolve(); await expect(page.locator("#toasts")).toContainText("original panel"); await expect(page.locator("html")).toHaveAttribute("data-syntax-theme", "plain");
  await expect(page.locator("#message-input")).toHaveValue("Account-change draft"); expect(f.calls.actions).toEqual([]); expect(f.calls.errors).toEqual([]);
});

test("bounded highlight batches eventually color every mounted block without retaining replaced content", async ({ page, context }) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let delayed = true;
  await context.route("**/vendor/syntax-javascript.js", async route => { if (delayed) { delayed = false; entered.resolve(); await release.promise; } return route.continue(); });
  const f = await setup(page, { contents: [] });
  await page.evaluate(async () => {
    const { highlightCode } = await import("/syntax-highlight.js");
    const code = document.createElement("code"); code.id = "changing-source"; code.textContent = 'const previous = "OLD";'; document.body.append(code); highlightCode(code, "js");
  });
  await entered.promise;
  await page.evaluate(async () => {
    const { highlightCode } = await import("/syntax-highlight.js"), code = document.querySelector("#changing-source");
    code.textContent = 'const next = "NEW";'; highlightCode(code, "js");
    const batch = document.createElement("section"); batch.id = "highlight-batch";
    for (let i = 0; i < 70; i++) { const item = document.createElement("code"); item.textContent = `const value = ${i};`; batch.append(item); highlightCode(item, "js"); }
    document.body.append(batch);
  });
  release.resolve(); await expect(page.locator("#changing-source")).toHaveAttribute("data-highlight", "ready"); await expect(page.locator("#changing-source")).toHaveText('const next = "NEW";');
  await expect(page.locator('#highlight-batch code[data-highlight="ready"]')).toHaveCount(70);
  expect(await page.locator("#highlight-batch").textContent()).not.toContain("OLD"); expect(f.calls.errors).toEqual([]); expect(f.calls.actions).toEqual([]);
});
