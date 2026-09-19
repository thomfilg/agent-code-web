// Standalone worker: only Node built-ins, also sent over SSH to cloud workers.
// Chrome uses private pipe descriptors, never a remotely reachable debug port.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";

export class ChromeBrowser extends EventEmitter {
  constructor({ executable = "google-chrome", profile = null, ProjectionPolicy = null } = {}) {
    super(); this.executable = executable; this.profile = profile; this.ProjectionPolicy = ProjectionPolicy;
    this.pending = new Map(); this.sequence = 0; this.viewport = { width: 1280, height: 800 }; this.watching = false;
    this.layoutQueue = Promise.resolve(); this.captureVersion = 0; this.lastFrameAt = 0;
    this.targetRevision = 0; this.statusSnapshots = new WeakMap();
    this.closingProjections = new Map();
  }
  async start() {
    this.directory = this.profile || await mkdtemp(path.join(os.tmpdir(), "relay-chrome-"));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.temporary = !this.profile;
    this.child = spawn(this.executable, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${this.directory}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-dev-shm-usage", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: this.directory, LANG: "C.UTF-8" } });
    this.child.stdio[3].on("error", () => {});
    this.child.stderr.on("data", chunk => { this.diagnostics = ((this.diagnostics || "") + chunk).slice(-2000); });
    this.child.once("error", error => this.fail(error));
    this.child.once("exit", () => this.fail(new Error(this.closing ? "Browser stopped" : `Chrome exited. Check installation and sandbox support. ${this.diagnostics || ""}`)));
    let buffer = "";
    this.child.stdio[4].setEncoding("utf8");
    this.child.stdio[4].on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 48 * 1024 * 1024) { this.fail(new Error("Chrome response exceeded limit")); return; }
      let end;
      while ((end = buffer.indexOf("\0")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { this.receive(JSON.parse(frame)); } catch { /* Ignore malformed protocol messages. */ }
      }
    });
    await this.call("Browser.getVersion");
    await this.call("Browser.setDownloadBehavior", { behavior: "deny" });
    await this.call("Target.setDiscoverTargets", { discover: true });
    const tabs = await this.tabs();
    await this.select(tabs[0]?.id || (await this.call("Target.createTarget", { url: "about:blank" })).targetId);
    return this.status();
  }
  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    if (!this.failed) { this.failed = error; this.emit("closed", { message: this.closing ? "Browser stopped" : error.message }); }
  }
  receive(message) {
    if (message.id) {
      const item = this.pending.get(message.id); if (!item) return;
      this.pending.delete(message.id); clearTimeout(item.timer);
      // Preserve native pipe order for the private projection: its trusted tap
      // only validates/enqueues this exact reply before later CDP events.
      try {item.onResponse?.(message);} catch(error) {item.reject(error);return;}
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result || {});
      return;
    }
    if (message.method === 'Target.detachedFromTarget' && this.sessionId && message.params?.sessionId === this.sessionId) {
      this.sessionId = null; this.captureVersion++;
      clearTimeout(this.captureTimer); this.captureTimer = null;
      clearTimeout(this.streamTimer); this.streamTimer = null; this.pendingStream = null; this.lastStreamData = null;
    }
    if (["Target.targetCreated", "Target.targetDestroyed", "Target.targetInfoChanged"].includes(message.method)) this.targetRevision++;
    this.projectEvent(message);
    if (message.method === "Page.screencastFrame") {
      void this.call("Page.screencastFrameAck", { sessionId: message.params.sessionId }, message.sessionId).catch(() => {});
      if (this.watching && !this.dialogOpen && !this.capturing && message.sessionId === this.sessionId) {
        const { data, metadata } = message.params;
        // Frames from a stopped stream can arrive after a resize. Never label
        // an old bitmap with the new CSS viewport or draw over an idle refine.
        if (metadata?.timestamp < this.streamStartedAt || metadata?.deviceWidth !== this.viewport.width || metadata?.deviceHeight !== this.viewport.height) return;
        this.streamFrame(data);
      }
    }
    if (message.sessionId === this.sessionId) {
      if (message.method === "Page.javascriptDialogOpening") { this.dialogOpen = true; this.emit("dialog", message.params); }
      if (message.method === "Page.javascriptDialogClosed") { this.dialogOpen = false; this.requestFrame(); }
      if (["Page.loadEventFired", "Page.domContentEventFired", "Page.frameNavigated", "Page.navigatedWithinDocument"].includes(message.method)) this.requestFrame();
    }
    if (["Target.targetCreated", "Target.targetDestroyed", "Target.targetInfoChanged"].includes(message.method)) {
      clearTimeout(this.tabsTimer);
      this.tabsTimer = setTimeout(() => { void this.status().then(value => this.publishStatus(value)).catch(() => {}); }, 50);
    }
  }
  call(method, params = {}, sessionId, {onResponse} = {}) {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome ${method} timed out`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, onResponse });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }
  page(method, params) {
    if (!this.sessionId) throw new Error("Choose a browser tab first");
    return this.call(method, params, this.sessionId);
  }
  projectEvent(message) {
    const projection = this.projection; if (!projection) return;
    if (['Target.targetCreated','Target.targetDestroyed','Target.targetInfoChanged'].includes(message.method)) {
      void this.projectSync(projection).catch(() => this.projectClose(projection)).catch(()=>{}); return;
    }
    const target = [...projection.targets.values()].find(item => item.sessionId === message.sessionId);
    if (!target) return;
    try {
      const params = target.policy.event(message.method,message.params);
      if (params && projection.subscribed) this.emit('projection',{id:projection.id,sessionId:target.sessionId,method:message.method,params});
    } catch { void this.projectClose(projection).catch(()=>{}); }
  }
  projectSync(projection) {
    if (projection.syncing) {projection.dirty=true;return projection.queue;}
    projection.syncing=true;
    const operation = Promise.resolve().then(async () => {
      let passes=0;
      do {
      projection.dirty=false;
      if (this.projection !== projection) throw Error('Guest projection revoked');
      const tabs = await this.tabs(); if (tabs.length > 12) throw Error('Guest projection tab limit');
      if (this.projection !== projection) throw Error('Guest projection revoked');
      for (const tab of tabs) if (!projection.targets.has(tab.id)) {
        if (this.projection !== projection) throw Error('Guest projection revoked');
        const {sessionId} = await this.call('Target.attachToTarget',{targetId:tab.id,flatten:true});
        const policy = new this.ProjectionPolicy(), target = {...tab,sessionId,policy}; projection.targets.set(tab.id,target);
        if (this.projection !== projection) throw Error('Guest projection revoked');
        await this.call('Page.getFrameTree',{},sessionId,{onResponse:message=>{if(!message.error)policy.result('Page.getFrameTree',message.result||{});}});
        if (this.projection !== projection) throw Error('Guest projection revoked');
        if (projection.subscribed) this.emit('projection',{id:projection.id,method:'Target.attachedToTarget',params:{sessionId,targetInfo:{targetId:tab.id,browserContextId:'relay-guest-context',type:'page',title:tab.title,url:tab.url,attached:true,canAccessOpener:false},waitingForDebugger:false}});
      }
      for (const [id,target] of projection.targets) if (!tabs.some(tab => tab.id === id)) {
        projection.targets.delete(id);
        if (projection.subscribed) this.emit('projection',{id:projection.id,method:'Target.detachedFromTarget',params:{sessionId:target.sessionId,targetId:id}});
      }
      } while(projection.dirty&&++passes<4);
    });
    projection.queue = operation.finally(()=>{projection.syncing=false;if(projection.dirty&&this.projection===projection)setImmediate(()=>{void this.projectSync(projection).catch(()=>this.projectClose(projection)).catch(()=>{});});});
    projection.queue.catch(()=>{});return projection.queue;
  }
  async projectClose(projection) {
    if (!projection || this.projection !== projection && this.closingProjections.get(projection.id)!==projection) return;
    this.closingProjections.set(projection.id,projection);
    if(this.projection===projection){this.projection=null;this.emit('projectionClosed',{id:projection.id});}
    if(projection.closing)return projection.closing;
    projection.closing=(async()=>{
      await projection.queue?.catch(()=>{});
      const outcomes=await Promise.allSettled([...projection.targets].map(async([id,target])=>{
        try{await this.call('Target.detachFromTarget',{sessionId:target.sessionId});}
        catch(error){if(!/^Session with given id not found\.?$/.test(error.message))throw error;}
        projection.targets.delete(id);
      }));
      if(outcomes.some(result=>result.status==='rejected'))throw Error('Guest projection cleanup unconfirmed');
      this.closingProjections.delete(projection.id);
    })().finally(()=>{projection.closing=null;});
    return projection.closing;
  }
  async project(params,onResponse) {
    const deny = () => {throw Error('Guest protocol denied');};
    if (!this.ProjectionPolicy || !params || typeof params.id !== 'string' || !/^[a-f0-9-]{36}$/.test(params.id) || Object.keys(params).some(key => !['id','operation','method','params','sessionId'].includes(key))) deny();
    if (params.operation === 'open') {
      if (this.projection || this.closingProjections.size || Object.keys(params).length !== 2) deny();
      const projection = {id:params.id,targets:new Map(),subscribed:false}; this.projection = projection;
      try { await this.projectSync(projection); return {tabId:this.tabId}; } catch { await this.projectClose(projection); throw Error('Guest projection unavailable'); }
    }
    if(params.operation==='close'&&Object.keys(params).length===2){
      await this.projectClose(this.projection?.id===params.id?this.projection:this.closingProjections.get(params.id));return{closed:true};
    }
    const projection = this.projection; if (!projection || projection.id !== params.id) deny();
    if (params.operation !== 'command') deny();
    const {method,params:input = {},sessionId} = params;
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Buffer.byteLength(JSON.stringify(input)) > 1024*1024) deny();
    const exact = fields => Object.keys(input).every(key => fields.includes(key));
    const current = () => {if (this.projection !== projection) deny();};
    if (sessionId === undefined) {
      if (method === 'Browser.getVersion' && exact([])) return {protocolVersion:'1.3',product:'HeadlessChrome/RelayGuest',userAgent:'HeadlessRelayGuest'};
      if (method === 'Target.getTargetInfo' && exact([])) return {targetInfo:{targetId:'relay-guest',type:'browser',attached:true}};
      if (method === 'Target.setAutoAttach' && exact(['autoAttach','flatten','waitForDebuggerOnStart']) && input.autoAttach === true && input.flatten === true && input.waitForDebuggerOnStart === true) {
        if (!projection.subscribed) {
          projection.subscribed = true;
          for (const target of projection.targets.values()) this.emit('projection',{id:projection.id,method:'Target.attachedToTarget',params:{sessionId:target.sessionId,targetInfo:{targetId:target.id,browserContextId:'relay-guest-context',type:'page',title:target.title,url:target.url,attached:true,canAccessOpener:false},waitingForDebugger:false}});
        } return {};
      }
      if (method === 'Target.createTarget' && exact(['url','browserContextId']) && input.url === 'about:blank' && [undefined,'relay-guest-context'].includes(input.browserContextId)) {
        if ((await this.tabs()).length >= 12) deny(); current();
        const state = await this.command('newTab',{}, {validWhile:current}); current(); await this.projectSync(projection); current(); return {targetId:state.tabId};
      }
      if (method === 'Target.closeTarget' && exact(['targetId']) && projection.targets.has(input.targetId)) {
        await this.command('closeTab',{id:input.targetId},{validWhile:current}); current(); await this.projectSync(projection); current(); return {success:true};
      }
      deny();
    }
    const target = [...projection.targets.values()].find(value => value.sessionId === sessionId); if (!target) deny();
    if (method === 'Log.enable' && exact([])) return {};
    // The UI owns the existing Chrome rendering defaults. Playwright's
    // headless font initialization is acknowledged without changing them.
    if (method === 'Page.setFontFamilies' && exact(['fontFamilies']) && input.fontFamilies && Object.keys(input.fontFamilies).every(key=>['standard','fixed','serif','sansSerif','cursive','fantasy','math'].includes(key)) && Object.values(input.fontFamilies).every(value=>typeof value==='string'&&value.length<=200)) return {};
    if (method === 'Target.setAutoAttach' && exact(['autoAttach','flatten','waitForDebuggerOnStart']) && input.autoAttach === true && input.flatten === true && input.waitForDebuggerOnStart === true) return {};
    if (method === 'Page.bringToFront' && exact([])) {await this.select(target.id,{validWhile:current});current();return {};}
    if (method === 'Page.captureScreenshot' && exact(['format','captureBeyondViewport','fromSurface','clip']) && input.format === 'png' && input.captureBeyondViewport !== true && input.fromSurface !== false) {
      if(target.id!==this.tabId)deny();
      const clip=input.clip;
      if(clip&&(Object.keys(clip).some(key=>!['x','y','width','height','scale'].includes(key))||clip.width!==this.viewport.width||clip.height!==this.viewport.height||!Number.isFinite(clip.scale)||clip.scale<=0||clip.scale>1))deny();
      return this.updateLayout(async()=>{
        current();if(target.id!==this.tabId)deny();
        const {visualViewport}=await this.page('Page.getLayoutMetrics');
        current();if(target.id!==this.tabId)deny();
        if(clip&&(clip.x!==visualViewport.pageX||clip.y!==visualViewport.pageY))deny();
        // The official contract is CSS-sized PNG of the current UI viewport;
        // retain the UI's retina emulation rather than overwriting its DPR.
        const dpr=this.viewport.width*this.viewport.height<=2097152?2:1;
        const value=await this.page('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{x:visualViewport.pageX,y:visualViewport.pageY,width:this.viewport.width,height:this.viewport.height,scale:1/dpr}});
        current();return value;
      });
    }
    if (method === 'Emulation.setDeviceMetricsOverride' && exact(['width','height','deviceScaleFactor','mobile','screenOrientation','screenWidth','screenHeight','positionX','positionY','dontSetVisibleSize'])) {
      if (input.mobile !== false || input.positionX || input.positionY || input.dontSetVisibleSize || ![0,1,2].includes(input.deviceScaleFactor)) deny();
      const selected=()=>{current();if(target.id!==this.tabId)deny();};
      selected();await this.resize(input,{validWhile:selected});selected();return {};
    }
    const safe = target.policy.command(method,input);
    if (method === 'Page.navigate') {const url = new URL(safe.url);if (!['http:','https:'].includes(url.protocol) && url.href !== 'about:blank' || url.username || url.password) deny();}
    const visibleMutation=method.startsWith('Input.')||['Page.navigate','Page.reload','Page.navigateToHistoryEntry'].includes(method);
    const execute=async()=>{
      current();if(visibleMutation&&target.id!==this.tabId)deny();
      if(visibleMutation){this.interactions=(this.interactions||0)+1;this.requestFrame();}
      let safeResult;
      try{await this.call(method,safe,sessionId,{onResponse:message=>{
        // No await/native action in this hook; the response is bound by the
        // pending Chrome request and the helper's outer request ID.
        try{current();if(message.error){onResponse?.({error:'Guest protocol denied'});return;}
          safeResult=target.policy.result(method,message.result||{});onResponse?.({value:safeResult});}
        catch{onResponse?.({error:'Guest protocol denied'});throw Error('Guest protocol denied');}
      }});current();return safeResult;}
      finally{if(visibleMutation){this.interactions--;this.requestFrame();}}
    };
    return visibleMutation?this.updateLayout(execute):execute();
  }
  async tabs() {
    const { targetInfos } = await this.call("Target.getTargets");
    return targetInfos.filter(tab => tab.type === "page").map(tab => ({ id: tab.targetId, title: tab.title.slice(0, 300), url: tab.url.slice(0, 4000) }));
  }
  statusStamp() { return {tabId:this.tabId,viewport:this.viewport,failed:this.failed,targetRevision:this.targetRevision}; }
  statusMatches(stamp) { return stamp.tabId===this.tabId&&stamp.viewport===this.viewport&&stamp.failed===this.failed&&stamp.targetRevision===this.targetRevision; }
  async status() {
    for(let attempt=0;attempt<3;attempt++) {
      const stamp=this.statusStamp(),tabs=await this.tabs();
      if(!this.statusMatches(stamp)||stamp.tabId&&!tabs.some(tab=>tab.id===stamp.tabId))continue;
      const value={running:!stamp.failed,tabId:stamp.tabId,tabs,viewport:stamp.viewport,mode:"guest",captureVersion:3,
        ...(this.transportValidation?{processIdentity:{helperPid:process.pid,chromePid:this.child.pid}}:{})};
      this.statusSnapshots.set(value,stamp);return value;
    }
    throw Error('Browser state changed while reading status; retry');
  }
  publishStatus(value) {
    const stamp=this.statusSnapshots.get(value);
    if(stamp&&this.statusMatches(stamp))this.emit('status',value);
  }
  updateLayout(action) {
    const pending = this.layoutQueue.then(action);
    this.layoutQueue = pending.catch(() => {}); return pending;
  }
  select(targetId, options = {}) { return this.updateLayout(() => this.selectPage(targetId,options)); }
  async selectPage(targetId, {validWhile} = {}) {
    validWhile?.();
    if (!(await this.tabs()).some(tab => tab.id === targetId)) throw new Error("Browser tab no longer exists");
    validWhile?.();
    if (targetId === this.tabId && this.sessionId) {
      await this.page('Page.bringToFront');
      validWhile?.();
      const status=await this.status();this.publishStatus(status);return status;
    }
    const wasWatching = this.watching;
    if (this.sessionId) {
      const previousSession=this.sessionId;
      await this.setWatching(false,{validWhile}); validWhile?.();
      if(this.sessionId===previousSession)await this.call("Target.detachFromTarget", { sessionId: previousSession }).catch(() => {});
      validWhile?.();
    }
    this.sessionId = (await this.call("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    this.tabId = targetId;
    validWhile?.();
    await this.page("Page.enable");
    validWhile?.();
    await this.page("Runtime.enable");
    validWhile?.();
    await this.page("Page.bringToFront");
    validWhile?.(); await this.setViewport(this.viewport,{validWhile}); validWhile?.();
    if (wasWatching) await this.setWatching(true,{validWhile});
    validWhile?.();
    const status = await this.status(); this.publishStatus(status); return status;
  }
  resize(params, options = {}) { return this.updateLayout(() => this.setViewport(params,options)); }
  async setViewport({ width, height }, {validWhile} = {}) {
    validWhile?.();
    if (!Number.isInteger(width) || width < 320 || width > 2560 || !Number.isInteger(height) || height < 240 || height > 1600) throw new Error("Viewport must be 320–2560 by 240–1600 pixels");
    const wasWatching = this.watching;
    await this.setWatching(false,{validWhile}); validWhile?.();
    // Retina-quality presets, with a bounded bitmap size for large custom views.
    const deviceScaleFactor = width * height <= 2097152 ? 2 : 1;
    await this.page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
    this.viewport = { width, height };
    validWhile?.();
    if (wasWatching) await this.setWatching(true,{validWhile});
    validWhile?.();
    this.publishStatus(await this.status());
    return this.viewport;
  }
  watch(enabled) { return this.updateLayout(() => this.setWatching(enabled)); }
  streamFrame(data) {
    if (data === this.pendingStream?.data || !this.pendingStream && data === this.lastStreamData) return;
    this.pendingStream = { data, mimeType: "image/jpeg", ...this.viewport };
    this.requestFrame();
    if (this.streamTimer) return;
    const startedAt = this.streamStartedAt;
    const flush = () => {
      this.streamTimer = null; const frame = this.pendingStream; this.pendingStream = null;
      if (!frame || !this.watching || this.capturing || this.dialogOpen || this.streamStartedAt !== startedAt || frame.data === this.lastStreamData) return;
      this.lastFrameAt = Date.now(); this.lastStreamData = frame.data; this.emit("frame", frame);
    };
    const delay = Math.max(0, 32 - (Date.now() - this.lastFrameAt));
    if (delay) this.streamTimer = setTimeout(flush, delay); else flush();
  }
  async setWatching(enabled, {validWhile} = {}) {
    validWhile?.();
    this.watching = Boolean(enabled);
    this.captureVersion++; clearTimeout(this.captureTimer); this.captureTimer = null;
    clearTimeout(this.streamTimer); this.streamTimer = null; this.pendingStream = null; this.lastStreamData = null;
    await this.page("Page.stopScreencast").catch(() => {});
    validWhile?.();
    if (this.watching) {
      // Use Chrome's compressed stream while interacting. Full-resolution PNG
      // is an idle refinement, not a prerequisite for every input or repaint.
      this.lastFrameAt = 0; this.lastStreamData = null; this.streamStartedAt = Date.now() / 1000;
      await this.page("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1 });
      validWhile?.();
      this.requestFrame();
    }
    return { watching: this.watching };
  }
  requestFrame() {
    if (!this.watching || this.closing || this.dialogOpen) return;
    const version = ++this.captureVersion;
    clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null;
      // Chrome temporarily adjusts its surface during capture. Serialize with
      // viewport changes and input so its cleanup cannot undo a later resize.
      void this.updateLayout(async () => {
        if (!this.watching || this.closing || this.dialogOpen || this.interactions || version !== this.captureVersion) return;
        const viewport = { ...this.viewport }; this.capturing = true;
        try {
          const { data } = await this.page("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          if (this.watching && !this.closing && version === this.captureVersion) { this.captureError = null; this.emit("frame", { data, mimeType: "image/png", ...viewport }); }
        } finally { this.capturing = false; }
      }).catch(error => { this.captureError = error.message; });
    }, 350);
  }
  async evaluate(expression) {
    if (typeof expression !== "string" || expression.length > 30000) throw new Error("Invalid browser expression");
    const result = await this.page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 10000 });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value ?? null;
  }
  async command(action, params = {}, options = {}) {
    const input = ["mouse", "key", "text", "navigate", "reload", "back", "forward"].includes(action);
    if (input) { this.interactions = (this.interactions || 0) + 1; this.requestFrame(); }
    try { return await this.dispatchCommand(action, params, options); }
    finally { if (input) { this.interactions--; this.requestFrame(); } }
  }
  async dispatchCommand(action, params = {}, options = {}) {
    switch (action) {
      case "project": return this.project(params,options.onResponse);
      case "status": return this.status();
      case "watch": return this.watch(params.enabled);
      case "resize": return this.resize(params);
      case "navigate": {
        const url = new URL(params.url);
        if (!["http:", "https:"].includes(url.protocol) && url.href !== "about:blank") throw new Error("Use an HTTP or HTTPS website address");
        if (url.username || url.password) throw new Error("Do not put credentials in browser addresses");
        const result = await this.updateLayout(() => this.page("Page.navigate", { url: url.href }));
        if (result.errorText) throw new Error(result.errorText);
        return { url: url.href };
      }
      case "reload": await this.updateLayout(() => this.page("Page.reload", { ignoreCache: params.ignoreCache === true })); return {};
      case "back": case "forward": {
        const history = await this.page("Page.getNavigationHistory");
        const entry = history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
        if (entry) await this.updateLayout(() => this.page("Page.navigateToHistoryEntry", { entryId: entry.id }));
        return {};
      }
      case "newTab": return this.updateLayout(async () => {
        options.validWhile?.();const {targetId}=await this.call("Target.createTarget", {url:"about:blank"});options.validWhile?.();
        return this.selectPage(targetId,options);
      });
      case "selectTab": return this.select(params.id);
      case "closeTab": return this.updateLayout(async () => {
        options.validWhile?.();
        if (!(await this.tabs()).some(tab => tab.id === params.id)) throw new Error("Unknown browser tab");
        options.validWhile?.();
        const current = params.id === this.tabId, wasWatching = this.watching;
        // Stop the old surface while its session still exists. Once Chrome
        // closes the target, selection must not await commands to that session.
        if (current) await this.setWatching(false,options);
        options.validWhile?.();
        try { await this.call("Target.closeTarget", { targetId: params.id }); }
        catch (error) { options.validWhile?.();if (current && wasWatching) await this.setWatching(true,options).catch(() => {}); throw error; }
        if (current) {
          this.sessionId = null; this.tabId = null;
          options.validWhile?.();
          const tabs = (await this.tabs()).filter(tab => tab.id !== params.id);
          options.validWhile?.();
          const targetId=tabs[0]?.id || (await this.call("Target.createTarget", {url:"about:blank"})).targetId;
          options.validWhile?.();await this.selectPage(targetId,options);options.validWhile?.();
          if (wasWatching) await this.setWatching(true,options);
          return this.status();
        }
        return this.status();
      });
      case "mouse": {
        if (!["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(params.type)) throw new Error("Invalid pointer event");
        const { x, y } = params;
        if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > this.viewport.width || y > this.viewport.height) throw new Error("Pointer outside browser viewport");
        const button = ["left", "right", "middle"].includes(params.button) ? params.button : "none";
        await this.updateLayout(() => this.page("Input.dispatchMouseEvent", { type: params.type, x, y, button, buttons: Number(params.buttons) & 7, modifiers: Number(params.modifiers) & 15,
          ...(params.type === "mouseWheel" ? { deltaX: Math.max(-3000, Math.min(3000, Number(params.deltaX) || 0)), deltaY: Math.max(-3000, Math.min(3000, Number(params.deltaY) || 0)) } : { clickCount: Math.min(3, Math.max(0, Number(params.clickCount) || 0)) }) }));
        return {};
      }
      case "key": {
        if (!["keyDown", "keyUp", "rawKeyDown"].includes(params.type) || typeof params.key !== "string" || params.key.length > 40) throw new Error("Invalid key event");
        await this.updateLayout(() => this.page("Input.dispatchKeyEvent", { type: params.type, key: params.key, code: String(params.code || "").slice(0, 40), windowsVirtualKeyCode: Number(params.keyCode) & 255,
          modifiers: Number(params.modifiers) & 15, ...(typeof params.text === "string" && params.text.length <= 4 ? { text: params.text } : {}) })); return {};
      }
      case "text":
        if (typeof params.text !== "string" || params.text.length > 30000) throw new Error("Text exceeds 30,000 characters");
        await this.updateLayout(() => this.page("Input.insertText", { text: params.text })); return {};
      case "dialog": await this.page("Page.handleJavaScriptDialog", { accept: params.accept === true, promptText: String(params.text || "").slice(0, 4000) }); return {};
      case "screenshot": return this.updateLayout(async () => ({ ...(await this.page("Page.captureScreenshot", { format: "png" })), ...this.viewport }));
      case "evaluate": return this.evaluate(params.expression);
      case "snapshot": {
        const { nodes } = await this.page("Accessibility.getFullAXTree");
        return { url: await this.evaluate("location.href"), nodes: nodes.filter(node => !node.ignored).slice(0, 1200).map(node => ({ id: node.backendDOMNodeId,
          role: node.role?.value, name: node.name?.value, value: node.role?.value === "textbox" && node.properties?.some(p => p.name === "protected" && p.value.value) ? undefined : node.value?.value,
          children: node.childIds, properties: node.properties?.filter(p => ["checked", "disabled", "expanded", "level"].includes(p.name)) })) };
      }
      case "click": case "fill": {
        if (typeof params.selector !== "string" || params.selector.length > 2000) throw new Error("A CSS selector is required");
        const selector = JSON.stringify(params.selector);
        if (action === "fill") {
          await this.evaluate(`(() => {const e=document.querySelector(${selector});if(!e)throw Error('Element not found');e.focus();e.select?.();return true})()`);
          return this.command("text", { text: params.text });
        }
        const point = await this.evaluate(`(() => {const e=document.querySelector(${selector});if(!e)throw Error('Element not found');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await this.command("mouse", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
        await this.command("mouse", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 }); return {};
      }
      default: throw new Error("Unknown browser action");
    }
  }
  async stop() {
    if (this.closing) return this.stopping;
    this.closing = true;
    this.watching = false; this.captureVersion++; clearTimeout(this.captureTimer); clearTimeout(this.streamTimer); this.pendingStream = null; this.lastStreamData = null;
    this.stopping = (async () => {
      clearTimeout(this.tabsTimer);
      if (this.child?.pid && this.child.exitCode === null && !this.child.signalCode) {
        const ended = new Promise(resolve => this.child.once("exit", resolve));
        void this.call("Browser.close").catch(() => {});
        const kill = setTimeout(() => this.child.kill("SIGKILL"), 3000);
        await ended; clearTimeout(kill);
      }
      this.fail(new Error("Browser stopped"));
      this.emit('stopped');
      if (this.temporary && this.directory) await rm(this.directory, { recursive: true, force: true });
    })();
    return this.stopping;
  }
}

