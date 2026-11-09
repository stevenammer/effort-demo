import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createDemoServer } from './serve.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_DIR?pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`):'playwright');
const remote=process.env.DEMO_BASE_URL?.replace(/\/$/,''),server=remote?null:createDemoServer();if(server)await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base=remote||`http://127.0.0.1:${server.address().port}`,errors=[],outside=[];
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{
 for(const action of ['navigate','dismiss']){
  const c=await browser.newContext({viewport:{width:390,height:900}});await c.route('**/*',r=>{if(!r.request().url().startsWith(base+'/')){outside.push(r.request().url());return r.abort();}return r.continue();});
  const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+'/public/');await p.locator('#capture-open:enabled').waitFor();const now=await p.locator('#now-title').textContent();await p.locator('#now-explore').click();await p.locator('#explore-text:enabled').waitFor();await p.locator('#explore-text').fill(`Synthetic branch while I ${action}.`);
  await p.evaluate(action=>{
    const dialog=document.querySelector('#explore-dialog'),save=document.querySelector('#save-exploration');
    const observer=new MutationObserver(()=>{
      if(action==='navigate'&&!dialog.open){observer.disconnect();document.querySelector('[data-view="engine"]').click();}
      if(action==='dismiss'&&save.disabled&&dialog.open){observer.disconnect();dialog.querySelector('[aria-label="Close exploration"]').click();}
    });observer.observe(action==='navigate'?dialog:save,{attributes:true,attributeFilter:action==='navigate'?['open']:['disabled']});
  },action);
  await p.locator('#save-exploration').click();await p.locator('#explore-dialog').waitFor({state:'hidden'});await p.waitForFunction(()=>!document.querySelector('#now-explore').disabled);
  assert.equal(await p.evaluate(()=>location.hash),action==='navigate'?'#engine':'#home');assert.equal(await p.locator('#now-title').textContent(),now);
  assert.equal(await p.evaluate(async action=>{const{createStore}=await import('./store.js');const s=createStore();try{return(await s.read()).explorations.filter(row=>row.text===`Synthetic branch while I ${action}.`).length;}finally{await s.close();}},action),1);
  await c.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);console.log('PASS: navigation immediately after exploration closes and dismissal during a pending save preserve the selected view; exactly one branch is saved and NOW stays chosen. No page errors/outside requests.');
}finally{await browser.close();if(server)await new Promise(done=>server.close(done));}
