// Isolated, synthetic UI acceptance for optional thinking moves and branch continuity.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createDemoServer } from './serve.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_DIR ? pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`) : 'playwright');
const remote = process.env.DEMO_BASE_URL?.replace(/\/$/, ''), server = remote ? null : createDemoServer();
if (server) await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = remote || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errors = [], outside = [];
async function state(page) { return page.evaluate(async () => { const { createStore } = await import('./store.js'); const s = createStore(); try { return await s.read(); } finally { await s.close(); } }); }
async function moves(page) { const s = await state(page); await page.goto(`${base}/public/#span/${s.spans.find(s => s.kind === 'moves').id}`); await page.locator('.move-card').first().waitFor(); }
async function edit(page, id) { await page.locator(`[data-move-id="${id}"]`).getByRole('button', { name: 'Edit or turn off…', exact: true }).click(); await page.locator('#move-name:enabled').waitFor(); }
async function branch(page, id) { await page.goto(`${base}/public/#branch/${id}`); const card = page.locator(`[data-branch-id="${id}"]`); await card.waitFor(); return card; }
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true, reducedMotion: 'reduce' }); context.setDefaultTimeout(12000);
    await context.route('**/*', route => { if (!route.request().url().startsWith(base + '/')) { outside.push(route.request().url()); return route.abort(); } return route.continue(); });
    context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    const page = await context.newPage(); await page.goto(`${base}/public/`); await page.locator('#capture-open:enabled').waitFor();
    await page.locator('#capture-open').click(); await page.locator('#capture-text').fill('Synthetic thinking source. Keep the first experiment small.'); await page.locator('#save-capture').click(); await page.locator('#capture-dialog').waitFor({ state: 'hidden' });
    const original = await state(page), source = original.captures.find(c => c.text.startsWith('Synthetic thinking source.'));
    await page.goto(`${base}/public/#thread/${source.id}`); await page.locator('#thread-post').getByRole('button', { name: 'Explore safely…', exact: true }).click(); await page.locator('#explore-text:enabled').waitFor();
    await page.locator('#explore-dialog .thinking-controls summary').click(); const moveId = '00000000-0000-4000-8000-000000000001';
    await page.locator('#explore-move').selectOption(moveId); const prompt = await page.locator('#explore-move-prompt').textContent();
    await page.locator('#explore-text').fill('Synthetic branch with an exact saved prompt.'); await page.locator('#save-exploration').click(); await page.locator('#explore-dialog').waitFor({ state: 'hidden' });
    const saved = await state(page), b = saved.explorations.find(b => b.text === 'Synthetic branch with an exact saved prompt.'); assert.equal(b.move.prompt, prompt); assert.deepEqual(saved.now, original.now);
    await moves(page); const seedCard = page.locator(`[data-move-id="${moveId}"]`); assert.match(await seedCard.textContent(), /Examples you kept \(0\)/);
    await edit(page, moveId); await page.locator('#move-prompt').fill('My synthetic revision. <img src=x onerror="window.thinkingInjected=true">'); await page.locator('#move-enabled').uncheck(); await page.locator('#save-move').click(); await page.locator('#move-dialog').waitFor({ state: 'hidden' });
    assert.match(await page.locator(`[data-move-id="${moveId}"]`).textContent(), /Turned off for new explorations/);
    let card = await branch(page, b.id); await card.locator('.saved-move summary').click(); assert.equal(await card.locator('.saved-move pre').textContent(), prompt);
    await card.getByRole('button', { name: 'Update branch status…', exact: true }).click(); await page.locator('#branch-note:enabled').waitFor(); await page.locator('#branch-status').selectOption('parked'); await page.locator('#branch-note').fill('Keep my reasoning.');
    await page.getByRole('button', { name: 'Close branch status', exact: true }).click(); await page.reload(); await page.locator(`[data-branch-id="${b.id}"]`).getByRole('button', { name: 'Update branch status…', exact: true }).click(); await page.locator('#branch-note:enabled').waitFor(); assert.equal(await page.locator('#branch-note').inputValue(), 'Keep my reasoning.'); assert.equal(await page.locator('#branch-status').inputValue(), 'parked'); await page.locator('#branch-evidence').check(); await page.locator('#save-branch-status').click(); await page.locator('#branch-dialog').waitFor({ state: 'hidden' });
    card = page.locator(`[data-branch-id="${b.id}"]`); assert.equal(await card.isVisible(), true, 'permalink opens the set-aside disclosure'); assert.match(await card.textContent(), /You explicitly kept this branch/); assert.equal(await card.locator('.branch-promotion').count(), 0);
    await moves(page); const evidence = page.locator(`[data-move-id="${moveId}"] .move-evidence`); await evidence.locator('summary').click(); await evidence.getByRole('link').click(); assert.equal(new URL(page.url()).hash, `#branch/${b.id}`);
    await page.locator('#thread-post').getByRole('button', { name: 'Explore safely…', exact: true }).click(); await page.locator('#explore-text:enabled').waitFor(); await page.locator('#explore-dialog .thinking-controls').evaluate(e => e.open = true); assert.equal(await page.locator(`#explore-move option[value="${moveId}"]`).count(), 0); await page.getByRole('button', { name: 'Close exploration', exact: true }).click();
    await moves(page); await page.getByRole('button', { name: '+ Add a thinking move', exact: true }).click(); await page.locator('#move-name:enabled').waitFor(); await page.locator('#move-name').fill('My synthetic tool'); await page.locator('#move-prompt').fill('Ask for the smallest useful proof.'); await page.getByRole('button', { name: 'Close thinking move', exact: true }).click(); await page.reload(); await page.locator('.move-card').first().waitFor(); await page.getByRole('button', { name: '+ Add a thinking move', exact: true }).click(); await page.locator('#move-name:enabled').waitFor(); assert.equal(await page.locator('#move-name').inputValue(), 'My synthetic tool'); assert.equal(await page.locator('#move-prompt').inputValue(), 'Ask for the smallest useful proof.'); await page.locator('#save-move').click(); await page.locator('#move-dialog').waitFor({ state: 'hidden' });
    assert.equal((await state(page)).moveEvents.filter(e => e.name === 'My synthetic tool').length, 1);
    if (width === 1440) {
      const peer = await context.newPage(); await peer.goto(`${base}/public/`); await peer.locator('#capture-open:enabled').waitFor(); await moves(peer); await edit(page, moveId); await page.locator('#move-prompt').fill('My pending wording stays.');
      await edit(peer, moveId); await peer.locator('#move-prompt').fill('Other tab revision.'); await peer.locator('#save-move').click(); await peer.locator('#move-dialog').waitFor({ state: 'hidden' });
      await page.locator('#save-move').click(); await page.locator('#move-error').getByText(/changed in another tab/).waitFor(); assert.equal(await page.locator('#move-prompt').inputValue(), 'My pending wording stays.');
      await page.locator('#move-dialog details summary').click(); await page.locator('#move-base').click(); await page.locator('#move-error').getByText(/Your wording is kept/).waitFor(); assert.match(await page.locator('#move-current').textContent(), /Other tab revision/); assert.equal(await page.locator('#move-prompt').inputValue(), 'My pending wording stays.'); await page.locator('#save-move').click(); await page.locator('#move-dialog').waitFor({ state: 'hidden' }); await peer.close();
    }
    assert.deepEqual((await state(page)).now, original.now); assert.equal(await page.evaluate(() => window.thinkingInjected), undefined);
    if (width === 1440) {
      await page.goto(`${base}/public/#thread/${source.id}`); await page.locator('#thread-post').getByRole('button', { name: 'Explore safely…', exact: true }).click(); await page.locator('#explore-text:enabled').waitFor(); await page.locator('#explore-text').fill('My unfinished branch survives changing NOW.'); await page.getByRole('button', { name: 'Close exploration', exact: true }).click();
      await page.evaluate(async id => { const { createStore } = await import('./store.js'); const s = createStore(); try { await s.choose(id, 0, 26); } finally { await s.close(); } }, source.id);
      await page.reload(); await page.locator('#thread-post').getByRole('button', { name: 'Explore safely…', exact: true }).click(); await page.locator('#explore-text:enabled').waitFor(); assert.equal(await page.locator('#explore-text').inputValue(), 'My unfinished branch survives changing NOW.'); await page.locator('#save-exploration').click(); await page.locator('#explore-error').getByText(/changed/).waitFor();
      await page.locator('#explore-current-place').click(); await page.locator('#explore-error').getByText(/Your wording is kept/).waitFor(); assert.equal(await page.locator('#explore-text').inputValue(), 'My unfinished branch survives changing NOW.'); await page.locator('#save-exploration').click(); await page.locator('#explore-dialog').waitFor({ state: 'hidden' });
      const adopted = await state(page), kept = adopted.explorations.find(b => b.text === 'My unfinished branch survives changing NOW.'); assert.deepEqual(adopted.places.find(p => p.id === kept.returnPointId).choice, adopted.now);
    }
    await page.locator('[data-view="engine"]').click(); const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]); const backup = await readFile(await download.path(), 'utf8'); const payload = JSON.parse(backup).payload; assert.equal(payload.version, 13); assert.equal(payload.branchEvents.length, 1);
    page.once('dialog', d => d.accept()); await page.locator('#reset').click(); await page.getByText('Browser demo cleared. Your private EFFORT app is separate.', { exact: true }).waitFor(); await page.locator('[data-view="engine"]').click(); await page.locator('#restore-file').setInputFiles({ name: 'synthetic-thinking.json', mimeType: 'application/json', buffer: Buffer.from(backup) }); await page.getByText(/Restore verified/).waitFor(); assert.deepEqual((await state(page)).branchEvents, payload.branchEvents); assert.deepEqual((await state(page)).moveEvents, payload.moveEvents);
    await branch(page, b.id); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`); await page.screenshot({ path: `/tmp/effort-thinking-${width}.png`, fullPage: true });
    await context.close(); console.log(`Thinking UI passed at ${width}px.`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(outside, []); console.log('Thinking acceptance passed, with no page errors or external requests.');
} finally { await browser.close(); if (server) await new Promise(r => server.close(r)); }
