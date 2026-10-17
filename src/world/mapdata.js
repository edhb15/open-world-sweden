/* =====================================================================
   The map: intercity routes with real road numbers, interchanges,
   2+1 roads, villages, rest areas and procedural side roads.
   ===================================================================== */
import { RNG, clamp, lerp, catmullRom, resample, noiseA, noiseB, hashStr, KMH, DEG } from '../core/math.js';
import { CITIES, CITY, isWater, cityMask, terrainWater } from './geo.js';
import { generateCity, generateVillage } from './citygen.js';
import { ROAD_TYPES } from './network.js';

const km = (e, n) => [e * 1000, -n * 1000];
const bearingVec = (deg) => [Math.sin(deg * DEG), -Math.cos(deg * DEG)];

/* ----------------------------- City extras ----------------------------- */
const CITY_EXTRA = {
  stockholm: {
    oldTown: { e: 0.15, n: 0.0, r: 170 }, industrialAngle: 3.6,
    features: [
      { type: 'landmark', landmark: 'cityhall', name: 'Stadshuset', e: -0.3, n: 0.16 },
      { type: 'landmark', landmark: 'globe', name: 'Globen', e: 0.35, n: -0.95 },
      { type: 'landmark', landmark: 'tvtower', name: 'Kaknästornet', e: 0.75, n: 0.55 },
      { type: 'landmark', landmark: 'church_big', name: 'Engelbrektskyrkan', e: 0.15, n: 0.62 },
      { type: 'park', e: -0.05, n: 0.42 }, { type: 'park', e: 0.55, n: 0.25 }, { type: 'square', e: 0.05, n: 0.24, landmark: 'fountain', name: 'Sergels torg' },
      { type: 'landmark', landmark: 'church_red', name: 'Högalidskyrkan', e: -0.45, n: -0.35 },
    ],
  },
  uppsala: { oldTown: { e: -0.08, n: 0.05, r: 150 }, features: [
    { type: 'landmark', landmark: 'cathedral', name: 'Uppsala domkyrka', e: -0.1, n: 0.06 },
    { type: 'landmark', landmark: 'castle_pink', name: 'Uppsala slott', e: -0.22, n: -0.12 }, { type: 'park', e: 0.15, n: -0.05 }] },
  goteborg: { features: [
    { type: 'landmark', landmark: 'lipstick', name: 'Läppstiftet', e: 0.05, n: 0.2 },
    { type: 'landmark', landmark: 'crane', name: 'Eriksbergskranen', e: -0.55, n: 0.22 },
    { type: 'landmark', landmark: 'tower', name: 'Gothia Towers', e: 0.45, n: -0.3 },
    { type: 'landmark', landmark: 'church_big', name: 'Domkyrkan', e: 0.05, n: -0.25 }, { type: 'park', e: 0.3, n: -0.12 }] },
  malmo: { oldTown: { e: 0.0, n: 0.15, r: 140 }, features: [
    { type: 'landmark', landmark: 'torso', name: 'Turning Torso', e: -0.55, n: 0.4 },
    { type: 'landmark', landmark: 'church_big', name: 'S:t Petri kyrka', e: 0.02, n: 0.05 }, { type: 'park', e: -0.3, n: -0.2 }] },
  kiruna: { features: [
    { type: 'landmark', landmark: 'kiruna_church', name: 'Kiruna kyrka', e: 0.12, n: -0.08 },
    { type: 'landmark', landmark: 'clocktower', name: 'Kiruna stadshus', e: -0.1, n: 0.1 },
    { type: 'landmark', landmark: 'mine', name: 'Gruvan', e: -0.35, n: -0.5 }] },
  gavle: { features: [{ type: 'square', e: 0.0, n: 0.05, landmark: 'goat', name: 'Gävlebocken' }, { type: 'church', e: 0.1, n: -0.15 }] },
  orebro: { features: [{ type: 'landmark', landmark: 'castle', name: 'Örebro slott', e: 0.0, n: 0.05 }, { type: 'landmark', landmark: 'svampen', name: 'Svampen', e: 0.25, n: 0.35 }] },
  vasteras: { features: [{ type: 'landmark', landmark: 'skrapan', name: 'Skrapan', e: 0.05, n: 0.08 }, { type: 'church', e: -0.12, n: 0.0 }] },
  linkoping: { features: [{ type: 'landmark', landmark: 'cathedral', name: 'Linköpings domkyrka', e: -0.05, n: 0.05 }] },
  lulea: { features: [{ type: 'church', e: 0.0, n: 0.05 }] },
  umea: { features: [{ type: 'church', e: 0.0, n: 0.0 }, { type: 'park', e: 0.15, n: 0.1 }] },
  sundsvall: { features: [{ type: 'church', e: 0.0, n: 0.05 }] },
  norrkoping: { features: [{ type: 'church', e: 0.0, n: 0.0 }] },
  jonkoping: { features: [{ type: 'church', e: 0.0, n: 0.05 }] },
  helsingborg: { features: [{ type: 'landmark', landmark: 'karnan', name: 'Kärnan', e: -0.1, n: 0.05 }] },
};

