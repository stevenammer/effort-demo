import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoServer } from '../scripts/serve.mjs';
test('local preview serves the demo and refuses private paths or writes', async () => {
  const server = createDemoServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/public/`); assert.equal(page.status, 200); const html=await page.text(); assert.match(html, /E\.F\.F\.O\.R\.T\./);
    const directive="connect-src 'self' https: http://127.0.0.1:* http://localhost:*"; assert.ok(page.headers.get('content-security-policy').includes(directive+';')); assert.ok(html.includes(directive+';')); assert.ok(!page.headers.get('content-security-policy').includes('connect-src *'));
    for (const path of ['/package.json', '/.git/config', '/.env', '/public/../../package.json', '/scripts/serve.mjs']) assert.equal((await fetch(base + path)).status, 404);
    const worker = await fetch(base + '/sw.js'); assert.equal(worker.status,200); assert.match(worker.headers.get('content-type'),/javascript/); assert.match(worker.headers.get('content-security-policy'),/connect-src 'self'/); assert.ok(!worker.headers.get('content-security-policy').includes('https:'));
    assert.equal((await fetch(base + '/shell-manifest.js')).status,200);
    assert.equal((await fetch(base + '/public/app.js', { method: 'POST' })).status, 405);
  } finally { await new Promise(done => server.close(done)); }
});
