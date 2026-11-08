// Real service-worker acceptance with synthetic releases on a repository subpath.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SHELL_ASSETS, SHELL_VERSION } from '../shell-manifest.js';
const { chromium } = await import(process.env.PLAYWRIGHT_DIR ? pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`) : 'playwright');
const root = new URL('../',import.meta.url), hash=raw=>createHash('sha256').update(raw).digest('hex');
const a = new Map(await Promise.all([...SHELL_ASSETS.map(x=>x.path),'sw.js','shell-manifest.js'].map(async path=>[path,await readFile(new URL(path,root))])));
function next(previous,label) {
  const files=new Map(previous); files.set('sw.js',Buffer.from(files.get('sw.js')+`\n// Synthetic release ${label}.\n`));
  files.set('public/offline.js',Buffer.from(files.get('public/offline.js')+`\n// Synthetic release ${label}.\n`));
  const assets=SHELL_ASSETS.map(x=>({path:x.path,sha256:hash(files.get(x.path))})); const workerHash=hash(files.get('sw.js')), version=hash(JSON.stringify({assets,workerHash}));
  files.set('shell-manifest.js',Buffer.from(`export const SHELL_VERSION=${JSON.stringify(version)}; export const SHELL_ASSETS=${JSON.stringify(assets)};`));
  return {files,version};
}
const b=next(a,'B'), c=next(b.files,'C'); c.files.set('public/offline.js',Buffer.from('Wrong deployment bytes.'));
let files=a;
const server=http.createServer((req,res)=>{
  let path=new URL(req.url,'http://localhost').pathname;
  if(!path.startsWith('/portfolio/')){res.writeHead(404);res.end();return;}
  path=path.slice('/portfolio/'.length); if(path===''||path==='public/')path+='index.html';
  const raw=files.get(path); if(!raw){res.writeHead(404);res.end('Unknown fixture path');return;}
  const ext=path.split('.').at(-1), type={js:'text/javascript',html:'text/html',css:'text/css',svg:'image/svg+xml'}[ext];
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'}); res.end(raw);
}); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/portfolio`, errors=[], outside=[];
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const context=await browser.newContext(); context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
context.on('request',r=>{if(!r.url().startsWith(base+'/'))outside.push(r.url());});
async function ready(p){await p.locator('#capture-open:enabled').waitFor();}
async function engine(p){await p.locator('[data-view="engine"]').click();}
async function version(p){return p.evaluate(()=>new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=e=>{channel.port1.close();resolve(e.data.version);};navigator.serviceWorker.controller.postMessage({type:'SHELL_STATUS'},[channel.port2]);}));}
try{
  let page=await context.newPage(); await page.goto(base+'/public/'); await ready(page); await engine(page);
  await page.locator('#offline-status').getByText('Available offline in this browser.',{exact:false}).waitFor(); assert.equal(await version(page),SHELL_VERSION);
  await page.locator('#capture-open').click(); await page.locator('#capture-text').fill('Offline original.'); await page.locator('#save-capture').click(); await page.locator('#capture-dialog').waitFor({state:'hidden'});
  await page.locator('#capture-open').click(); await page.locator('#capture-text').fill('Unfinished offline draft.'); await page.locator('#draft-state').getByText('Draft kept in this browser.',{exact:true}).waitFor();
  await context.setOffline(true); await page.reload(); await ready(page); await page.locator('#capture-open').click(); assert.equal(await page.locator('#capture-text').inputValue(),'Unfinished offline draft.');
  await page.locator('#capture-text').fill('Saved while disconnected.'); await page.locator('#save-capture').click(); await page.locator('#capture-dialog').waitFor({state:'hidden'});
  await page.close(); page=await context.newPage(); await page.goto(base+'/'); await ready(page);
  assert.equal(await page.evaluate(async()=>{const {createStore}=await import('./store.js');const s=createStore();try{return (await s.read()).captures.some(x=>x.text==='Saved while disconnected.');}finally{await s.close();}}),true);
  await context.setOffline(false); await engine(page); files=b.files;
  await page.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration();await reg.update();});
  await page.locator('#apply-update').waitFor({state:'visible'}); assert.equal(await version(page),SHELL_VERSION,'an update waits without replacing the current release');
  await page.locator('#capture-open').click(); await page.locator('#capture-text').fill('Writing kept through the update.'); await page.locator('#draft-state').getByText('Draft kept in this browser.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Close capture',exact:true}).click();
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.restorePut=()=>{IDBObjectStore.prototype.put=put;};IDBObjectStore.prototype.put=function(...args){if(this.name==='drafts')throw Error('Update write fault');return put.apply(this,args);};});
  await page.locator('#apply-update').click(); await page.locator('#offline-status').getByText('Update paused:',{exact:false}).waitFor(); assert.equal(await version(page),SHELL_VERSION); assert.equal(await page.evaluate(()=>document.body.inert),false);
  await page.evaluate(()=>window.restorePut()); await page.locator('#apply-update').click();
  await page.waitForEvent('load'); await ready(page); await engine(page); await page.locator('#offline-status').getByText('Available offline in this browser.',{exact:false}).waitFor();
  assert.equal(await version(page),b.version); await page.locator('#capture-open').click(); assert.equal(await page.locator('#capture-text').inputValue(),'Writing kept through the update.'); await page.getByRole('button',{name:'Close capture',exact:true}).click();
  const cacheCount=await page.evaluate(async()=> (await caches.keys()).length); files=c.files;
  await page.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration();await new Promise(async(resolve,reject)=>{reg.addEventListener('updatefound',()=>{const w=reg.installing;w.addEventListener('statechange',()=>{if(w.state==='redundant')resolve();if(w.state==='installed')reject(Error('Corrupt fixture was installed'));});},{once:true});try{await reg.update();}catch(e){reject(e);}});});
  assert.equal(await page.evaluate(async()=> (await caches.keys()).length),cacheCount,'bad install removes only its incomplete cache'); assert.equal(await version(page),b.version);
  await context.setOffline(true); await page.reload(); await ready(page); await page.locator('#capture-open').click(); assert.equal(await page.locator('#capture-text').inputValue(),'Writing kept through the update.');
  const paths=await page.evaluate(async()=>{const urls=[];for(const key of await caches.keys()){for(const r of await(await caches.open(key)).keys())urls.push(new URL(r.url).pathname);}return urls;});
  assert.ok(paths.every(path=>path.startsWith('/portfolio/')&&!path.includes('private')));
  // Shut down the browser process, then reopen the same synthetic profile offline.
  files=a; const profile=await mkdtemp(join(tmpdir(),'effort-offline-profile-')); let persistent;
  const launch=()=>chromium.launchPersistentContext(profile,{executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  try {
    persistent=await launch(); let savedPage=await persistent.newPage(); await savedPage.goto(base+'/public/'); await ready(savedPage); await engine(savedPage);
    await savedPage.locator('#offline-status').getByText('Available offline in this browser.',{exact:false}).waitFor();
    await savedPage.locator('#capture-open').click(); await savedPage.locator('#capture-text').fill('Draft across browser restart.'); await savedPage.locator('#draft-state').getByText('Draft kept in this browser.',{exact:true}).waitFor();
    await persistent.close(); persistent=await launch(); await persistent.setOffline(true); savedPage=await persistent.newPage(); await savedPage.goto(base+'/'); await ready(savedPage);
    await engine(savedPage); await savedPage.locator('#draft-recovery summary').first().click();
    const recovered=savedPage.locator('#draft-recovery-items details').filter({hasText:'Draft across browser restart.'}).first();
    await recovered.locator('summary').click(); await recovered.getByRole('button',{name:'Recover into this tab',exact:true}).click();
    await savedPage.locator('#capture-open').click(); assert.equal(await savedPage.locator('#capture-text').inputValue(),'Draft across browser restart.');
  } finally { await persistent?.close(); await rm(profile,{recursive:true,force:true}); }
  assert.deepEqual(errors,[]); assert.deepEqual(outside,[]);
  console.log('PASS: verified real worker on repository subpath, offline reload, fresh tab and full browser restart via root, disconnected capture, explicit update with draft checks, failed-check refusal, intact writing after upgrade, and corrupt-release rollback. No page errors or external requests.');
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