/* ------------------------------- Routes ------------------------------- */
// Waypoints in km. {ic} = motorway interchange to a city, {jct} = at-grade junction to a city,
// {vic} = interchange to a village, {village} = village on the road, {rest} = rest area.
const ROUTES = [
  {
    id: 'E4S', ref: 'E4', type: 'motorway', speed: 110, from: { city: 'stockholm' }, to: { city: 'helsingborg' }, destF: 'Malmö', destB: 'Stockholm',
    pts: [[-0.9, -1.9], { ic: 'sodertalje', b: 160 }, [-3.5, -3.95], { ic: 'nykoping', b: 330 }, [-5.6, -5.55], { rest: 'Kolmården' },
      { ic: 'norrkoping', b: 20 }, [-7.8, -6.85], { ic: 'linkoping', b: 340 }, [-9.6, -7.78], { rest: 'Gränna' }, [-10.12, -8.3], [-10.7, -9.1],
      { ic: 'jonkoping', b: 90 }, [-11.6, -10.9], { ic: 'varnamo', b: 90 }, [-12.2, -13.6], { rest: 'Ljungby' }, [-13.25, -14.6]],
  },
  {
    id: 'E4N', ref: 'E4', type: 'motorway', speed: 120, from: { city: 'stockholm' }, to: { node: 'E4N_end' }, destF: 'Sundsvall', destB: 'Stockholm',
    pts: [[0.15, 2.0], { vic: 'Arlanda', b: 270, d: 0.6, id: 'arlanda' }, [0.0, 3.6], [-0.1, 4.7], { ic: 'uppsala', b: 90 }, [0.55, 8.2], { rest: 'Tierp' },
      { ic: 'gavle', b: 270 }, [0.3, 11.05]],
  },
  {
    id: 'E4N2', ref: 'E4', type: 'expressway', speed: 100, from: { node: 'E4N_end' }, to: { node: 'Tore' }, destF: 'Luleå', destB: 'Sundsvall',
    pts: [{ village: 'Söderhamn', side: 1 }, [0.6, 11.9], { jct: 'hudiksvall', b: 270 }, [0.9, 13.6], { jct: 'sundsvall', b: 270 }, [1.7, 15.3], { village: 'Härnösand', side: -1 },
      [2.6, 16.2], { jct: 'ornskoldsvik', b: 290 }, [3.7, 17.9], { jct: 'umea', b: 280 }, [4.8, 19.9], { jct: 'skelleftea', b: 300 }, [6.6, 21.9],
      { village: 'Piteå', side: 1 }, { jct: 'lulea', b: 240 }, [7.1, 23.65], [8.0, 24.05], [8.8, 24.15]],
  },
  { id: 'E4N3', ref: 'E4', type: 'primary', speed: 90, from: { node: 'Tore' }, to: { villageEnd: 'Haparanda' }, destF: 'Haparanda', destB: 'Luleå',
    pts: [[9.6, 24.35], [10.6, 24.5]] },
  { id: 'E10', ref: 'E10', type: 'primary', speed: 90, from: { node: 'Tore' }, to: { city: 'kiruna' }, destF: 'Kiruna', destB: 'Töre',
    pts: [[7.6, 24.6], { jct: 'gallivare', b: 110 }, [5.0, 25.6], { village: 'Svappavaara', side: -1 }, [4.3, 26.0]] },
  {
    id: 'E20', ref: 'E20', type: 'expressway', speed: 100, from: { ic: 'E4S:sodertalje', side: 'city' }, to: { city: 'goteborg' }, destF: 'Göteborg', destB: 'Stockholm',
    pts: [[-3.7, -2.95], { village: 'Arboga', side: 1 }, [-5.2, -2.2], [-6.8, -1.6], { jct: 'orebro', b: 180 }, [-9.6, -1.95], { village: 'Hova', side: -1 },
      { jct: 'mariestad', b: 110 }, [-12.1, -4.1], { village: 'Alingsås', side: 1 }, [-13.2, -4.65]],
  },
  {
    id: 'E18', ref: 'E18', type: 'motorway', speed: 110, from: { city: 'stockholm' }, to: { city: 'orebro' }, destF: 'Örebro', destB: 'Stockholm',
    pts: [[-1.4, 1.5], [-2.6, 1.95], { vic: 'Enköping', b: 0, d: 0.55 }, [-3.9, 2.5], [-4.8, 3.3], { ic: 'vasteras', b: 0 }, [-6.6, 3.35], { rest: 'Köping' }, [-7.5, 2.4], [-7.9, 1.0]],
  },
  {
    id: 'E6', ref: 'E6', type: 'motorway', speed: 110, from: { city: 'goteborg' }, to: { city: 'malmo' }, destF: 'Malmö', destB: 'Göteborg',
    pts: [[-15.25, -7.1], { vic: 'Kungsbacka', b: 90, d: 0.55 }, [-15.2, -8.0], { vic: 'Varberg', b: 270, d: 0.5 }, [-14.9, -9.2], { rest: 'Falkenberg' }, [-14.75, -9.9],
      { ic: 'halmstad', b: 70 }, [-13.4, -12.6], { vic: 'Ängelholm', b: 270, d: 0.5 }, [-13.4, -14.0], { ic: 'helsingborg', b: 90 }, [-13.0, -16.4]],
  },
  {
    id: 'Rv40', ref: '40', type: 'expressway', speed: 100, from: { city: 'goteborg' }, to: { city: 'jonkoping' }, destF: 'Jönköping', destB: 'Göteborg',
    pts: [[-13.9, -6.3], { village: 'Borås', side: -1 }, [-13.2, -7.1], { village: 'Ulricehamn', side: 1 }, [-12.4, -8.4]],
  },
  { id: 'Rv73', ref: '73', type: 'primary', speed: 90, from: { city: 'stockholm' }, to: { villageEnd: 'Nynäshamn' }, destF: 'Nynäshamn', destB: 'Stockholm',
    pts: [[0.15, -1.9], { village: 'Handen', side: 1 }, [-0.1, -2.45], [-0.35, -2.8]] },
  { id: 'Rv222', ref: '222', type: 'primary', speed: 80, from: { city: 'stockholm' }, to: { villageEnd: 'Stavsnäs' }, destF: 'Gustavsberg', destB: 'Stockholm',
    pts: [[1.65, 0.62], [2.3, 0.75], { village: 'Gustavsberg', side: -1 }, [3.0, 0.62], [3.4, 0.55]] },
  { id: 'Rv77', ref: '77', type: 'primary', speed: 80, from: { ic: 'E4N:arlanda', side: 'R' }, to: { villageEnd: 'Norrtälje' }, destF: 'Norrtälje', destB: 'Arlanda',
    pts: [[1.0, 3.1], { village: 'Rimbo', side: 1 }, [1.6, 3.35], [2.0, 3.45]] },
  { id: 'Rv55', ref: '55', type: 'secondary', speed: 80, from: { city: 'uppsala' }, to: { ic: 'E18:Enköping', side: 'village' }, destF: 'Enköping', destB: 'Uppsala',
    pts: [[-1.6, 5.4], { village: 'Örsundsbro', side: 1 }, [-2.4, 3.6]] },
];

