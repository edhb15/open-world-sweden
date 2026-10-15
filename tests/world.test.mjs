// Builds the full world headlessly and prints statistics.
import { buildWorld } from '../src/world/world.js';
const t0 = performance.now();
const world = await buildWorld((label, ms) => console.log(('  ' + label).padEnd(16), ms.toFixed(0) + ' ms'));
const net = world.net;
console.log('nodes', net.nodes.length, 'roads', net.roads.length, 'paths', world.paths.length);
const byType = {};
let totalLen = 0;
for (const r of net.roads) { byType[r.type] = (byType[r.type] || 0) + r.len; totalLen += r.len; }
for (const k in byType) console.log('  ', k.padEnd(12), (byType[k] / 1000).toFixed(1), 'km');
console.log('total road km', (totalLen / 1000).toFixed(1));
const kinds = {};
for (const n of net.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
console.log('node kinds', kinds);
const ctl = {};
for (const n of net.nodes) if (n.kind === 'junction') ctl[n.control] = (ctl[n.control] || 0) + 1;
console.log('controls', ctl);
console.log('crossings', net.crossings.length, 'lots', world.lots.length, 'pois', world.pois.length, 'villages', world.villages.length, 'side roads', world.sideRoads.length);
// dead-end lanes (no exits) other than deadend nodes
let noExit = 0, noEntry = 0;
for (const p of world.paths) { if (!p.exits.length) noExit++; if (!p.entries.length && p.kind !== 'lane') noEntry++; }
console.log('paths without exits', noExit, 'non-lane without entries', noEntry);
// bridges
let br = 0; for (const r of net.roads) br += r.spans ? r.spans.length : 0;
console.log('bridge spans', br);
// steepest grade per type
const steep = {};
for (const r of net.roads) for (let i = 0; i < r.n - 1; i++) { const g = Math.abs(r.Y[i + 1] - r.Y[i]) / (r.S[i + 1] - r.S[i] || 1); if (!steep[r.type] || g > steep[r.type].g) steep[r.type] = { g, r: r.id, x: r.X[i], z: r.Z[i] }; }
for (const k in steep) console.log('  max grade', k.padEnd(12), (steep[k].g * 100).toFixed(1) + '%', 'at', (steep[k].x/1000).toFixed(2), (-steep[k].z/1000).toFixed(2));
console.log('starts', world.starts.map((s) => s.id).join(', '));
console.log('total', (performance.now() - t0).toFixed(0), 'ms');
