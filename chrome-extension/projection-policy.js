// Private Playwright-to-one-tab protocol, not an agent tool or generic CDP API.
const keys = {
  'Page.enable': [], 'Page.getFrameTree': [], 'Page.getLayoutMetrics': [],
  'Page.setLifecycleEventsEnabled': ['enabled'], 'Page.createIsolatedWorld': ['frameId','worldName','grantUniveralAccess'],
  'Page.addScriptToEvaluateOnNewDocument': ['source','worldName','includeCommandLineAPI','runImmediately'],
  'Page.removeScriptToEvaluateOnNewDocument': ['identifier'], 'Page.navigate': ['url','referrer','frameId','referrerPolicy'],
  'Page.reload': ['ignoreCache'], 'Page.getNavigationHistory': [], 'Page.navigateToHistoryEntry': ['entryId'],
  'Page.handleJavaScriptDialog': ['accept','promptText'],
  'Runtime.enable': [], 'Runtime.runIfWaitingForDebugger': [],
  'Runtime.evaluate': ['expression','objectGroup','includeCommandLineAPI','silent','contextId','returnByValue','generatePreview','userGesture','awaitPromise','throwOnSideEffect','timeout','disableBreaks','replMode','allowUnsafeEvalBlockedByCSP','uniqueContextId'],
  'Runtime.callFunctionOn': ['functionDeclaration','objectId','arguments','silent','returnByValue','generatePreview','userGesture','awaitPromise','executionContextId','objectGroup','throwOnSideEffect','uniqueContextId'],
  'Runtime.releaseObject': ['objectId'], 'Runtime.releaseObjectGroup': ['objectGroup'],
  'Runtime.getProperties': ['objectId','ownProperties','accessorPropertiesOnly','generatePreview','nonIndexedPropertiesOnly'],
  'Runtime.addBinding': ['name','executionContextId','executionContextName'],
  'DOM.describeNode': ['objectId','nodeId','backendNodeId','depth','pierce'], 'DOM.resolveNode': ['nodeId','backendNodeId','objectGroup','executionContextId'],
  'DOM.getContentQuads': ['nodeId','backendNodeId','objectId'], 'DOM.scrollIntoViewIfNeeded': ['nodeId','backendNodeId','objectId','rect'],
  'Input.insertText': ['text'], 'Input.dispatchKeyEvent': ['type','modifiers','timestamp','text','unmodifiedText','keyIdentifier','code','key','windowsVirtualKeyCode','nativeVirtualKeyCode','autoRepeat','isKeypad','isSystemKey','location','commands'],
  'Input.dispatchMouseEvent': ['type','x','y','modifiers','timestamp','button','buttons','clickCount','force','tangentialPressure','tiltX','tiltY','twist','deltaX','deltaY','pointerType'],
  'Network.enable': ['maxTotalBufferSize','maxResourceBufferSize','maxPostDataSize'],
  'Network.setCacheDisabled': ['cacheDisabled'],
  'Emulation.setFocusEmulationEnabled': ['enabled'],
};
const fail = () => { throw Error('Scoped browser protocol denied'); };
export class ProjectionPolicy {
  constructor() { this.frames = new Set(); this.contexts = new Set(); this.objects = new Set(); this.nodes = new Set(); this.backends = new Set(); this.scripts = new Set(); this.history = new Set(); }
  remember(set, id) { if (id === undefined) return; if (set.size >= 10000 && !set.has(id)) fail(); set.add(id); }
  command(method, params = {}) {
    if (!Object.hasOwn(keys, method) || !params || Object.getPrototypeOf(params) !== Object.prototype || Object.keys(params).some(key => !keys[method].includes(key)) || new TextEncoder().encode(JSON.stringify(params)).byteLength > 1024 * 1024) fail();
    for (const [key,set] of [['frameId',this.frames],['contextId',this.contexts],['executionContextId',this.contexts],['objectId',this.objects],['nodeId',this.nodes],['backendNodeId',this.backends],['identifier',this.scripts],['entryId',this.history]]) if (params[key] !== undefined && !set.has(params[key])) fail();
    if (params.uniqueContextId !== undefined) fail();
    if (params.arguments !== undefined) {
      if (!Array.isArray(params.arguments) || params.arguments.length > 100) fail();
      for (const arg of params.arguments) if (!arg || Object.keys(arg).some(key => !['value','unserializableValue','objectId'].includes(key)) || arg.objectId !== undefined && !this.objects.has(arg.objectId)) fail();
    }
    for (const key of ['expression','functionDeclaration','source','worldName','objectGroup','name','text','key','code','url']) if (params[key] !== undefined && typeof params[key] !== 'string') fail();
    for (const key of ['enabled','grantUniveralAccess','includeCommandLineAPI','runImmediately','ignoreCache','accept','silent','returnByValue','generatePreview','userGesture','awaitPromise','throwOnSideEffect','disableBreaks','replMode','allowUnsafeEvalBlockedByCSP','ownProperties','accessorPropertiesOnly','nonIndexedPropertiesOnly','pierce','cacheDisabled','autoRepeat','isKeypad','isSystemKey']) if (params[key] !== undefined && typeof params[key] !== 'boolean') fail();
    for (const key of ['contextId','executionContextId','nodeId','backendNodeId','entryId','depth','modifiers','windowsVirtualKeyCode','nativeVirtualKeyCode','buttons','clickCount','location','maxTotalBufferSize','maxResourceBufferSize','maxPostDataSize']) if (params[key] !== undefined && (!Number.isSafeInteger(params[key]) || params[key] < 0 || params[key] > 16*1024*1024)) fail();
    for (const key of ['timestamp','timeout','x','y','force','tangentialPressure','tiltX','tiltY','twist','deltaX','deltaY']) if (params[key] !== undefined && (typeof params[key] !== 'number' || !Number.isFinite(params[key]))) fail();
    for (const key of ['objectId','identifier','frameId','referrer','referrerPolicy','promptText','executionContextName','unmodifiedText','keyIdentifier','button','pointerType']) if (params[key] !== undefined && (typeof params[key] !== 'string' || params[key].length > 30000)) fail();
    if (params.rect !== undefined && (!params.rect || Object.keys(params.rect).some(key => !['x','y','width','height'].includes(key)) || Object.values(params.rect).some(value => !Number.isFinite(value)))) fail();
    if (params.commands !== undefined && (!Array.isArray(params.commands) || params.commands.length > 20 || params.commands.some(value => typeof value !== 'string' || !['selectAll','copy','paste','cut','undo','redo'].includes(value)))) fail();
    // Native clipboard editing commands are never used for official type/key.
    if (params.commands?.some(value => ['copy','paste','cut'].includes(value))) fail();
    if (method === 'Input.dispatchKeyEvent' && !['keyDown','keyUp','rawKeyDown','char'].includes(params.type)) fail();
    if (method === 'Input.dispatchKeyEvent' && (((params.modifiers || 0) & 6) && (/^(c|v|x)$/i.test(params.key || '') || /^Key[CVX]$/.test(params.code || '') || [67,86,88].includes(params.windowsVirtualKeyCode)) || ((params.modifiers || 0) & 8) && (params.key === 'Insert' || params.code === 'Insert') || /^(Copy|Paste|Cut)$/.test(params.key || ''))) fail();
    if (method === 'Input.dispatchKeyEvent') {
      const insert = /^(Insert|Ins)$/.test(params.key || '') || params.code === 'Insert' || params.windowsVirtualKeyCode === 45;
      const del = /^(Delete|Del)$/.test(params.key || '') || params.code === 'Delete' || params.windowsVirtualKeyCode === 46;
      if (insert && ((params.modifiers || 0) & 14) || del && ((params.modifiers || 0) & 8)) fail();
    }
    if (params.includeCommandLineAPI === true) fail();
    if (method === 'Input.dispatchMouseEvent' && !['mousePressed','mouseReleased','mouseMoved','mouseWheel'].includes(params.type)) fail();
    if (method === 'Page.setLifecycleEventsEnabled' && params.enabled !== true) fail();
    if (method === 'Network.setCacheDisabled' && typeof params.cacheDisabled !== 'boolean') fail();
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled !== true) fail();
    return structuredClone(params);
  }
  result(method, value) {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2*1024*1024) fail();
    if (method === 'Page.getFrameTree') {
      const visit = tree => { if (!tree) return; this.remember(this.frames,tree.frame.id); for (const child of tree.childFrames || []) visit(child); }; visit(value.frameTree);
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') this.remember(this.scripts,value.identifier);
    if (method === 'Page.createIsolatedWorld') this.remember(this.contexts,value.executionContextId);
    if (method === 'Page.getNavigationHistory') { this.history.clear(); for (const entry of value.entries || []) this.remember(this.history,entry.id); }
    // Only protocol-owned handle fields, never arbitrary webpage returnByValue
    // objects that happen to contain keys such as objectId/backendNodeId.
    const remote = object => { if (object?.objectId) this.remember(this.objects,object.objectId); };
    if (['Runtime.evaluate','Runtime.callFunctionOn','DOM.resolveNode'].includes(method)) remote(value.result || value.object);
    if (method === 'Runtime.getProperties') for (const property of [...(value.result||[]),...(value.internalProperties||[])]) { remote(property.value); remote(property.get); remote(property.set); }
    if (method === 'DOM.describeNode') { const node = value.node; if (node?.nodeId) this.remember(this.nodes,node.nodeId); if (node?.backendNodeId) this.remember(this.backends,node.backendNodeId); }
    return value;
  }
  event(method, p) {
    if (method === 'Runtime.executionContextCreated') { if (!this.frames.has(p.context?.auxData?.frameId)) return null; this.remember(this.contexts,p.context.id); }
    else if (method === 'Runtime.executionContextDestroyed') this.contexts.delete(p.executionContextId);
    else if (method === 'Runtime.executionContextsCleared') { this.contexts.clear(); this.objects.clear(); this.nodes.clear(); this.backends.clear(); }
    else if (method === 'Runtime.bindingCalled') { if (!this.contexts.has(p.executionContextId)) return null; }
    else if (method === 'Page.frameAttached') { if (!this.frames.has(p.parentFrameId)) return null; this.remember(this.frames,p.frameId); }
    else if (method === 'Page.frameNavigated') { if (p.frame.parentId && !this.frames.has(p.frame.parentId)) return null; this.remember(this.frames,p.frame.id); }
    else if (method === 'Page.frameDetached') { if (!this.frames.has(p.frameId)) return null; this.frames.delete(p.frameId); }
    else if (['Page.lifecycleEvent','Page.frameStartedLoading','Page.frameStoppedLoading','Page.navigatedWithinDocument'].includes(method)) { if (!this.frames.has(p.frameId)) return null; }
    else if (['Page.loadEventFired','Page.domContentEventFired','Page.javascriptDialogOpening','Page.javascriptDialogClosed'].includes(method)) { /* Authorized page only. */ }
    else if (method === 'Network.requestWillBeSent') return { requestId:p.requestId, loaderId:p.loaderId, frameId:p.frameId, type:p.type, timestamp:p.timestamp, wallTime:p.wallTime, documentURL:p.documentURL, initiator:{type:'other'}, request:{url:p.request.url,method:p.request.method,headers:{}}, ...(p.redirectResponse ? {redirectResponse:{url:p.redirectResponse.url,status:p.redirectResponse.status,statusText:p.redirectResponse.statusText,headers:{},mimeType:p.redirectResponse.mimeType,connectionReused:false,connectionId:0,encodedDataLength:0,securityState:'unknown'}} : {}) };
    else if (method === 'Network.responseReceived') return {requestId:p.requestId,loaderId:p.loaderId,frameId:p.frameId,timestamp:p.timestamp,type:p.type,hasExtraInfo:false,response:{url:p.response.url,status:p.response.status,statusText:p.response.statusText,headers:{},mimeType:p.response.mimeType,connectionReused:false,connectionId:0,encodedDataLength:0,securityState:'unknown'}};
    else if (['Network.loadingFinished','Network.loadingFailed'].includes(method)) return {requestId:p.requestId,timestamp:p.timestamp,encodedDataLength:p.encodedDataLength,errorText:p.errorText,canceled:p.canceled,type:p.type};
    else return null;
    return p;
  }
}