/* ----------------------------- Builder ----------------------------- */
export function buildMap(net, log = () => {}) {
  const world = {
    cities: {}, lots: [], parks: [], parkings: [], pois: [], villages: [], routes: [], interchanges: {}, restAreas: [],
    starts: [], namedNodes: {}, sideRoads: [], cameras: [], places: [],
  };
  const rng = new RNG(20240601);
  const occ = new Occupancy(60);

  // ---- 1. resolve waypoint geometry & gateway requests
  const gwReq = new Map(); // city -> [{bearing, key, type, roundabout}]
  const reqGw = (cityId, bearingRad, key, type, roundabout) => {
    const l = gwReq.get(cityId) || [];
    l.push({ bearing: bearingRad, key, type, roundabout });
    gwReq.set(cityId, l);
  };
  const cityEdge = (c, bdeg, extra) => {
    const [dx, dz] = bearingVec(bdeg);
    return [c.x + dx * (c.r + extra), c.z + dz * (c.r + extra)];
  };
  for (const R of ROUTES) {
    R.wps = R.pts.map((p) => {
      if (Array.isArray(p)) return { pos: km(p[0], p[1]) };
      if (p.ic) { const c = CITY[p.ic]; const pos = cityEdge(c, p.b, 330); reqGw(p.ic, (p.b) * DEG, R.id + ':ic:' + p.ic, 'avenue', false); return { ...p, pos }; }
      if (p.jct) { const c = CITY[p.jct]; const pos = cityEdge(c, p.b, 300); reqGw(p.jct, p.b * DEG, R.id + ':jct:' + p.jct, 'avenue', false); return { ...p, pos }; }
      if (p.vic || p.village || p.rest) return { ...p, pos: null };
      return { ...p, pos: null };
    });
  }
  // route ends at cities
  const cityBearing = (c, p) => Math.atan2(p[0] - c.x, -(p[1] - c.z));
  for (const R of ROUTES) {
    const firstPos = R.wps.find((w) => w.pos)?.pos;
    const lastPos = [...R.wps].reverse().find((w) => w.pos)?.pos;
    const big = R.type === 'motorway' || R.type === 'expressway';
    if (R.from.city) reqGw(R.from.city, cityBearing(CITY[R.from.city], firstPos), R.id + ':from', 'avenue', big);
    if (R.to.city) reqGw(R.to.city, cityBearing(CITY[R.to.city], lastPos), R.id + ':to', 'avenue', big);
  }

  // ---- 2. cities
  for (const c of CITIES) {
    const extra = CITY_EXTRA[c.id] || {};
    const spec = { ...c, ...extra };
    if (extra.oldTown) spec.oldTown = { x: c.x + extra.oldTown.e * 1000, z: c.z - extra.oldTown.n * 1000, r: extra.oldTown.r };
    const reqs = gwReq.get(c.id) || [];
    // merge requests with similar bearings
    const merged = [];
    for (const q of reqs) {
      const m = merged.find((x) => Math.abs(angDiff(x.bearing, q.bearing)) < 0.35);
      if (m) { m.keys.push(q.key); m.roundabout = m.roundabout || q.roundabout; }
      else merged.push({ ...q, keys: [q.key] });
    }
    const gen = generateCity(net, spec, merged, world);
    world.cities[c.id] = gen;
    for (const g of gen.gateways) for (const k of g.keys) world.namedNodes['gw:' + k] = g.node;
    // occupancy: block city area
    occ.markDisc(c.x, c.z, c.r + 120);
    world.lots.push(...gen.lots); world.parks.push(...gen.parks); world.parkings.push(...gen.parkings); world.pois.push(...gen.pois);
    world.places.push({ name: c.name, x: c.x, z: c.z, kind: 'city', size: c.size });
  }
  log('cities');

  // ---- 3. routes
  const pending = ROUTES.slice();
  let guard = 0;
  while (pending.length && guard++ < 50) {
    for (let q = 0; q < pending.length; q++) {
      const R = pending[q];
      if (R.from.ic && !world.interchanges[R.from.ic]) continue;
      if (R.from.node && !world.namedNodes[R.from.node]) continue;
      if (R.to.ic && !world.interchanges[R.to.ic]) continue;
      buildRoute(net, world, R, rng, occ);
      pending.splice(q, 1); q--;
    }
  }
  log('routes');
  removeCityRoadsCrossing(net, world);
  junctionsAtCrossings(net);

  // ---- 4. side roads from route junction candidates
  for (const cand of world.sideCandidates || []) buildSideRoad(net, world, cand, rng, occ);
  log('side roads');

  // ---- 5. villages
  for (const v of world.villages) {
    const g = generateVillage(net, v, world);
    world.lots.push(...g.lots); world.parks.push(...g.parks); world.parkings.push(...g.parkings); world.pois.push(...g.pois);
    world.places.push({ name: v.name, x: v.x, z: v.z, kind: 'village' });
  }
  log('villages');
  return world;
}

function angDiff(a, b) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }

/* --------------------------- Occupancy grid --------------------------- */
class Occupancy {
  constructor(cell) { this.cell = cell; this.set = new Set(); }
  k(i, j) { return i * 100003 + j; }
  markPoly(pts, r) {
    const C = this.cell;
    for (const p of pts) {
      for (let i = Math.floor((p[0] - r) / C); i <= Math.floor((p[0] + r) / C); i++)
        for (let j = Math.floor((p[1] - r) / C); j <= Math.floor((p[1] + r) / C); j++) this.set.add(this.k(i, j));
    }
  }
  markDisc(x, z, r) {
    const C = this.cell;
    for (let i = Math.floor((x - r) / C); i <= Math.floor((x + r) / C); i++)
      for (let j = Math.floor((z - r) / C); j <= Math.floor((z + r) / C); j++)
        if (Math.hypot(i * C + C / 2 - x, j * C + C / 2 - z) < r) this.set.add(this.k(i, j));
  }
  test(x, z) { return this.set.has(this.k(Math.floor(x / this.cell), Math.floor(z / this.cell))); }
}

