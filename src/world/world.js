/* =====================================================================
   World assembly: geography + map + network + lanes.
   ===================================================================== */
import { RNG } from '../core/math.js';
import { initGeo, CITY, cityAt } from './geo.js';
import { Network } from './network.js';
import { buildMap } from './mapdata.js';
import { assignControls, buildLanes } from '../traffic/lanes.js';

export async function buildWorld(progress = () => {}) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const stamp = (label) => progress(label, (typeof performance !== 'undefined' ? performance : Date).now() - t0);
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  initGeo();
  stamp('geo'); await yieldUI();
  const net = new Network();
  const world = buildMap(net, stamp);
  await yieldUI();
  net.finalize(stamp);
  await yieldUI();
  assignControls(net, new RNG(7));
  const paths = buildLanes(net);
  stamp('lanes');
  // drop lots that ended up on a road
  world.lots = world.lots.filter((l) => {
    // every footprint corner (and the centre) must stay off the roads
    const c = Math.cos(l.rot), s = Math.sin(l.rot);
    const margin = l.needsClear ? Math.min(2, l.needsClear * 0.3) : 0.2;
    for (const [a, b] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = l.x + (a * l.w / 2) * c - (b * l.d / 2) * s, z = l.z + (a * l.w / 2) * s + (b * l.d / 2) * c;
      if (net.nearestRoadClearance(x, z) < margin) return false;
    }
    return true;
  });
  world.pois = world.pois.filter((p) => p.type === 'landmark' || p.type === 'rest' || net.nearestRoadClearance(p.x, p.z) > 6);
  stamp('lots');
  world.net = net;
  world.paths = paths;
  world.signals = net.nodes.filter((n) => n.signal).map((n) => n.signal);
  computeStarts(world);
  return world;
}

function computeStarts(world) {
  const net = world.net;
  const starts = [];
  // Bromma-ish: residential street west of central Stockholm
  const pick = (cityId, prefer) => {
    const g = world.cities[cityId];
    if (!g) return null;
    const c = g.city;
    let best = null, bs = -Infinity;
    const res = net.roads.filter((r) => r.city === cityId && r.type === 'residential');
    for (const r of res) {
      if (!r.lanePathsF.length || r.len < 80) continue;
      const mx = r.X[r.n >> 1], mz = r.Z[r.n >> 1];
      const sc = (prefer ? ((mx - c.x) * prefer[0] + (mz - c.z) * prefer[1]) / c.r : 0) - Math.abs(Math.hypot(mx - c.x, mz - c.z) / c.r - 0.75) * 2;
      if (sc > bs) { bs = sc; best = r; }
    }
    return best;
  };
  const mk = (id, label, cityId, prefer) => {
    const r = pick(cityId, prefer);
    if (!r) return;
    const s = r.len * 0.5;
    starts.push({ id, label, road: r, s, city: cityId });
  };
  mk('bromma', 'Bromma, Stockholm', 'stockholm', [-1, 0]);
  mk('stockholm_s', 'Södermalm, Stockholm', 'stockholm', [0, 1]);
  mk('uppsala', 'Uppsala', 'uppsala', [1, 0]);
  mk('goteborg', 'Göteborg', 'goteborg', [1, 0]);
  mk('malmo', 'Malmö', 'malmo', [0, -1]);
  mk('jonkoping', 'Jönköping', 'jonkoping', [1, 0]);
  mk('sundsvall', 'Sundsvall', 'sundsvall', [-1, 0]);
  mk('umea', 'Umeå', 'umea', [0, -1]);
  mk('kiruna', 'Kiruna', 'kiruna', [0, 1]);
  mk('orebro', 'Örebro', 'orebro', [0, 1]);
  world.starts = starts;
}
