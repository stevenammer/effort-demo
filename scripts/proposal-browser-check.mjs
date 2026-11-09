// Acceptance for derived-proposal preparation. Uses an isolated synthetic browser workspace.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const sourceText = 'Fictional source: plan a workshop exercise.\nMaybe keep the first version small.';
const branchText = 'I noticed one small workshop exercise could work.';
const distillationText = 'I\'ll test one fictional workshop exercise on Friday.\n<img src=x onerror="window.proposalInjected=true">';
const distillationType = 'DECISION CANDIDATE';

function routeContext(context) {
  return context.route('**/*', route => {
    if (!route.request().url().startsWith(base + '/')) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
}
async function stateOf(page) {
  return page.evaluate(async () => {
    const { createStore } = await import('./store.js');
    const store = createStore();
    try { return await store.read(); } finally { await store.close(); }
  });
}
async function addBranch(page, text, dial = 'WILD') {
  await page.locator('#thread-post').getByRole('button', { name: 'Explore safely…', exact: true }).click();
  await page.locator('#explore-text:enabled').waitFor();
  await page.locator('#explore-text').fill(text);
  await page.locator('#explore-dial').selectOption(dial);
  await page.locator('#save-exploration').click();
  const branch = page.locator('#thread-explorations .exploration-card').filter({ hasText: text });
  await branch.waitFor();
  return branch;
}
async function addDistillation(page, branch, text, type = distillationType) {
  await branch.getByRole('button', { name: 'Distill…', exact: true }).click();
  await page.locator('#distill-text:enabled').waitFor();
  await page.locator('#distill-text').fill(text);
  await page.locator('#distill-type').selectOption(type);
  await page.locator('#save-distillation').click();
  await page.locator('#distill-dialog').waitFor({ state: 'hidden' });
  const card = page.locator('#thread-explorations .distillation-card').filter({ hasText: text });
  await card.waitFor();
  return card;
}
async function captureSeed(page, suffix = '') {
  await page.goto(`${base}/public/`);
  await page.locator('#capture-open:enabled').waitFor();
  await page.locator('#capture-open').click();
  await page.locator('#capture-text').fill(suffix ? `${sourceText}\n${suffix}` : sourceText);
  await page.locator('#save-capture').click();
  await page.locator('#capture-dialog').waitFor({ state: 'hidden' });
  const savedText = suffix ? `${sourceText}\n${suffix}` : sourceText;
  const sourceId = await page.evaluate(async text => {
    const { createStore } = await import('./store.js');
    return (await createStore().read()).captures.find(row => row.text === text).id;
  }, savedText);
  await page.goto(`${base}/public/#thread/${sourceId}`);
  await page.locator('#thread-post h1').waitFor();
  return { sourceId, savedText };
}
async function prepareMainFlow(page, { faultReadback = false, viewportName, width }) {
  const { sourceId } = await captureSeed(page);
  const initialState = await stateOf(page);
  const initialNow = await page.locator('#now-title').textContent();
  const initialChoice = initialState.now;
  const branch = await addBranch(page, branchText, 'WILD');
  assert.equal(await page.locator('#now-title').textContent(), initialNow, 'exploration must leave NOW unchanged');
  const distillation = await addDistillation(page, branch, distillationText);
  const before = await stateOf(page);
  const distillationId = before.distillations.find(row => row.text === distillationText)?.id;
  assert.ok(distillationId, 'the exact distillation must be persisted');
  assert.equal(await page.locator('#now-title').textContent(), initialNow, 'distillation must leave NOW unchanged');
  let peer = null;
  if (viewportName === 'desktop') {
    peer = await page.context().newPage(); peer.setDefaultTimeout(10000); peer.on('pageerror', error => errors.push(error.message));
    await peer.goto(`${base}/public/#thread/${sourceId}`); await peer.locator('#thread-post h1').waitFor();
    await peer.locator('#thread-explorations .distillation-card').filter({ hasText: distillationText }).waitFor();
  }

  // Verify that a sandbox distillation is not promotable in the UI or store API.
  const sandbox = await addBranch(page, 'Sandbox-only branch', 'UNHINGED SANDBOX');
  const sandboxDistill = await addDistillation(page, sandbox, 'Sandbox proposal refusal fixture.', 'INSIGHT');
  assert.equal(await sandboxDistill.getByRole('button', { name: 'Consider as a next step…', exact: true }).count(), 0);
  const sandboxId = (await stateOf(page)).distillations.find(row => row.text === 'Sandbox proposal refusal fixture.').id;
  const refusal = await page.evaluate(async distillationId => {
    const { createStore } = await import('./store.js');
    try { await createStore().prepareProposal({ distillationId }); return null; }
    catch (error) { return error.message; }
  }, sandboxId);
  assert.match(refusal, /sandbox/i, 'the store must refuse direct sandbox promotion');
  assert.equal(await page.locator('#now-title').textContent(), initialNow);

  if (faultReadback) {
    const proposalId = await page.evaluate(async distillationId => {
      const { stableId } = await import('./primitives.js');
      const { createStore } = await import('./store.js');
      const store = createStore(); const { epoch } = await store.health(); await store.close();
      return stableId(JSON.stringify(['proposal', epoch ?? null, distillationId]));
    }, distillationId);
    await page.evaluate(id => {
      window.__proposalOriginalGet = IDBObjectStore.prototype.get;
      window.__proposalReads = 0;
      window.__proposalFailReadback = true;
      IDBObjectStore.prototype.get = function(key) {
        const request = window.__proposalOriginalGet.call(this, key);
        if (this.name === 'captures' && key === id) {
          window.__proposalReads++;
          if (window.__proposalReads === 2 && window.__proposalFailReadback) {
            window.__proposalFailReadback = false;
            Object.defineProperty(request, 'result', { configurable: true, get: () => undefined });
          }
        }
        return request;
      };
    }, proposalId);
  }

  const consider = distillation.getByRole('button', { name: 'Consider as a next step…', exact: true });
  if (viewportName === 'desktop') { await consider.focus(); await page.keyboard.press('Enter'); }
  else await consider.click();
  if (faultReadback) {
    const oldNotice = await page.locator('#notice').textContent();
    await page.locator('#notice').waitFor({ state: 'visible' });
    await page.waitForFunction(old => document.querySelector('#notice').textContent !== old, oldNotice);
    assert.match(await page.locator('#notice').textContent(), /proposal could not be read back/i);
    const afterFault = await stateOf(page);
    assert.equal(afterFault.captures.filter(row => row.derivedFromId === distillationId).length, 1, 'the committed proposal must survive a readback failure');
    await page.evaluate(() => { IDBObjectStore.prototype.get = window.__proposalOriginalGet; });
    const retry = page.locator('#thread-explorations .distillation-card').filter({ hasText: distillationText }).getByRole('button', { name: 'Consider as a next step…', exact: true });
    await retry.click();
  }
  await page.locator('#source-dialog').waitFor({ state: 'visible' });
  await page.locator('#source-body .proposal-provenance p').getByText('Prepared from your distillation. Saved links verified.', { exact: true }).waitFor();
  assert.equal(await page.locator('#now-title').textContent(), initialNow, 'preparing a proposal must not change NOW');
  assert.equal(await page.evaluate(() => window.proposalInjected), undefined, 'proposal text must remain inert');
  const saved = await stateOf(page);
  const proposal = saved.captures.find(row => row.derivedFromId === distillationId);
  assert.ok(proposal, 'proposal capture must be persisted');
  assert.equal(proposal.text, distillationText, 'proposal text must exactly match its distillation');
  assert.equal(saved.intentEvents.length, before.intentEvents.length, 'preparation must not create a commitment');
  if (faultReadback) assert.equal(saved.captures.filter(row => row.derivedFromId === distillationId).length, 1, 'retry must be idempotent');
  if (peer) {
    const peerReply = peer.locator('#thread-replies .thread-reply').filter({ hasText: distillationText });
    await peerReply.locator('.proposal-provenance p').getByText('Prepared from your distillation. Saved links verified.', { exact: true }).waitFor();
    await peer.locator('#thread-explorations .distillation-card').filter({ hasText: distillationText }).getByRole('button', { name: 'Consider as a next step…', exact: true }).click();
    await peer.locator('#source-dialog').waitFor({ state: 'visible' });
    assert.equal((await stateOf(peer)).captures.filter(row => row.id === proposal.id).length, 1, 'a second tab must reuse the same prepared proposal');
    await peer.getByRole('button', { name: 'Close original', exact: true }).click();
  }

  const provenance = page.locator('#source-body .proposal-provenance');
  await provenance.locator('.proposal-lineage summary').click();
  const lineage = provenance.locator('.proposal-lineage');
  assert.deepEqual(await lineage.locator('pre').allTextContents(), [distillationText, branchText, sourceText]);
  await lineage.getByRole('button', { name: 'Open source thread', exact: true }).click();
  await page.locator('#source-dialog').waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).hash, `#thread/${sourceId}`, 'lineage should return to the original source thread');
  await page.locator('#thread-explorations .distillation-card').filter({ hasText: distillationText }).waitFor();

  // Reopen the prepared proposal and commit only an exact organized fragment.
  const card = page.locator('#thread-replies .thread-reply').filter({ hasText: distillationText });
  await card.locator('.proposal-provenance p').getByText('Prepared from your distillation. Saved links verified.', { exact: true }).waitFor();
  const beforeChoice = await page.locator('#now-title').textContent();
  const matching = await stateOf(page);
  assert.equal(matching.captures.filter(row => row.derivedFromId === distillationId).length, 1);
  const reopen = page.locator('#thread-explorations .distillation-card').filter({ hasText: distillationText }).getByRole('button', { name: 'Consider as a next step…', exact: true });
  await reopen.click();
  await page.locator('#source-body .fragment').filter({ hasText: "I'll test one fictional workshop exercise on Friday." }).getByRole('button', { name: 'Make this my next step', exact: true }).click();
  await page.locator('#source-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#now-title').textContent === "I'll test one fictional workshop exercise on Friday.");
  assert.notEqual(await page.locator('#now-title').textContent(), beforeChoice, 'only explicit source-quote selection changes NOW');
  assert.equal(await page.evaluate(() => window.proposalInjected), undefined);
  await page.goto(`${base}/public/#thread/${sourceId}`); await page.locator('#thread-post h1').waitFor();
  await page.locator('#thread-explorations .distillation-card').filter({ hasText: distillationText }).waitFor();
  await page.locator('#thread-replies .thread-reply').filter({ hasText: distillationText }).waitFor();
  await page.locator('#thread-explorations .exploration-card').filter({ hasText: branchText }).locator('.branch-promotion summary').getByText('Used for a chosen step', { exact: true }).waitFor();
  if (viewportName) await page.screenshot({ path: `/tmp/effort-proposal-${width}.png`, fullPage: true });
  return { sourceId, distillationId, proposalId: proposal.id, initialNow, initialChoice, initialEvents: initialState.intentEvents, branchText, distillationText, peer };
}