/* ------------------------------ Polyline ------------------------------ */
function meander(wpPos, type, seed) {
  const amp = { motorway: 38, expressway: 55, primary: 70, secondary: 55, local: 40, gravel: 28 }[type] || 40;
  const lam = { motorway: 1900, expressway: 1300, primary: 900, secondary: 600, local: 360, gravel: 220 }[type] || 500;
  const pts = [wpPos[0]];
  let sAcc = 0;
  for (let i = 1; i < wpPos.length; i++) {
    const a = wpPos[i - 1], b = wpPos[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const m = Math.max(1, Math.round(L / (lam / 3.5)));
    const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
    for (let k = 1; k < m; k++) {
      const t = k / m;
      const taper = Math.sin(Math.PI * t);
      const off = noiseA((sAcc + L * t) / lam, seed * 0.37) * amp * taper;
      pts.push([a[0] + (b[0] - a[0]) * t - dz * off, a[1] + (b[1] - a[1]) * t + dx * off]);
    }
    pts.push(b);
    sAcc += L;
  }
  return pts;
}

class Poly {
  constructor(pts) {
    this.pts = pts;
    const n = pts.length;
    this.S = new Float64Array(n);
    for (let i = 1; i < n; i++) this.S[i] = this.S[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    this.len = this.S[n - 1];
  }
  idxAt(s) {
    let lo = 0, hi = this.pts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.S[m] <= s) lo = m; else hi = m - 1; }
    return lo;
  }
  nearestIdx(s) { const i = this.idxAt(s); return i < this.pts.length - 1 && this.S[i + 1] - s < s - this.S[i] ? i + 1 : i; }
  at(s, lat = 0) {
    s = clamp(s, 0, this.len);
    const i = Math.min(this.idxAt(s), this.pts.length - 2);
    const a = this.pts[i], b = this.pts[i + 1];
    const L = this.S[i + 1] - this.S[i] || 1;
    const t = (s - this.S[i]) / L;
    const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
    // right normal = (-tz, tx)
    return [a[0] + (b[0] - a[0]) * t - tz * lat, a[1] + (b[1] - a[1]) * t + tx * lat];
  }
  tangent(s) {
    const i = Math.min(this.idxAt(clamp(s, 0, this.len)), this.pts.length - 2);
    const a = this.pts[i], b = this.pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  }
  sOf(p) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.pts.length; i++) {
      const d = (this.pts[i][0] - p[0]) ** 2 + (this.pts[i][1] - p[1]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return this.S[best];
  }
  slice(s0, s1) {
    const i0 = this.nearestIdx(s0), i1 = this.nearestIdx(s1);
    return this.pts.slice(i0, i1 + 1);
  }
}

