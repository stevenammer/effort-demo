// Acceptance for the bounded safe exploration slice. Uses the demo's existing Playwright install.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDemoServer } from './serve.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_DIR
  ? pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`)
  : 'playwright');
const remote = process.env.DEMO_BASE_URL?.replace(/\/$/, '');
const server = remote ? null : createDemoServer();
if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = remote || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errors = [], outside = [];
const source = 'Exploration fixture: prepare a small workshop';
const rawText = '  Try the exercise first.\n<img src=x onerror="window.injection=true">  ';

try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844], ['small-phone', 320, 760]]) {
    const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, reducedMotion: 'reduce' });
    context.setDefaultTimeout(10000);
    await context.route('**/*', route => {
      if (!route.request().url().startsWith(base + '/')) { outside.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.goto(`${base}/public/`);
    await page.locator('#capture-open:enabled').waitFor();
    await page.keyboard.press('Tab');
    await page.locator('.skip').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.skip').getAttribute('href'), '#main');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'main');
    await page.evaluate(() => document.activeElement.blur());
    await page.locator('#capture-open').click();
    await page.locator('#capture-text').fill(source);
    await page.locator('#save-capture').click();
    await page.locator('#capture-dialog').waitFor({ state: 'hidden' });
    const sourceId = await page.evaluate(async text => {
      const { createStore } = await import('./store.js');
      return (await createStore().read()).captures.find(row => row.text === text).id;
    }, source);
    await page.goto(`${base}/public/#thread/${sourceId}`);
    await page.locator('#thread-post h1').waitFor();
    assert.equal(await page.locator('#thread-post h1').innerText(), source, `thread failed to open: ${await page.locator('#thread-post').innerText()}`);
    const initialNow = await page.locator('#now-title').textContent();
    assert.ok(initialNow);

    // Home's own exploration affordance starts from the chosen NOW and returns to its source thread.
    const homeNowId = await page.evaluate(async () => {
      const { createStore } = await import('./store.js');
      return (await createStore().read()).now.captureId;
    });
    await page.locator('[data-view="home"]').click();
    await page.locator('#now-explore').click();
    await page.locator('#explore-text:enabled').waitFor();
    await page.locator('#explore-text').fill('A branch started from Home.');
    await page.locator('#explore-dial').selectOption('NORMAL');
    await page.locator('#save-exploration').click();
    await page.waitForFunction(id => location.hash === `#thread/${id}`, homeNowId);
    assert.equal(await page.locator('#now-title').textContent(), initialNow, 'Home exploration must leave NOW unchanged');
    await page.goto(`${base}/public/#thread/${sourceId}`);
    await page.locator('#thread-post h1').waitFor();

    // An exploration draft survives closing and reload in the thread composer context.
    await page.locator('#thread-post').getByRole('button', { name: 'Explore safely…', exact: true }).click();
    await page.locator('#explore-form').waitFor();
    await page.locator('#explore-text').fill(rawText);
    await page.locator('#explore-dial').selectOption('UNHINGED SANDBOX');
    await page.getByRole('button', { name: 'Close exploration', exact: true }).click();
    await page.reload();
    await page.locator('#thread-post h1').waitFor();
    await page.locator('#thread-post').getByRole('button', { name: 'Explore safely…', exact: true }).click();
    await page.locator('#explore-text:enabled').waitFor();
    assert.equal(await page.locator('#explore-text').inputValue(), rawText);
    assert.equal(await page.locator('#explore-dial').inputValue(), 'UNHINGED SANDBOX');
    await page.locator('#save-exploration').click();
    await page.locator('#explore-dialog').waitFor({ state: 'hidden' });
    const wild = page.locator('#thread-explorations .exploration-card').filter({ hasText: rawText });
    await wild.waitFor();
    assert.equal(await wild.locator('button', { hasText: 'Choose from original' }).count(), 0, 'UNHINGED SANDBOX must not expose original promotion');
    assert.equal(await page.locator('#now-title').textContent(), initialNow, 'saving an exploration must not alter NOW');
    assert.equal(await page.evaluate(() => window.injection), undefined, 'raw exploration text must not execute HTML');

    // Nested branches retain provenance and every dial value is saveable.
    await wild.getByRole('button', { name: 'Branch from here…', exact: true }).click();
    await page.locator('#explore-dialog').waitFor();
    await page.locator('#explore-text').fill('A nested branch, kept separate.');
    await page.locator('#explore-dial').selectOption('TIGHT');
    await page.locator('#save-exploration:enabled').waitFor();
    await page.locator('#save-exploration').click();
    const nested = page.locator('#thread-explorations .exploration-card').filter({ hasText: 'A nested branch, kept separate.' });
    await nested.waitFor();
    await page.screenshot({ path: `/tmp/effort-exploration-${width}.png`, fullPage: true });
    for (const dial of ['NORMAL', 'WILD']) {
      await page.locator('#thread-post').getByRole('button', { name: 'Explore safely…', exact: true }).click();
      await page.locator('#explore-text').fill(`Dial check ${dial}`);
      await page.locator('#explore-dial').selectOption(dial);
      await page.locator('#save-exploration').click();
      await page.locator('#thread-explorations .exploration-card').filter({ hasText: `Dial check ${dial}` }).waitFor();
    }

    // Distillation drafts persist. Saving one is inert until the explicit original choice.
    await nested.getByRole('button', { name: 'Distill…', exact: true }).click();
    await page.locator('#distill-text').fill('  A useful open tension.\n<script>window.injection=true</script>  ');
    await page.locator('#distill-type').selectOption({ label: 'OPEN TENSION' });
    await page.locator('#distill-error').getByText('Draft kept in this browser.', { exact: true }).waitFor();
    await page.reload();
    await nested.getByRole('button', { name: 'Distill…', exact: true }).click();
    await page.locator('#distill-text:enabled').waitFor();
    assert.equal(await page.locator('#distill-text').inputValue(), '  A useful open tension.\n<script>window.injection=true</script>  ');
    assert.equal(await page.locator('#distill-type').inputValue(), 'OPEN TENSION');
    await page.locator('#save-distillation').click();
    await page.locator('#distill-dialog').waitFor({ state: 'hidden' });
    const distillation = page.locator('#thread-explorations .distillation-card').filter({ hasText: 'A useful open tension.' });
    await distillation.waitFor();
    assert.equal(await page.locator('#now-title').textContent(), initialNow, 'saving a distillation must not alter NOW');
    assert.equal(await page.evaluate(() => window.injection), undefined);
    await distillation.getByRole('button', { name: 'Choose from original…', exact: true }).click();
    await page.locator('#source-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#now-title').textContent(), initialNow, 'opening the original must not change NOW');
    await page.locator('#show-organized').click();
    const originalChoice = page.locator('#source-body .fragment button').first();
    await originalChoice.waitFor();
    await originalChoice.click();
    await page.locator('#source-dialog').waitFor({ state: 'hidden' });
    await page.locator('[data-view="home"]').click();
    await page.waitForFunction(before => document.querySelector('#now-title').textContent !== before, initialNow);
    assert.match(await page.locator('#now-title').textContent(), /Exploration fixture|prepare a small workshop/i);

    // Source choice returns Home. Reopen the original thread, then resume its saved place.
    await page.goto(`${base}/public/#thread/${sourceId}`);
    await page.locator('#thread-post h1').waitFor();
    const returnCard = page.locator('#thread-explorations .exploration-card').filter({ hasText: 'A nested branch, kept separate.' });
    await returnCard.getByRole('button', { name: 'Return to where I was', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('#now-title').textContent === expected, initialNow);

    // A pending exploration write keeps the editor text when IndexedDB rejects it.
    await page.goto(`${base}/public/#thread/${sourceId}`);
    await page.locator('#thread-post h1').waitFor();
    await page.locator('#thread-post').getByRole('button', { name: 'Explore safely…', exact: true }).click();
    await page.locator('#explore-text').fill('Keep this failed exploration draft.');
    await page.evaluate(() => {
      window.originalExploreAdd = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(value) {
        if (this.name === 'explorations') throw Error('Exploration storage unavailable for this test');
        return window.originalExploreAdd.call(this, value);
      };
    });
    await page.locator('#save-exploration').click();
    await page.getByText(/Exploration storage unavailable for this test/).waitFor();
    assert.equal(await page.locator('#explore-text').inputValue(), 'Keep this failed exploration draft.');
    await page.evaluate(() => { IDBObjectStore.prototype.add = window.originalExploreAdd; });
    await page.getByRole('button', { name: 'Close exploration', exact: true }).click();

    // Second tab sees committed exploration and distillation without a reload.
    const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
    await second.goto(`${base}/public/#thread/${sourceId}`);
    await second.locator('#thread-post h1').waitFor();
    await second.locator('#thread-explorations .exploration-card').filter({ hasText: 'A nested branch, kept separate.' }).waitFor();
    await second.locator('#thread-explorations .distillation-card').filter({ hasText: 'A useful open tension.' }).waitFor();
    await second.locator('#thread-explorations .exploration-card').filter({ hasText: 'A nested branch, kept separate.' }).getByRole('button', { name: 'Branch from here…', exact: true }).click();
    await second.locator('#explore-text').fill('Saved in the other tab.');
    await second.locator('#explore-dial').selectOption('NORMAL');
    await second.locator('#save-exploration').click();
    await page.locator('#thread-explorations .exploration-card').filter({ hasText: 'Saved in the other tab.' }).waitFor();

    // Export and restore preserve branch structure, open tensions and exact text.
    await page.locator('[data-view="engine"]').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
    const backup = await readFile(await download.path(), 'utf8');
    const payload = JSON.parse(backup).payload;
    assert.ok(payload.explorations.some(row => row.text === rawText && row.dial === 'UNHINGED SANDBOX'));
    assert.ok(payload.explorations.some(row => row.text === 'A nested branch, kept separate.' && row.parentId));
    assert.ok(payload.distillations.some(row => row.type === 'OPEN TENSION' && row.text.includes('<script>')));
    const restoreContext = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
    restoreContext.setDefaultTimeout(10000);
    await restoreContext.route('**/*', route => {
      if (!route.request().url().startsWith(base + '/')) { outside.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const restorePage = await restoreContext.newPage(); restorePage.on('pageerror', error => errors.push(error.message));
    restorePage.setDefaultTimeout(10000);
    await restorePage.goto(`${base}/public/`); await restorePage.locator('[data-view="engine"]').click();
    await restorePage.locator('#restore-file').setInputFiles({ name: 'exploration-backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
    await restorePage.getByText(/Restore verified/).waitFor();
    await restorePage.goto(`${base}/public/#thread/${sourceId}`);
    await restorePage.locator('#thread-explorations .exploration-card').filter({ hasText: 'A nested branch, kept separate.' }).waitFor();
    await restorePage.locator('#thread-explorations .distillation-card').filter({ hasText: 'A useful open tension.' }).waitFor();
    await restoreContext.close();

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} layout overflow`);
    await second.close(); await context.close();
  }
  // The installed shell starts, then can reopen with the network cut off.
  const offlineContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  offlineContext.setDefaultTimeout(10000);
  await offlineContext.route('**/*', route => {
    if (!route.request().url().startsWith(base + '/')) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const offlinePage = await offlineContext.newPage(); offlinePage.setDefaultTimeout(10000); offlinePage.on('pageerror', error => errors.push(error.message));
  await offlinePage.goto(`${base}/public/`);
  await offlinePage.locator('[data-view="engine"]').click();
  await offlinePage.locator('#offline-status').getByText('Available offline in this browser.', { exact: false }).waitFor();
  await offlineContext.setOffline(true); await offlinePage.reload();
  await offlinePage.locator('#now-title').waitFor();
  assert.equal(await offlinePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'offline shell layout overflow');
  await offlineContext.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log('PASS: safe exploration, nested branches, all dials, open tension distillation, inert saves, explicit promotion/return, persistent drafts, failed-write recovery, cross-tab updates, backup/restore, offline reopen and 1440px/390px/320px layouts. No page errors or external requests.');
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
