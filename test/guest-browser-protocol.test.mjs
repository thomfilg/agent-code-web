import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {BrowserProcess} from '../src/shared-browser.mjs';
import {ChromeBrowser,browserProtocolTimeout} from '../src/browser-worker.mjs';
import {acquireGuestProjection} from '../src/guest-browser-projection.mjs';
import {waitFor} from './helpers.mjs';
import WebSocket from 'ws';
import {once} from 'node:events';

test('only the initial Chrome handshake receives the bounded EC2 cold-start allowance',()=>{
  assert.equal(browserProtocolTimeout('Browser.getVersion'),60000);
  assert.equal(browserProtocolTimeout('Target.getTargets'),20000);
  assert.equal(browserProtocolTimeout('Runtime.evaluate'),20000);
});

test('private projection admits bounded renderer utilities but rejects oversize before writing; UI budget is unchanged',async t=>{
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()}),browser=new BrowserProcess(child);
  t.after(()=>{browser.fail(Error('Synthetic teardown'));child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();});
  child.stdout.write(JSON.stringify({event:'ready',value:{running:true,mode:'guest'}})+'\n');await browser.ready;
  let writes=0,bytes=0;
  child.stdin.on('data',data=>{writes++;bytes=data.length;const {id}=JSON.parse(data);child.stdout.write(JSON.stringify({id,value:{}})+'\n');});
  await browser.dispatch('project',{id:'synthetic-id',operation:'command',method:'Runtime.evaluate',params:{expression:'x'.repeat(330364)}});
  assert.equal(writes,1);assert.ok(bytes>330364&&bytes<1024*1024);
  assert.throws(()=>browser.dispatch('project',{expression:'x'.repeat(1024*1024+1024)}),/exceeded limit/);
  assert.throws(()=>browser.dispatch('text',{text:'x'.repeat(100000)}),/exceeded limit/);
  assert.equal(writes,1);assert.equal(browser.pending.size,0,'rejected frames create no timeout or unknown-input receipt');
});

test('native Chrome response tap precedes the following CDP context event in the same pipe frame',async()=>{
  const browser=new ChromeBrowser(),input=new PassThrough(),seen=[];
  browser.child={stdio:[null,null,null,input]};
  browser.projection={id:'fixture',subscribed:true,targets:new Map([['tab',{sessionId:'session',policy:{event:(_method,params)=>params}}]])};
  browser.on('projection',()=>seen.push('context'));
  const result=browser.call('Page.getFrameTree',{},'session',{onResponse:()=>seen.push('reply')});
  browser.receive({id:1,result:{frameTree:{frame:{id:'tab'}}}});
  browser.receive({sessionId:'session',method:'Runtime.executionContextCreated',params:{context:{id:1}}});
  assert.deepEqual(seen,['reply','context']);await result;input.destroy();
});

test('native projection validates a reply exactly once before a following context-clear event',async()=>{
  const browser=new ChromeBrowser({ProjectionPolicy:class{}}),input=new PassThrough(),handles=new Set();
  const id='00000000-0000-0000-0000-000000000000';let validations=0;
  browser.child={stdio:[null,null,null,input]};
  const policy={command:(_method,params)=>params,result:(_method,value)=>{validations++;handles.add(value.result.objectId);return value;},event:(_method,params)=>{handles.clear();return params;}};
  browser.projection={id,subscribed:true,targets:new Map([['tab',{sessionId:'session',policy}]])};
  const result=browser.project({id,operation:'command',method:'Runtime.evaluate',params:{expression:'fixture'},sessionId:'session'},()=>{});
  browser.receive({id:1,result:{result:{objectId:'owned-before-clear'}}});
  browser.receive({sessionId:'session',method:'Runtime.executionContextsCleared',params:{}});
  await result;assert.equal(validations,1);assert.equal(handles.size,0,'completion cannot restore handles invalidated by a later native event');input.destroy();
});

test('initial frame seeding cannot restore a frame detached immediately after its native reply',async()=>{
  const frames=new Set(),input=new PassThrough();let validations=0;
  class Policy{result(_method,value){validations++;frames.add(value.frameTree.frame.id);return value;}event(_method,params){frames.delete(params.frameId);return params;}}
  const browser=new ChromeBrowser({ProjectionPolicy:Policy}),projection={id:'fixture',targets:new Map(),subscribed:false};
  browser.child={stdio:[null,null,null,input]};browser.projection=projection;browser.tabs=async()=>[{id:'tab'}];
  const synced=browser.projectSync(projection);
  await waitFor(()=>browser.pending.has(1));browser.receive({id:1,result:{sessionId:'session'}});
  await waitFor(()=>browser.pending.has(2));browser.receive({id:2,result:{frameTree:{frame:{id:'frame'}}}});
  browser.receive({sessionId:'session',method:'Page.frameDetached',params:{frameId:'frame'}});
  await synced;assert.equal(validations,1);assert.equal(frames.size,0);input.destroy();
});