/* ------------------------------ Routes ------------------------------ */
function buildRoute(net, world, R, rng, occ) {
  const T = ROAD_TYPES[R.type];
  // start/end nodes & positions
  let startNode, endNode, startPos, endPos;
  const resolveEnd = (spec, isStart) => {
    if (spec.city) { const n = world.namedNodes['gw:' + R.id + (isStart ? ':from' : ':to')]; return { node: n, pos: [n.x, n.z] }; }
    if (spec.node) {
      const n = world.namedNodes[spec.node];
      if (n) return { node: n, pos: [n.x, n.z] };
      return { node: null, pos: null, name: spec.node };
    }
    if (spec.ic) {
      const ic = world.interchanges[spec.ic];
      const t = spec.side === 'city' ? ic.cityTerm : spec.side === 'village' ? ic.cityTerm : spec.side === 'R' ? ic.TR : ic.TL;
      return { node: t, pos: [t.x, t.z] };
    }
    if (spec.villageEnd) return { node: null, pos: null, villageEnd: spec.villageEnd };
    return { node: null, pos: null };
  };
  const st = resolveEnd(R.from, true), en = resolveEnd(R.to, false);
  const wps = R.wps;
  const fixed = wps.filter((w) => w.pos).map((w) => w.pos);
  startPos = st.pos || fixed.shift();
  endPos = en.pos || fixed.pop();
  // positions for waypoints including vic/village/rest placeholders (interpolated later)
  const posList = [startPos, ...wps.filter((w) => w.pos && w.pos !== startPos && w.pos !== endPos).map((w) => w.pos), endPos];
  const seed = hashStr(R.id) % 1000;
  let pts = meander(posList, R.type, seed);
  pts = catmullRom(pts, 6);
  pts = resample(pts, 4);
  const P = new Poly(pts);
  occ.markPoly(pts.filter((_, i) => i % 5 === 0), T.lanes[0] * T.laneW + 30);

  // cuts: {s, kind, data}
  const cuts = [{ s: 0, kind: 'start' }, { s: P.len, kind: 'end' }];
  // place placeholder waypoints evenly between neighbouring fixed waypoints
  const fixedS = [];
  for (let i = 0; i < wps.length; i++) if (wps[i].pos) fixedS.push([i, P.sOf(wps[i].pos)]);
  const sForIndex = (i) => {
    let prev = [-1, 0], next = [wps.length, P.len];
    for (const f of fixedS) { if (f[0] < i && f[0] > prev[0]) prev = f; if (f[0] > i && f[0] < next[0]) next = f; }
    // count placeholders between
    let k = 0, cnt = 0;
    for (let q = prev[0] + 1; q < next[0]; q++) { if (!wps[q].pos) { cnt++; if (q <= i) k = cnt; } }
    return lerp(prev[1], next[1], k / (cnt + 1));
  };
  const zones = [];
  for (let i = 0; i < wps.length; i++) {
    const w = wps[i];
    if (w.ic || w.vic) {
      const s0 = w.ic ? P.sOf(w.pos) : sForIndex(i);
      cuts.push({ s: s0 - 240, kind: 'split', ic: w, s0 }, { s: s0 + 240, kind: 'split', ic: w, s0 });
    } else if (w.rest) {
      const s0 = sForIndex(i);
      cuts.push({ s: s0 - 260, kind: 'split', rest: w, s0 }, { s: s0 + 260, kind: 'split', rest: w, s0 });
    } else if (w.jct) {
      cuts.push({ s: P.sOf(w.pos), kind: 'jct', jct: w });
    } else if (w.village) {
      const s0 = sForIndex(i);
      cuts.push({ s: s0, kind: 'village', village: w, s0 }, { s: s0 + 230, kind: 'village2', village: w, s0 });
      if (R.type !== 'expressway' && R.type !== 'motorway') {
        zones.push([s0 - 380, s0 + 610, 50], [s0 - 900, s0 + 1130, 70]);
      }
    }
  }
  // city approach zones
  if (R.from.city) zones.push([0, R.type === 'motorway' ? 1300 : 700, R.type === 'motorway' ? 80 : 70]);
  if (R.to.city) zones.push([P.len - (R.type === 'motorway' ? 1300 : 700), P.len, R.type === 'motorway' ? 80 : 70]);
  if (R.type === 'motorway' && R.from.city) zones.push([1300, 3200, 100]);
  if (R.type === 'motorway' && R.to.city) zones.push([P.len - 3200, P.len - 1300, 100]);
  if (R.to.villageEnd) zones.push([P.len - 500, P.len, 50]);
  for (const z of zones) { if (z[0] > 30) cuts.push({ s: z[0], kind: 'zone' }); if (z[1] < P.len - 30) cuts.push({ s: z[1], kind: 'zone' }); }
  const speedAt = (s) => {
    let v = R.speed;
    for (const z of zones) if (s >= z[0] && s <= z[1]) v = Math.min(v, z[2]);
    return v;
  };
  // 2+1 switch points
  const SW = 1900;
  if (R.type === 'expressway') for (let s = SW; s < P.len - 300; s += SW) cuts.push({ s, kind: 'switch' });
  // side-road junction candidates
  if (R.type !== 'motorway') {
    let s = rng.float(700, 1600);
    while (s < P.len - 500) { cuts.push({ s, kind: 'side', side: rng.chance(0.5) ? 1 : -1 }); s += rng.float(1300, 3200); }
  }
  // sort & dedupe
  const importance = { start: 9, end: 9, split: 8, jct: 7, village: 7, village2: 6, switch: 3, zone: 2, side: 1 };
  cuts.sort((a, b) => a.s - b.s);
  const kept = [];
  for (const c of cuts) {
    c.s = clamp(c.s, 0, P.len);
    const last = kept[kept.length - 1];
    const minGap = c.kind === 'side' || (last && last.kind === 'side') ? 140 : c.kind === 'switch' || (last && last.kind === 'switch') ? 160 : 45;
    if (last && c.s - last.s < minGap) {
      if (importance[c.kind] > importance[last.kind]) { kept[kept.length - 1] = c; }
      continue;
    }
    kept.push(c);
  }
  // make sure split pairs survived together
  const pairOK = new Set();
  for (const c of kept) if (c.kind === 'split') pairOK.add(c.ic || c.rest);
  for (let i = kept.length - 1; i >= 0; i--) {
    const c = kept[i];
    if (c.kind === 'split') {
      const both = kept.filter((k) => k.kind === 'split' && (k.ic || k.rest) === (c.ic || c.rest)).length === 2;
      if (!both) kept.splice(i, 1);
    }
  }
  // nodes at cuts
  for (const c of kept) {
    c.i = P.nearestIdx(c.s);
    c.s = P.S[c.i];
  }
  for (let q = 0; q < kept.length; q++) {
    const c = kept[q];
    if (q === 0 && st.node) { c.node = st.node; continue; }
    if (q === kept.length - 1 && en.node) { c.node = en.node; continue; }
    const p = P.pts[c.i];
    c.node = net.addNode(p[0], p[1], { kind: c.kind === 'split' ? 'split' : null });
    if (q === 0 && st.name) world.namedNodes[st.name] = c.node;
    if (q === kept.length - 1 && en.name) world.namedNodes[en.name] = c.node;
  }
  // roads between cuts
  const roads = [];
  let lanesCfg = 0; // expressway: 0 => F2B1, 1 => F1B2
  for (let q = 0; q < kept.length - 1; q++) {
    const a = kept[q], b = kept[q + 1];
    if (a.kind === 'switch') lanesCfg ^= 1;
    const ctrl = P.pts.slice(a.i, b.i + 1);
    if (ctrl.length < 2) continue;
    ctrl[0] = [a.node.x, a.node.z];
    ctrl[ctrl.length - 1] = [b.node.x, b.node.z];
    const mid = (a.s + b.s) / 2;
    const xs = {};
    if (R.type === 'expressway') { xs.lanesF = lanesCfg ? 1 : 2; xs.lanesB = lanesCfg ? 2 : 1; }
    if (R.type === 'motorway' && R.ref === 'E4' && R.id === 'E4S' && mid < 2600) { xs.lanesF = 3; xs.lanesB = 3; }
    const r = net.addRoad(a.node, b.node, R.type, {
      ref: R.ref, route: R.id, speed: speedAt(mid), ctrl, xs, dest: { fwd: R.destF, bwd: R.destB },
      name: R.ref.match(/^E/) ? R.ref : 'Väg ' + R.ref,
    });
    r.routeS0 = a.s;
    roads.push(r);
    a.roadOut = r; b.roadIn = r;
  }
  // split nodes through roads
  for (const c of kept) if (c.kind === 'split' && c.roadIn && c.roadOut) c.node.split = { through: [c.roadIn, c.roadOut] };
  // junction & village markers
  world.routes.push({ id: R.id, ref: R.ref, type: R.type, roads, poly: P, cuts: kept });

  // ---- interchanges, rest areas
  const done = new Set();
  for (const c of kept) {
    if (c.kind !== 'split') continue;
    const tag = c.ic || c.rest;
    if (done.has(tag)) continue;
    done.add(tag);
    const pair = kept.filter((k) => k.kind === 'split' && (k.ic || k.rest) === tag);
    if (pair.length !== 2) continue;
    const [N1, N2] = pair;
    if (c.ic) buildInterchange(net, world, R, P, N1, N2, c.ic, rng, occ);
    else buildRestArea(net, world, R, P, N1, N2, c.rest);
  }
  // ---- at-grade junctions to cities
  for (const c of kept) {
    if (c.kind === 'jct') {
      const gw = world.namedNodes['gw:' + R.id + ':jct:' + c.jct.jct];
      if (gw) {
        const ctrl = [[c.node.x, c.node.z], [lerp(c.node.x, gw.x, 0.5), lerp(c.node.z, gw.z, 0.5)], [gw.x, gw.z]];
        net.addRoad(c.node, gw, 'primary', { speed: 70, name: CITY[c.jct.jct].name, ctrl, dest: { fwd: CITY[c.jct.jct].name, bwd: R.ref } });
      }
    }
    if (c.kind === 'village') {
      const v = c.village;
      const two = kept.find((k) => k.kind === 'village2' && k.village === v);
      const t = P.tangent(c.s);
      world.villages.push({ name: v.village, x: c.node.x, z: c.node.z, dirx: t[0], dirz: t[1], side: v.side || 1, node: c.node, node2: two ? two.node : null, petrol: true, route: R.id });
    }
    if (c.kind === 'side') {
      const t = P.tangent(c.s);
      (world.sideCandidates ||= []).push({ node: c.node, dirx: -t[1] * c.side, dirz: t[0] * c.side, route: R.id, ref: R.ref });
    }
  }
  // village at the end
  if (R.to.villageEnd) {
    const n = kept[kept.length - 1].node;
    const t = P.tangent(P.len);
    world.villages.push({ name: R.to.villageEnd, x: n.x, z: n.z, dirx: t[0], dirz: t[1], side: 1, node: n, node2: null, petrol: false, route: R.id, end: true });
  }
}

