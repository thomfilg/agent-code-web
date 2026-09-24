import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ChromeBrowser} from '../src/browser-worker.mjs';
import {SharedBrowsers,BrowserProcess} from '../src/shared-browser.mjs';
import {OfficialBrowserMcp} from '../src/official-browser-mcp.mjs';
import {acquireGuestProjection} from '../src/guest-browser-projection.mjs';
import {waitFor} from './helpers.mjs';

const id='00000000-0000-0000-0000-000000000000',nextId='11111111-1111-1111-1111-111111111111';
test('exact projection cleanup retains failed detach ownership and blocks reopen until confirmed',async()=>{
  const browser=new ChromeBrowser({ProjectionPolicy:class{}});let fail=true,detaches=0;
  const projection={id,targets:new Map([['tab',{id:'tab',sessionId:'owned-session'}]])};browser.projection=projection;
  browser.call=async(method,params)=>{assert.equal(method,'Target.detachFromTarget');assert.equal(params.sessionId,'owned-session');detaches++;if(fail)throw Error('Synthetic private detach failure');return{};};
  await assert.rejects(browser.projectClose(projection),/cleanup unconfirmed/);
  assert.equal(browser.projection,null);assert.equal(browser.closingProjections.get(id),projection);
  await assert.rejects(browser.project({id:nextId,operation:'open'}),/denied/);
  assert.deepEqual(await browser.project({id:nextId,operation:'close'}),{closed:true});assert.equal(detaches,1,'foreign-ID close cannot release old ownership');
  fail=false;assert.deepEqual(await browser.project({id,operation:'close'}),{closed:true});assert.equal(detaches,2);assert.equal(browser.closingProjections.size,0);
  assert.deepEqual(await browser.project({id,operation:'close'}),{closed:true});assert.equal(detaches,2,'confirmed absence is idempotent');
  browser.projectSync=async()=>{};await browser.project({id:nextId,operation:'open'});assert.equal(browser.projection.id,nextId);
});

test('attach acknowledged after revocation remains owned if its detach fails',async()=>{
  const browser=new ChromeBrowser({ProjectionPolicy:class{}}),projection={id,targets:new Map()};browser.projection=projection;browser.tabs=async()=>[{id:'tab'}];
  let release,entered=false,fail=true;const gate=new Promise(resolve=>{release=resolve;});
  browser.call=async(method)=>{if(method==='Target.attachToTarget'){entered=true;await gate;return{sessionId:'late-session'};}assert.equal(method,'Target.detachFromTarget');if(fail)throw Error('Synthetic detach failure');return{};};
  const opening=browser.projectSync(projection);opening.catch(()=>{});await waitFor(()=>entered);
  const closing=browser.projectClose(projection);closing.catch(()=>{});release();
  await assert.rejects(opening,/revoked/);await assert.rejects(closing,/cleanup unconfirmed/);
  assert.equal(projection.targets.get('tab').sessionId,'late-session');assert.equal(browser.closingProjections.get(id),projection);
  fail=false;await browser.project({id,operation:'close'});assert.equal(browser.closingProjections.size,0);
});

test('lost open ACK always exact-closes; failed close remains available through retained cleanup owner',async()=>{
  for(const failFirstClose of [false,true]) {
    const worker=Object.assign(new EventEmitter(),{child:{}});let ownedId,retained,opens=0,closes=0;
    worker.dispatch=async(_action,params)=>{
      if(params.operation==='open'){opens++;ownedId=params.id;throw Error('Synthetic lost open ACK');}
      assert.equal(params.operation,'close');assert.equal(params.id,ownedId);closes++;
      if(failFirstClose&&closes===1)throw Error('Synthetic private close failure');return{closed:true};
    };
    await assert.rejects(acquireGuestProjection({browser:worker,validate:async()=>true,playwright:{chromium:{connectOverCDP:()=>assert.fail('No acquisition after lost open ACK')}},retainCleanup:receipt=>{retained=receipt;}}),/unavailable|cleanup unconfirmed/);
    assert.equal(opens,1);assert.equal(closes,1);await retained.release();assert.equal(closes,failFirstClose?2:1);assert.equal(opens,1);
  }
});

