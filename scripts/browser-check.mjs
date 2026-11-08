// Offline acceptance using an existing Playwright install. No native app or private browser profile.
import { pathToFileURL } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createDemoServer } from './serve.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_DIR ? pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`) : 'playwright');
const server = createDemoServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`, errors = [], outside = [];
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
    // Real browser storage failures must leave the input and its draft intact.
    await page.evaluate(() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v) { if (k === 'effort-public-demo-v1') throw Error('Storage unavailable for this test'); return window.originalSetItem.call(this, k, v); }; });
    await page.locator('#capture-open').click(); await page.locator('#capture-text').fill('Keep this failed-save draft.'); await page.locator('#save-capture').click();
    await page.locator('#draft-state').getByText('Storage unavailable for this test', { exact: false }).waitFor();
    assert.equal(await page.locator('#capture-text').inputValue(), 'Keep this failed-save draft.');
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
    await page.getByRole('button', { name: 'Close capture', exact: true }).click();
    // A broken saved-state record cannot silently erase a valid draft on reload.
    await page.evaluate(() => localStorage.setItem('effort-public-demo-v1', '{broken'));
    await page.reload(); await page.getByText('Saved demo data could not be verified.', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('effort-public-demo-v1-draft')).text), 'Keep this failed-save draft.');
    await page.reload(); assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('effort-public-demo-v1-draft')).text), 'Keep this failed-save draft.');
    page.once('dialog', d => d.accept()); await page.locator('#sample-reset').click();
    await page.getByText('Fictional examples loaded.', { exact: true }).waitFor();
    await page.locator('[data-view="engine"]').click(); await page.screenshot({ path: `${output}/engine-${name}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  console.log('PASS: 1440px, 390px and 320px; exact originals, draft recovery, explicit NOW choice, export/restore, tamper refusal, failed storage and corrupt-cache recovery. No page errors or external requests.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