/* ---------------------------- Interchanges ---------------------------- */
function buildInterchange(net, world, R, P, N1, N2, ic, rng, occ) {
  const s0 = (N1.s + N2.s) / 2;
  const L = (N2.s - N1.s) / 2;
  const t = P.tangent(s0);
  const n = [-t[1], t[0]]; // right normal
  const mw = N1.roadOut.xs;
  const rampXS = net.roads.length ? null : null;
  const off = 56;
  const [px, pz] = P.at(s0);
  const TR = net.addNode(px + n[0] * off, pz + n[1] * off, { kind: 'roundabout', roundabout: { r: 15 } });
  const TL = net.addNode(px - n[0] * off, pz - n[1] * off, { kind: 'roundabout', roundabout: { r: 15 } });
  // ramp lateral offset so its inner pavement edge meets the motorway shoulder
  const rampLat = mw.edgeR + 2.475;
  const rampLatL = -mw.edgeL + 2.475;
  const ramp = (from, to, ctrl) => net.addRoad(from, to, 'ramp', { ctrl, speed: 70, name: 'Påfart' });
  const p = (s, lat) => P.at(s, lat);
  const sA = N1.s, sB = N2.s;
  // A: forward off-ramp (right side) N1 -> TR
  const A = ramp(N1.node, TR, [p(sA, rampLat), p(sA + 70, rampLat + 1.2), p(s0 - 95, off - 6), [TR.x, TR.z]]);
  // B: forward on-ramp TR -> N2
  const B = ramp(TR, N2.node, [[TR.x, TR.z], p(s0 + 95, off - 6), p(sB - 70, rampLat + 1.2), p(sB, rampLat)]);
  // C: backward off-ramp (left side) N2 -> TL
  const C = ramp(N2.node, TL, [p(sB, -rampLatL), p(sB - 70, -rampLatL - 1.2), p(s0 + 95, -(off - 6)), [TL.x, TL.z]]);
  // D: backward on-ramp TL -> N1
  const D = ramp(TL, N1.node, [[TL.x, TL.z], p(s0 - 95, -(off - 6)), p(sA + 70, -rampLatL - 1.2), p(sA, -rampLatL)]);
  A.name = 'Avfart'; C.name = 'Avfart';
  // bridge road over the motorway
  const cityName = ic.ic ? CITY[ic.ic].name : ic.vic;
  const br = net.addRoad(TL, TR, 'primary', { ctrl: [[TL.x, TL.z], [TR.x, TR.z]], speed: 70, name: cityName, tags: { flatOver: true } });
  br.prio = 0.5;
  for (const r of [A, B, C, D]) r.prio = 1.6;
  const entry = { TR, TL, ramps: [A, B, C, D], bridge: br, route: R.id, name: cityName, s0, x: px, z: pz, ref: R.ref };
  // city side
  let cityTerm = null, otherTerm = null;
  if (ic.ic) {
    const c = CITY[ic.ic];
    const side = (c.x - px) * n[0] + (c.z - pz) * n[1] > 0 ? 1 : -1;
    cityTerm = side > 0 ? TR : TL; otherTerm = side > 0 ? TL : TR;
    const gw = world.namedNodes['gw:' + R.id + ':ic:' + ic.ic];
    if (gw) {
      const dx = gw.x - cityTerm.x, dz = gw.z - cityTerm.z;
      const ctrl = [[cityTerm.x, cityTerm.z], [cityTerm.x + n[0] * side * 60, cityTerm.z + n[1] * side * 60], [gw.x - dx * 0.25, gw.z - dz * 0.25], [gw.x, gw.z]];
      net.addRoad(cityTerm, gw, 'primary', { ctrl, speed: 70, name: c.name, dest: { fwd: c.name, bwd: R.ref } });
    }
    // E-road number for the junction exit sign
    world.interchanges[R.id + ':' + ic.ic] = { ...entry, cityTerm, otherTerm };
  } else if (ic.vic) {
    const side = ic.b != null ? (bearingVec(ic.b)[0] * n[0] + bearingVec(ic.b)[1] * n[1] > 0 ? 1 : -1) : 1;
    cityTerm = side > 0 ? TR : TL; otherTerm = side > 0 ? TL : TR;
    const d = (ic.d || 0.5) * 1000;
    const vx = cityTerm.x + n[0] * side * d, vz = cityTerm.z + n[1] * side * d;
    if (!isWater(vx, vz)) {
      const vn = net.addNode(vx, vz, {});
      const ctrl = [[cityTerm.x, cityTerm.z], [cityTerm.x + n[0] * side * d * 0.5 + t[0] * 40, cityTerm.z + n[1] * side * d * 0.5 + t[1] * 40], [vx, vz]];
      const lr = net.addRoad(cityTerm, vn, 'secondary', { ctrl, speed: 70, name: ic.vic, dest: { fwd: ic.vic, bwd: R.ref } });
      // continue a bit beyond so the village sits on a through street
      const vx2 = vx + n[0] * side * 260, vz2 = vz + n[1] * side * 260;
      const vn2 = net.addNode(vx2, vz2, {});
      net.addRoad(vn, vn2, 'secondary', { ctrl: [[vx, vz], [vx2, vz2]], speed: 50, name: ic.vic, route: 'v:' + ic.vic });
      lr.route = 'v:' + ic.vic;
      world.villages.push({ name: ic.vic, x: vx, z: vz, dirx: n[0] * side, dirz: n[1] * side, side: 1, node: vn, node2: null, petrol: true, route: R.id });
    }
    if (ic.id) world.interchanges[R.id + ':' + ic.id] = { ...entry, cityTerm, otherTerm };
    world.interchanges[R.id + ':' + ic.vic] = { ...entry, cityTerm, otherTerm };
  }
  // other side: sometimes a local road out into the countryside
  if (otherTerm && rng.chance(0.75)) {
    const side = otherTerm === TR ? 1 : -1;
    (world.sideCandidates ||= []).push({ node: otherTerm, dirx: n[0] * side, dirz: n[1] * side, route: R.id, ref: R.ref, fromIc: true });
  }
  world.interchangesList = world.interchangesList || [];
  world.interchangesList.push(entry);
  occ.markPoly([[TR.x, TR.z], [TL.x, TL.z]], 80);
}