test('official context acquisition rejection retains cleanup receipt for explicit retry',async t=>{
  let releases=0;
  const binding={ownerId:'owner',chatId:'chat',companyId:'company',environmentId:'environment',provider:'codex',accountId:'account',accountRevision:1,companyRevision:1,environmentRevision:1,attemptId:'attempt',mode:'guest',generation:1};
  const proxy=new OfficialBrowserMcp({binding,validateBinding:async()=>true,acquireContext:async({retainCleanup})=>{
    retainCleanup({release:async()=>{if(++releases===1)throw Error('Synthetic private cleanup failure');}});throw Error('Synthetic failed acquisition after open');
  }});t.after(()=>proxy.revoke());
  await assert.rejects(proxy.callTool({name:'browser_snapshot'}),/REVOKED/);assert.equal(releases,1);
  await proxy.revoke();assert.equal(releases,2);await assert.rejects(proxy.callTool({name:'browser_snapshot'}),/REVOKED/);
});

test('runtime replacement cannot lose a failed prior cleanup owner before any new proxy exists',async()=>{
  const browsers=new SharedBrowsers({store:{},config:{sessionCapabilityTtlMs:60000}});let releases=0,fail=true;
  browsers.browserAttempts.set('chat',{proxy:{revoke:async()=>{releases++;if(fail)throw Error('Synthetic cleanup failure');}}});
  for(let i=0;i<2;i++){browsers.runtime('chat','http://127.0.0.1',{validWhile:()=>true});await assert.rejects(browsers.browserAttempts.get('chat').previousCleanup);}
  fail=false;browsers.runtime('chat','http://127.0.0.1',{validWhile:()=>true});await browsers.browserAttempts.get('chat').previousCleanup;
  assert.ok(releases>=3);await browsers.stop('chat');assert.equal(browsers.browserAttempts.has('chat'),false);
});

test('explicit Stop still terminates owned worker after projection failure and retains receipts on failed termination',async()=>{
  const browsers=new SharedBrowsers({store:{},config:{sessionCapabilityTtlMs:60000}});let stops=0,fail=true;
  const browser={child:{},stop:async()=>{stops++;if(fail)throw Error('Synthetic owner termination failed');browser.ownedStopConfirmed=true;}};
  const attempt={proxy:{revoke:async()=>{if(!browser.ownedStopConfirmed)throw Error('Synthetic projection cleanup uncertain');}}};
  const entry={browser,ready:Promise.resolve(),viewers:new Set()};browsers.entries.set('chat',entry);browsers.browserAttempts.set('chat',attempt);
  await assert.rejects(browsers.stop('chat'),/termination failed/);assert.equal(stops,1);assert.equal(browsers.entries.get('chat'),entry);assert.equal(browsers.browserAttempts.get('chat'),attempt);
  fail=false;await browsers.stop('chat');assert.equal(stops,2);assert.equal(browsers.entries.has('chat'),false);assert.equal(browsers.browserAttempts.has('chat'),false);
});

test('a helper exit alone never confirms owned Chrome termination; its private stop receipt does',{timeout:6000},async t=>{
  for(const confirmed of [false,true]) {
    const child=Object.assign(new EventEmitter(),{exitCode:0,signalCode:null,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()}),browser=new BrowserProcess(child);
    t.after(()=>{browser.fail(Error('Synthetic teardown'));child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();});
    child.stdout.write(JSON.stringify({event:'ready',value:{running:true}})+'\n');await browser.ready;
    if(confirmed)child.stdout.write(JSON.stringify({event:'chromeStopped',value:{stopped:true}})+'\n');
    if(confirmed){await browser.stop();assert.equal(browser.ownedStopConfirmed,true);}
    else{
      await assert.rejects(browser.stop(),/termination is unconfirmed/);assert.notEqual(browser.ownedStopConfirmed,true);
      child.stdout.write(JSON.stringify({event:'chromeStopped',value:{stopped:true}})+'\n');
      await browser.stop();assert.equal(browser.ownedStopConfirmed,true,'explicit retry can use the subsequently confirmed exact owned stop');
    }
  }
});
