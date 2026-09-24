import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import WebSocket from 'ws';
import {acquireGuestProjection} from '../src/guest-browser-projection.mjs';
import {acquirePersonalProjection} from '../src/personal-browser-projection.mjs';
import {waitFor} from './helpers.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,mode) {
  const worker=Object.assign(new EventEmitter(),{child:{}}),personal=new EventEmitter(),abort=new AbortController();
  const grant={chatId:'synthetic-chat',active:true,bridge:{}},viewport={width:390,height:844};
  const state={feed:false,rounds:0,emitted:0,received:0,maxUnreceived:0,commands:0,statusReads:0,selections:0,valid:true};
  let id,socket,cleanup;
  const responses=[];
  worker.dispatch=async(action,params={},options={})=>{
    if(action==='project'&&params.operation==='open'){id=params.id;return{tabId:'tab'};}
    if(action==='project'&&params.operation==='close')return{closed:true};
    if(action==='status'){state.statusReads++;return{tabId:'tab',viewport};}
    state.commands++;const value={frameTree:{frame:{id:'tab',url:'about:blank'}}};options.onResponse({value});return value;
  };
  personal.currentGrant=()=>grant;
  personal.request=async(_bridge,_action,params)=>{
    if(params.operation==='open'){id=params.id;return{frame:{id:'tab',url:'about:blank'}};}
    if(params.operation==='close')return{};
    state.commands++;return{frameTree:{frame:{id:'tab',url:'about:blank'}}};
  };
  const emit=()=>{
    state.emitted++;state.maxUnreceived=Math.max(state.maxUnreceived,state.emitted-state.received);
    const event={id,sessionId:'page',method:'Network.loadingFinished',params:{requestId:String(state.emitted),timestamp:0,encodedDataLength:1}};
    if(mode==='guest')worker.emit('projection',event);else personal.emit('projection',grant,event);
  };
  const validate=async()=>{
    if(state.hold)await state.hold;
    if(state.feed){state.rounds++;await tick();if(state.feed)for(let i=0;i<64;i++)emit();}
    return state.valid;
  };
  const playwright={chromium:{connectOverCDP:async(url,{headers})=>{
    socket=new WebSocket(url,{headers});socket.on('error',()=>{});socket.on('message',data=>{
      const value=JSON.parse(data);if(value.method==='Network.loadingFinished')state.received++;else responses.push(value);
    });await once(socket,'open');
    return{contexts:()=>[{pages:()=>[{viewportSize:()=>viewport}]}],isConnected:()=>socket.readyState===1,close:async()=>socket.terminate()};
  }}};
  const lease=mode==='guest'
    ?await acquireGuestProjection({browser:worker,playwright,validate,signal:abort.signal,retainCleanup:value=>{cleanup=value;}})
    :await acquirePersonalProjection({personal,grant,playwright,validate,signal:abort.signal});
  t.after(async()=>{state.feed=false;state.releaseHold?.();abort.abort();await (cleanup||lease).release();});
  if(mode==='guest')worker.emit('projection',{id,method:'Target.attachedToTarget',params:{sessionId:'page',targetInfo:{targetId:'tab'}}});
  else socket.send(JSON.stringify({id:1,method:'Target.setAutoAttach',params:{autoAttach:true,flatten:true,waitForDebuggerOnStart:true}}));
  await waitFor(()=>responses.some(value=>value.method==='Target.attachedToTarget'));
  return{state,lease,socket,responses,emit,abort};
}

test('guest and personal finite watermarks admit commands during continuous authorized events below bounds',{timeout:5000},async t=>{
  for(const mode of ['guest','personal']) {
    const f=await fixture(t,mode);f.state.feed=true;f.emit();
    f.socket.send(JSON.stringify({id:77,sessionId:'page',method:'Page.getFrameTree',params:{}}));
    let prepared=mode==='personal';
    const preparing=mode==='guest'?f.lease.beforeTool({selectTab:async()=>{f.state.selections++;},resize:async()=>assert.fail('Unexpected resize')}).then(()=>{prepared=true;}):Promise.resolve();
    await waitFor(()=>f.state.rounds>=40);
    assert.equal(f.state.feed,true);assert.equal(f.lease.isCurrent(),true);
    assert.ok(f.state.received>1000);assert.ok(f.state.maxUnreceived<1024);
    assert.equal(f.state.commands,1,mode+' admits the request without requiring future events to stop');
    assert.equal(prepared,true);if(mode==='guest'){assert.equal(f.state.statusReads,1);assert.equal(f.state.selections,1);}
    await waitFor(()=>f.responses.some(value=>value.id===77));
    f.state.feed=false;await preparing;await f.lease.release();
  }
});

test('release rejects held event-prefix barriers without dispatching queued commands in either mode',{timeout:5000},async t=>{
  for(const mode of ['guest','personal']) {
    const f=await fixture(t,mode);f.state.hold=new Promise(resolve=>{f.state.releaseHold=resolve;});f.emit();
    f.socket.send(JSON.stringify({id:77,sessionId:'page',method:'Page.getFrameTree',params:{}}));
    await tick();await tick();f.abort.abort();f.state.releaseHold();
    await f.lease.release();await waitFor(()=>f.socket.readyState===3);
    assert.equal(f.state.commands,0);assert.equal(f.state.received,0);assert.equal(f.lease.isCurrent(),false);
  }
});

test('overflow and failed authorization reject pending prefixes without releasing stale output in either mode',{timeout:5000},async t=>{
  for(const mode of ['guest','personal'])for(const failure of ['overflow','authorization']) {
    const f=await fixture(t,mode);f.state.hold=new Promise(resolve=>{f.state.releaseHold=resolve;});f.emit();
    f.socket.send(JSON.stringify({id:77,sessionId:'page',method:'Page.getFrameTree',params:{}}));
    await tick();await tick();
    if(failure==='overflow')for(let i=0;i<1025;i++)f.emit();
    else f.state.valid=false;
    f.state.releaseHold();await waitFor(()=>f.socket.readyState===3);await f.lease.release();
    assert.equal(f.state.commands,0,mode+' '+failure);assert.equal(f.state.received,0);assert.equal(f.lease.isCurrent(),false);
    assert.equal(f.responses.some(value=>value.id===77),false);
  }
});