function buildRestArea(net, world, R, P, N1, N2, rest) {
  const s0 = (N1.s + N2.s) / 2;
  const mw = N1.roadOut.xs;
  const rampLat = mw.edgeR + 2.3;
  const latL = -mw.edgeL + 2.3;
  const sA = N1.s, sB = N2.s;
  const off = 46;
  const p = (s, lat) => P.at(s, lat);
  const r1 = net.addRoad(N1.node, N2.node, 'rest', { ctrl: [p(sA, rampLat), p(sA + 80, rampLat + 3), p(s0 - 110, off), p(s0, off), p(s0 + 110, off), p(sB - 80, rampLat + 3), p(sB, rampLat)], speed: 50, name: 'Rastplats ' + rest.rest });
  const r2 = net.addRoad(N2.node, N1.node, 'rest', { ctrl: [p(sB, -latL), p(sB - 80, -latL - 3), p(s0 + 110, -off), p(s0, -off), p(s0 - 110, -off), p(sA + 80, -latL - 3), p(sA, -latL)], speed: 50, name: 'Rastplats ' + rest.rest });
  r1.prio = 1.6; r2.prio = 1.6;
  const t = P.tangent(s0);
  for (const [side, r] of [[1, r1], [-1, r2]]) {
    const c = P.at(s0, side * (off + 16));
    world.restAreas.push({ name: rest.rest, x: c[0], z: c[1], rot: Math.atan2(t[1], t[0]), side, road: r });
    world.pois.push({ type: 'rest', x: c[0], z: c[1], rot: Math.atan2(t[1], t[0]), name: 'Rastplats ' + rest.rest });
    world.parkings.push({ x: c[0], z: c[1], w: 120, d: 16, rot: Math.atan2(t[1], t[0]), cars: 0.35, trucks: true, lot: true, rest: true });
  }
}

/* ----------------------------- Side roads ----------------------------- */
const HAMLETS = ['Björkby', 'Granlunda', 'Sjövik', 'Ekbacken', 'Lillby', 'Storsjö', 'Furuhöjd', 'Tallnäs', 'Mossen', 'Kvarnbyn', 'Lindås', 'Hagby',
  'Bäckebo', 'Rönnliden', 'Åkerby', 'Ängsvik', 'Bergby', 'Myrbacka', 'Älvsby', 'Fjällsta', 'Holmen', 'Vretstorp', 'Ödsmål', 'Kärrby', 'Norrby',
  'Söderby', 'Västanå', 'Östansjö', 'Gärdet', 'Hultet', 'Torpet', 'Lövåsen', 'Skogsby', 'Grustäkten', 'Mjölnartorp', 'Nyhem', 'Åsen', 'Vik'];
let hamletIdx = 0;

function buildSideRoad(net, world, cand, rng, occ) {
  const typeR = rng.next();
  const type = typeR < 0.5 ? 'gravel' : typeR < 0.86 ? 'local' : 'secondary';
  let x = cand.node.x, z = cand.node.z;
  let hx = cand.dirx, hz = cand.dirz;
  const ctrl = [[x, z]];
  const total = rng.float(700, type === 'secondary' ? 3200 : 2200);
  const step = type === 'gravel' ? 120 : 170;
  let reason = 'len';
  for (let s = 0; s < total; s += step) {
    const a = rng.float(-0.38, 0.38);
    const c = Math.cos(a), sn = Math.sin(a);
    [hx, hz] = [hx * c - hz * sn, hx * sn + hz * c];
    const nx = x + hx * step, nz = z + hz * step;
    if (isWater(nx, nz) || isWater((x + nx) / 2, (z + nz) / 2)) { reason = 'water'; break; }
    if (cityMask(nx, nz) > 0.02) { reason = 'city'; break; }
    if (s > 200 && occ.test(nx, nz)) { reason = 'road'; break; }
    x = nx; z = nz;
    ctrl.push([x, z]);
  }
  if (ctrl.length < 3) return;
  occ.markPoly(ctrl.slice(1), 50);
  const end = net.addNode(x, z, {});
  const num = type === 'secondary' ? String(200 + (hashStr(cand.route + ctrl.length + x) % 780)) : type === 'local' && rng.chance(0.4) ? String(500 + (hashStr('l' + x) % 499)) : null;
  const name = HAMLETS[hamletIdx++ % HAMLETS.length];
  const r = net.addRoad(cand.node, end, type, { ctrl, speed: type === 'gravel' ? 70 : type === 'local' ? 70 : 80, ref: num, name: num ? 'Väg ' + num : null, dest: { fwd: name, bwd: cand.ref } });
  world.sideRoads.push(r);
  // destination at the end: farm / hamlet / lake cottages
  const lots = world.lots;
  const rr = new RNG(hashStr(name + x));
  const kind = reason === 'water' ? 'cottages' : rr.chance(0.55) ? 'farm' : 'hamlet';
  const ang = Math.atan2(hz, hx);
  const place = (dx, dz, o) => {
    const px = x + hx * dx - hz * dz, pz = z + hz * dx + hx * dz;
    if (!isWater(px, pz)) lots.push({ x: px, z: pz, rot: ang + (o.rotOff || 0), ...o, needsClear: 6 });
  };
  const FALU = 0x8e2a1f;
  if (kind === 'farm') {
    place(-10, 18, { kind: 'house', w: 10, d: 8, floors: 2, floorH: 2.8, color: rr.chance(0.7) ? FALU : 0xf2efe6, style: 'falu', roof: 'gable', roofColor: 0x6e2c22, trim: 0xf4f1ea, garden: true });
    place(14, 24, { kind: 'barn', w: 22, d: 12, floors: 1, floorH: 5.5, color: FALU, style: 'falu', roof: 'gable', roofColor: 0x3a3d40, trim: 0xf4f1ea });
    place(10, -20, { kind: 'barn', w: 10, d: 7, floors: 1, floorH: 3.4, color: FALU, style: 'falu', roof: 'gable', roofColor: 0x3a3d40, trim: 0xf4f1ea });
    world.fields = world.fields || [];
    world.fields.push({ x: x + hx * 80, z: z + hz * 80, r: rr.float(120, 220), rot: ang });
  } else if (kind === 'cottages') {
    for (let k = 0; k < rr.int(2, 5); k++) place(-20 + k * 14, rr.float(-28, 28), { kind: 'house', w: 6.5, d: 5.5, floors: 1, floorH: 2.6, color: rr.chance(0.8) ? FALU : 0xe8cf7a, style: 'falu', roof: 'gable', roofColor: 0x2f3236, trim: 0xf4f1ea, rotOff: rr.float(-0.3, 0.3) });
  } else {
    for (let k = 0; k < rr.int(3, 7); k++) {
      const sgn = k % 2 ? 1 : -1;
      place(-60 - k * 22, sgn * rr.float(17, 24), { kind: 'house', w: rr.float(8, 10.5), d: rr.float(7, 8.5), floors: rr.chance(0.5) ? 2 : 1, floorH: 2.8, color: rr.chance(0.65) ? FALU : rr.pick([0xf2efe6, 0xe8cf7a, 0xd9d4c4]), style: 'falu', roof: 'gable', roofColor: rr.pick([0x9b3b2a, 0x2f3236]), trim: 0xf4f1ea, garden: true });
    }
  }
  world.places.push({ name, x, z, kind: 'hamlet' });
}

