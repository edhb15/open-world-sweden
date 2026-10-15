// Drive test: start the game, run the autopilot for N simulated seconds, log telemetry, screenshot.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(req.url.split('?')[0]); const f = path.join(root, u === '/' ? 'index.html' : u); if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, r));
const [query = '', out = 'shots/drive.png', seconds = '20'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const logs = [];
page.on('console', (m) => { if (!m.text().includes('willReadFrequently')) logs.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + '\n' + e.stack));
await page.goto(`http://localhost:${server.address().port}/index.html?shot=1${query}`);
await page.waitForFunction(() => window.__shotReady, null, { timeout: 240000 }).catch((e) => logs.push('timeout ' + e.message));
const t0 = Date.now();
const tele = await page.evaluate(async (secs) => {
  const g = window.__game; const out = []; g.noRender = true;
  const steps = Math.round(secs * 30);
  for (let i = 0; i < steps; i++) {
    g.frame(1 / 30);
    if (i % 30 === 0) { const P = g.player.phys; out.push([ (i/30).toFixed(0), (P.fwdSpeed*3.6).toFixed(0)+'kmh', P.gearLabel(), P.rpm.toFixed(0)+'rpm', 'y='+P.p[1].toFixed(2), 'surf='+P.wheels.map(w=>w.surface[0]+(w.contact?'':'!')).join(''), 'roll='+P.R[3].toFixed(2), g.player.roadInfo && g.player.roadInfo.road ? g.player.roadInfo.road.name : '-', 'off='+(g.player.roadInfo? g.player.roadInfo.off.toFixed(1):'-') ].join(' ')); }
  }
  g.noRender = false; g.frame(1/30);
  return out;
}, +seconds);
console.log(tele.join('\n'));
console.log('sim wall ms', Date.now() - t0);
await page.screenshot({ path: out });
console.log(logs.slice(0, 30).join('\n'));
await browser.close(); server.close();
