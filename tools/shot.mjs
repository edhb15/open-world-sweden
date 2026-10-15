// Usage: node tools/shot.mjs "<query>" out.png [waitMs] [w] [h]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let f = path.join(root, u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const [query = '', out = 'shot.png', wait = '4000', W = '1280', H = '720'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +W, height: +H } });
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + '\n' + e.stack));
const t0 = Date.now();
await page.goto(`http://localhost:${port}/index.html${query}`);
await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden') || window.__shotReady, null, { timeout: 240000 }).catch((e) => logs.push('wait timeout ' + e.message));
await page.waitForTimeout(+wait);
if (process.env.EVAL) { try { const r = await page.evaluate(process.env.EVAL); logs.push('eval: ' + JSON.stringify(r)); } catch (e) { logs.push('eval error ' + e.message); } }
await page.screenshot({ path: out });
console.log('load+wait ms', Date.now() - t0);
console.log(logs.filter((l, i) => !l.includes('useProgram') || i < 3).slice(0, 60).join('\n'));
await browser.close();
server.close();
