import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createAgentWebServer} from '../src/server.mjs';
import {BrowserProcess} from '../src/shared-browser.mjs';
import {temporaryDirectory,testConfig,waitFor} from './helpers.mjs';
import {startBrowserSite} from './fixtures/browser-site.mjs';

test('guest official MCP uses the normal private-pipe worker, current UI tab and viewport without starting a model', {timeout:60000}, async t => {
  const root=await temporaryDirectory(t),site=await startBrowserSite(),protocolFailures=[],inflight=new Map();let starts=0,models=0,client,projectionId,holdMutation,commandSeq=0,largestFrame=0;
  const app=await createAgentWebServer({config:testConfig(root,{AGENT_CHROME_BIN:'/usr/bin/google-chrome-stable',AGENT_IDLE_TIMEOUT_MS:'60000'}),
    adapterFactory:()=>{models++;throw Error('No model in browser fixture');},
    browserOptions:{isActive:()=>true,acquire:async()=>({workspace:root,runtimeHome:root,spawn:(command,args,options)=>{if(command==='node'&&args.includes('--input-type=module'))starts++;return spawn(command,args,options);}}),processFactory:child=>{
      const browser=new BrowserProcess(child),dispatch=browser.dispatch.bind(browser);
      browser.dispatch=async(action,params,options={})=>{
        const seq=++commandSeq;if(action==='project'){if(params.operation==='open')projectionId=params.id;largestFrame=Math.max(largestFrame,Buffer.byteLength(JSON.stringify(params)));inflight.set(seq,{method:params.method||params.operation,started:Date.now()});}
        const held=holdMutation&&action==='project'&&params.method==='Input.dispatchMouseEvent'&&params.params.type==='mouseReleased';
        const callback=options.onResponse;
        const forwarded=held&&callback?{...options,onResponse:packet=>{void holdMutation.then(()=>callback(packet));}}:options;
        try{const result=await dispatch(action,params,forwarded);if(held)await holdMutation;return result;}
        catch(error){if(action==='project'&&protocolFailures.length<30)protocolFailures.push({method:params?.method,error:error.message});else if(action!=='project')error.message+=' [synthetic UI action: '+action+']';throw error;}
        finally{inflight.delete(seq);}
      };
      return browser;
    }}});
  const {url}=await app.start();t.after(async()=>{await client?.close();await app.stop();await site.close();});
  const ownerId=`user_${randomBytes(16).toString('hex')}`,services=await app.resources.forOwner(ownerId);
  await services.companies.save({id:'guest-company',name:'Guest fixture'});
  const environment=await services.environments.save({name:'Guest environment',backend:'local',companyId:'guest-company'});
  const accountId=`account_${randomUUID()}`;
  await app.manager.agentAccounts.save({id:accountId,ownerId,provider:'codex',name:'Synthetic guest account',status:'connected',revision:1,auth:{synthetic:true}});
  const chat=await app.store.create({ownerId,agent:'codex',agentAccountId:accountId,environmentId:environment.id,repositories:[{companyId:'guest-company',fullName:'fixture/guest'}],title:'Guest browser fixture'});
  const anonymous=await app.store.create({agent:'mock',title:'Legacy UI only'}),denied=app.manager.browsers.runtime(anonymous.id,url,{validWhile:()=>true}).relay_browser;
  assert.equal((await fetch(denied.url,{method:'POST',headers:{...denied.headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).status,403);
  assert.equal(starts,0,'anonymous scope cannot wake a worker through discovery');
  let live=true;
  const runtime=app.manager.browsers.runtime(chat.id,url,{validWhile:()=>live}).relay_browser;
  client=new Client({name:'synthetic-guest-agent',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(runtime.url),{requestInit:{headers:runtime.headers}}));
  const catalog=await client.listTools();assert.ok(catalog.tools.some(tool=>tool.name==='browser_type'));assert.equal(starts,0,'discovery never starts a worker');
  const call=async(name,args={})=>{try{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return result;}catch(error){error.message+=' '+name+(args.action?':'+args.action:'')+' '+JSON.stringify({failures:protocolFailures,inflight:[...inflight.values()].map(value=>({method:value.method,elapsedMs:Date.now()-value.started})),largestFrame});throw error;}};
  await call('browser_navigate',{url:site.url});
  assert.match((await call('browser_tabs',{action:'list'})).content[0].text,/^Browser mode: guest\./);
  const entry=app.manager.browsers.entries.get(chat.id),child=entry.browser.child;
  assert.ok(child.spawnargs.includes('--input-type=module'));assert.equal(starts,1);
  for(const method of ['Storage.getCookies','Browser.close','Target.attachToTarget','Target.createBrowserContext'])await assert.rejects(entry.browser.dispatch('project',{id:projectionId,operation:'command',method,params:{}}),/denied/);
  await assert.rejects(entry.browser.dispatch('project',{id:projectionId,operation:'command',method:'Runtime.evaluate',sessionId:'unowned-session',params:{expression:'1'}}),/denied/);
  await call('browser_click',{target:'#click'});await call('browser_type',{target:'#entry',text:'Guest official typing'});
  assert.equal(await app.manager.browsers.command(chat.id,'evaluate',{expression:"document.querySelector('#entry').value"}),'Guest official typing');
  assert.match(JSON.stringify(await call('browser_snapshot')),/Clicks: 1/);
  assert.match(JSON.stringify(await call('browser_evaluate',{function:'() => document.title'})),/fixture/i);
  assert.match(JSON.stringify(await call('browser_evaluate',{function:"async () => { await Promise.all(Array.from({length:96},(_,i)=>fetch('/synthetic-asset?i='+i).then(r=>r.text()))); history.pushState({},'', '/spa-state'); document.body.dataset.assetBurst='complete'; return '96 assets complete'; }"})),/96 assets complete/);
  assert.match(JSON.stringify(await call('browser_snapshot')),/Live development fixture/);
  await call('browser_resize',{width:390,height:844});
  assert.deepEqual(app.manager.browsers.info(chat.id).viewport,{width:390,height:844});
  assert.deepEqual(await app.manager.browsers.command(chat.id,'evaluate',{expression:'[innerWidth,innerHeight,devicePixelRatio]'}),[390,844,2]);
  const screenshot=await call('browser_take_screenshot'),images=screenshot.content.filter(item=>item.type==='image');assert.equal(images.length,1);assert.doesNotMatch(screenshot.content[0].text,/\.png|\/tmp/);
  const pixels=Buffer.from(images[0].data,'base64');assert.deepEqual([pixels.readUInt32BE(16),pixels.readUInt32BE(20)],[390,844]);
  const first=app.manager.browsers.info(chat.id).tabId;
  await call('browser_tabs',{action:'new',url:site.url});
  const second=app.manager.browsers.info(chat.id).tabId;assert.notEqual(second,first);
  await app.manager.browsers.command(chat.id,'selectTab',{id:first});
  await call('browser_type',{target:'#entry',text:'UI-selected first tab'});
  assert.equal(app.manager.browsers.info(chat.id).tabId,first);
  await call('browser_tabs',{action:'select',index:1});assert.equal(app.manager.browsers.info(chat.id).tabId,second);
  const symbolic=state=>({selected:state.tabId===first?'first':state.tabId===second?'second':state.tabId?'other':'none',tabs:state.tabs.map(tab=>tab.id===first?'first':tab.id===second?'second':'other')});
  const beforeClose={ui:symbolic(app.manager.browsers.info(chat.id)),native:symbolic(await entry.browser.dispatch('status'))};
  await call('browser_tabs',{action:'close',index:1});
  try{await waitFor(()=>app.manager.browsers.info(chat.id).tabs.length===1&&app.manager.browsers.info(chat.id).tabId===first);}
  catch(error){error.message+=' '+JSON.stringify({beforeClose,afterClose:{ui:symbolic(app.manager.browsers.info(chat.id)),native:symbolic(await entry.browser.dispatch('status'))},failures:protocolFailures,inflight:[...inflight.values()].map(value=>({method:value.method,elapsedMs:Date.now()-value.started}))});throw error;}
  const afterClose=await entry.browser.dispatch('status');assert.deepEqual(afterClose.tabs.map(tab=>tab.id),[first]);assert.equal(afterClose.tabId,first);
  assert.equal(starts,1);assert.equal(models,0);
  let release;holdMutation=new Promise(resolve=>{release=resolve;});
  const mutation=client.callTool({name:'browser_click',arguments:{target:'#click'}});mutation.catch(()=>{});
  try {
    await waitFor(async()=>await app.manager.browsers.command(chat.id,'evaluate',{expression:"document.querySelector('#click').textContent"})==='Clicks: 2');
    live=false;release();await assert.rejects(mutation,/revoked|REVOKED|denied/);
  }finally{release();holdMutation=null;}
  assert.equal(await app.manager.browsers.command(chat.id,'evaluate',{expression:"document.querySelector('#click').textContent"}),'Clicks: 2','stale mutating result is discarded without replay');
  assert.equal(entry.browser.child,child,'scope revocation does not restart the worker');
  await assert.rejects(client.callTool({name:'browser_tabs',arguments:{action:'list'}}),'revocation must not return inferred mode metadata');
  assert.equal(app.manager.browsers.info(chat.id).running,true,'agent projection release leaves user Chrome alive');
  await client.close();live=true;
  const next=app.manager.browsers.runtime(chat.id,url,{validWhile:()=>live}).relay_browser;
  client=new Client({name:'next-synthetic-guest-attempt',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(next.url),{requestInit:{headers:next.headers}}));
  await call('browser_snapshot');
  holdMutation=new Promise(resolve=>{release=resolve;});
  const detachedMutation=client.callTool({name:'browser_click',arguments:{target:'#click'}});detachedMutation.catch(()=>{});
  try {
    await waitFor(async()=>await app.manager.browsers.command(chat.id,'evaluate',{expression:"document.querySelector('#click').textContent"})==='Clicks: 3');
    child.detached=true;child.emit('transportDetached');release();await assert.rejects(detachedMutation,/denied|REVOKED|revoked/);
  }finally{release();holdMutation=null;}
  await assert.rejects(client.callTool({name:'browser_snapshot',arguments:{}}));
  assert.equal(starts,1,'transport loss never reconnects or acquires another worker automatically');
  assert.equal(await app.manager.browsers.command(chat.id,'evaluate',{expression:"document.querySelector('#click').textContent"}),'Clicks: 3');
  await app.manager.browsers.stop(chat.id);await waitFor(()=>child.exitCode!==null||child.signalCode!==null);
  assert.equal(entry.browser.ownedStopConfirmed,true,'explicit owner Stop confirms actual Chrome termination despite projection cleanup uncertainty');
  assert.equal(app.manager.browsers.entries.has(chat.id),false);
  assert.equal(app.store.get(chat.id).messages.length,0);
});