/* City streets must not cross motorways / 2+1 roads at grade. */
function removeCityRoadsCrossing(net, world) {
  const C = 64;
  const grid = new Map();
  for (const rt of world.routes) {
    if (rt.type !== 'motorway' && rt.type !== 'expressway') continue;
    const pts = rt.poly.pts;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const k = Math.floor(pts[i][0] / C) * 100003 + Math.floor(pts[i][1] / C);
      let l = grid.get(k); if (!l) { l = []; grid.set(k, l); }
      l.push([pts[i], pts[i + 1]]);
    }
  }
  const hits = (a, b) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.ceil(L / 20);
    for (let q = 0; q <= steps; q++) {
      const x = a[0] + (b[0] - a[0]) * q / steps, z = a[1] + (b[1] - a[1]) * q / steps;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const l = grid.get((Math.floor(x / C) + di) * 100003 + Math.floor(z / C) + dj);
        if (!l) continue;
        for (const [p, q2] of l) if (segX(a, b, p, q2)) return true;
      }
    }
    return false;
  };
  for (const r of net.roads.slice()) {
    if (!r.city || r.district === 'gateway') continue;
    const c = r.ctrl;
    for (let i = 0; i < c.length - 1; i++) if (hits(c[i], c[i + 1])) { net.removeRoad(r); break; }
  }
}
function segX(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return false;
  const qx = c[0] - a[0], qz = c[1] - a[1];
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/* Ordinary roads that cross without sharing a node get an at-grade junction. */
const LIMITED = new Set(['motorway', 'expressway', 'ramp', 'rest']);
function junctionsAtCrossings(net) {
  const C = 48;
  const grid = new Map();
  const roads = net.roads.filter((r) => !LIMITED.has(r.type) && r.prio > 1);
  roads.forEach((r, ri) => {
    const c = r.ctrl;
    for (let i = 0; i < c.length - 1; i++) {
      const x0 = Math.min(c[i][0], c[i + 1][0]), x1 = Math.max(c[i][0], c[i + 1][0]);
      const z0 = Math.min(c[i][1], c[i + 1][1]), z1 = Math.max(c[i][1], c[i + 1][1]);
      for (let gx = Math.floor(x0 / C); gx <= Math.floor(x1 / C); gx++)
        for (let gz = Math.floor(z0 / C); gz <= Math.floor(z1 / C); gz++) {
          const k = gx * 100003 + gz;
          let l = grid.get(k); if (!l) { l = []; grid.set(k, l); }
          l.push([ri, i]);
        }
    }
  });
  const cuts = new Map(); // road -> [{seg, t, node}]
  const seen = new Set();
  const plen = (r) => { let L = 0; for (let i = 1; i < r.ctrl.length; i++) L += Math.hypot(r.ctrl[i][0] - r.ctrl[i - 1][0], r.ctrl[i][1] - r.ctrl[i - 1][1]); return L; };
  const sAlong = (r, seg, t) => { let L = 0; for (let i = 1; i <= seg; i++) L += Math.hypot(r.ctrl[i][0] - r.ctrl[i - 1][0], r.ctrl[i][1] - r.ctrl[i - 1][1]); return L + t * Math.hypot(r.ctrl[seg + 1][0] - r.ctrl[seg][0], r.ctrl[seg + 1][1] - r.ctrl[seg][1]); };
  for (const l of grid.values()) {
    for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) {
      const [ra, ia] = l[a], [rb, ib] = l[b];
      if (ra === rb) continue;
      const A = roads[ra], B = roads[rb];
      if (A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue;
      const key = ra < rb ? ra + ':' + ia + ':' + rb + ':' + ib : rb + ':' + ib + ':' + ra + ':' + ia;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = A.ctrl[ia], q = A.ctrl[ia + 1], u = B.ctrl[ib], v = B.ctrl[ib + 1];
      const rx = q[0] - p[0], rz = q[1] - p[1], sx = v[0] - u[0], sz = v[1] - u[1];
      const den = rx * sz - rz * sx;
      if (Math.abs(den) < 1e-9) continue;
      const qx = u[0] - p[0], qz = u[1] - p[1];
      const t = (qx * sz - qz * sx) / den, w = (qx * rz - qz * rx) / den;
      if (t < 0 || t > 1 || w < 0 || w > 1) continue;
      const sa = sAlong(A, ia, t), sb = sAlong(B, ib, w);
      const La = plen(A), Lb = plen(B);
      if (sa < 25 || La - sa < 25 || sb < 25 || Lb - sb < 25) {
        // too close to an existing node: drop the less important (city) road
        const victim = A.prio >= B.prio ? A : B;
        if (victim.city) victim.dead = true;
        continue;
      }
      const x = p[0] + rx * t, z = p[1] + rz * t;
      const node = net.addNode(x, z, {});
      (cuts.get(A) || cuts.set(A, []).get(A)).push({ seg: ia, t, node, s: sa });
      (cuts.get(B) || cuts.set(B, []).get(B)).push({ seg: ib, t: w, node, s: sb });
    }
  }
  for (const r of net.roads.slice()) if (r.dead && !cuts.has(r)) net.removeRoad(r);
  for (const [r, list] of cuts) {
    if (r.dead) { net.removeRoad(r); continue; }
    list.sort((a, b) => a.s - b.s);
    // drop cuts closer than 30 m to each other
    const L = [];
    for (const c of list) if (!L.length || c.s - L[L.length - 1].s > 30) L.push(c);
    net.removeRoad(r);
    let prevNode = r.a, prevPt = null, segStart = 0;
    const pieces = [];
    let cur = [r.ctrl[0]];
    let ci = 0;
    for (let i = 0; i < r.ctrl.length - 1; i++) {
      while (ci < L.length && L[ci].seg === i) {
        const c = L[ci++];
        const pt = [c.node.x, c.node.z];
        cur.push(pt);
        pieces.push({ a: prevNode, b: c.node, ctrl: cur });
        prevNode = c.node; cur = [pt];
      }
      cur.push(r.ctrl[i + 1]);
    }
    pieces.push({ a: prevNode, b: r.b, ctrl: cur });
    for (const pc of pieces) {
      if (pc.ctrl.length < 2) continue;
      const nr = net.addRoad(pc.a, pc.b, r.type, { ref: r.ref, name: r.name, route: r.route, speed: r.speed, ctrl: pc.ctrl, city: r.city, district: r.district, dest: r.dest, tags: r.tags });
      nr.xs = r.xs; nr.prio = r.prio;
    }
  }
}
