// Upgrade an actual published client to DB8 while a second old tab keeps writing.
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SHELL_ASSETS, SHELL_VERSION } from '../shell-manifest.js';
const { chromium } = await import(process.env.PLAYWRIGHT_DIR ? pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`) : 'playwright');
const previous=process.env.UPGRADE_FROM || '054bf1905ae2be858f1a273e567d23ae4c03ad98', root=new URL('../',import.meta.url);
const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:16*1024*1024});
const oldPaths=git('ls-tree','-r','--name-only',previous).toString().trim().split('\n').filter(p=>p==='index.html'||p==='sw.js'||p==='shell-manifest.js'||p.startsWith('public/'));
const old=new Map(oldPaths.map(p=>[p,git('show',`${previous}:${p}`)]));
const oldSchema = Number(old.get('public/database.js').toString().match(/DB_VERSION = (\d+)/)[1]);
const current=new Map(await Promise.all([...SHELL_ASSETS.map(x=>x.path),'sw.js','shell-manifest.js'].map(async p=>[p,await readFile(new URL(p,root))])));
let files=old;const errors=[],outside=[];
const server=http.createServer((req,res)=>{let p=new URL(req.url,'http://localhost').pathname;if(!p.startsWith('/upgrade/')){res.writeHead(404);res.end();return;}p=p.slice(9);if(p===''||p==='public/')p+='index.html';const b=files.get(p);if(!b){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':{js:'text/javascript',html:'text/html',css:'text/css',svg:'image/svg+xml'}[p.split('.').at(-1)]||'application/octet-stream','Cache-Control':'no-store'});res.end(b);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/upgrade`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const c=await browser.newContext();c.setDefaultTimeout(10000);c.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));c.on('request',r=>{if(!r.url().startsWith(base+'/'))outside.push(r.url());});
const ready=async p=>p.locator('#capture-open:enabled').waitFor();
try{
 const a=await c.newPage();await a.goto(base+'/public/');await ready(a);await a.locator('[data-view="engine"]').click();await a.locator('#offline-status').getByText('Available offline in this browser.',{exact:false}).waitFor();
 const oldFile = oldSchema >= 6 ? await a.evaluate(async () => { const {createStore}=await import('./store.js'); const s=createStore(); try { const source=(await s.read()).captures[0]; return await s.attach({captureId:source.id,name:'pre-upgrade.txt',mime:'text/plain',bytes:new TextEncoder().encode('Exact pre-upgrade file bytes.')}); } finally {await s.close();} }) : null;
 await a.locator('#capture-open').click();await a.locator('#capture-text').fill('First old tab draft.');await a.locator('#draft-state').getByText('Draft kept in this browser.',{exact:true}).waitFor();await a.getByRole('button',{name:'Close capture',exact:true}).click();
 const b=await c.newPage();await b.goto(base+'/public/');await ready(b);await b.locator('#capture-open').click();await b.locator('#capture-text').fill('Second old tab draft.');await b.locator('#draft-state').getByText('Draft kept in this browser.',{exact:true}).waitFor();
 files=current;await a.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration();await reg.update();});await a.locator('#apply-update').waitFor({state:'visible'});
 await Promise.all([a.waitForEvent('load'),a.locator('#apply-update').click()]);await ready(a);assert.equal(await a.evaluate(async()=>{const {DB_VERSION}=await import('./database.js');return DB_VERSION;}),8);
 await a.locator('#capture-open').click();assert.equal(await a.locator('#capture-text').inputValue(),'First old tab draft.');await a.getByRole('button',{name:'Close capture',exact:true}).click();
 // The stale tab cannot write to the upgraded database, but its synchronous mirror retains new typing.
 await b.locator('#capture-text').fill('Late writing in the second old tab after the schema upgrade.');await b.locator('#draft-state').getByText(/older than the saved EFFORT workspace/).waitFor();
 assert.equal(await b.locator('#capture-text').inputValue(),'Late writing in the second old tab after the schema upgrade.');await b.reload();await ready(b);await b.locator('#capture-open').click();assert.equal(await b.locator('#capture-text').inputValue(),'Late writing in the second old tab after the schema upgrade.');await b.locator('#save-capture').click();await b.locator('#capture-dialog').waitFor({state:'hidden'});
 const state=await b.evaluate(async()=>{const {createStore}=await import('./store.js');const s=createStore();try{return await s.read();}finally{await s.close();}});assert.ok(state.captures.some(x=>x.text==='Late writing in the second old tab after the schema upgrade.'));assert.equal(state.version,10);assert.deepEqual(state.artifacts,oldFile ? [oldFile] : []);
 const workerVersion=await a.evaluate(()=>new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=e=>{channel.port1.close();resolve(e.data.version);};navigator.serviceWorker.controller.postMessage({type:'SHELL_STATUS'},[channel.port2]);}));assert.equal(workerVersion,SHELL_VERSION);
 assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);console.log(`PASS: real published DB${oldSchema}/service-worker upgrade to DB8; two separate tab drafts preserved; stale-tab writes retained in emergency mirror; deliberate reload recovers exact late typing; primary capture works after upgrade; existing file bytes ${oldFile ? 'preserved exactly' : 'not present in old schema'}.`);
}finally{await browser.close();await new Promise(r=>server.close(r));}
