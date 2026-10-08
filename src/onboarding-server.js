import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.ONBOARDING_PORT || 4321);
const origin = `http://127.0.0.1:${port}`;
const configPath = resolve(root, 'work/onboarding/config.json');
const files = new Map([
  ['/onboarding.js', 'public/onboarding.js'], ['/onboarding.css', 'public/onboarding.css'],
  ['/style.css', 'public/style.css'], ['/fonts/space-grotesk.ttf', 'public/fonts/space-grotesk.ttf'],
  ['/vendor/minds-connect.js', 'node_modules/@animocabrands/minds-connect/dist/index.js'],
  ['/vendor/minds-client.js', 'node_modules/@animocabrands/minds-client-lib/dist/index.js'],
]);
const server = createServer((req, res) => {
  try {
    if (req.headers.host !== new URL(origin).host || req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) {
      res.writeHead(403).end('This test runs on localhost.'); return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const path = new URL(req.url, origin).pathname;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (path === '/connect/config') {
      const saved = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ clientId: process.env.MINDS_OAUTH_CLIENT_ID || saved.clientId || null, redirectUri: `${origin}/callback` })); return;
    }
    if (path === '/' || path === '/callback') {
      const nonce = randomBytes(18).toString('base64');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; connect-src 'self' https://api.build.hellominds.ai https://api.oauth.hellominds.ai; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      res.end(readFileSync(resolve(root, 'public/onboarding.html'), 'utf8').replaceAll('IMPORT_NONCE', nonce)); return;
    }
    const file = files.get(path);
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'font/ttf');
    res.end(readFileSync(resolve(root, file)));
  } catch { res.writeHead(500).end('The test could not be loaded.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Riddlemaster onboarding test: ${origin}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