export async function runBrowserWorker({ ProjectionPolicy = null } = {}) {
  const browser = new ChromeBrowser({ executable: process.env.AGENT_CHROME_BIN || "google-chrome", ProjectionPolicy });
  const watchLeaseMs = Number(process.env.RELAY_BROWSER_WATCH_LEASE_MS || 0);
  if (watchLeaseMs && (!Number.isInteger(watchLeaseMs) || watchLeaseMs < 1000 || watchLeaseMs > 10000)) throw new Error("Invalid browser watch lease");
  browser.transportValidation = watchLeaseMs > 0;
  let lastControllerHeartbeat = Date.now(), watchExpired = false;
  const watchTimer = watchLeaseMs ? setInterval(() => {
    if (Date.now() - lastControllerHeartbeat < watchLeaseMs || watchExpired) return;
    watchExpired = true; latestFrame = null;
    void browser.watch(false).catch(() => {});
  }, Math.floor(watchLeaseMs / 3)) : null;
  watchTimer?.unref();
  const send = message => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(message) + "\n"); };
  browser.once('stopped',()=>send({event:'chromeStopped',value:{stopped:true}}));
  let latestFrame = null, writingFrame = false;
  const flushFrame = () => {
    if (writingFrame || !latestFrame || process.stdout.destroyed) return;
    const value = latestFrame; latestFrame = null; writingFrame = true;
    process.stdout.write(JSON.stringify({ event: "frame", value }) + "\n", () => { writingFrame = false; flushFrame(); });
  };
  for (const type of ["status", "dialog", "closed", "projectionClosed"]) browser.on(type, value => send({ event: type, value }));
  browser.on('projection',value=>{
    const message=JSON.stringify({event:'projection',value})+'\n';
    if(Buffer.byteLength(message)>2*1024*1024||process.stdout.writableLength>2*1024*1024){void browser.projectClose(browser.projection).catch(()=>{});return;}
    if(!process.stdout.destroyed)process.stdout.write(message);
  });
  browser.on("frame", value => { if (!watchExpired) { latestFrame = value; flushFrame(); } });
  const close = async () => { clearInterval(watchTimer); await browser.stop(); process.exit(0); };
  process.once("SIGTERM", close); process.once("SIGINT", close);
  try { send({ event: "ready", value: await browser.start() }); }
  catch (error) { send({ event: "fatal", value: { message: error.message } }); await close(); return; }
  const input = createInterface({ input: process.stdin });
  input.on("line", line => {
    // Official Playwright injects a renderer utility larger than the legacy
    // UI action budget. Only the private bounded projection protocol may use
    // the larger frame; ordinary commands retain their original limit.
    if (Buffer.byteLength(line) > 1024*1024 + 1024) return;
    let message; try { message = JSON.parse(line); } catch { return; }
    if (!Number.isInteger(message.id)) return;
    if (message.action !== 'project' && Buffer.byteLength(line) > 100000) {send({id:message.id,error:'Browser command exceeded limit'});return;}
    if (message.action === "transportHeartbeat" && watchLeaseMs) {
      lastControllerHeartbeat = Date.now(); send({ id: message.id, value: { watching: browser.watching, watchExpired } }); return;
    }
    if (message.action === "watch" && watchLeaseMs && message.params?.enabled) {
      lastControllerHeartbeat = Date.now(); watchExpired = false;
    }
    let replied=false;
    const reply=value=>{if(replied)return;replied=true;send({id:message.id,...value});};
    void browser.command(message.action, message.params,{onResponse:reply}).then(value=>reply({value}),error=>reply({error:error.message}));
  });
  input.once("close", close);
}
