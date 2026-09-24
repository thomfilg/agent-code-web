import { createRequire } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { authorizeBrowserTool, browserToolCatalog, browserPolicyFailure } from "./official-browser-policy.mjs";
import { isPersonalProjectionLease, isPersonalProjectionProvider } from './personal-browser-projection.mjs';

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
  mode: z.enum(["guest", "personal"]), personalGrantId: id.optional(), accountIdentityHash:z.string().regex(/^[a-f0-9]{64}$/).optional() }).refine(value => value.mode === "personal" ? Boolean(value.personalGrantId) : value.personalGrantId === undefined);

// Context providers are trusted application wiring. Personal acquisition must
// return a lease minted by the grant-owned projection, not a marker boolean or
// generic profile CDP connection. Guest acquisition uses the existing owned
// worker's private-pipe projection, never a host-browser fallback.
// EC2 guest browsers reach Chrome through a durable, reconnectable transport;
// heavy pages can need tens of seconds there, so calls get a generous bound.
const CALL_TIMEOUT_MS = 90000;

// One bounded line for operator logs: no stack, no request payloads.
const diagnostic = error => `${error?.name || "Error"}${error?.code ? ` [${error.code}]` : ""}: ${String(error?.message || error).split("\n")[0].slice(0, 300)}`;

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
    if (this.#lease?.isCurrent && !this.#lease.isCurrent()) {this.#fence();throw browserPolicyFailure('CONNECTION_LOST');}
    let valid = false;
    try { valid = await this.#validate(this.#binding) === true; } catch { /* Fail closed without exposing authority diagnostics. */ }
    if (this.#revoked || !valid || this.#lease?.isCurrent && !this.#lease.isCurrent()) { this.#fence(); throw browserPolicyFailure("SCOPE_CHANGED"); }
  }
  #fence() { this.#revoked = true; this.#controller.abort(browserPolicyFailure("REVOKED")); }
  async #context() {
    await this.#check();
    return this.#contextPromise ||= (async () => {
      try {
        const lease = await this.#acquire({ binding: this.#binding, signal: this.#controller.signal, playwright: matchingBrowserRuntime(), retainCleanup:receipt=>{
          if(this.#lease||typeof receipt?.release!=='function')throw browserPolicyFailure('CONTEXT_INVALID');
          this.#lease=receipt;
        } });
        if (typeof lease?.release === "function") this.#lease = lease;
        if (this.#binding.mode === 'personal' && !isPersonalProjectionLease(lease)) throw browserPolicyFailure('PERSONAL_PROJECTION_UNAVAILABLE');
        if (!lease || typeof lease.release !== "function" || !lease.context || typeof lease.context.pages !== "function") throw browserPolicyFailure("CONTEXT_INVALID");
        await this.#check();
        return lease.context;
      } catch (error) { console.error(`relay_browser context unavailable (${this.#binding.mode}): ${diagnostic(error)}`); this.#fence(); throw browserPolicyFailure("CONTEXT_UNAVAILABLE"); }
    })();
  }
  async #initialize() {
    return this.#initializing ||= (async () => {
      this.#directory = await mkdtemp(path.join(os.tmpdir(), "relay-official-browser-mcp-"));
      await this.#check();
      this.#server = await official.createConnection({ browser: { browserName: "chromium", isolated: false }, capabilities: [],
        saveSession: false, outputDir: this.#directory, outputMaxSize: 2 * 1024 * 1024, allowUnrestrictedFileAccess: false,
        console: { level: "error" }, timeouts: { action: 15000, navigation: 45000, settle: 0, idle: 0 }, imageResponses: "allow", snapshot: { mode: "full" } }, () => this.#context());
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
        if (this.#binding.mode === 'personal' && !isPersonalProjectionProvider(this.#acquire)) throw browserPolicyFailure('PERSONAL_PROJECTION_UNAVAILABLE');
        await this.#initialize(); await this.#check();
        await this.#context();
        if (this.#lease.beforeTool) {
          await this.#lease.beforeTool({selectTab:async index => {
            const listed = await this.#client.callTool({name:'browser_tabs',arguments:{action:'list'}},undefined,{signal:this.#controller.signal,timeout:CALL_TIMEOUT_MS});
            if(listed.isError)throw browserPolicyFailure('TAB_SYNC_FAILED');
            const result = await this.#client.callTool({name:'browser_tabs',arguments:{action:'select',index}},undefined,{signal:this.#controller.signal,timeout:CALL_TIMEOUT_MS});
            if(result.isError)throw browserPolicyFailure('TAB_SYNC_FAILED');
          },resize:async size=>{
            const result=await this.#client.callTool({name:'browser_resize',arguments:size},undefined,{signal:this.#controller.signal,timeout:CALL_TIMEOUT_MS});
            if(result.isError)throw browserPolicyFailure('VIEWPORT_SYNC_FAILED');
          }});
          await this.#check();
        }
        let result;
        const started = Date.now();
        try {result = await this.#client.callTool({ name, arguments: input }, undefined, { signal: this.#controller.signal, timeout:CALL_TIMEOUT_MS });}
        catch(error) {if(name==='browser_take_screenshot')this.#fence();throw error;}
        finally {
          if(name==='browser_take_screenshot'&&this.#directory) {
            const directory=this.#directory;
            for(const file of await readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;}))await rm(path.join(directory,file),{recursive:true,force:true});
          }
        }
        if (Date.now() - started > 3000) console.log(`relay_browser ${name} took ${Date.now() - started} ms (${this.#binding.mode})`);
        await this.#check();
        if (name === 'browser_tabs') result={...result,content:[{type:'text',text:this.#binding.mode==='guest'
          ? 'Browser mode: guest. localhost refers to this chat worker.'
          : "Browser mode: personal. Only the explicitly shared automation tab is available; localhost refers to the user's computer."},...result.content]};
        if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw browserPolicyFailure("RESULT_TOO_LARGE");
        if (name === 'browser_take_screenshot') {
          // The official backend may create its own temporary output file. Never
          // accept caller paths, retain a frame history or return filesystem links.
          if (result.isError) return {isError:true,content:[{type:'text',text:'Shared viewport screenshot unavailable'}]};
          const images=result.content.filter(item=>item.type==='image'&&item.mimeType==='image/png');
          if(images.length!==1)throw browserPolicyFailure('SCREENSHOT_UNAVAILABLE');
          return {content:[{type:'text',text:'Current shared guest viewport.'},...images]};
        }
        return result;
      } catch (error) {
        if (this.#revoked) { await this.revoke().catch(() => {}); throw browserPolicyFailure("REVOKED"); }
        if (error?.code && typeof error.code === "string" && error.message?.startsWith("Browser MCP access denied")) throw error;
        // Official tool error results remain webpage-visible data. Unexpected
        // transport/provider exceptions must not disclose private internals to
        // the agent; the operator log keeps the first line for diagnosis.
        console.error(`relay_browser ${name} failed (${this.#binding.mode}): ${diagnostic(error)}`);
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
