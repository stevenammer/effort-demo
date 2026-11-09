import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { setupOffline } from '../public/offline.js';

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) { const list = this.listeners.get(type) ?? []; list.push(callback); this.listeners.set(type, list); }
  emit(type) { for (const callback of this.listeners.get(type) ?? []) callback({ type }); }
}

// Accelerate readiness deadlines and bounded retry waits; restore globals and dispose timers.
test('a transient readiness timeout should be retried without a controllerchange event', async () => {
  const previousChannel = globalThis.MessageChannel, previousTimeout = globalThis.setTimeout;
  let probes = 0, dispose; const ports = [];
  class FakeChannel { constructor() { this.port1 = { onmessage: null, close() {} }; this.port2 = { reply: data => this.port1.onmessage?.({ data }) }; ports.push(this.port1); } }
  const registration = new Target(); registration.waiting = null; registration.installing = null;
  const serviceWorker = new Target(); serviceWorker.controller = { postMessage(message, [port]) { if (message.type === 'SHELL_STATUS' && ++probes > 1) queueMicrotask(() => port.reply({ ready: true })); } };
  serviceWorker.register = async () => registration;
  const status = { textContent: '' }, button = { hidden: false, disabled: false };
  try {
    globalThis.MessageChannel = FakeChannel;
    globalThis.setTimeout = (fn, ms, ...args) => previousTimeout(fn, ms === 3000 ? 10 : [250,500].includes(ms) ? 2 : ms, ...args);
    dispose = await setupOffline({ status, button, serviceWorker, beforeUpdate: async () => () => {} });
    await delay(80);
    assert.ok(probes > 1, `expected an automatic retry, observed ${probes} probe(s): ${status.textContent}`);
    assert.match(status.textContent, /Available offline/);
  } finally { dispose?.(); globalThis.MessageChannel = previousChannel; globalThis.setTimeout = previousTimeout; for (const port of ports) port.close(); }
});

test('an installation already in progress when register resolves should be observed', async () => {
  const worker = new Target(); worker.state = 'installing';
  const registration = new Target(); registration.waiting = null; registration.installing = worker;
  const serviceWorker = new Target(); serviceWorker.controller = null; serviceWorker.register = async () => registration;
  const status = { textContent: '' }, button = { hidden: false, disabled: false };
  const dispose = await setupOffline({ status, button, serviceWorker, beforeUpdate: async () => () => {} });
  assert.match(status.textContent, /Preparing offline/);
  worker.state = 'installed'; registration.installing = null; registration.waiting = worker; worker.emit('statechange');
  await delay(20);
  assert.equal(button.hidden, false, `expected the waiting update to be offered: ${status.textContent}`);
  assert.match(status.textContent, /update is ready/i);
  dispose?.();
});


test('unresponsive workers exhaust bounded retries without advertising offline readiness',async()=>{
 const priorChannel=globalThis.MessageChannel,priorTimeout=globalThis.setTimeout;let probes=0,dispose;
 class SilentChannel{constructor(){this.port1={onmessage:null,close(){}};this.port2={};}}
 const registration=new Target();registration.waiting=null;registration.installing=null;const serviceWorker=new Target();serviceWorker.controller={postMessage(){probes++;}};serviceWorker.register=async()=>registration;const status={textContent:''},button={hidden:false,disabled:false};
 try{globalThis.MessageChannel=SilentChannel;globalThis.setTimeout=(fn,ms,...args)=>priorTimeout(fn,ms===3000?10:[250,500].includes(ms)?2:ms,...args);dispose=await setupOffline({status,button,serviceWorker,beforeUpdate:async()=>()=>{}});await delay(100);assert.equal(probes,3);assert.match(status.textContent,/offline copy is unavailable/i);await delay(30);assert.equal(probes,3);}finally{dispose?.();globalThis.MessageChannel=priorChannel;globalThis.setTimeout=priorTimeout;}
});

test('an existing waiting worker remains explicitly applicable when registration refresh fails',async()=>{
  const registration=new Target(),commands=[];registration.installing=null;registration.waiting={postMessage(message){commands.push(message.type);}};
  const serviceWorker=new Target();serviceWorker.controller=null;serviceWorker.register=async()=>{throw Error('Network unavailable during refresh');};serviceWorker.getRegistration=async()=>registration;const status={textContent:''},button={hidden:true,disabled:false};let approved=0;
  const dispose=await setupOffline({status,button,serviceWorker,beforeUpdate:async()=>{approved++;return()=>{};}});
  try{assert.equal(button.hidden,false);assert.equal(approved,0);assert.deepEqual(commands,[]);await button.onclick();assert.equal(approved,1);assert.deepEqual(commands,['APPLY_UPDATE']);}finally{dispose?.();}
});
