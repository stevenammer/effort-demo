import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { SHELL_ASSETS, SHELL_VERSION, SHELL_WORKER_HASH } from '../shell-manifest.js';
import { manifest, source } from '../scripts/update-shell.mjs';
const root = new URL('../', import.meta.url);

test('manifest exactly matches shell assets and worker bytes', async () => {
 const actual = await manifest(); assert.deepEqual(SHELL_ASSETS, actual.assets); assert.equal(SHELL_VERSION, actual.version); assert.equal(SHELL_WORKER_HASH, actual.workerHash); assert.equal(await readFile(new URL('shell-manifest.js', root), 'utf8'), await source());
 assert.ok(SHELL_ASSETS.length <= 50); assert.ok(SHELL_ASSETS.some(x => x.path === 'index.html')); assert.ok(SHELL_ASSETS.some(x => x.path === 'public/index.html'));
 for (const item of SHELL_ASSETS) { assert.match(item.path, /^(index\.html|public\/[\w./-]+\.(html|js|css|svg|webmanifest))$/); assert.equal(createHash('sha256').update(await readFile(new URL(item.path, root))).digest('hex'), item.sha256); }
});

async function worker({ failPath } = {}) {
 const listeners = {}, data = new Map(), calls = []; let claimed = 0, skipped = 0;
 const caches = { async open(name) { if (!data.has(name)) data.set(name, new Map()); const map = data.get(name); return { async put(key, val) { map.set(key, val.clone()); }, async match(key) { return map.get(key)?.clone(); } }; }, async keys() { return [...data.keys()]; }, async delete(name) { return data.delete(name); } };
 const self = { registration: { scope: 'https://example.test/repo/' }, clients: { async claim() { claimed++; } }, async skipWaiting() { skipped++; }, addEventListener(name, fn) { listeners[name] = fn; } };
 async function fetch(url) { calls.push(url); const path = new URL(url).pathname.replace('/repo/', ''); if (path === failPath) return new Response('wrong'); return new Response(await readFile(new URL(path, root))); }
 const code = (await readFile(new URL('sw.js', root), 'utf8')).replace(/^import .*?;\n/, '');
 vm.runInNewContext(code, { self, caches, fetch, crypto: webcrypto, URL, Response, SHELL_VERSION, SHELL_ASSETS });
 async function lifecycle(type, extra = {}) { let promise; listeners[type]({ ...extra, waitUntil(p) { promise = p; } }); if (promise) await promise; }
 function request(url, method = 'GET') { let response; listeners.fetch({ request: { url, method }, respondWith(p) { response = p; } }); return response; }
 return { data, calls, lifecycle, request, counts: () => ({ claimed, skipped }) };
}

test('verified install serves only allowlisted assets and directories under repository scope', async () => {
 const w = await worker(); await w.lifecycle('install'); await w.lifecycle('activate'); assert.equal(w.counts().claimed, 1); assert.equal(w.counts().skipped, 0);
 for (const [url, path] of [['https://example.test/repo/', 'index.html'], ['https://example.test/repo/public/', 'public/index.html'], ['https://example.test/repo/public/#thread/fictional', 'public/index.html'], ['https://example.test/repo/public/app.js', 'public/app.js']]) {
   const response = await w.request(url); assert.equal(await response.text(), await readFile(new URL(path, root), 'utf8'));
 }
 for (const [url, method] of [['https://example.test/repo/private.json', 'GET'], ['https://example.test/repo/public/app.js?q=secret', 'GET'], ['https://elsewhere.test/repo/public/app.js', 'GET'], ['https://example.test/repo/public/app.js', 'POST'], ['https://example.test/repository/public/app.js', 'GET']]) assert.equal(w.request(url, method), undefined);
 const before = w.calls.length; await w.request('https://example.test/repo/public/app.js'); assert.equal(w.calls.length, before);
 await w.lifecycle('message', { data: { type: 'APPLY_UPDATE' } }); assert.equal(w.counts().skipped, 1);
});

test('failed install removes incomplete cache and preserves prior cache', async () => {
 const w = await worker({ failPath: 'public/app.js' }); w.data.set('effort-offline-shell-v1-older-complete', new Map([['old', new Response('keep')]]));
 await assert.rejects(w.lifecycle('install'), /did not match/); assert.deepEqual([...w.data.keys()], ['effort-offline-shell-v1-older-complete']); assert.equal(await w.data.get('effort-offline-shell-v1-older-complete').get('old').text(), 'keep');
});
