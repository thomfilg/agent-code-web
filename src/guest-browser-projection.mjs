import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';

// Controller-private bridge to the already owned worker's private Chrome pipe.
// Never a worker debug port, browser launcher, user endpoint or agent capability.
export async function acquireGuestProjection({browser:worker,playwright,validate,signal,retainCleanup}) {
  if(typeof retainCleanup!=='function')throw Error('Guest projection cleanup owner is required');
  const id = randomUUID(), token = randomBytes(32).toString('hex'), targets = [];
  let stopped = false, socket, browser, context, opening, listening, connecting, openSent = false, cleanupConfirmed = false, pending = 0, queuedBytes = 0, draining = false;
  const events=[],barriers=new Set();let queuedSequence=0,processedSequence=0;
  let eventQueue = Promise.resolve(), releasing;
  const denied = () => Error('Guest browser projection unavailable');
  const server = createServer((_req,res) => {res.writeHead(404);res.end();});
  const sockets = new WebSocketServer({noServer:true,maxPayload:1024*1024});
  const current = async () => {
    if (stopped || signal?.aborted || worker.error || worker.stopping || worker.child.detached || await validate() !== true) throw denied();
    if (stopped || signal?.aborted || worker.error || worker.stopping || worker.child.detached) throw denied();
  };
  const send = value => {
    if (stopped || socket?.readyState !== 1) return;
    if (socket.bufferedAmount + Buffer.byteLength(JSON.stringify(value)) > 2*1024*1024) {void release().catch(()=>{});return;}
    socket.send(JSON.stringify(value));
  };
  const enqueue = (kind,value) => {
    if(stopped)return;
    const bytes=Buffer.byteLength(JSON.stringify(value));
    if(events.length>=1024||queuedBytes+bytes>2*1024*1024){void release().catch(()=>{});return;}
    events.push({kind,value,bytes,sequence:++queuedSequence});queuedBytes+=bytes;
    drain();
  };
  const event=value=>{if(value.id===id)enqueue('event',value);};
  function drain() {
    if(draining||stopped||!events.length)return;
    draining=true;
    eventQueue=(async()=>{while(events.length&&!stopped){
      // A bounded synchronous batch shares one durable authorization boundary;
      // don't serialize an entire record read for every asset-network event.
      await current();const batch=events.splice(0,64);
      for(const {kind,value,bytes,sequence} of batch){if(stopped)break;queuedBytes-=bytes;
      if(kind==='reply')send(value);
      else {
      if (value.method === 'Target.attachedToTarget') {
        const target = value.params.targetInfo.targetId;
        if (!targets.includes(target)) targets.push(target);
      }
      if (value.method === 'Target.detachedFromTarget') {const index=targets.indexOf(value.params.targetId);if(index>=0)targets.splice(index,1);}
      const {id:_,...message} = value;send(message);
      }
      processedSequence=sequence;
      if(!stopped)for(const barrier of barriers)if(processedSequence>=barrier.until){barriers.delete(barrier);barrier.resolve();}
      }
    }})().catch(() => {void release().catch(()=>{});}).finally(()=>{draining=false;drain();});
  }
  const drainEvents=()=>{
    if(stopped)return Promise.reject(denied());
    const until=queuedSequence;if(processedSequence>=until)return Promise.resolve();
    if(barriers.size>=65){void release().catch(()=>{});return Promise.reject(denied());}
    return new Promise((resolve,reject)=>barriers.add({until,resolve,reject}));
  };
  const closed = value => {if (!value?.id || value.id === id) void release().catch(()=>{});};
  const status = value => {if (value.detached || !value.running) void release().catch(()=>{});};
  server.on('upgrade',(request,connection,head) => {
    const candidate = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '')?.[1];
    if (socket || stopped || request.headers.origin || request.url !== '/' || !candidate || !timingSafeEqual(Buffer.from(candidate),Buffer.from(token))) {connection.destroy();return;}
    sockets.handleUpgrade(request,connection,head,ws => {
      socket=ws;ws.on('error',()=>{});ws.once('close',()=>{void release().catch(()=>{});});
      ws.on('message',data => {
        if (++pending>64) {pending--;void release().catch(()=>{});return;}
        let message;try{message=JSON.parse(data);}catch{pending--;void release().catch(()=>{});return;}
        if (!message || !Number.isSafeInteger(message.id) || typeof message.method !== 'string' || Object.keys(message).some(key=>!['id','method','params','sessionId'].includes(key))) {pending--;void release().catch(()=>{});return;}
        let replied=false;
        const run = async () => {
          await drainEvents();await current();
          await worker.dispatch('project',{id,operation:'command',method:message.method,params:message.params||{},...(message.sessionId?{sessionId:message.sessionId}:{})},{onResponse:packet=>{
            replied=true;
            enqueue('reply',{id:message.id,sessionId:message.sessionId,...(packet.error?{error:{code:-32000,message:'Guest browser protocol denied'}}:{result:packet.value})});
          }});
          if(!replied)throw denied();
        };
        void run().catch(()=>{if(!replied)enqueue('reply',{id:message.id,sessionId:message.sessionId,error:{code:-32000,message:'Guest browser protocol denied'}});}).finally(()=>{pending--;});
      });
    });
  });
  function release() {
    if(releasing)return releasing;
    stopped=true;events.length=0;queuedBytes=0;worker.off('projection',event);worker.off('projectionClosed',closed);worker.off('closed',closed);worker.off('status',status);signal?.removeEventListener('abort',abort);
    for(const barrier of barriers)barrier.reject(denied());barriers.clear();
    releasing=(async()=>{
      socket?.terminate();sockets.close();
      await opening?.catch(()=>{});await listening?.catch(()=>{});await connecting?.catch(()=>{});
      await browser?.close().catch(()=>{});
      await new Promise(resolve=>server.listening?server.close(resolve):resolve());
      // Never ensureConnected/restart a helper from cleanup or replay an input.
      if(openSent&&!cleanupConfirmed){
        if(worker.ownedStopConfirmed){cleanupConfirmed=true;return;}
        if(worker.error||worker.stopping||worker.child.detached)throw Error('Guest projection cleanup unconfirmed');
        const receipt=await worker.dispatch('project',{id,operation:'close'});
        if(receipt?.closed!==true)throw Error('Guest projection cleanup unconfirmed');
        cleanupConfirmed=true;
      }
    })().catch(()=>{releasing=null;throw Error('Guest projection cleanup unconfirmed');});return releasing;
  }
  const abort=()=>{void release().catch(()=>{});};
  worker.on('projection',event);worker.on('projectionClosed',closed);worker.on('closed',closed);worker.on('status',status);signal?.addEventListener('abort',abort,{once:true});
  try {
    retainCleanup({release});
    await current();openSent=true;opening=worker.dispatch('project',{id,operation:'open'});await opening;await current();
    listening=new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});await listening;await current();
    connecting=playwright.chromium.connectOverCDP(`ws://127.0.0.1:${server.address().port}/`,{headers:{Authorization:`Bearer ${token}`},noDefaults:true,timeout:10000}).then(value=>{browser=value;return value;});
    await connecting;await current();context=browser.contexts()[0];if(!context||context.pages().length<1)throw denied();
    return {context,release,isCurrent:()=>!stopped&&!worker.error&&!worker.stopping&&!worker.child.detached&&browser.isConnected(),beforeTool:async ({selectTab,resize})=>{
      await current();await drainEvents();
      const state=await worker.dispatch('status');await current();
      const index=targets.indexOf(state.tabId);
      if(index<0||context.pages().length!==targets.length)throw denied();
      await selectTab(index);await current();
      const viewport=context.pages()[index].viewportSize();
      if(!viewport||viewport.width!==state.viewport.width||viewport.height!==state.viewport.height){await resize(state.viewport);await current();}
    }};
  }catch{await release();throw denied();}
}
