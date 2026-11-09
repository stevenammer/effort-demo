import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDemoServer } from './serve.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_DIR?pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`):'playwright');
const remote=process.env.DEMO_BASE_URL?.replace(/\/$/,''), server=remote?null:createDemoServer();
if(server)await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base=remote||`http://127.0.0.1:${server.address().port}`,errors=[],outside=[];
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try {
  for(const width of [1440,390,320]) {
    const context=await browser.newContext({viewport:{width,height:900},acceptDownloads:true});
    await context.route('**/*',route=>{if(!route.request().url().startsWith(base+'/')){outside.push(route.request().url());return route.abort();}return route.continue();});
    const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/public/'); await page.locator('#capture-open:enabled').waitFor();
    const chosen=await page.locator('#now-title').innerText();
    await page.locator('#capture-open').click();
    const writing='  Maybe try a fictional exercise.\nI will not call anyone.\n<img src=x onerror="window.archiveAttack=true">  ';
    await page.locator('#capture-text').fill(writing);
    await page.locator('#capture-preview .source-group').first().waitFor();
    assert.equal(await page.locator('#capture-preview button').count(),0);
    await page.locator('#capture-ef').click();
    assert.equal(await page.locator('#capture-preview pre').textContent(),writing);
    await page.getByRole('button',{name:'Close capture',exact:true}).click(); await page.reload();
    await page.locator('#capture-open').click(); assert.equal(await page.locator('#capture-text').inputValue(),writing);
    assert.equal(await page.locator('#capture-preview pre').textContent(),writing);
    await page.locator('#capture-ef').click();
    // Force a projection failure, not a storage failure. Saving the original must still work.
    await page.evaluate(()=>{const original=document.createElement.bind(document);document.createElement=function(tag,...args){if(tag==='section')throw Error('Synthetic EF renderer failure');return original(tag,...args);};window.restoreElements=()=>{document.createElement=original;};});
    await page.locator('#capture-text').fill(writing+'\nStill exact.');
    await page.locator('#capture-preview').getByText('Organization is unavailable. You can still save the original.',{exact:true}).waitFor();
    await page.locator('#save-capture').click(); await page.locator('#capture-dialog').waitFor({state:'hidden'});
    await page.evaluate(()=>window.restoreElements()); assert.equal(await page.locator('#now-title').innerText(),chosen);
    const fixture=await page.evaluate(async()=>{
      const {openDatabase,request}=await import('./database.js');
      const rows=await Promise.all(Array.from({length:110},async(_,n)=>{const text=n===3?'  Duplicate title\r\nNeedle %_ [x] 👩🏽‍💻\r\n  ':`Duplicate title\nFictional source ${n}.`;return {id:crypto.randomUUID(),text,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join(''),createdAt:new Date(Date.UTC(2026,0,1,0,n)).toISOString(),span:'Learning',sample:false};}));
      rows[4].parentId=rows[3].id;
      const db=openDatabase();await db.run(['captures'],'readwrite',async tx=>{for(const row of rows)await request(tx.objectStore('captures').add(row));});await db.close();return{target:rows[3],reply:rows[4]};
    });
    await page.reload();await page.locator('#capture-open:enabled').waitFor();await page.locator('[data-view="fort"]').click();
    assert.equal(await page.locator('.archive-card').count(),50);
    await page.locator('#fort-more').click(); assert.equal(await page.locator('.archive-card').count(),100);
    await page.locator('#fort-more').click(); assert.equal(await page.locator('.archive-card').count(),113);
    await page.locator('#fort-more').waitFor({state:'hidden'});
    await page.locator('#fort-search').fill('%_ [x]');await page.getByRole('button',{name:'Search originals',exact:true}).click();
    assert.equal(await page.locator('.archive-card').count(),1);
    await page.locator('#fort-ef').click();assert.equal(await page.locator('.archive-card > pre').textContent(),fixture.target.text);
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download original',exact:true}).click()]);
    assert.equal(await readFile(await download.path(),'utf8'),fixture.target.text);
    await page.locator('#fort-clear').click();
    await page.goto(`${base}/public/#fort/${fixture.reply.id}`);await page.locator(`#fort-${fixture.reply.id}`).waitFor();
    assert.equal(await page.locator(`#fort-${fixture.reply.id} > pre`).textContent(),fixture.reply.text);
    await page.locator(`#fort-${fixture.reply.id}`).getByRole('button',{name:'THREAD',exact:true}).click();
    await page.locator(`#reply-${fixture.reply.id}`).waitFor();
    await page.goto(`${base}/public/#fort/${fixture.target.id}`);await page.locator(`#fort-${fixture.target.id}`).waitFor();
    // A second tab's capture must not reorder or replace the page being read.
    await page.evaluate(()=>{window.keptArchiveCard=document.querySelector('.archive-card');});
    const second=await context.newPage();await second.goto(base+'/public/');await second.locator('#capture-open').click();await second.locator('#capture-text').fill('A late fictional arrival.');await second.locator('#save-capture').click();await second.locator('#capture-dialog').waitFor({state:'hidden'});
    await page.locator('#fort-refresh').waitFor();assert.equal(await page.evaluate(()=>window.keptArchiveCard===document.querySelector('.archive-card')),true);
    await second.close();await page.locator('#fort-refresh').click();
    assert.equal(await page.locator('#now-title').textContent(),chosen);
    await page.screenshot({path:`/tmp/effort-fort-${width}.png`,fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.equal(await page.evaluate(()=>window.archiveAttack),undefined);
    await page.locator('[data-view="engine"]').click();await page.locator('#offline-status').getByText('Available offline',{exact:false}).waitFor();
    await context.setOffline(true);await page.goto(`${base}/public/#fort/${fixture.target.id}`);await page.locator(`#fort-${fixture.target.id}`).waitFor();
    assert.equal(await page.locator(`#fort-${fixture.target.id} > pre`).textContent(),fixture.target.text);
    await context.setOffline(false);
    // A record damaged after its snapshot must lose its verified display, while its raw copy survives.
    await page.evaluate(async id=>{const{openDatabase,request}=await import('./database.js');const db=openDatabase();await db.run(['captures'],'readwrite',async tx=>{const table=tx.objectStore('captures'),row=await request(table.get(id));row.text='Damaged synthetic archive bytes';await request(table.put(row));});await db.close();dispatchEvent(new Event('focus'));},fixture.target.id);
    await page.locator(`#fort-${fixture.target.id}`).getByText('This source now needs recovery. Check Engine Room or a backup.',{exact:true}).waitFor();
    assert.equal(await page.locator(`#fort-${fixture.target.id} pre`).count(),0);
    await page.locator('[data-view="engine"]').click();await page.locator('#recovery-status').getByText('1 damaged record preserved separately.',{exact:false}).waitFor();
    // The real browser limit remains useful: page 1000 exact originals without creating 1000 cards at once.
    if(width===1440){
      await page.evaluate(async()=>{const{openDatabase,request}=await import('./database.js');const db=openDatabase();await db.run(['captures'],'readwrite',async tx=>{const table=tx.objectStore('captures'),rows=await request(table.getAll()),sample=rows.find(row=>!row.parentId);for(let n=rows.length;n<1000;n++)await request(table.add({...sample,id:crypto.randomUUID()}));});await db.close();});
      await page.reload();await page.locator('#capture-open:enabled').waitFor();await page.locator('[data-view="fort"]').click();
      await page.locator('#fort-count').getByText('50 of 1000 matching originals shown',{exact:false}).waitFor();assert.equal(await page.locator('.archive-card').count(),50);
      await page.locator('#capture-open').click();await page.locator('#capture-text').fill('Keep this exact over-capacity draft.');await page.locator('#save-capture').click();
      await page.locator('#draft-state').getByText('limit',{exact:false}).waitFor();assert.equal(await page.locator('#capture-text').inputValue(),'Keep this exact over-capacity draft.');
      await page.getByRole('button',{name:'Close capture',exact:true}).click();
    }
    await page.locator('[data-view="engine"]').click();page.once('dialog',d=>d.accept());await page.locator('#reset').click();
    await page.getByText('Browser demo cleared. Your private E.F.F.O.R.T. app is separate.',{exact:true}).waitFor();
    assert.equal(await page.locator('#fort-entries pre').count(),0);assert.equal(await page.locator('#capture-preview pre').count(),0);
    await page.locator('[data-view="fort"]').click();await page.getByText('No saved originals yet.',{exact:true}).waitFor();
    if(width===1440){
      await page.evaluate(async()=>{const{openDatabase,request}=await import('./database.js');const db=openDatabase();const rows=await Promise.all([{id:'00000000-0000-4000-8000-000000000001',text:'An earlier instant with a later-looking clock.',createdAt:'2026-01-01T12:00:00+09:00'},{id:'00000000-0000-4000-8000-000000000002',text:'A later instant with an earlier-looking clock.',createdAt:'2026-01-01T04:00:00Z'}].map(async row=>({...row,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(row.text)))).map(b=>b.toString(16).padStart(2,'0')).join(''),span:'Learning',sample:false})));await db.run(['captures'],'readwrite',async tx=>{for(const row of rows)await request(tx.objectStore('captures').add(row));});await db.close();});
      await page.goto(base+'/public/#home');await page.reload();await page.locator('#capture-open:enabled').waitFor();
      assert.match(await page.locator('#recent .entry-card h3').first().textContent(),/^A later instant/);
      await page.locator('[data-view="fort"]').click();assert.equal(await page.locator('.archive-card').first().getAttribute('id'),'fort-00000000-0000-4000-8000-000000000002');
    }
    await context.close();console.log(`FORT/live EF passed ${width}px.`);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  console.log('PASS: live reversible EF, projection failure with exact saved original, full FORT paging/search, source IDs, exact CRLF downloads, deep reply/thread links, unchanged NOW, cross-tab reading stability, corrupt-source removal, reset clearing,1000-record paging/capacity refusal and offline reopening at1440/390/320. No page errors or external requests.');
} finally {await browser.close();if(server)await new Promise(done=>server.close(done));}
