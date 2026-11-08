// Isolated synthetic composer continuity checks. No private profile or network requests.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createDemoServer } from './serve.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_DIR ? pathToFileURL(`${process.env.PLAYWRIGHT_DIR}/index.mjs`) : 'playwright');
const server = createDemoServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errors = [], external = []; let context;
try {
  context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = route.request().url(); if (!url.startsWith(base + '/')) { external.push(url); return route.abort(); }
    if (url.endsWith('/public/app.js')) {
      const response = await route.fetch(); let code = await response.text();
      code = code.replace('store = createStore(); await store.seed();', 'store = createStore(); await new Promise(resolve => setTimeout(resolve, 800)); await store.seed();');
      code = code.replace('let record = await shelf.load(context);', "if (window.__delayReply && context.startsWith('reply:')) await new Promise(resolve => setTimeout(resolve, 400)); let record = await shelf.load(context);");
      code = code.replace('await store.capture(text, span, null, { requestId:', "if (window.__delayCapture) { window.__captureWaiting = true; await new Promise(resolve => { window.__releaseCapture = resolve; }); } await store.capture(text, span, null, { requestId:");
      code = code.replace("await clearDraft('capture', body); releaseRequest", "await clearDraft('capture', body); if(window.__pauseCleanup) { window.__cleanupWaiting = true; await new Promise(resolve => { window.__releaseCleanup = resolve; }); } releaseRequest");
      return route.fulfill({ response, body: code });
    }
    return route.continue();
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/public/'); await page.waitForFunction(() => document.querySelector('#main').inert); assert.equal(await page.locator('#main').getAttribute('aria-busy'), 'true'); await page.locator('#hold-open').evaluate(button => button.click()); assert.equal(await page.locator('#hold-dialog').evaluate(dialog => dialog.open), false); await page.locator('#capture-open:enabled').waitFor(); assert.equal(await page.locator('#main').evaluate(main => main.inert), false); await page.locator('#hold-open').waitFor();
  await page.locator('#hold-open').click(); await page.locator('#hold-summary').fill('Synthetic held place'); await page.locator('#hold-next').fill('Synthetic next note');
  await page.getByRole('button', { name: 'Close hold my place' }).click(); await page.reload(); await page.locator('#hold-open').click();
  await page.locator('#hold-summary:enabled').waitFor(); assert.equal(await page.locator('#hold-summary').inputValue(), 'Synthetic held place'); assert.equal(await page.locator('#hold-next').inputValue(), 'Synthetic next note');
  await page.getByRole('button', { name: 'Close hold my place' }).click();
  await page.locator('[data-view="spans"]').first().click(); await page.locator('#new-span').click(); await page.locator('#span-name').fill('Synthetic span draft');
  await page.getByRole('button', { name: 'Close new Attention Span' }).click(); await page.reload(); await page.locator('[data-view="spans"]').first().click(); await page.locator('#new-span').click();
  await page.locator('#span-name:enabled').waitFor(); assert.equal(await page.locator('#span-name').inputValue(), 'Synthetic span draft'); await page.getByRole('button', { name: 'Close new Attention Span' }).click();
  await page.locator('#span-list').getByRole('link', { name: 'Workspace', exact: true }).click(); await page.locator('.commitment-card').first().getByRole('button', { name: 'Drop commitment…' }).click();
  await page.locator('#drop-note').fill('Synthetic retained reason'); await page.getByRole('button', { name: 'Close drop commitment' }).click(); await page.reload();
  await page.locator('.commitment-card').first().getByRole('button', { name: 'Drop commitment…' }).click(); await page.locator('#drop-note:enabled').waitFor(); assert.equal(await page.locator('#drop-note').inputValue(), 'Synthetic retained reason'); await page.getByRole('button', { name: 'Close drop commitment' }).click();
  // Two actual post routes, then a nested draft retained across reload and rapid route changes.
  await page.locator('[data-view="home"]').click();
  for (const text of ['Synthetic thread alpha', 'Synthetic thread beta']) { await page.locator('#capture-open').click(); await page.locator('#capture-text').fill(text); await page.locator('#save-capture').click(); await page.locator('#capture-dialog').waitFor({ state: 'hidden' }); }
  const ids = await page.evaluate(async () => { const { createStore } = await import('./store.js'); const s = createStore(), state = await s.read(); return ['Synthetic thread alpha', 'Synthetic thread beta'].map(t => state.captures.find(c => c.text === t).id); });
  await page.goto(`${base}/public/#thread/${ids[0]}`); await page.locator('#reply-text').fill('Synthetic first reply'); await page.locator('#save-reply').click(); await page.locator('.thread-reply').waitFor();
  await page.locator('.thread-reply').first().getByRole('button', { name: 'Reply to this' }).click(); await page.locator('#reply-text').fill('Synthetic nested draft');
  await page.locator('#reply-draft-state').getByText('Draft kept in this browser.', { exact: true }).waitFor(); await page.reload(); await page.locator('#thread-post h1').waitFor(); assert.equal(await page.locator('#reply-text').inputValue(), 'Synthetic nested draft');
  await page.locator('#save-reply').click(); await page.locator('.thread-reply.depth-1').waitFor();
  const parentLinks = await page.evaluate(async () => { const { createStore } = await import('./store.js'); const state = await createStore().read(); const parent = state.captures.find(c => c.text === 'Synthetic first reply'), child = state.captures.find(c => c.text === 'Synthetic nested draft'); return { parent: parent.id, parentParent: parent.parentId, childParent: child.parentId }; }); assert.equal(parentLinks.parentParent, ids[0]); assert.equal(parentLinks.childParent, parentLinks.parent);
  await page.locator('#reply-text').fill('Alpha retained draft'); await page.locator('#reply-draft-state').getByText('Draft kept in this browser.', { exact: true }).waitFor();
  await page.evaluate(([a,b]) => { window.__delayReply = true; location.hash = `#thread/${b}`; setTimeout(() => { location.hash = `#thread/${a}`; }, 20); }, ids);
  await page.locator('#thread-post h1').getByText('Synthetic thread alpha').waitFor(); assert.equal(await page.locator('#reply-text').inputValue(), 'Alpha retained draft');
  // Hold the original save after submission and type newer text while it is pending.
  await page.locator('#capture-open').click(); await page.locator('#capture-text').fill('Original submitted text'); await page.evaluate(() => { window.__delayCapture = true; });
  await page.locator('#save-capture').click(); await page.waitForFunction(() => window.__captureWaiting); await page.locator('#capture-text').fill('Newer unsent text'); await page.evaluate(() => window.__releaseCapture());
  await page.getByText('Saved. Exact original read back and verified. Your next step is unchanged.', { exact: true }).waitFor(); assert.equal(await page.locator('#capture-text').inputValue(), 'Newer unsent text');
  await page.reload(); await page.locator('#capture-open').click(); assert.equal(await page.locator('#capture-text').inputValue(), 'Newer unsent text');
  await page.locator('#capture-text').fill('Second submitted text'); await page.evaluate(() => { window.__delayCapture = false; window.__pauseCleanup = true; });
  await page.locator('#save-capture').click(); await page.waitForFunction(() => window.__cleanupWaiting); await page.locator('#capture-text').fill('Writing entered during cleanup'); await page.evaluate(() => window.__releaseCleanup());
  await page.locator('#save-capture:enabled').waitFor(); assert.equal(await page.locator('#capture-text').inputValue(), 'Writing entered during cleanup');
  await page.reload(); await page.locator('#capture-open').click(); assert.equal(await page.locator('#capture-text').inputValue(), 'Writing entered during cleanup');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); console.log('PASS: delayed startup protection; hold, span, drop and nested reply drafts; rapid reply route switching; later capture input survives save and reload.');
} catch (error) { console.error('PAGE ERRORS:', errors, 'EXTERNAL:', external); throw error; } finally { if (context) await context.unrouteAll({ behavior: 'wait' }); await browser.close(); await new Promise(resolve => server.close(resolve)); }