async function restoreFile(page, json) {
  await page.locator('#restore-file').setInputFiles({ name: 'proposal-backup.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await page.getByText(/Restore verified/).waitFor();
}

try {
  const contexts = [];
  let desktopData;
  for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844], ['small-phone', 320, 760]]) {
    const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, reducedMotion: 'reduce' });
    context.setDefaultTimeout(10000); routeContext(context); contexts.push(context);
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/public/`); await page.locator('#capture-open:enabled').waitFor();
    await page.keyboard.press('Tab'); await page.locator('.skip').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.skip').getAttribute('href'), '#main'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'main'); await page.evaluate(() => document.activeElement.blur());
    const data = await prepareMainFlow(page, { faultReadback: name === 'desktop', viewportName: name, width });
    if (name === 'desktop') desktopData = { ...data, page, context };
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} layout overflow`);
  }

  const { page, context, sourceId, proposalId, distillationId, distillationText, initialChoice, initialEvents, peer } = desktopData;

  // Export v11 with proposal provenance and prepare a valid version 6 migration fixture.
  await page.locator('[data-view="engine"]').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  const backup = await readFile(await download.path(), 'utf8');
  const bundle = JSON.parse(backup), payload = structuredClone(bundle.payload);
  assert.equal(payload.version, 11); assert.ok(payload.captures.some(row => row.id === proposalId));
  const legacyPayload = structuredClone(payload); legacyPayload.version = 6; delete legacyPayload.personEvents; delete legacyPayload.contactReceipts; delete legacyPayload.openedReceipts; delete legacyPayload.artifacts; delete legacyPayload.branchEvents; delete legacyPayload.moveEvents;
  legacyPayload.captures = legacyPayload.captures.filter(row => !row.derivedFromId);
  const keptCaptureIds = new Set(legacyPayload.captures.map(row => row.id));
  legacyPayload.now = initialChoice;
  legacyPayload.intentEvents = structuredClone(initialEvents);
  const keptCommitmentIds = new Set(legacyPayload.intentEvents.map(row => row.commitmentId));
  legacyPayload.places = legacyPayload.places.filter(row => (row.choice === null || keptCaptureIds.has(row.choice.captureId)) && (row.commitmentId === null || keptCommitmentIds.has(row.commitmentId)));
  const keptPlaceIds = new Set(legacyPayload.places.map(row => row.id));
  legacyPayload.resumptions = legacyPayload.resumptions.filter(row => keptPlaceIds.has(row.placeId));
  const legacyBackup = JSON.stringify({ payload: legacyPayload, sha256: createHash('sha256').update(JSON.stringify(legacyPayload)).digest('hex') });

  // Same workspace reset and restore preserves the proposal and source lineage.
  page.once('dialog', dialog => dialog.accept()); await page.locator('#reset').click();
  await page.getByText('Browser demo cleared. Your private EFFORT app is separate.', { exact: true }).waitFor();
  await page.locator('[data-view="engine"]').click(); await restoreFile(page, backup);
  await page.goto(`${base}/public/#thread/${sourceId}`); await page.locator('#thread-post h1').waitFor();
  const restoredReply = page.locator('#thread-replies .thread-reply').filter({ hasText: distillationText });
  await restoredReply.locator('.proposal-provenance p').getByText('Prepared from your distillation. Saved links verified.', { exact: true }).waitFor();
  assert.equal((await stateOf(page)).captures.filter(row => row.id === proposalId).length, 1);

  // A clean browser upgrades a version 6 backup to version 11 without fabricating proposals.
  const oldContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  oldContext.setDefaultTimeout(10000); routeContext(oldContext);
  const oldPage = await oldContext.newPage(); oldPage.setDefaultTimeout(10000); oldPage.on('pageerror', error => errors.push(error.message));
  await oldPage.goto(`${base}/public/`); await oldPage.locator('[data-view="engine"]').click(); await restoreFile(oldPage, legacyBackup);
  assert.equal((await stateOf(oldPage)).captures.some(row => row.derivedFromId), false, 'v6 restore must not invent proposal records');
  const [upgradedDownload] = await Promise.all([oldPage.waitForEvent('download'), oldPage.locator('#download').click()]);
  assert.equal(JSON.parse(await readFile(await upgradedDownload.path(), 'utf8')).payload.version, 11);
  await oldContext.close();

  // Corrupt only the distillation metadata; its exact proposal writing remains available with recovery provenance.
  await page.evaluate(async id => {
    const { openDatabase, request } = await import('./database.js'); const db = openDatabase();
    await db.run(['distillations'], 'readwrite', async tx => {
      const table = tx.objectStore('distillations'), row = await request(table.get(id));
      row.text = 'Damaged distillation fixture'; await request(table.put(row));
    }); await db.close();
  }, distillationId);
  await page.reload(); await page.locator('#thread-post h1').waitFor();
  const recoveredReply = page.locator('#thread-replies .thread-reply').filter({ hasText: distillationText });
  await recoveredReply.locator('.proposal-provenance p').getByText('Proposal source links need recovery. Its exact writing is kept.', { exact: true }).waitFor();
  assert.equal((await stateOf(page)).captures.find(row => row.id === proposalId).text, distillationText);
  assert.match(await recoveredReply.innerText(), /I'll test one fictional workshop exercise on Friday\./);
  await page.locator('[data-view="engine"]').click();
  await page.locator('#recovery-panel').waitFor({ state: 'visible' });
  await page.locator('#recovery-status').getByText(/damaged record.*preserved separately/i).waitFor();
  const damagedCopy = page.locator('#recovery-items details').filter({ hasText: 'Damaged distillation fixture' });
  await damagedCopy.locator('summary').click();
  assert.match(await damagedCopy.innerText(), /Damaged distillation fixture/);
  assert.ok((await stateOf(page)).recovery.some(row => row.source === 'distillations' && row.raw.includes('Damaged distillation fixture')));

  // Reset while an asynchronous proposal hash is pending. The old action must not reopen a source dialog.
  const staleContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  staleContext.setDefaultTimeout(10000); routeContext(staleContext);
  const stalePage = await staleContext.newPage(); stalePage.setDefaultTimeout(10000); stalePage.on('pageerror', error => errors.push(error.message));
  const staleSeed = await captureSeed(stalePage, 'Reset race fixture');
  const staleBranch = await addBranch(stalePage, 'A branch that will reset.', 'WILD');
  const staleDistillation = await addDistillation(stalePage, staleBranch, 'I will test a reset-safe proposal.');
  const staleDistillationId = (await stateOf(stalePage)).distillations.find(row => row.text === 'I will test a reset-safe proposal.').id;
  await stalePage.evaluate(() => {
    const subtle = crypto.subtle, original = subtle.digest.bind(subtle);
    window.__originalDigest = original; window.__proposalDigestStarted = false;
    Object.defineProperty(subtle, 'digest', { configurable: true, value: (...args) => {
      if (!window.__proposalDigestStarted && new TextDecoder().decode(args[1]) === 'I will test a reset-safe proposal.') {
        window.__proposalDigestStarted = true;
        return new Promise(resolve => { window.__releaseProposalDigest = () => original(...args).then(resolve); });
      }
      return original(...args);
    } });
  });
  await staleDistillation.getByRole('button', { name: 'Consider as a next step…', exact: true }).click();
  await stalePage.waitForFunction(() => window.__proposalDigestStarted === true);
  const resetTab = await staleContext.newPage(); resetTab.setDefaultTimeout(10000); resetTab.on('pageerror', error => errors.push(error.message));
  await resetTab.goto(`${base}/public/`); await resetTab.locator('[data-view="engine"]').click();
  resetTab.once('dialog', dialog => dialog.accept()); await resetTab.locator('#reset').click();
  await resetTab.getByText('Browser demo cleared. Your private EFFORT app is separate.', { exact: true }).waitFor();
  await stalePage.evaluate(() => { window.__releaseProposalDigest(); });
  await stalePage.waitForFunction(() => document.querySelector('#notice').classList.contains('error') && /workspace changed/i.test(document.querySelector('#notice').textContent));
  assert.equal(await stalePage.locator('#source-dialog').evaluate(dialog => dialog.open), false, 'stale action must not open a proposal after reset');
  assert.equal((await stateOf(stalePage)).captures.some(row => row.text === 'I will test a reset-safe proposal.' && row.derivedFromId), false);
  await staleContext.close();

  // Offline shell opens from the Engine Room and keeps a usable page without network.
  const offlineContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  offlineContext.setDefaultTimeout(10000); routeContext(offlineContext);
  const offlinePage = await offlineContext.newPage(); offlinePage.setDefaultTimeout(10000); offlinePage.on('pageerror', error => errors.push(error.message));
  await offlinePage.goto(`${base}/public/`); await offlinePage.locator('[data-view="engine"]').click();
  await offlinePage.locator('#offline-status').getByText('Available offline in this browser.', { exact: false }).waitFor();
  await offlineContext.setOffline(true); await offlinePage.reload(); await offlinePage.locator('#capture-open').waitFor();
  assert.equal(await offlinePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await offlineContext.close();

  assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  console.log('PASS: proposal preparation and explicit exact choice; sandbox refusal; exact lineage and inert text; idempotent readback retry and duplicate guard; live cross-tab state; backup v11/reset/restore and v6 upgrade; damaged distillation recovery with intact proposal; async reset fencing; offline reopen; keyboard flow; 1440px/390px/320px. No page errors or external requests.');
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