test('closing the selected UI tab never commands its destroyed session and preserves watching on the remaining tab',async()=>{
  const browser=new ChromeBrowser(),calls=[],afterDestroy=[];
  let destroyed=false;
  browser.tabId='second';browser.sessionId='old-ui';browser.watching=true;browser.requestFrame=()=>{};
  browser.tabs=async()=>destroyed?[{id:'first'}]:[{id:'first'},{id:'second'}];
  browser.call=async(method,params={},sessionId)=>{
    calls.push(method);
    if(destroyed&&(sessionId==='old-ui'||params.sessionId==='old-ui')){afterDestroy.push(method);throw Error('Synthetic destroyed session');}
    if(method==='Target.closeTarget'){assert.equal(params.targetId,'second');destroyed=true;return{success:true};}
    if(method==='Target.attachToTarget'){assert.equal(params.targetId,'first');return{sessionId:'new-ui'};}
    return{};
  };
  const result=await browser.command('closeTab',{id:'second'});
  assert.deepEqual(afterDestroy,[],'stop/detach must never await a reply from a destroyed UI session');
  assert.ok(calls.indexOf('Page.stopScreencast')<calls.indexOf('Target.closeTarget'));
  assert.equal(result.tabId,'first');assert.equal(browser.sessionId,'new-ui');assert.equal(browser.watching,true);
});

test('close never reselects the acknowledged closing target from a transient native target list',async()=>{
  const browser=new ChromeBrowser();let closed=false,readsAfterClose=0;
  browser.tabId='second';browser.sessionId='old-ui';browser.requestFrame=()=>{};
  browser.tabs=async()=>!closed||++readsAfterClose===1?[{id:'second'},{id:'first'}]:[{id:'first'}];
  browser.call=async(method,params={})=>{
    if(method==='Target.closeTarget'){closed=true;return{success:true};}
    if(method==='Target.attachToTarget'){assert.equal(params.targetId,'first');return{sessionId:'remaining-ui'};}
    return{};
  };
  const state=await browser.command('closeTab',{id:'second'});
  assert.equal(state.tabId,'first');assert.equal(browser.sessionId,'remaining-ui');assert.deepEqual(state.tabs.map(tab=>tab.id),['first']);
});

test('reselecting the already-owned UI tab preserves its session and viewing state',async()=>{
  const browser=new ChromeBrowser(),calls=[];browser.tabId='first';browser.sessionId='owned-ui';browser.watching=true;browser.requestFrame=()=>{};
  browser.tabs=async()=>[{id:'first'}];browser.call=async(method)=>{calls.push(method);return method==='Target.attachToTarget'?{sessionId:'replacement-ui'}:{};};
  const state=await browser.select('first');assert.equal(state.tabId,'first');assert.equal(browser.sessionId,'owned-ui');assert.equal(browser.watching,true);
  assert.equal(calls.includes('Target.detachFromTarget'),false);assert.equal(calls.includes('Target.attachToTarget'),false);
});

test('only exact native UI-session detach invalidates ownership; explicit same-tab selection repairs it',async()=>{
  const browser=new ChromeBrowser();let attaches=0;
  browser.tabId='first';browser.sessionId='owned-ui';browser.watching=true;browser.requestFrame=()=>{};
  browser.tabs=async()=>[{id:'first'}];browser.call=async(method)=>{if(method==='Target.attachToTarget'){attaches++;return{sessionId:'repaired-ui'};}return{};};
  browser.receive({method:'Target.detachedFromTarget',params:{sessionId:'unrelated-projection'}});
  assert.equal(browser.sessionId,'owned-ui');await browser.select('first');assert.equal(attaches,0);
  browser.receive({method:'Target.detachedFromTarget',params:{sessionId:'owned-ui'}});
  assert.equal(browser.sessionId,null);assert.equal(attaches,0,'invalidation never implicitly reattaches or replays an action');
  await browser.select('first');assert.equal(attaches,1);assert.equal(browser.sessionId,'repaired-ui');assert.equal(browser.watching,true);
});

