import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// Capacitor serves webDir at its local origin. Keep the repository's existing
// /public/ layout because the service worker's checked asset list uses it.
const root = resolve('.');
const output = resolve(root, 'android-web');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'shell-manifest.js', 'sw.js', 'public']) {
  await cp(resolve(root, name), resolve(output, name), { recursive: true });
}
console.log('Prepared android-web from the local static shell.');
