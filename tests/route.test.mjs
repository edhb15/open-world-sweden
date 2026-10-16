// Routes between every pair of start locations must exist and be sensible.
import { buildWorld } from '../src/world/world.js';
import { Router } from '../src/nav/router.js';
const world = await buildWorld(() => {});
const R = new Router(world);
const pts = world.starts.map((s) => { const p = world.net.pointAt(s.road, s.s, 0); return { id: s.id, x: p[0], z: p[2] }; });
let fail = 0, n = 0, worst = 0;
for (const a of pts) for (const b of pts) {
  if (a === b) continue;
  const t0 = performance.now();
  const r = R.route({ x: a.x, z: a.z }, { x: b.x, z: b.z });
  const ms = performance.now() - t0;
  worst = Math.max(worst, ms);
  n++;
  const crow = Math.hypot(a.x - b.x, a.z - b.z);
  if (!r) { fail++; console.log('FAIL no route', a.id, '->', b.id); continue; }
  const detour = r.length / Math.max(crow, 1);
  if (detour > 4 && crow > 2000) { fail++; console.log('FAIL detour', a.id, '->', b.id, detour.toFixed(1)); }
  if (!r.maneuvers.length || r.maneuvers[r.maneuvers.length - 1].type !== 'arrive') { fail++; console.log('FAIL maneuvers', a.id, b.id); }
}
console.log(`${n} routes, ${fail} failures, slowest ${worst.toFixed(0)} ms`);
if (fail) process.exit(1);
