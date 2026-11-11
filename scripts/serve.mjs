import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const headers = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; font-src 'self'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(), camera=(), geolocation=()', 'Cache-Control': 'no-store',
};
export function createDemoServer() {
  return http.createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, headers); res.end(); return; }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400, headers); res.end(); return; }
    if (path === '/') path = '/index.html';
    if (path === '/public' || path === '/public/') path = '/public/index.html';
    const allowed = ['/index.html', '/README.md', '/SOURCE.md', '/LICENSE', '/sw.js', '/shell-manifest.js'].includes(path) ||
      path.startsWith('/public/') && ['.html', '.js', '.css', '.svg', '.webmanifest'].includes(extname(path));
    const target = resolve(root, `.${path}`);
    if (!allowed || !target.startsWith(resolve(root) + sep)) { res.writeHead(404, headers); res.end(); return; }
    try {
      const body = await readFile(target);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8' }[extname(path)] ?? 'text/plain; charset=utf-8';
      res.writeHead(200, { ...headers, ...(path === '/sw.js' ? { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'" } : {}), 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404, headers); res.end(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Choose a valid local PORT.');
  const server = createDemoServer(); server.listen(port, '127.0.0.1', () => console.log(`E.F.F.O.R.T. demo: http://127.0.0.1:${port}/public/`));
}
