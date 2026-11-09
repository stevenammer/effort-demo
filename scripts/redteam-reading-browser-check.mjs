// Proposed reader red-team checks inspired by Joplin's patched Markdown-preview
// XSS advisory: https://github.com/laurent22/joplin/security/advisories/GHSA-hff8-hjwv-j9q7
// Only synthetic strings are used; payloads set a harmless window sentinel.
import assert from 'node:assert/strict';
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
const outside = [], errors = [], successes = [];

function routeContext(context) {
  return context.route('**/*', route => {
    const url = route.request().url();
    if (!url.startsWith(base + '/')) { outside.push(url); return route.abort(); }
    return route.continue();
  });
}

async function seed(page) {
  return page.evaluate(async () => {
    const { createStore } = await import('./store.js');
    const store = createStore();
    try {
      await store.reset();
      const span = 'Red Team Reading';
      await store.createSpan(span);
      const target = await store.capture('# Duplicate title\nTarget source text must remain separate.', span);
      const otherTitle = await store.capture('# Duplicate title\nA second exact source with the same title.', 'Learning');
      const hostile = [
        '# Reader fixtures',
        'Literal HTML: <script>window.__effortRedteamSentinel = "script"</script>',
        '<img src="x" onerror="window.__effortRedteamSentinel = \'img\'">',
        '<svg onload="window.__effortRedteamSentinel = \'svg\'"><a href="javascript:window.__effortRedteamSentinel=\'svg-link\'">x</a></svg>',
        '```mermaid\nflowchart TD\n  A[<a href="/local" data-from-md onclick="window.__effortRedteamSentinel=\'mermaid\'">link</a>]\n```',
        '[script scheme](javascript:window.__effortRedteamSentinel%3D%22javascript%22)',
        '[data scheme](data:text/html,<script>window.__effortRedteamSentinel="data"</script>)',
        '[blob scheme](blob:https://example.invalid/00000000-0000-4000-8000-000000000001)',
        '[credential URL](https://user:password@example.invalid/private)',
        '[bad local route](#thread/not-an-id)',
        `Literal embed syntax: {{embed [[${target.id}]]}}`,
        `[Correct source](#thread/${target.id})`,
      ].join('\n');
      const source = await store.capture(hostile, span);
      const attachmentText = '<script>window.__effortRedteamSentinel = "attachment"</script>\n<img src=x onerror="window.__effortRedteamSentinel=\'attachment-img\'">';
      await store.attach({ captureId: source.id, name: 'hostile-fixture.txt', mime: 'text/plain', bytes: new TextEncoder().encode(attachmentText) });
      await store.close();
      return { sourceId: source.id, targetId: target.id, duplicateId: otherTitle.id, hostile, attachmentText };
    } finally { await store.close(); }
  });
}

try {
  for (const [label, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844], ['small-phone', 320, 760]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(10000); routeContext(context);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    await page.goto(`${base}/public/`);
    await page.locator('#capture-open:enabled').waitFor();
    const data = await seed(page);

    await page.goto(`${base}/public/#thread/${data.sourceId}`);
    await page.locator('#thread-post h1').waitFor();
    const reading = page.locator('#thread-post > .rich-reading');
    await page.locator('#thread-post h1').getByText('Reader fixtures', { exact: true }).waitFor();
    await reading.waitFor();
    assert.equal(await reading.locator('script, img, svg, iframe, object, embed').count(), 0, `${label}: source markup must stay text`);
    assert.equal(await page.evaluate(() => window.__effortRedteamSentinel), undefined, `${label}: no sentinel code may execute`);

    const textContent = await reading.textContent();
    for (const line of [
      '<script>window.__effortRedteamSentinel = "script"</script>',
      '<img src="x" onerror="window.__effortRedteamSentinel = \'img\'">',
      '<svg onload="window.__effortRedteamSentinel = \'svg\'"><a href="javascript:window.__effortRedteamSentinel=\'svg-link\'">x</a></svg>',
      '[script scheme](javascript:window.__effortRedteamSentinel%3D%22javascript%22)',
      '[data scheme](data:text/html,<script>window.__effortRedteamSentinel="data"</script>)',
      '[blob scheme](blob:https://example.invalid/00000000-0000-4000-8000-000000000001)',
      '[credential URL](https://user:password@example.invalid/private)',
      '[bad local route](#thread/not-an-id)',
    ]) assert.ok(textContent.includes(line), `${label}: hostile syntax should remain visible literally: ${line}`);

    assert.equal(await reading.locator('a[href^="javascript:"], a[href^="data:"], a[href^="blob:"], a[href*="user:password"], a[href="#thread/not-an-id"]').count(), 0,
      `${label}: unsafe and malformed routes must not become active links`);
    const local = reading.getByRole('link', { name: 'Correct source', exact: true });
    assert.equal(await local.getAttribute('href'), `#thread/${data.targetId}`, `${label}: local link should retain the exact source ID`);
    assert.ok(textContent.includes(`Literal embed syntax: {{embed [[${data.targetId}]]}}`),
      `${label}: embed-like text must remain literal rather than expand another source`);
    assert.equal(textContent.includes('Target source text must remain separate.'), false,
      `${label}: rendering one source must not expose linked source text`);
    const attachment = page.locator('#thread-post .artifact-preview');
    await attachment.locator('summary').click();
    assert.equal(await attachment.locator('pre.raw').textContent(), data.attachmentText,
      `${label}: hostile attachment text preview must be exact plain text`);
    assert.equal(await attachment.locator('script, img, svg, iframe').count(), 0,
      `${label}: attachment preview must not create active elements`);

    await local.click();
    await page.waitForFunction(id => location.hash === `#thread/${id}`, data.targetId);
    await page.locator('#thread-post > .rich-reading').getByText('Target source text must remain separate.', { exact: true }).waitFor();
    assert.notEqual(data.targetId, data.duplicateId, `${label}: duplicate titles must retain distinct IDs`);
    assert.equal(await page.evaluate(() => window.__effortRedteamSentinel), undefined, `${label}: no hostile content executed after local navigation`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: reader layout overflow`);
    assert.deepEqual(outside, [], `${label}: rendering and local navigation must make no external requests`);
    successes.push(`${label} ${width}px`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log(`PASS: inert synthetic hostile Markdown, strict ID-based local links, literal embed text, duplicate-title identity, no external requests; ${successes.join(', ')}.`);
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