test('projection close/select/resize/new queued behind layout cannot mutate after revocation',async()=>{
  for(const kind of ['close','select','resize','new']) {
    const browser=new ChromeBrowser({ProjectionPolicy:class{}}),id='00000000-0000-0000-0000-000000000000',calls=[];
    const projection={id,targets:new Map([['tab',{id:'tab',sessionId:'project-session'}]])};browser.projection=projection;browser.tabId='tab';browser.sessionId='ui';
    browser.tabs=async()=>[{id:'tab'}];browser.call=async method=>{calls.push(method);return{};};
    let release,queued=false;browser.layoutQueue=new Promise(resolve=>{release=resolve;});
    const update=browser.updateLayout.bind(browser);browser.updateLayout=callback=>{queued=true;return update(callback);};
    const command=kind==='close'?{method:'Target.closeTarget',params:{targetId:'tab'}}:kind==='new'?{method:'Target.createTarget',params:{url:'about:blank'}}:kind==='select'?{method:'Page.bringToFront',sessionId:'project-session',params:{}}:{method:'Emulation.setDeviceMetricsOverride',sessionId:'project-session',params:{width:390,height:844,mobile:false,deviceScaleFactor:1}};
    const pending=browser.project({id,operation:'command',...command});pending.catch(()=>{});
    await waitFor(()=>queued);await browser.projectClose(projection);const cleanupCount=calls.length;release();
    await assert.rejects(pending,/denied|revoked/);assert.deepEqual(calls.slice(cleanupCount),[],kind+' cannot start a native mutation after the held queue is released');
  }
});

test('projection revocation between native phases forbids later selection/resize/close/new mutations',async()=>{
  for(const kind of ['close','select','resize','new']) {
    const browser=new ChromeBrowser({ProjectionPolicy:class{}}),id='00000000-0000-0000-0000-000000000000',calls=[];
    const projection={id,targets:new Map([['tab',{id:'tab',sessionId:'project-session'}]])};browser.projection=projection;browser.tabId=kind==='select'?'previous':'tab';browser.sessionId='ui';browser.requestFrame=()=>{};
    browser.tabs=async()=>[{id:'tab'},{id:'previous'}];
    let release,entered=false;const gate=new Promise(resolve=>{release=resolve;});
    browser.call=async method=>{calls.push(method);if(method===(kind==='new'?'Target.createTarget':'Page.stopScreencast')){entered=true;await gate;return{targetId:'new-tab'};}return{};};
    const command=kind==='close'?{method:'Target.closeTarget',params:{targetId:'tab'}}:kind==='new'?{method:'Target.createTarget',params:{url:'about:blank'}}:kind==='select'?{method:'Page.bringToFront',sessionId:'project-session',params:{}}:{method:'Emulation.setDeviceMetricsOverride',sessionId:'project-session',params:{width:390,height:844,mobile:false,deviceScaleFactor:1}};
    const pending=browser.project({id,operation:'command',...command});pending.catch(()=>{});
    await waitFor(()=>entered);await browser.projectClose(projection);const cleanupCount=calls.length;release();
    await assert.rejects(pending,/denied|revoked/);assert.deepEqual(calls.slice(cleanupCount),[],kind+' cannot continue native mutations after a held authorized phase completes');
  }
});

test('projected resize cannot mutate a different UI selection after its layout wait',async()=>{
  const browser=new ChromeBrowser({ProjectionPolicy:class{}}),id='00000000-0000-0000-0000-000000000000',calls=[];
  browser.projection={id,targets:new Map([['tab',{id:'tab',sessionId:'project-session'}]])};browser.tabId='tab';browser.sessionId='ui';
  let release,queued=false;browser.layoutQueue=new Promise(resolve=>{release=resolve;});
  const update=browser.updateLayout.bind(browser);browser.updateLayout=callback=>{queued=true;return update(callback);};
  browser.call=async method=>{calls.push(method);return{};};
  const pending=browser.project({id,operation:'command',method:'Emulation.setDeviceMetricsOverride',sessionId:'project-session',params:{width:390,height:844,mobile:false,deviceScaleFactor:1}});pending.catch(()=>{});
  await waitFor(()=>queued);browser.tabId='other';release();
  await assert.rejects(pending,/denied/);assert.deepEqual(calls,[]);
});

test('projected screenshot cannot capture after revocation or UI selection change during metrics read',async()=>{
  for(const change of ['revoke','selection']) {
    const browser=new ChromeBrowser({ProjectionPolicy:class{}}),id='00000000-0000-0000-0000-000000000000',calls=[];
    const projection={id,targets:new Map([['tab',{id:'tab',sessionId:'project-session'}]])};browser.projection=projection;browser.tabId='tab';browser.sessionId='ui';
    let release,entered=false;const gate=new Promise(resolve=>{release=resolve;});
    browser.call=async method=>{calls.push(method);if(method==='Page.getLayoutMetrics'){entered=true;await gate;return{visualViewport:{pageX:0,pageY:0}};}return{};};
    const pending=browser.project({id,operation:'command',method:'Page.captureScreenshot',sessionId:'project-session',params:{format:'png'}});pending.catch(()=>{});
    await waitFor(()=>entered);if(change==='revoke')await browser.projectClose(projection);else browser.tabId='other';release();
    await assert.rejects(pending,/denied/);assert.equal(calls.includes('Page.captureScreenshot'),false,change);
  }
});

