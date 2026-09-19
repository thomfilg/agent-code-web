import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createAgentWebServer} from '../src/server.mjs';
import {temporaryDirectory,testConfig,waitFor} from './helpers.mjs';
import {startBrowserSite} from './fixtures/browser-site.mjs';
import {ProjectionPolicy} from '../chrome-extension/projection-policy.js';

test('projection policy denies profile/global APIs, foreign handles and fake webpage handle promotion',() => {
  const p = new ProjectionPolicy();
  for (const method of ['Storage.getCookies','Network.getCookies','Browser.close','Target.getTargets','Target.attachToTarget','Target.createTarget','Fetch.disable','Fetch.continueRequest','Page.setDownloadBehavior','Network.getResponseBody','Runtime.compileScript']) assert.throws(() => p.command(method,{}));
  assert.throws(() => p.command('Runtime.evaluate',{expression:'1',contextId:123}));
  p.result('Runtime.evaluate',{result:{type:'object',value:{objectId:'foreign'}}});
  assert.throws(() => p.command('Runtime.getProperties',{objectId:'foreign'}));
  assert.throws(() => p.command('Page.getFrameTree',{escape:true}));
  assert.equal(p.event('Runtime.consoleAPICalled',{args:[{value:'private'}]}),null);
  assert.equal(p.event('Network.requestWillBeSentExtraInfo',{headers:{Cookie:'fake-private'}}),null);
  const event = p.event('Network.requestWillBeSent',{requestId:'1',request:{url:'http://localhost/',method:'GET',headers:{Cookie:'fake-private'},postData:'fake-private'}});
  assert.equal(JSON.stringify(event).includes('fake-private'),false);
  for (const identity of [{key:'Insert'},{code:'Insert'},{windowsVirtualKeyCode:45}]) for (const modifiers of [2,4,8]) assert.throws(() => p.command('Input.dispatchKeyEvent',{type:'keyDown',modifiers,...identity}));
  for (const identity of [{key:'Delete'},{code:'Delete'},{windowsVirtualKeyCode:46}]) assert.throws(() => p.command('Input.dispatchKeyEvent',{type:'keyDown',modifiers:8,...identity}));
  assert.doesNotThrow(() => p.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Delete',modifiers:0}));
});

test('actual extension and official MCP use only the explicitly shared tab through normal gateway', {timeout:60000}, async t => {
  const root = await temporaryDirectory(t), site = await startBrowserSite();
  let workerStarts = 0,modelStarts = 0;
  const app = await createAgentWebServer({config:testConfig(path.join(root,'relay')),
    workerBackend:{kind:'local',acquire:async () => {workerStarts++;throw Error('Worker acquisition forbidden in this browser fixture');},sleep:async()=>{},destroy:async()=>{},shutdown:async()=>{}},
    adapterFactory:() => {modelStarts++;throw Error('Model startup forbidden in this browser fixture');}});
  const {url} = await app.start(); let profile,client;
  t.after(async () => { await client?.close(); await profile?.close(); await app.stop(); await site.close(); });
  // Synthetic Google-format owner, never a fabricated real session/cookie.
  const user = {id:`user_${randomBytes(16).toString('hex')}`,username:'synthetic-user'};
  const services = await app.resources.forOwner(user.id);
  await services.companies.save({id:'fixture-company',name:'Fixture'});
  const environment = await services.environments.save({name:'Fixture',backend:'local',companyId:'fixture-company'});
  const agentId = `account_${randomUUID()}`;
  await app.manager.agentAccounts.save({id:agentId,ownerId:user.id,provider:'codex',name:'Synthetic account',status:'connected',revision:1,auth:{synthetic:true}});
  const chat = await app.store.create({ownerId:user.id,agent:'codex',agentAccountId:agentId,environmentId:environment.id,repositories:[{fullName:'fixture/project',companyId:'fixture-company'}],title:'Synthetic official browser'});
  const pair = await app.manager.browsers.personal.pair(user,{name:'Disposable Chrome',companyId:'fixture-company'});
  const extension = path.resolve('chrome-extension');
  profile = await chromium.launchPersistentContext(path.join(root,'disposable-profile'),{channel:'chromium',headless:true,chromiumSandbox:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker = profile.serviceWorkers()[0] || await profile.waitForEvent('serviceworker');
  const personal = await profile.newPage(), fixtureUrl = site.url.replace('127.0.0.1','localhost'); await personal.goto(fixtureUrl);
  await personal.getByRole('button',{name:'Fixture sign in'}).click();
  const unrelated = await profile.newPage(); await unrelated.goto(site.url);
  await unrelated.evaluate(() => {localStorage.setItem('unrelated-secret','fake-private');document.cookie='unrelated_cookie=fake-cookie';document.title='Unrelated private tab';});
  const popup = await profile.newPage(); await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await popup.locator('#relay-url').fill(url); await popup.locator('#pair-code').fill(pair.code); await popup.getByRole('button',{name:'Pair this Chrome profile'}).click();
  await waitFor(() => app.manager.browsers.personal.bridges.get(pair.id)?.ready);
  await app.manager.browsers.personal.enable(chat.id,user,pair.id);
  const grant = app.manager.browsers.personal.currentGrant(chat.id), tabId = grant.state.tabId;
  const runtime = app.manager.browsers.runtime(chat.id,url,{validWhile:()=>true}).relay_browser;
  const originalRequest = app.manager.browsers.personal.request.bind(app.manager.browsers.personal); let projections = 0, projectionId, holdRelease;
  app.manager.browsers.personal.request = async (...args) => {
    if (args[1] === 'project' && args[2].operation === 'open') {projections++;projectionId = args[2].id;}
    const result = await originalRequest(...args);
    if (holdRelease && args[1] === 'project' && args[2].method === 'Input.dispatchMouseEvent' && args[2].params.type === 'mouseReleased') await holdRelease;
    return result;
  };
  client = new Client({name:'synthetic-product-agent',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(runtime.url),{requestInit:{headers:runtime.headers}}));
  const before = profile.pages().length, catalog = await client.listTools();
  assert.ok(catalog.tools.some(tool => tool.name === 'browser_snapshot'));
  assert.ok(!catalog.tools.some(tool => ['browser_evaluate','browser_run_code_unsafe'].includes(tool.name)));
  assert.equal(profile.pages().length,before); assert.equal(projections,0,'discovery does not acquire projection');
  const call = async (name,args={}) => { const result = await client.callTool({name,arguments:args}); assert.notEqual(result.isError,true,JSON.stringify(result)); return result; };
  await call('browser_navigate',{url:fixtureUrl});
  const snapshot = await call('browser_snapshot');
  assert.match(JSON.stringify(snapshot),/Signed in as Alice/);
  assert.doesNotMatch(JSON.stringify(snapshot),/fake-private|fake-cookie|Unrelated private tab/);
  for (const method of ['Storage.getCookies','Network.getCookies','Browser.close','Target.getTargets','Target.attachToTarget','Fetch.disable']) await assert.rejects(originalRequest(grant.bridge,'project',{operation:'command',id:projectionId,method,params:{}},grant),/denied/);
  const unrelatedSession = await profile.newCDPSession(unrelated);
  const foreign = await unrelatedSession.send('Runtime.evaluate',{expression:'document.body'});
  await assert.rejects(originalRequest(grant.bridge,'project',{operation:'command',id:projectionId,method:'Runtime.getProperties',params:{objectId:foreign.result.objectId}},grant),/denied/);
  await unrelatedSession.detach();
  await call('browser_click',{target:'#click'});
  await waitFor(async () => (await (await fetch(site.url+'/observed')).json()).clicks === 1);
  await call('browser_type',{target:'#entry',text:'Official MCP typed'});
  await waitFor(async () => (await (await fetch(site.url+'/observed')).json()).text === 'Official MCP typed');
  assert.equal(app.manager.browsers.personal.currentGrant(chat.id).state.tabId,tabId);
  assert.equal(personal.isClosed(),false); assert.equal(await unrelated.evaluate(() => localStorage.getItem('unrelated-secret')),'fake-private');
  await assert.rejects(client.callTool({name:'browser_evaluate',arguments:{function:'() => document.cookie'}}));
  await assert.rejects(client.callTool({name:'browser_tabs',arguments:{action:'new'}}));
  const blockedNavigation = await client.callTool({name:'browser_navigate',arguments:{url}});
  assert.equal(blockedNavigation.isError,true,'Relay hostname is still blocked by the owning extension');
  // Hold a real mutating command AFTER the extension executed it; durable account
  // changes must discard its result and must never replay the click.
  let release; holdRelease = new Promise(resolve => {release = resolve;});
  const click = client.callTool({name:'browser_click',arguments:{target:'#click'}}); click.catch(() => {});
  try {
    await waitFor(async () => (await (await fetch(site.url+'/observed')).json()).clicks === 2);
    const record = await app.records.get('agent-account',agentId);
    await app.records.put('agent-account',agentId,{...record,revision:2});
    release(); await assert.rejects(click,/REVOKED|revoked/);
  } finally {release();holdRelease = null;}
  assert.equal((await (await fetch(site.url+'/observed')).json()).clicks,2);
  assert.equal(projections,1,'no automatic reconnect or replay after a stale result');
  assert.equal((await app.manager.browsers.command(chat.id,'status',{})).running,true,'projection detach leaves the authorized user tab alive');
  await client.close();
  const renewedRuntime = app.manager.browsers.runtime(chat.id,url,{validWhile:()=>true}).relay_browser;
  client = new Client({name:'stale-consent',version:'1'});
  const staleConsent = await fetch(renewedRuntime.url,{method:'POST',headers:{...renewedRuntime.headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.equal(staleConsent.status,403,'reconnected account cannot inherit earlier sharing consent');
  await assert.rejects(client.connect(new StreamableHTTPClientTransport(new URL(renewedRuntime.url),{requestInit:{headers:renewedRuntime.headers}})),/Personal browser MCP access is unavailable or revoked/);
  await client.close();
  await app.manager.browsers.personal.revokeChat(chat.id);
  await app.manager.browsers.personal.enable(chat.id,user,pair.id);
  client = new Client({name:'explicit-new-consent',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(renewedRuntime.url),{requestInit:{headers:renewedRuntime.headers}}));
  await call('browser_navigate',{url:fixtureUrl});
  assert.equal(projections,2,'fresh explicit consent may create one new projection');
  app.manager.browsers.personal.bridges.get(pair.id).socket.terminate();
  await waitFor(() => !app.manager.browsers.personal.currentGrant(chat.id));
  await assert.rejects(client.callTool({name:'browser_snapshot',arguments:{}}));
  await waitFor(() => app.manager.browsers.personal.bridges.get(pair.id)?.ready,{timeoutMs:10000});
  assert.equal(app.manager.browsers.personal.currentGrant(chat.id),undefined,'automatic bridge reconnect never restores sharing');
  await client.close();
  const claudeId = `account_${randomUUID()}`;
  await app.manager.agentAccounts.save({id:claudeId,ownerId:user.id,provider:'claude',name:'Synthetic Claude account',status:'connected',revision:1,auth:{synthetic:true},accountIdentity:'synthetic-workspace',subject:'synthetic-user'});
  await app.store.update(chat.id,{agent:'claude',agentAccountId:claudeId});
  await app.manager.browsers.personal.enable(chat.id,user,pair.id);
  const claudeRuntime = app.manager.browsers.runtime(chat.id,url,{validWhile:()=>true}).relay_browser;
  client = new Client({name:'synthetic-claude-product-agent',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(claudeRuntime.url),{requestInit:{headers:claudeRuntime.headers}}));
  await call('browser_navigate',{url:fixtureUrl});
  assert.match(JSON.stringify(await call('browser_snapshot')),/Signed in as Alice/);
  assert.equal(app.manager.browsers.browserAttempts.get(chat.id).proxy.binding.provider,'claude');
  await app.manager.browsers.personal.revokeChat(chat.id);
  assert.equal(personal.isClosed(),false);
  assert.equal(unrelated.isClosed(),false);
  assert.equal(workerStarts,0); assert.equal(modelStarts,0);
  assert.equal(app.store.get(chat.id).messages.length,0,'no native model was started');
});
