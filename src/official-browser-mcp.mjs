import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { authorizeBrowserTool, browserToolCatalog, browserPolicyFailure } from "./official-browser-policy.mjs";

const require = createRequire(import.meta.url), officialRequire = createRequire(require.resolve("@playwright/mcp"));
const official = require("@playwright/mcp");
export const officialBrowserVersions = Object.freeze({ mcp: officialRequire("@playwright/mcp/package.json").version, playwright: officialRequire("playwright-core/package.json").version });
export function matchingBrowserRuntime() {
  if (officialBrowserVersions.mcp !== "0.0.81" || officialBrowserVersions.playwright !== "1.64.0-alpha-2026-09-14") throw browserPolicyFailure("RUNTIME_VERSION_CHANGED");
  return officialRequire("playwright");
}
const id = z.string().min(1).max(200), revision = z.number().int().positive();
const bindingSchema = z.strictObject({ ownerId: id, chatId: id, companyId: id, environmentId: id, provider: z.enum(["codex", "claude"]), accountId: id,
  accountRevision: revision, companyRevision: revision, environmentRevision: revision, attemptId: id, generation: revision,
  mode: z.enum(["guest", "personal"]), personalGrantId: id.optional() }).refine(value => value.mode === "personal" ? Boolean(value.personalGrantId) : value.personalGrantId === undefined);

// No HTTP endpoint or runtime caller is enabled by this partition. The trusted
// context provider owns a guest context; personal projection is not implemented
// and cannot be admitted with a marker boolean or generic CDP URL.
export class OfficialBrowserMcp {
  #binding; #validate; #acquire; #server; #client; #directory; #initializing; #contextPromise; #lease; #released = false;
  #revoked = false; #closing; #controller = new AbortController(); #pending = 0; #queue = Promise.resolve();
  constructor({ binding, validateBinding, acquireContext }) {
    const parsed = bindingSchema.safeParse(binding);
    if (!parsed.success || typeof validateBinding !== "function" || typeof acquireContext !== "function") throw browserPolicyFailure("BINDING_INVALID");
    this.#binding = Object.freeze(parsed.data); this.#validate = validateBinding; this.#acquire = acquireContext;
    matchingBrowserRuntime();
  }
  get binding() { return this.#binding; }
  async #check() {
    if (this.#revoked) throw browserPolicyFailure("REVOKED");
    let valid = false;
    try { valid = await this.#validate(this.#binding) === true; } catch { /* Fail closed without exposing authority diagnostics. */ }
    if (this.#revoked || !valid) { this.#fence(); throw browserPolicyFailure("SCOPE_CHANGED"); }
  }
  #fence() { this.#revoked = true; this.#controller.abort(browserPolicyFailure("REVOKED")); }
  async #context() {
    await this.#check();
    if (this.#binding.mode === "personal") throw browserPolicyFailure("PERSONAL_PROJECTION_UNAVAILABLE");
    return this.#contextPromise ||= (async () => {
      try {
        const lease = await this.#acquire({ binding: this.#binding, signal: this.#controller.signal, playwright: matchingBrowserRuntime() });
        if (typeof lease?.release === "function") this.#lease = lease;
        if (!lease || typeof lease.release !== "function" || !lease.context || typeof lease.context.pages !== "function") throw browserPolicyFailure("CONTEXT_INVALID");
        await this.#check();
        return lease.context;
      } catch { this.#fence(); throw browserPolicyFailure("CONTEXT_UNAVAILABLE"); }
    })();
  }
  async #initialize() {
    return this.#initializing ||= (async () => {
      this.#directory = await mkdtemp(path.join(os.tmpdir(), "relay-official-browser-mcp-"));
      await this.#check();
      this.#server = await official.createConnection({ browser: { browserName: "chromium", isolated: false }, capabilities: [],
        saveSession: false, outputDir: this.#directory, outputMaxSize: 2 * 1024 * 1024, allowUnrestrictedFileAccess: false,
        console: { level: "error" }, timeouts: { action: 5000, navigation: 10000, settle: 0, idle: 0 }, imageResponses: "omit", snapshot: { mode: "full" } }, () => this.#context());
      await this.#check();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      this.#client = new Client({ name: "relay-browser-policy", version: "1" });
      await this.#server.connect(serverTransport); await this.#client.connect(clientTransport);
      await this.#check();
    })();
  }
  async toolsList() {
    try {
      await this.#check(); await this.#initialize();
      const result = await this.#client.listTools(); await this.#check();
      return { tools: browserToolCatalog(this.#binding.mode, result.tools) };
    } catch (error) { if (this.#revoked) await this.revoke().catch(() => {}); throw error; }
  }
  callTool({ name, arguments: args = {} }, { signal } = {}) {
    // This check precedes initialization and context acquisition. Cached or
    // fabricated tool names cannot bypass filtered discovery.
    const input = authorizeBrowserTool(this.#binding.mode, name, args);
    if (this.#revoked) return Promise.reject(browserPolicyFailure("REVOKED"));
    if (signal?.aborted) return Promise.reject(browserPolicyFailure("CANCELLED"));
    if (this.#pending >= 8) return Promise.reject(browserPolicyFailure("BUSY"));
    this.#pending++;
    const abort = () => { void this.revoke().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    const operation = this.#queue.then(async () => {
      try {
        await this.#check();
        if (this.#binding.mode === "personal") throw browserPolicyFailure("PERSONAL_PROJECTION_UNAVAILABLE");
        await this.#initialize(); await this.#check();
        const result = await this.#client.callTool({ name, arguments: input }, undefined, { signal: this.#controller.signal, timeout: 15000 });
        await this.#check();
        if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw browserPolicyFailure("RESULT_TOO_LARGE");
        return result;
      } catch (error) {
        if (this.#revoked) { await this.revoke().catch(() => {}); throw browserPolicyFailure("REVOKED"); }
        if (error?.code && typeof error.code === "string" && error.message?.startsWith("Browser MCP access denied")) throw error;
        // Official tool error results remain webpage-visible data. Unexpected
        // transport/provider exceptions must not disclose private internals.
        throw browserPolicyFailure("CALL_FAILED");
      }
    });
    this.#queue = operation.catch(() => {});
    return operation.finally(() => { this.#pending--; signal?.removeEventListener("abort", abort); });
  }
  revoke() {
    this.#fence();
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      await this.#initializing?.catch(() => {});
      await Promise.allSettled([this.#client?.close(), this.#server?.close()]);
      await this.#contextPromise?.catch(() => {});
      if (this.#lease && !this.#released) { await this.#lease.release(); this.#released = true; }
      if (this.#directory) { await rm(this.#directory, { recursive: true, force: true }); this.#directory = null; }
    })();
    return this.#closing.catch(() => { this.#closing = null; throw browserPolicyFailure("CLEANUP_UNCONFIRMED"); });
  }
  close() { return this.revoke(); }
}