test('status cannot publish a pre-await selected target over the current UI selection',async t=>{
  const browser=new ChromeBrowser();let release,reads=0;
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()}),worker=new BrowserProcess(child);
  t.after(()=>{worker.fail(Error('Synthetic teardown'));child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();});
  child.stdout.write(JSON.stringify({event:'ready',value:{running:true,tabId:'closed-second',tabs:[{id:'closed-second'}]}})+'\n');await worker.ready;
  browser.tabId='closed-second';browser.tabs=()=>++reads===1?new Promise(resolve=>{release=resolve;}):Promise.resolve([{id:'remaining-first'}]);
  const pending=browser.status();browser.tabId='remaining-first';
  child.stdout.write(JSON.stringify({event:'status',value:{running:true,tabId:'remaining-first',tabs:[{id:'remaining-first'}]}})+'\n');
  release([{id:'remaining-first'}]);const state=await pending;
  child.stdout.write(JSON.stringify({event:'status',value:state})+'\n');
  assert.equal(worker.state.tabId,'remaining-first');assert.ok(worker.state.tabs.some(tab=>tab.id===worker.state.tabId));
});

test('status publication rejects every superseded stamp and bounded churn never invents a snapshot',async()=>{
  for(const change of [browser=>{browser.tabId='other';},browser=>{browser.viewport={width:390,height:844};},browser=>{browser.failed=Error('Synthetic stop');},browser=>{browser.targetRevision++;}]) {
    const browser=new ChromeBrowser(),published=[];browser.tabId='first';browser.tabs=async()=>[{id:'first'}];browser.on('status',value=>published.push(value));
    const before=await browser.status();change(browser);browser.publishStatus(before);assert.deepEqual(published,[]);
  }
  const browser=new ChromeBrowser(),published=[];let reads=0;browser.tabId='first';browser.on('status',value=>published.push(value));
  browser.tabs=async()=>{reads++;browser.targetRevision++;return[{id:'first'}];};
  await assert.rejects(browser.status(),/state changed/);assert.equal(reads,3);assert.deepEqual(published,[]);
});

test('private guest bridge keeps reply/event ordering under held authority and clears both on revoke',{timeout:5000},async t=>{
  for(const revoke of [false,true]) {
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()}),worker=new BrowserProcess(child);
    child.stdout.write(JSON.stringify({event:'ready',value:{running:true}})+'\n');await worker.ready;
    let projectionId,socket,outputWritten=false,release,valid=true;
    const gate=new Promise(resolve=>{release=resolve;}),received=[];
    const reply=(id,value)=>child.stdout.write(JSON.stringify({id,value})+'\n');
    child.stdin.on('data',data=>{
      const command=JSON.parse(data);
      if(command.params?.operation==='open'){projectionId=command.params.id;reply(command.id,{tabId:'tab'});return;}
      if(command.params?.operation==='command'){
        outputWritten=true;
        child.stdout.write(JSON.stringify({id:command.id,value:{frameTree:{frame:{id:'tab'}}}})+'\n'+JSON.stringify({event:'projection',value:{id:projectionId,sessionId:'page',method:'Runtime.executionContextCreated',params:{context:{id:1}}}})+'\n');return;
      }
      reply(command.id,command.params?.operation==='close'?{closed:true}:{});
    });
    const playwright={chromium:{connectOverCDP:async(url,{headers})=>{
      socket=new WebSocket(url,{headers});socket.on('message',data=>received.push(JSON.parse(data)));socket.on('error',()=>{});await once(socket,'open');
      return{contexts:()=>[{pages:()=>[{}]}],isConnected:()=>socket.readyState===1,close:async()=>{socket.terminate();}};
    }}};
    const lease=await acquireGuestProjection({browser:worker,playwright,retainCleanup:()=>{},validate:async()=>{if(outputWritten)await gate;return valid;}});
    t.after(async()=>{release();await lease.release();worker.fail(Error('Synthetic teardown'));child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();});
    socket.send(JSON.stringify({id:77,sessionId:'page',method:'Page.getFrameTree',params:{}}));
    await waitFor(()=>outputWritten);assert.deepEqual(received,[]);
    if(revoke)valid=false;
    release();
    if(revoke){await waitFor(()=>socket.readyState===3);assert.deepEqual(received,[],'revocation discards queued replies and events');}
    else{await waitFor(()=>received.length===2);assert.equal(received[0].id,77);assert.equal(received[1].method,'Runtime.executionContextCreated');}
    await lease.release();worker.fail(Error('Synthetic teardown'));child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
  }
});
