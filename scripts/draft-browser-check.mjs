// Synthetic fault/concurrency acceptance in isolated browser contexts.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createDemoServer } from './serve.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_DIR ? pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`) : 'playwright');
const remote = process.env.DEMO_BASE_URL?.replace(/\/$/, '');
const server = remote ? null : createDemoServer();
if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = remote || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome', headless:true, args:['--no-sandbox']});
const errors = [], outside = [];
async function context() {
  const c = await browser.newContext({viewport:{width:390,height:844}});
  await c.route('**/*', route => { if (!route.request().url().startsWith(base+'/')) { outside.push(route.request().url()); return route.abort(); } return route.continue(); });
  c.on('page', p => p.on('pageerror', e => errors.push(e.message))); return c;
}
async function open(c) { const p = await c.newPage(); await p.goto(base+'/public/'); await p.locator('#capture-open:enabled').waitFor(); return p; }
async function writer(p, text) { await p.locator('#capture-open').click(); await p.locator('#capture-text').fill(text); await p.locator('#draft-state').getByText('Draft kept in this browser.', {exact:true}).waitFor(); }
async function state(p) { return p.evaluate(async () => { const {createStore}=await import('./store.js'); const s=createStore(); try { return await s.read(); } finally { await s.close(); } }); }
try {
  const c = await context(), a = await open(c), b = await open(c);
  await writer(a, '  First tab exact draft.\n😀  '); await writer(b, 'Second tab independent draft.');
  await a.reload(); await a.locator('#capture-open:enabled').waitFor(); await a.locator('#capture-open').click();
  assert.equal(await a.locator('#capture-text').inputValue(), '  First tab exact draft.\n😀  ');
  await b.reload(); await b.locator('#capture-open:enabled').waitFor(); await b.locator('#capture-open').click();
  assert.equal(await b.locator('#capture-text').inputValue(), 'Second tab independent draft.');
  // A tab cloned from opener sessionStorage forks the existing writing, keeping both.
  const popupPromise = a.waitForEvent('popup'); await a.evaluate(() => window.open(location.href, '_blank')); const clone = await popupPromise;
  await clone.locator('#capture-open:enabled').waitFor(); await clone.locator('#capture-open').click();
  assert.equal(await clone.locator('#capture-text').inputValue(), '  First tab exact draft.\n😀  ');
  await clone.locator('#capture-text').fill('Cloned tab fork.'); await clone.locator('#draft-state').getByText('Draft kept in this browser.', {exact:true}).waitFor();
  assert.equal((await state(a)).drafts.filter(d=>d.context==='capture' && d.body.text).length, 3);
  await clone.close();
  // Reset in a different tab leaves visible writing alone, but blocks passive resurrection.
  await b.getByRole('button', {name:'Close capture',exact:true}).click(); await b.locator('[data-view="engine"]').click();
  b.once('dialog', d=>d.accept()); await b.locator('#reset').click(); await b.getByText('Browser demo cleared. Your private EFFORT app is separate.',{exact:true}).waitFor();
  await a.locator('#draft-state').getByText('Workspace changed in another tab.',{exact:false}).waitFor();
  assert.equal(await a.locator('#capture-text').inputValue(), '  First tab exact draft.\n😀  ');
  await a.getByRole('button',{name:'Close capture',exact:true}).click(); assert.equal((await state(b)).drafts.length,0);
  await a.locator('#capture-open').click(); await a.locator('#capture-text').fill('Explicit new-workspace writing.');
  await a.locator('#draft-state').getByText('Draft kept in this browser.',{exact:true}).waitFor();
  assert.equal((await state(b)).drafts[0].body.text, 'Explicit new-workspace writing.');
  await c.close();

  const replyContext = await context(), replyPage = await open(replyContext), resetPage = await open(replyContext);
  const replySource = (await state(replyPage)).captures[0].id;
  await replyPage.goto(`${base}/public/#thread/${replySource}`); await replyPage.locator('#reply-text:enabled').waitFor();
  await replyPage.locator('#reply-text').fill('Reply retained across reset.'); await replyPage.locator('#reply-draft-state').getByText('Draft kept in this browser.',{exact:true}).waitFor();
  const saved = await resetPage.evaluate(async()=>{ const {createStore}=await import('./store.js'); const s=createStore(); try{return await s.exportData();}finally{await s.close();} });
  await resetPage.locator('[data-view="engine"]').click(); resetPage.once('dialog',dialog=>dialog.accept()); await resetPage.locator('#reset').click();
  await resetPage.getByText('Browser demo cleared. Your private EFFORT app is separate.',{exact:true}).waitFor();
  await replyPage.locator('#reply-draft-state').getByText('Workspace changed',{exact:false}).waitFor();
  await replyPage.locator('[data-view="home"]').click();
  await resetPage.evaluate(async raw=>{ const {createStore}=await import('./store.js'); const s=createStore(); try{await s.restore(raw);}finally{await s.close();} },saved);
  await replyPage.goto(`${base}/public/#thread/${replySource}`); await replyPage.locator('#reply-text:enabled').waitFor();
  // Re-establish the live reset fence without navigating the document, to exercise volatile route copies.
  await resetPage.evaluate(async()=>{ const {createStore}=await import('./store.js'); const s=createStore(); try{await s.reset();}finally{await s.close();} });
  await replyPage.locator('#reply-draft-state').getByText('Workspace changed',{exact:false}).waitFor();
  await replyPage.locator('[data-view="home"]').click();
  await resetPage.evaluate(async raw=>{ const {createStore}=await import('./store.js'); const s=createStore(); try{await s.restore(raw);}finally{await s.close();} },saved);
  await replyPage.evaluate(id=>{ location.hash=`#thread/${id}`; },replySource); await replyPage.locator('#reply-text:enabled').waitFor();
  await replyPage.locator('#reply-text').fill('Explicitly revised reply after reset.'); await replyPage.locator('#reply-draft-state').getByText('Draft kept in this browser.',{exact:true}).waitFor();
  await replyPage.locator('[data-view="home"]').click(); await replyPage.evaluate(id=>{location.hash=`#thread/${id}`;},replySource);
  await replyPage.locator('#reply-text:enabled').waitFor(); assert.equal(await replyPage.locator('#reply-text').inputValue(),'Explicitly revised reply after reset.');
  await replyContext.close();

  const recovery = await context(), p = await open(recovery);
  await writer(p, 'Earlier draft.');
  await p.evaluate(() => { const put=IDBObjectStore.prototype.put; IDBObjectStore.prototype.put=function(...args) { if(this.name==='drafts')throw Error('Draft write fault'); return put.apply(this,args); }; });
  await p.locator('#capture-text').fill('Latest failed-write draft.'); await p.locator('#draft-state').getByText('Draft write fault',{exact:false}).waitFor();
  await p.reload(); await p.locator('#capture-open:enabled').waitFor(); await p.locator('#capture-open').click();
  assert.equal(await p.locator('#capture-text').inputValue(), 'Latest failed-write draft.');
  // Accepting a primary post and failing only draft cleanup must not duplicate on retry/reload.
  await p.evaluate(() => { const put=IDBObjectStore.prototype.put; IDBObjectStore.prototype.put=function(value,...rest) { if(this.name==='drafts' && value.body?.text==='')throw Error('Cleanup fault'); return put.call(this,value,...rest); }; });
  await p.locator('#save-capture').click(); await p.locator('#draft-state').getByText('Original saved. Draft cleanup failed.',{exact:false}).waitFor();
  assert.equal((await state(p)).captures.filter(x=>x.text==='Latest failed-write draft.').length,1);
  await p.reload(); await p.locator('#capture-open:enabled').waitFor(); await p.locator('#capture-open').click();
  assert.equal(await p.locator('#capture-text').inputValue(), 'Latest failed-write draft.');
  await p.locator('#save-capture').click(); await p.locator('#capture-dialog').waitFor({state:'hidden'});
  assert.equal((await state(p)).captures.filter(x=>x.text==='Latest failed-write draft.').length,1);
  await recovery.close();

  const degraded = await context();
  await degraded.addInitScript(() => { const getAll=IDBObjectStore.prototype.getAll; IDBObjectStore.prototype.getAll=function(...args) { if(this.name==='drafts')throw Error('Draft shelf unavailable'); return getAll.apply(this,args); }; });
  const d=await open(degraded); await d.locator('#capture-open').click();
  await d.locator('#draft-state').getByText('Draft storage could not open:',{exact:false}).waitFor();
  await d.locator('#capture-text').fill('Primary saving without the draft shelf.'); await d.locator('#save-capture').click();
  // Cleanup is unavailable, but the original has still been saved and acknowledged.
  await d.locator('#draft-state').getByText('Original saved.',{exact:false}).waitFor();
  assert.equal(await d.evaluate(async()=>{ const {createStore}=await import('./store.js'); const s=createStore(); try{return (await s.read({includeDrafts:false})).captures.filter(c=>c.text==='Primary saving without the draft shelf.').length;}finally{await s.close();} }),1);
  await degraded.close();
  assert.deepEqual(errors,[]); assert.deepEqual(outside,[]);
  console.log('PASS: isolated and cloned tabs, exact draft reload, cross-tab reset fencing, failed-write recovery, accepted-save cleanup retry without duplicate posts, and primary capture with unavailable draft storage. No page errors or external requests.');
} finally { await browser.close(); if(server) await new Promise(resolve=>server.close(resolve)); }
