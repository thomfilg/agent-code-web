import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { CapabilityBroker } from "./capabilities.mjs";
import { terminateWorker } from "./worker-process.mjs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { prepareChrome } from "./chrome-software.mjs";
import { captureWorker } from "./software.mjs";
import { browserSelectionExpression } from "./browser-clipboard.mjs";
import { sendBrowserFrame } from "./browser-frames.mjs";
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OfficialBrowserMcp } from './official-browser-mcp.mjs';
import { personalProjectionProvider } from './personal-browser-projection.mjs';
import { acquireGuestProjection } from './guest-browser-projection.mjs';

const stopped = () => ({ running: false, mode: "guest", tabs: [], tabId: null });
const uiActions = new Set(["status", "navigate", "reload", "back", "forward", "newTab", "selectTab", "closeTab", "mouse", "key", "text", "resize", "dialog", "copy"]);

export class BrowserProcess extends EventEmitter {
  constructor(child) {
    super(); this.child = child; this.pending = new Map(); this.sequence = 0; this.state = stopped();
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.chromeStoppedReceipt=new Promise(resolve=>{this.resolveChromeStopped=resolve;});
    // The worker's private Browser.getVersion handshake allows a bounded
    // 60-second EC2 cold start. Keep this outer timer slightly longer so the
    // transport does not preempt the more precise worker diagnostic.
    this.timer = setTimeout(() => this.fail(new Error("Shared Chrome startup timed out")), 75000);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id) {
        const item = this.pending.get(message.id); if (!item) return;
        this.pending.delete(message.id); clearTimeout(item.timer);
        const deliver = () => {
          try {item.onResponse?.(message);} catch(error) {item.reject(error);return;}
          message.error ? item.reject(new Error(message.error)) : item.resolve(message.value);
        };
        if (this.child.commandSettled) void this.child.commandSettled(message.id).then(deliver, error => item.reject(error));
        else deliver();
        return;
      }
      if (["status", "ready"].includes(message.event)) this.state = message.value;
      if(message.event==='chromeStopped'&&message.value?.stopped===true){this.chromeStopped=true;this.resolveChromeStopped();}
      if (message.event === "ready") { clearTimeout(this.timer); this.resolveReady(this.state); }
      if (["fatal", "closed"].includes(message.event)) this.fail(new Error(message.value.message));
      else this.emit(message.event, message.value);
    });
    child.stdin.on("error", () => {});
    child.stderr.on("data", chunk => { this.diagnostics = ((this.diagnostics || "") + chunk).slice(-2000); });
    child.once("error", error => this.fail(error));
    child.once("exit", () => this.fail(new Error(this.diagnostics || "Shared Chrome disconnected")));
    child.on("transportDetached", () => {
      clearInterval(this.heartbeat);
      this.state = { ...this.state, detached: true };
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Browser connection was lost; the action outcome may be unknown. It was not replayed.")); }
      this.pending.clear(); this.emit("status", this.state);
    });
    if (child.recovered) {
      clearTimeout(this.timer);
      void this.dispatch("status").then(value => {
        if (this.error) return;
        this.state = value; this.resolveReady(value); this.startHeartbeat();
      }, error => this.fail(error));
    } else this.startHeartbeat();
  }
  startHeartbeat() {
    clearInterval(this.heartbeat);
    if (!this.child.watchLeaseMs) return;
    this.heartbeat = setInterval(() => {
      if (!this.error && !this.stopping && !this.child.detached && !this.heartbeatPending) {
        this.heartbeatPending = Promise.resolve().then(() => this.dispatch("transportHeartbeat")).catch(() => {}).finally(() => { this.heartbeatPending = null; });
      }
    }, Math.floor(this.child.watchLeaseMs / 3));
    this.heartbeat.unref();
  }
  async ensureConnected() {
    if (!this.child.reconnect || !this.child.detached) return;
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      if (this.stopping || this.error) throw new Error("Browser stopped");
      await this.child.reconnect();
      if (this.stopping || this.error) throw new Error("Browser stopped");
      this.state = await this.dispatch("status");
      if (this.watchingRequested) await this.dispatch("watch", { enabled: true });
      this.startHeartbeat(); this.emit("status", this.state);
    })();
    try { return await this.reconnecting; } finally { this.reconnecting = null; }
  }
  fail(error) {
    if (this.error) return;
    this.error = error; this.state = stopped(); clearTimeout(this.timer); clearInterval(this.heartbeat); this.rejectReady(error);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear(); this.emit("closed", { message: error.message });
  }
  async command(action, params = {}) {
    await this.ready;
    if (this.error) throw this.error;
    if (action === "watch") this.watchingRequested = params.enabled === true;
    await this.ensureConnected();
    if (this.stopping || this.error) throw new Error("Browser stopped");
    return this.dispatch(action, params);
  }
  dispatch(action, params = {}, {onResponse} = {}) {
    if (this.pending.size >= 100) throw new Error("Browser is busy; wait for pending actions");
    const id = ++this.sequence;
    const encoded=JSON.stringify({id,action,params});
    if(Buffer.byteLength(encoded)>(action==='project'?1024*1024+1024:100000))throw new Error('Browser command exceeded limit');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Browser action timed out")); }, 25000);
      this.pending.set(id, { resolve, reject, timer, onResponse });
      if (this.child.sendCommand) {
        void this.child.sendCommand({ id, action, params }).catch(error => {
          const item = this.pending.get(id); if (!item) return;
          this.pending.delete(id); clearTimeout(item.timer); item.reject(error);
        });
      } else this.child.stdin.write(encoded + "\n");
    });
  }
  async stop() {
    if(this.ownedStopConfirmed)return;
    this.stopping = true; clearInterval(this.heartbeat);
    if (this.child.terminateRemote) await this.child.terminateRemote();
    else {
      let timer;
      const receipt=Promise.race([this.chromeStoppedReceipt,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned Chrome termination is unconfirmed')),4000);})]);receipt.catch(()=>{});
      try{this.child.stdin.end();await terminateWorker(this.child,4000);await receipt;}
      finally{clearTimeout(timer);}
    }
    this.ownedStopConfirmed=true;
    this.fail(new Error("Browser stopped"));
  }
}

export class SharedBrowsers {
  constructor({ store, config, acquire, onIdle = async () => {}, isActive = () => false, onViewers = async () => {}, processFactory = child => new BrowserProcess(child) }) {
    this.store = store; this.config = config; this.acquire = acquire; this.processFactory = processFactory;
    this.isActive = isActive; this.onViewers = onViewers;
    this.browserAttempts = new Map();
    this.entries = new Map(); this.versions = new Map(); this.grants = new CapabilityBroker({ ttlMs: config.sessionCapabilityTtlMs }); this.onIdle = onIdle;
  }
  requireChat(chatId) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.archived) throw new Error("Unarchive the chat before opening its browser");
    return chat;
  }
  info(chatId) {
    this.requireChat(chatId);
    const personal = this.personal?.currentGrant(chatId);
    if (personal?.active) return { ...personal.state, mode: "personal", viewers: personal.viewers.size };
    const entry = this.entries.get(chatId);
    return { ...(entry?.browser?.state || stopped()), starting: Boolean(entry && !entry.browser), viewers: entry?.viewers.size || 0 };
  }
  hasViewers(chatId) { return Boolean(this.entries.get(chatId)?.viewers.size || this.personal?.grants.get(chatId)?.viewers.size); }
  async ensure(chatId) {
    this.requireChat(chatId);
    if (this.entries.has(chatId)) {
      const existing = this.entries.get(chatId), version = this.versions.get(chatId) || 0;
      if (existing.stopping) throw new Error("Browser is stopping; retry Stop if cleanup failed");
      await existing.ready;
      if (existing.stopping) throw new Error("Browser is stopping; retry Stop if cleanup failed");
      if (existing.browser?.child?.reconnect) existing.browser.watchingRequested = existing.viewers.size > 0;
      if (existing.suspended) {
        existing.resumePromise ||= (async () => {
          await this.acquire(chatId);
          if (this.entries.get(chatId) !== existing || (this.versions.get(chatId) || 0) !== version) throw new Error("Browser resume cancelled");
          await existing.browser?.ensureConnected();
          existing.suspended = false;
          this.touch(chatId);
        })().finally(() => { existing.resumePromise = null; });
        await existing.resumePromise;
      } else await existing.browser?.ensureConnected();
      if (this.entries.get(chatId) !== existing || (this.versions.get(chatId) || 0) !== version) throw new Error("Browser start cancelled");
      return existing;
    }
    if (this.entries.size >= 12) throw new Error("Close an unused shared browser first (12 browser limit)");
    const version = this.versions.get(chatId) || 0;
    const entry = { viewers: new Set(), browser: null };
    this.entries.set(chatId, entry);
    entry.ready = (async () => {
      const executor = await this.acquire(chatId);
      if ((this.versions.get(chatId) || 0) !== version) throw new Error("Browser start cancelled");
      const executable = await prepareChrome(executor, captureWorker, () => {}, this.config.chromeBin);
      if ((this.versions.get(chatId) || 0) !== version) throw new Error("Browser start cancelled");
      const source = await readFile(new URL("./browser-worker.mjs", import.meta.url), "utf8");
      const policy = await readFile(new URL('../chrome-extension/projection-policy.js',import.meta.url),'utf8');
      const env = { PATH: executor.environmentPath || process.env.PATH, HOME: executor.runtimeHome, LANG: "C.UTF-8", AGENT_CHROME_BIN: executable };
      const child = await (executor.spawnBrowser || executor.spawn).call(executor, "node", ["--input-type=module", "-e", source + `\nconst {ProjectionPolicy}=await import(${JSON.stringify('data:text/javascript;base64,'+Buffer.from(policy).toString('base64'))}); await runBrowserWorker({ProjectionPolicy});`], { cwd: executor.workspace, env, stdio: ["pipe", "pipe", "pipe"] });
      const browser = this.processFactory(child); entry.browser = browser;
      browser.on("frame", value => {
        entry.frame = value;
        for (const viewer of entry.viewers) sendBrowserFrame(viewer, value);
      });
      for (const event of ["status", "dialog"]) browser.on(event, value => { for (const viewer of entry.viewers) this.send(viewer, { event, value: event === "status" ? { ...value, clipboard: true } : value }); });
      browser.on("closed", value => {
        clearTimeout(entry.idleTimer);
        if (this.entries.get(chatId) === entry) {
          if (browser.child?.terminateRemote) {
            // The remote anchor outlives the helper. Keep its receipt reachable
            // until confirmed cleanup, including natural helper failure.
            if (!entry.stopping) void this.stop(chatId, false).then(() => this.onIdle(chatId)).catch(() => {});
          } else { this.entries.delete(chatId); void this.onIdle(chatId).catch(() => {}); }
        }
        for (const viewer of entry.viewers) { this.send(viewer, { event: "closed", value }); viewer.close(1000, "Browser stopped"); }
        void this.onViewers(chatId).catch(() => {});
      });
      await browser.ready;
      if ((this.versions.get(chatId) || 0) !== version) throw new Error("Browser start cancelled");
      this.touch(chatId); return entry;
    })().catch(async error => {
      // An awaited spawn may already own a remote helper even before ready.
      // Preserve that receipt if cleanup fails, and block replacement starts.
      entry.stopping = true;
      if (typeof error.retryBrowserCleanup === "function") {
        entry.pendingCleanup = error.retryBrowserCleanup;
        throw error;
      }
      if (entry.browser) await entry.browser.stop();
      if (this.entries.get(chatId) === entry) this.entries.delete(chatId);
      if ((this.versions.get(chatId) || 0) === version) await this.onIdle(chatId).catch(() => {});
      throw error;
    });
    return entry.ready;
  }
  touch(chatId) {
    const entry = this.entries.get(chatId); if (!entry) return;
    clearTimeout(entry.idleTimer);
    if (!entry.viewers.size && !this.personal?.grants.has(chatId) && !this.isActive(chatId)) {
      entry.idleTimer = setTimeout(() => { void this.stop(chatId, false).then(() => this.onIdle(chatId)).catch(() => {}); }, Math.max(1000, this.config.idleTimeoutMs));
      entry.idleTimer.unref?.();
    }
  }
  send(socket, message) { if (socket.readyState === 1) socket.send(JSON.stringify(message)); }
  async attach(chatId, socket) {
    if (this.personal?.grants.has(chatId)) return this.personal.attachViewer(chatId, socket);
    const entry = await this.ensure(chatId);
    if (socket.readyState !== 1) return;
    if (this.personal?.grants.has(chatId)) return this.personal.attachViewer(chatId, socket);
    entry.viewers.add(socket); this.touch(chatId);
    void this.onViewers(chatId).catch(() => {});
    this.send(socket, { event: "status", value: { ...entry.browser.state, clipboard: true } });
    if (entry.frame) sendBrowserFrame(socket, entry.frame);
    let pending = 0;
    socket.on("message", data => {
      if (this.personal?.grants.has(chatId) || socket.readyState !== 1) { socket.close(4001, "Browser access changed"); return; }
      let input; try { input = JSON.parse(data); } catch { socket.close(1008, "Invalid browser input"); return; }
      if (!input || !Number.isInteger(input.id) || !uiActions.has(input.action)) { socket.close(1008, "Invalid browser action"); return; }
      if (++pending > 64) { socket.close(1008, "Too many browser actions"); return; }
      const action = input.action === "copy" ? "evaluate" : input.action;
      const params = input.action === "copy" ? { expression: browserSelectionExpression } : input.params;
      void entry.browser.command(action, params).then(value => this.send(socket, { id: input.id, value }), error => this.send(socket, { id: input.id, error: error.message })).finally(() => { pending--; });
    });
    socket.once("close", () => {
      entry.viewers.delete(socket);
      void this.onViewers(chatId).catch(() => {});
      if (!entry.viewers.size) {
        entry.browser.watchingRequested = false;
        if (!entry.browser.child?.detached) void entry.browser.command("watch", { enabled: false }).catch(() => {});
        this.touch(chatId);
      }
    });
    await entry.browser.command("watch", { enabled: true });
  }
  async command(chatId, action, params) {
    const epoch = this.personal?.epochs.get(chatId) || 0;
    let value;
    if (this.personal?.grants.has(chatId)) value = await this.personal.command(chatId, action, params);
    else {
      const entry = await this.ensure(chatId);
      if ((this.personal?.epochs.get(chatId) || 0) !== epoch) throw new Error("Browser access changed; retry the action");
      this.touch(chatId); value = await entry.browser.command(action, params); this.touch(chatId);
    }
    if ((this.personal?.epochs.get(chatId) || 0) !== epoch) throw new Error("Browser access changed; previous results were discarded");
    return value;
  }
  async stop(chatId, revoke = true) {
    await this.personal?.revokeChat(chatId);
    this.invalidateOfficial(chatId);
    const attempt=this.browserAttempts.get(chatId);
    const cleanup=()=>attempt?.proxy?attempt.proxy.revoke():attempt?.cleanup?.();
    let cleanupFailed=false;
    try{await cleanup();}catch{cleanupFailed=true;}
    this.versions.set(chatId, (this.versions.get(chatId) || 0) + 1);
    if (revoke) this.grants.revokeChat(chatId);
    const entry = this.entries.get(chatId);
    if (!entry) {
      if(cleanupFailed)throw Error('Browser cleanup is unconfirmed; retry Stop');
      if(this.browserAttempts.get(chatId)===attempt)this.browserAttempts.delete(chatId);
      return;
    }
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopping = true;
    clearTimeout(entry.idleTimer);
    entry.stopPromise = (async () => {
      await entry.ready.catch(() => {});
      if (entry.pendingCleanup) { await entry.pendingCleanup(); entry.pendingCleanup = null; }
      if (entry.browser) await entry.browser.stop();
      if(cleanupFailed)await cleanup();
      if(this.browserAttempts.get(chatId)===attempt)this.browserAttempts.delete(chatId);
      if (this.entries.get(chatId) === entry) this.entries.delete(chatId);
    })();
    try { await entry.stopPromise; } finally { entry.stopPromise = null; }
  }
  async revokeForSuspend(chatId) {
    await this.personal?.revokeChat(chatId);
    this.invalidateOfficial(chatId);
    const attempt = this.browserAttempts.get(chatId);
    const cleanup = () => attempt?.proxy ? attempt.proxy.revoke() : attempt?.cleanup?.();
    try { await cleanup(); }
    catch { throw new Error("Browser capability cleanup is unconfirmed; hibernation was cancelled"); }
    if (this.browserAttempts.get(chatId) === attempt) this.browserAttempts.delete(chatId);
    this.grants.revokeChat(chatId);
  }
  async detachForSuspend(chatId) {
    const entry = this.entries.get(chatId);
    if (!entry) return { retained: false };
    await entry.ready;
    if (entry.suspended) return { retained: true, processId: "shared-chrome" };
    if (entry.stopping || entry.viewers.size || entry.browser.pending.size) throw new Error("Shared Chrome is not at a quiescent suspension boundary");
    clearTimeout(entry.idleTimer); clearInterval(entry.browser.heartbeat);
    await entry.browser.heartbeatPending?.catch(() => {});
    await entry.browser.ensureConnected();
    if (entry.browser.pending.size) throw new Error("Shared Chrome changed while preparing suspension");
    if (entry.browser.watchingRequested) await entry.browser.command("watch", { enabled: false });
    const child = entry.browser.child;
    await child.inputQueue; await child.outputQueue; await child.storageQueue;
    if (child.detached || typeof child.detach !== "function") throw new Error("Shared Chrome transport cannot detach safely");
    child.detach();
    entry.suspended = true;
    let resumed = false;
    return { retained: true, processId: "shared-chrome", resume: async () => {
      if (resumed) return;
      const current = this.entries.get(chatId);
      if (current !== entry) throw new Error("Shared Chrome was replaced before suspension rollback");
      await entry.browser.ensureConnected();
      entry.suspended = false;
      resumed = true; this.touch(chatId);
    } };
  }
  async shutdown() {
    await this.personal?.shutdown();
    for (const [chatId, entry] of this.entries) {
      if (!entry.suspended) continue;
      clearTimeout(entry.idleTimer); clearInterval(entry.browser?.heartbeat);
      entry.browser?.child?.detach?.();
      this.entries.delete(chatId); this.browserAttempts.delete(chatId); this.grants.revokeChat(chatId);
    }
    await Promise.allSettled([...new Set([...this.entries.keys(),...this.browserAttempts.keys()])].map(id => this.stop(id)));
  }
  suspendRuntime(chatId) {
    const attempt = this.browserAttempts.get(chatId);
    if (!attempt) return null;
    if (typeof attempt.validWhile !== "function" || attempt.validWhile() !== true) throw new Error("Browser capability expired before hibernation");
    if (!attempt.capabilityToken || !this.grants.validate(attempt.capabilityToken, "browser")) throw new Error("Browser capability expired before hibernation");
    return { schema: 1, token: attempt.capabilityToken };
  }
  runtime(chatId, origin, {validWhile = null, restoreToken = null} = {}) {
    if (restoreToken !== null && !/^cap_[A-Za-z0-9_-]{43}$/.test(restoreToken)) throw new Error("Browser hibernation checkpoint is invalid");
    const previous=this.browserAttempts.get(chatId);
    this.invalidateOfficial(chatId);
    const cleanup=previous?.proxy?previous.proxy.revoke.bind(previous.proxy):previous?.cleanup||(()=>Promise.resolve());
    const previousCleanup=cleanup();previousCleanup.catch(()=>{});
    this.browserAttempts.set(chatId,{id:randomUUID(),validWhile,personalUsed:false,cleanup,previousCleanup,generation:(this.versions.get(chatId)||0)+1});
    const token = restoreToken === null ? this.grants.issue({ chatId, provider: "browser" }) : restoreToken;
    if (restoreToken !== null) this.grants.restoreToken({ token, chatId, provider: "browser" });
    this.browserAttempts.get(chatId).capabilityToken = token;
    return { relay_browser: { type: "http", url: `${origin}/gateway/browser`, headers: { Authorization: `Bearer ${token}` } } };
  }
  invalidateOfficial(chatId) {
    const attempt = this.browserAttempts.get(chatId);
    if (attempt) { attempt.revoked = true; void attempt.proxy?.revoke().catch(() => {}); }
  }
  async official(chatId,token) {
    const attempt = this.browserAttempts.get(chatId), grant = this.personal?.currentGrant(chatId), epoch = this.personal?.epochs.get(chatId) || 0;
    if (!attempt || typeof attempt.validWhile !== 'function' || !attempt.validWhile() || !this.personalScope || attempt.personalUsed && !grant?.active) throw Error('Browser MCP requires the current authorized agent attempt');
    const mode = grant?.active ? 'personal' : 'guest', modeKey = mode === 'personal' ? grant.id : `guest:${epoch}`;
    if (attempt.revoked) {
      // Only a fresh explicit sharing grant can admit a new projection. A link
      // reconnect, retry or later message under the old grant cannot do so.
      if (mode !== 'personal' || attempt.proxyModeKey === modeKey) throw Error('Browser access was revoked');
      if(!attempt.transition)attempt.transition=Promise.resolve(attempt.proxy?.revoke()).then(()=>{
        attempt.proxy = null; attempt.initializing = null; attempt.revoked = false;
      }).finally(()=>{attempt.transition=null;});
      await attempt.transition;
    }
    if (attempt.proxy) return attempt.proxy;
    if (mode === 'personal') attempt.personalUsed = true;
    attempt.proxyModeKey = modeKey;
    return attempt.initializing ||= (async () => {
      await attempt.previousCleanup;
      const scope = await this.personalScope(chatId);
      if (mode === 'personal' && (!grant.officialScope || JSON.stringify(grant.officialScope) !== JSON.stringify(scope))) throw Error('Authorize Chrome sharing again for the current agent scope');
      const binding = {...scope,attemptId:attempt.id,generation:attempt.generation,mode,...(mode === 'personal'?{personalGrantId:grant.id}:{})};
      const live = () => {
        const observed=this.personal?.currentGrant(chatId);
        return !attempt.revoked && attempt.proxyModeKey === modeKey && this.browserAttempts.get(chatId) === attempt && attempt.validWhile() && this.grants.validate(token,'browser') && (this.personal?.epochs.get(chatId)||0) === epoch && (mode === 'personal' ? observed === grant && grant.active : !observed);
      };
      const validate = async () => {
        if (!live()) return false;
        const current = await this.personalScope(chatId);
        return JSON.stringify(current) === JSON.stringify(scope) && Boolean(live());
      };
      if (!await validate()) throw Error('Browser scope changed');
      const acquireContext = mode === 'personal' ? personalProjectionProvider({personal:this.personal,grant,validate}) : async ({playwright,signal,retainCleanup}) => {
        await attempt.previousCleanup;
        if (!await validate()) throw Error('Browser scope changed');
        const entry = await this.ensure(chatId);
        if (!await validate()) throw Error('Browser scope changed');
        return acquireGuestProjection({browser:entry.browser,playwright,signal,retainCleanup,validate:async () => this.entries.get(chatId) === entry && await validate()});
      };
      attempt.proxy = new OfficialBrowserMcp({binding,validateBinding:validate,acquireContext});
      return attempt.proxy;
    })();
  }
  async handle(request, response, url) {
    if (url.pathname !== "/gateway/browser") return false;
    const finish = (code, message) => { response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ error: message })); return true; };
    if (request.headers.origin || url.search) return finish(403, "Browser gateway only accepts agent requests");
    const token = /^Bearer (.+)$/i.exec(request.headers.authorization || "")?.[1];
    const grant = this.grants.validate(token, "browser");
    if (!grant || !this.store.get(grant.chatId)) return finish(401, "Invalid or expired browser capability");
    if (request.method !== "POST") return finish(405, "Use MCP POST requests");
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 100000) return finish(413, "Browser request too large"); chunks.push(chunk); }
    let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { return finish(400, "Invalid JSON"); }
    {
      let proxy; try { proxy = await this.official(grant.chatId,token); } catch { return finish(403,'Browser MCP access is unavailable or revoked'); }
      const server = new Server({name:'relay-official-shared-chrome',version:'1'},{capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema,() => proxy.toolsList());
      server.setRequestHandler(CallToolRequestSchema,(request,extra) => proxy.callTool(request.params,{signal:extra.signal}));
      const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      response.once('close',() => { void transport.close(); void server.close(); });
      await server.connect(transport); await transport.handleRequest(request,response,body); return true;
    }
  }
}
