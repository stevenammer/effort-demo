// Offline acceptance using an existing Playwright install. No native app or private browser profile.
import { pathToFileURL } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDemoServer } from './serve.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_DIR ? pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`) : 'playwright');
const remote = process.env.DEMO_BASE_URL?.replace(/\/$/, '');
const server = remote ? null : createDemoServer();
if (server) await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = remote || `http://127.0.0.1:${server.address().port}`, errors = [], outside = [];
const output = process.env.DEMO_SCREEN_DIR || '/tmp/effort-demo-screens'; await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844], ['small-phone', 320, 760]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', acceptDownloads: true });
    await context.route('**/*', route => {
      if (!route.request().url().startsWith(base + '/')) { outside.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/public/'); await page.locator('#now-title').getByText("I'll review the workshop outline before lunch.", { exact: true }).waitFor();
    const now = await page.locator('#now-title').innerText();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/home-${name}.png`, fullPage: true });
    await page.locator('[data-view="spans"]').first().click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/spans-${name}.png`, fullPage: true });
    await page.locator('#capture-open').click();
    const original = '  Maybe make a workshop exercise.\nI\'ll test the outline tomorrow.\n<img src=x onerror="window.injected=true">  ';
    await page.locator('#capture-text').fill(original); await page.locator('#capture-span').selectOption('Learning');
    await page.getByText('Draft kept in this browser.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close capture', exact: true }).click(); await page.reload();
    await page.locator('#capture-open').click(); assert.equal(await page.locator('#capture-text').inputValue(), original);
    await page.locator('#save-capture').click(); await page.locator('#capture-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#now-title').innerText(), now);
    await page.locator('[data-view="home"]').click();
    await page.locator('#recent .entry-card').first().getByRole('button').click();
    await page.locator('#show-raw').click(); assert.equal(await page.locator('#source-body pre').innerText(), original);
    await page.locator('#show-organized').click();
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.locator('#source-body .fragment').filter({ hasText: "I'll test the outline tomorrow." }).getByRole('button').click();
    await page.waitForFunction(() => document.querySelector('#now-title').textContent === "I'll test the outline tomorrow.");
    assert.equal(await page.locator('#now-title').innerText(), "I'll test the outline tomorrow.");
    await page.locator('[data-view="engine"]').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
    const exported = await readFile(await download.path(), 'utf8'); const bundle = JSON.parse(exported);
    assert.equal(bundle.payload.captures.at(-1).text, original);
    page.once('dialog', d => d.accept()); await page.locator('#reset').click();
    await page.getByText('Browser demo cleared. Your private EFFORT app is separate.', { exact: true }).waitFor();
    await page.locator('[data-view="engine"]').click();
    const upload = text => page.locator('#restore-file').setInputFiles({ name: 'demo.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await upload(exported); await page.getByText('Restore verified. 3 missing captures added; existing originals kept.', { exact: true }).waitFor();
    await upload(exported); await page.getByText('Restore verified. 0 missing captures added; existing originals kept.', { exact: true }).waitFor();
    bundle.payload.captures[0].text = 'Changed without a checksum'; await upload(JSON.stringify(bundle));
    await page.getByText('Backup checksum mismatch. Nothing was changed.', { exact: true }).waitFor();
    assert.equal(await page.locator('#storage-count').innerText(), '3 saved originals');
    // Inject a real database request failure rather than failing obsolete localStorage writes.
    await page.evaluate(() => { window.originalAdd = IDBObjectStore.prototype.add; IDBObjectStore.prototype.add = function(value) { if (this.name === 'captures') throw Error('Storage unavailable for this test'); return window.originalAdd.call(this, value); }; });
    await page.locator('#capture-open').click(); await page.locator('#capture-text').fill('Keep this failed-save draft.'); await page.locator('#save-capture').click();
    await page.locator('#draft-state').getByText('Storage unavailable for this test', { exact: false }).waitFor();
    assert.equal(await page.locator('#capture-text').inputValue(), 'Keep this failed-save draft.');
    await page.evaluate(() => { IDBObjectStore.prototype.add = window.originalAdd; });
    await page.getByRole('button', { name: 'Close capture', exact: true }).click();
    // Damage the actual database; preserve the damaged bytes and continue capture.
    await page.evaluate(async () => {
      const { openDatabase, request } = await import('./database.js'); const db = openDatabase();
      await db.run(['captures'], 'readwrite', async tx => { const table = tx.objectStore('captures'); const rows = await request(table.getAll()); const damaged = rows.find(row => row.sample); damaged.text = 'Damaged fixture bytes'; await request(table.put(damaged)); }); await db.close();
    });
    await page.reload(); await page.locator('#capture-open').waitFor({ state: 'visible' });
    await page.locator('[data-view="engine"]').click(); await page.locator('#recovery-status').getByText('1 damaged record preserved separately.', { exact: false }).waitFor();
    await page.locator('#capture-open').click(); assert.equal(await page.locator('#capture-text').inputValue(), 'Keep this failed-save draft.');
    await page.locator('#save-capture').click(); await page.locator('#capture-dialog').waitFor({ state: 'hidden' });
    // A second real tab must see updates without reload and must not overwrite the first.
    const second = await context.newPage(); await second.goto(base + '/public/');
    await second.locator('#capture-open').click(); await second.locator('#capture-text').fill('A thought from the second tab.'); await second.locator('#save-capture').click();
    await second.locator('#capture-dialog').waitFor({ state: 'hidden' });
    await page.locator('#storage-count').getByText('4 saved originals', { exact: true }).waitFor();
    await second.close();
    page.once('dialog', d => d.accept()); await page.locator('#sample-reset').click();
    await page.getByText('Fictional examples loaded.', { exact: true }).waitFor();
    await page.locator('[data-view="engine"]').click(); await page.screenshot({ path: `${output}/engine-${name}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await context.close();
  }
  // Exercise an actual pre-upgrade visitor profile, including a damaged original.
  const migration = await browser.newContext();
  await migration.addInitScript(({ hash }) => {
    if (sessionStorage.getItem('migration-fixture')) return;
    const text = '  A pre-upgrade thought.\nKeep the spacing.  ';
    const good = { id: '11111111-1111-4111-8111-111111111111', text, hash, createdAt: '2026-01-01T00:00:00.000Z', span: 'Learning', sample: false };
    const bad = { ...good, id: '22222222-2222-4222-8222-222222222222', text: 'Changed bytes without a matching checksum.' };
    const raw = JSON.stringify({ version: 1, kind: 'effort-browser-demo', captures: [good, bad], now: null });
    localStorage.setItem('effort-public-demo-v1', raw); sessionStorage.setItem('original-fixture', raw); sessionStorage.setItem('migration-fixture', '1');
  }, { hash: createHash('sha256').update('  A pre-upgrade thought.\nKeep the spacing.  ').digest('hex') });
  const legacyPage = await migration.newPage(); await legacyPage.goto(base + '/public/');
  await legacyPage.locator('[data-view="engine"]').click();
  await legacyPage.locator('#storage-count').getByText('1 saved original', { exact: true }).waitFor();
  assert.equal(await legacyPage.evaluate(() => localStorage.getItem('effort-public-demo-v1') === sessionStorage.getItem('original-fixture')), true);
  await legacyPage.locator('#capture-open').click(); await legacyPage.locator('#capture-text').fill('Capture still works after migration.'); await legacyPage.locator('#save-capture').click();
  await legacyPage.locator('#capture-dialog').waitFor({ state: 'hidden' }); await legacyPage.reload();
  await legacyPage.locator('#storage-count').getByText('2 saved originals', { exact: true }).waitFor();
  await migration.close();
  assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  console.log('PASS: 1440px, 390px and 320px; exact originals, draft recovery, explicit NOW choice, export/restore, tamper refusal, failed database writes, damaged-record recovery and cross-tab refresh. No page errors or external requests.');
} finally { await browser.close(); if (server) await new Promise(done => server.close(done)); }
