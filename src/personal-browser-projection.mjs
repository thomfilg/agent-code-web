import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { ProjectionPolicy } from '../chrome-extension/projection-policy.js';

const leases = new WeakSet();
const providers = new WeakSet();
export const isPersonalProjectionLease = lease => leases.has(lease);
export const isPersonalProjectionProvider = provider => providers.has(provider);
export function personalProjectionProvider(options) {
  const provider = input => acquirePersonalProjection({...options,...input}); providers.add(provider); return provider;
}
const denied = () => Error('Scoped browser projection unavailable');

// A private single-client CDP facade, never a profile endpoint. Only the trusted
// context provider sees its capability; agent tool arguments cannot reach it.
export async function acquirePersonalProjection({ personal, grant, playwright, validate, signal }) {
  const id = randomUUID(), token = randomBytes(32).toString('hex'), policy = new ProjectionPolicy();
  let stopped = false, browser, socket, opened = false, opening, connecting, listening, pending = 0, eventPending = 0, subscribed = false, frame;
  let eventQueue = Promise.resolve();
  const server = createServer((req,res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer:true, maxPayload:1024*1024 });
  const current = async () => {
    if (stopped || signal?.aborted || personal.currentGrant(grant.chatId) !== grant || !grant.active || await validate() !== true) throw denied();
    if (stopped || signal?.aborted || personal.currentGrant(grant.chatId) !== grant || !grant.active) throw denied();
  };
  const send = value => { if (socket?.readyState === 1 && !stopped) { if (socket.bufferedAmount > 2*1024*1024) { void release(); return; } socket.send(JSON.stringify(value)); } };
  const event = (eventGrant,value) => {
    if (eventGrant !== grant || value?.id !== id || !subscribed || stopped) return;
    if (++eventPending > 64) { eventPending--; void release(); return; }
    const operation = eventQueue.then(current).then(() => { const params = policy.event(value.method,value.params); if (params) send({sessionId:'page',method:value.method,params}); });
    eventQueue = operation.catch(() => { void release(); }).finally(() => { eventPending--; });
  };
  const revoked = eventGrant => { if (eventGrant === grant) void release(); };
  const target = () => ({targetId:frame.id,browserContextId:'relay-grant-context',type:'page',title:'Shared automation tab',url:frame.url || 'about:blank',attached:true,canAccessOpener:false});
  async function dispatch(message) {
    await current();
    if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string' || Object.keys(message).some(key => !['id','method','params','sessionId'].includes(key))) throw denied();
    const {method,params = {},sessionId} = message;
    if (sessionId === undefined) {
      if (method === 'Browser.getVersion' && !Object.keys(params).length) return {protocolVersion:'1.3',product:'Chrome/RelayProjection',userAgent:'Scoped-Relay-Projection'};
      if (method === 'Target.getTargetInfo' && !Object.keys(params).length) return {targetInfo:target()};
      if (method === 'Target.setAutoAttach' && params.autoAttach === true && params.flatten === true && params.waitForDebuggerOnStart === true && Object.keys(params).length === 3) {
        if (!subscribed) { subscribed = true; send({method:'Target.attachedToTarget',params:{sessionId:'page',targetInfo:target(),waitingForDebugger:false}}); } return {};
      }
      throw denied();
    }
    if (sessionId !== 'page') throw denied();
    // These are virtual subscriptions only: logs and descendant targets are not
    // exposed, and cannot enable browser-wide access or disable Fetch ownership.
    if (method === 'Log.enable' && !Object.keys(params).length) return {};
    if (method === 'Target.setAutoAttach' && params.autoAttach === true && params.flatten === true && params.waitForDebuggerOnStart === true && Object.keys(params).length === 3) return {};
    await eventQueue; await current();
    const input = policy.command(method,params);
    const result = await personal.request(grant.bridge,'project',{operation:'command',id,method,params:input},grant);
    await current(); return policy.result(method,result);
  }
  server.on('upgrade',(request,connection,head) => {
    const candidate = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '')?.[1];
    if (socket || stopped || request.headers.origin || request.url !== '/' || !candidate || !timingSafeEqual(Buffer.from(candidate),Buffer.from(token))) { connection.destroy(); return; }
    sockets.handleUpgrade(request,connection,head,ws => {
      socket = ws;
      ws.on('error',() => {}); ws.once('close',() => { void release(); });
      ws.on('message',data => {
        if (++pending > 64) { pending--; void release(); return; }
        let message; try { message = JSON.parse(data); } catch { pending--; void release(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { pending--; void release(); return; }
        void dispatch(message).then(result => send({id:message.id,sessionId:message.sessionId,result}), () => send({id:message.id,sessionId:message.sessionId,error:{code:-32000,message:'Scoped browser protocol denied'}})).finally(() => { pending--; });
      });
    });
  });
  let releasing;
  function release() {
    if (releasing) return releasing;
    stopped = true; personal.off('projection',event); personal.off('projectionClosed',revoked); signal?.removeEventListener('abort',abort);
    releasing = (async () => {
      socket?.terminate(); sockets.close();
      await opening?.catch(() => {}); await listening?.catch(() => {}); await connecting?.catch(() => {});
      await browser?.close().catch(() => {});
      await new Promise(resolve => server.listening ? server.close(resolve) : resolve());
      if (opened && personal.currentGrant(grant.chatId) === grant && grant.active) await personal.request(grant.bridge,'project',{operation:'close',id},grant).catch(() => {});
    })();
    return releasing;
  }
  const abort = () => { void release(); };
  personal.on('projection',event); personal.on('projectionClosed',revoked); signal?.addEventListener('abort',abort,{once:true});
  try {
    await current();
    opening = personal.request(grant.bridge,'project',{operation:'open',id},grant).then(result => {opened = true; return result;});
    const result = await opening; frame = result.frame; policy.frames.add(frame.id);
    await current();
    listening = new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
    await listening; await current();
    connecting = playwright.chromium.connectOverCDP(`ws://127.0.0.1:${server.address().port}/`,{headers:{Authorization:`Bearer ${token}`},noDefaults:true,timeout:10000}).then(value => {browser = value; return value;});
    await connecting;
    await current();
    const context = browser.contexts()[0]; if (!context || context.pages().length !== 1) throw denied();
    const lease = {context,release}; leases.add(lease); return lease;
  } catch { await release(); throw denied(); }
}
