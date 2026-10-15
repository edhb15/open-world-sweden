/* =====================================================================
   Geography of the compressed Sweden map.

   World units are metres. three.js axes: +x = east, -z = north, +y = up.
   The map keeps the relative layout of real Sweden but compresses travel
   distances (Malmö -> Kiruna is ~45 km of road instead of ~1 600 km) while
   cities, roads and buildings are kept at life-size scale.
   ===================================================================== */
import { clamp, lerp, smoothstep, fbm, noiseA, noiseB, noiseC, distToSeg, pointInPoly, polySDF, segParam } from '../core/math.js';

// km (east, north) -> world [x, z]
export const K = (e, n) => [e * 1000, -n * 1000];
export const toKm = (x, z) => [x / 1000, -z / 1000];

/* ------------------------------ Coastline ------------------------------ */
// Land polygon (Scandinavia + Finland) in km (east, north).
const LAND_KM = [
  [-40, 60], [60, 60], [60, 5], [20, 4.5], [9.0, 5.0], [10.0, 8.0], [9.5, 12.0], [9.0, 16.0], [10.0, 18.5],
  [11.0, 21.0], [11.2, 23.0], [10.5, 24.2], [9.6, 24.0], [8.6, 23.0], [7.8, 22.0], [6.5, 20.5], [5.5, 18.6],
  [4.6, 17.6], [4.2, 17.0], [3.3, 15.6], [2.6, 14.5], [2.1, 12.6], [2.0, 10.1], [2.6, 7.6], [2.8, 5.0],
  [2.4, 3.2], [1.6, 1.4], [2.3, 1.35], [3.3, 1.15], [3.75, 0.75], [3.5, 0.3], [2.6, 0.18], [1.5, 0.22], [1.0, 0.1], [1.3, -1.2], [0.4, -2.6], [-1.6, -3.7], [-3.8, -5.5], [-5.7, -6.7],
  [-4.6, -7.6], [-4.0, -9.6], [-5.6, -13.0], [-6.6, -16.0], [-8.6, -17.2], [-9.2, -18.5], [-10.2, -18.9],
  [-12.2, -19.1], [-13.7, -17.7], [-14.3, -16.3], [-14.7, -15.2], [-14.8, -13.0], [-14.8, -10.9],
  [-15.6, -8.5], [-16.1, -5.6], [-16.4, -2.5], [-16.8, 1.5], [-22, 2.6], [-40, 2.0],
];
export const LAND = LAND_KM.map(([e, n]) => K(e, n));

// Big lakes (water level 0). km polygons.
const LAKES_KM = {
  'Mälaren': [[-0.35, 0.28], [-0.9, 0.9], [-1.8, 1.1], [-2.6, 0.75], [-3.4, 1.55], [-4.5, 1.75], [-5.3, 2.15], [-6.4, 2.0],
    [-6.8, 1.3], [-5.8, 0.9], [-4.6, 0.6], [-3.6, 0.2], [-2.7, -0.5], [-1.7, -0.8], [-0.9, -0.35], [-0.5, 0.05]],
  'Vättern': [[-11.85, -9.15], [-11.0, -9.05], [-10.5, -7.8], [-10.1, -6.4], [-10.15, -4.8], [-10.6, -4.5], [-10.95, -5.6],
    [-11.35, -7.2], [-11.7, -8.4]],
  'Vänern': [[-14.4, -3.9], [-13.0, -4.1], [-12.0, -3.4], [-11.7, -2.0], [-12.3, -0.9], [-13.6, -0.8], [-14.6, -1.8], [-14.8, -3.0]],
};
export const LAKES = Object.fromEntries(Object.entries(LAKES_KM).map(([k, v]) => [k, v.map(([e, n]) => K(e, n))]));

// Rivers and channels: polyline (km), width (m), level at mouth, slope (m per m upstream), valley width.
// The first point is the upstream end; the last point is the mouth.
const RIVERS_KM = [
  { name: 'Göta älv', w: 150, slope: 0, valley: 0, pts: [[-14.42, -3.92], [-14.6, -4.6], [-14.85, -5.3], [-15.2, -5.56], [-15.7, -5.62], [-16.6, -5.66]] },
  { name: 'Saltsjön', w: 260, slope: 0, valley: 0, pts: [[0.33, 0.0], [0.6, -0.04], [0.9, 0.04], [1.4, 0.02]] },
  { name: 'Norrström', w: 80, slope: 0, valley: 0, pts: [[-0.06, 0.06], [0.08, 0.15], [0.24, 0.12], [0.36, 0.01]] },
  { name: 'Söderström', w: 70, slope: 0, valley: 0, pts: [[-0.06, 0.0], [0.1, -0.12], [0.26, -0.1], [0.36, -0.01]] },
  { name: 'Riddarfjärden', w: 220, slope: 0, valley: 0, pts: [[-0.5, 0.2], [-0.3, 0.06], [-0.06, 0.03]] },
  { name: 'Fyrisån', w: 28, slope: 0, valley: 250, pts: [[-0.75, 7.6], [-0.66, 6.8], [-0.7, 6.3], [-0.55, 5.6], [-0.2, 4.6], [0.9, 3.6], [2.7, 3.4]] },
  { name: 'Ljusnan', w: 90, slope: 0.0016, valley: 500, pts: [[-6.0, 11.6], [-3.0, 11.3], [-0.6, 11.7], [0.8, 11.6], [2.4, 11.5]] },
  { name: 'Indalsälven', w: 110, slope: 0.0016, valley: 600, pts: [[-6.0, 15.6], [-3.0, 15.2], [-0.4, 15.4], [1.6, 15.1], [3.3, 15.15]] },
  { name: 'Umeälven', w: 120, slope: 0.0016, valley: 600, pts: [[-3.0, 19.8], [0.0, 19.4], [2.6, 19.0], [4.4, 18.45], [5.8, 18.1]] },
  { name: 'Skellefteälven', w: 90, slope: 0.0016, valley: 500, pts: [[-2.0, 21.5], [1.5, 21.0], [4.2, 20.6], [5.6, 20.35], [6.9, 20.2]] },
  { name: 'Luleälven', w: 130, slope: 0.0016, valley: 600, pts: [[-1.0, 24.8], [2.5, 24.4], [5.5, 23.9], [7.2, 23.35], [8.2, 22.75]] },
  { name: 'Torne älv', w: 120, slope: 0.002, valley: 600, pts: [[0.5, 28.2], [3.0, 27.6], [6.5, 27.0], [9.0, 26.0], [10.8, 24.6]] },
];
export const RIVERS = RIVERS_KM.map((r) => {
  const pts = r.pts.map(([e, n]) => K(e, n));
  // cumulative distance from mouth
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = L[L.length - 1];
  const fromMouth = L.map((v) => total - v);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
  const pad = r.w + r.valley + 200;
  return { ...r, pts, fromMouth, bbox: [minX - pad, minZ - pad, maxX + pad, maxZ + pad] };
});

/* ------------------------------ Cities ------------------------------ */
// size: 3 = metropolis, 2 = city, 1 = town. lat = real latitude for the sun.
const CITIES_KM = [
  { id: 'stockholm', name: 'Stockholm', e: 0, n: 0, r: 1500, size: 3, lat: 59.33 },
  { id: 'sodertalje', name: 'Södertälje', e: -2.9, n: -2.3, r: 430, size: 1, lat: 59.2 },
  { id: 'uppsala', name: 'Uppsala', e: -0.7, n: 6.3, r: 760, size: 2, lat: 59.86 },
  { id: 'vasteras', name: 'Västerås', e: -5.6, n: 2.75, r: 520, size: 2, lat: 59.61 },
  { id: 'orebro', name: 'Örebro', e: -8.4, n: -0.8, r: 560, size: 2, lat: 59.27 },
  { id: 'nykoping', name: 'Nyköping', e: -4.5, n: -5.0, r: 380, size: 1, lat: 58.75 },
  { id: 'norrkoping', name: 'Norrköping', e: -7.0, n: -6.5, r: 540, size: 2, lat: 58.59 },
  { id: 'linkoping', name: 'Linköping', e: -8.7, n: -7.6, r: 540, size: 2, lat: 58.41 },
  { id: 'jonkoping', name: 'Jönköping', e: -11.45, n: -9.65, r: 600, size: 2, lat: 57.78 },
  { id: 'varnamo', name: 'Värnamo', e: -11.9, n: -12.4, r: 300, size: 1, lat: 57.18 },
  { id: 'helsingborg', name: 'Helsingborg', e: -14.0, n: -15.3, r: 560, size: 2, lat: 56.05 },
  { id: 'malmo', name: 'Malmö', e: -12.8, n: -17.65, r: 1000, size: 3, lat: 55.6 },
  { id: 'halmstad', name: 'Halmstad', e: -13.95, n: -11.0, r: 420, size: 1, lat: 56.67 },
  { id: 'goteborg', name: 'Göteborg', e: -15.0, n: -5.5, r: 1100, size: 3, lat: 57.71 },
  { id: 'mariestad', name: 'Mariestad', e: -11.35, n: -2.6, r: 300, size: 1, lat: 58.71 },
  { id: 'gavle', name: 'Gävle', e: 0.95, n: 10.3, r: 500, size: 2, lat: 60.67 },
  { id: 'hudiksvall', name: 'Hudiksvall', e: 1.35, n: 12.6, r: 300, size: 1, lat: 61.73 },
  { id: 'sundsvall', name: 'Sundsvall', e: 1.85, n: 14.6, r: 500, size: 2, lat: 62.39 },
  { id: 'ornskoldsvik', name: 'Örnsköldsvik', e: 3.55, n: 17.0, r: 300, size: 1, lat: 63.29 },
  { id: 'umea', name: 'Umeå', e: 4.75, n: 18.75, r: 560, size: 2, lat: 63.83 },
  { id: 'skelleftea', name: 'Skellefteå', e: 5.85, n: 20.65, r: 400, size: 1, lat: 64.75 },
  { id: 'lulea', name: 'Luleå', e: 7.95, n: 23.15, r: 500, size: 2, lat: 65.58 },
  { id: 'gallivare', name: 'Gällivare', e: 5.9, n: 25.05, r: 300, size: 1, lat: 67.13 },
  { id: 'kiruna', name: 'Kiruna', e: 3.5, n: 26.65, r: 650, size: 2, lat: 67.86 },
];
export const CITIES = CITIES_KM.map((c) => ({ ...c, x: c.e * 1000, z: -c.n * 1000 }));
export const CITY = Object.fromEntries(CITIES.map((c) => [c.id, c]));

export function cityAt(x, z, pad = 0) {
  for (const c of CITIES) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < c.r + pad) return c;
  }
  return null;
}
// 0..1 how "urban" a point is (1 inside city core).
export function cityMask(x, z) {
  let m = 0;
  for (const c of CITIES) {
    const dx = x - c.x, dz = z - c.z;
    if (Math.abs(dx) > c.r * 1.6 || Math.abs(dz) > c.r * 1.6) continue;
    const d = Math.hypot(dx, dz);
    m = Math.max(m, 1 - smoothstep(c.r * 0.85, c.r * 1.5, d));
  }
  return m;
}

/* -------------------- Latitude (for sun & daylight) -------------------- */
export function latitudeAt(x, z) {
  const n = -z / 1000;
  if (n >= 0) return 59.33 + n * ((67.86 - 59.33) / 26.65);
  return 59.33 + n * ((59.33 - 55.6) / 17.65);
}

/* ---------------------- Signed distance rasters ---------------------- */
// Raster covering the playable map. Outside it we fall back to exact SDF.
const RX0 = -26000, RZ0 = -36000, RCELL = 125;
const RW = Math.ceil((22000 - RX0) / RCELL) + 1; // x to 22 km east
const RH = Math.ceil((24000 - RZ0) / RCELL) + 1; // z to 24 km south
let coastRaster = null, lakeRaster = null;

function buildRaster(fn) {
  const r = new Float32Array(RW * RH);
  for (let j = 0; j < RH; j++) {
    const z = RZ0 + j * RCELL;
    for (let i = 0; i < RW; i++) r[j * RW + i] = fn(RX0 + i * RCELL, z);
  }
  return r;
}
function sampleRaster(r, x, z, fallback) {
  const fx = (x - RX0) / RCELL, fz = (z - RZ0) / RCELL;
  if (fx < 0 || fz < 0 || fx >= RW - 1 || fz >= RH - 1) return fallback(x, z);
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const a = r[j * RW + i], b = r[j * RW + i + 1], c = r[(j + 1) * RW + i], d = r[(j + 1) * RW + i + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

// Fast polygon SDF with bbox early-out per edge set.
function makePolySDF(poly) {
  return (x, z) => polySDF(x, z, poly);
}
const coastExact = makePolySDF(LAND);
function lakesExact(x, z) {
  let best = -Infinity;
  for (const k in LAKES) best = Math.max(best, polySDF(x, z, LAKES[k]));
  return best; // positive inside a lake
}

export function initGeo() {
  if (coastRaster) return;
  coastRaster = buildRaster(coastExact);
  lakeRaster = buildRaster((x, z) => {
    // cheap reject: far from any lake bbox
    return lakesExact(x, z);
  });
}

/* ------------------------- Regional character ------------------------- */
// Archipelago strength (more islands / ragged shore).
function archipelago(e, n) {
  let a = 0.25;
  // Stockholm archipelago
  a = Math.max(a, (1 - smoothstep(0, 1.6, Math.abs(n - 1.0) - 3.0)) * (1 - smoothstep(0, 1.2, Math.abs(e - 2.5) - 1.6)));
  // Bohuslän west coast
  a = Math.max(a, 0.8 * (1 - smoothstep(0, 1.5, Math.abs(n + 1.5) - 3.0)) * (1 - smoothstep(0, 1.0, Math.abs(e + 16.4) - 0.8)));
  // High coast (Höga kusten)
  a = Math.max(a, 0.7 * (1 - smoothstep(0, 1.5, Math.abs(n - 16.2) - 1.0)));
  return a;
}

const gauss = (e, n, ce, cn, s) => Math.exp(-((e - ce) ** 2 + (n - cn) ** 2) / (2 * s * s));

// Base macro elevation & hill amplitude for a location.
function region(e, n, coastKm) {
  let base = 9, amp = 14, rough = 0.5;
  // Småland highlands
  const sm = gauss(e, n, -10.5, -11.3, 2.6);
  base += 55 * sm; amp += 14 * sm;
  // Skåne: flat farmland
  const sk = smoothstep(-14.5, -16.5, n);
  amp = lerp(amp, 5, sk); base = lerp(base, 6, sk);
  // Mälardalen, Östergötland & Västergötland plains: gentle
  const plains = Math.max(gauss(e, n, -3.0, 1.0, 2.5), gauss(e, n, -8.0, -6.8, 1.6), gauss(e, n, -12.5, -5.0, 1.8));
  amp = lerp(amp, 7, plains * 0.8);
  // Norrland: rises inland from the coast, rougher
  const nf = smoothstep(2.0, 7.0, n);
  base += nf * clamp(coastKm - 0.6, 0, 22) * 16;
  amp += nf * 22; rough = lerp(rough, 0.75, nf);
  // Fjäll: Kebnekaise massif west of Kiruna, plus the Scandes along the border
  const fj = gauss(e, n, -1.5, 27.8, 3.0);
  const scandes = smoothstep(14, 24, n) * smoothstep(-2.0, -8.0, e);
  base += 520 * fj + 260 * scandes; amp += 160 * Math.max(fj, scandes); rough = lerp(rough, 1, Math.max(fj, scandes));
  // Kirunavaara (iron ore mountain) just south-west of Kiruna
  base += 110 * gauss(e, n, 3.0, 26.05, 0.35);
  return { base, amp, rough };
}

/* ------------------------- Small forest lakes ------------------------- */
const LAKE_CELL = 1300;
const lakeCache = new Map();
let lakeBlocker = null; // (x,z,r) => true if a lake may not be placed there (roads, cities)
export function setLakeBlocker(fn) { lakeBlocker = fn; lakeCache.clear(); }

function smallLakeInCell(ci, cj) {
  const key = ci * 100003 + cj;
  let v = lakeCache.get(key);
  if (v !== undefined) return v;
  v = null;
  const h = (k) => {
    let s = Math.imul(ci, 73856093) ^ Math.imul(cj, 19349663) ^ Math.imul(k, 83492791);
    s = Math.imul(s ^ (s >>> 13), 1274126177); s ^= s >>> 16;
    return (s >>> 0) / 4294967296;
  };
  const cx = (ci + 0.2 + 0.6 * h(1)) * LAKE_CELL;
  const cz = (cj + 0.2 + 0.6 * h(2)) * LAKE_CELL;
  const e = cx / 1000, n = -cz / 1000;
  // density varies by region: Småland & Norrland are full of lakes
  let p = 0.32 + 0.3 * gauss(e, n, -10.5, -11.3, 3.5) + 0.25 * smoothstep(5, 12, n);
  if (n < -14.5) p *= 0.3; // Skåne
  if (h(3) < p) {
    const R = 90 + 260 * h(4) * h(4) + 60 * h(5);
    const coast = coastSDF(cx, cz);
    if (coast > R * 2 + 300 && lakeSDF(cx, cz) < -R * 2 - 200 && cityMask(cx, cz) < 0.01 && !(lakeBlocker && lakeBlocker(cx, cz, R * 1.7 + 25))) {
      // water level: just under the lowest natural ground around the rim
      let lo = Infinity;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        lo = Math.min(lo, naturalHeight(cx + Math.cos(a) * R * 1.55, cz + Math.sin(a) * R * 1.55));
      }
      const level = lo - 0.8;
      if (level > 1.5) v = { x: cx, z: cz, R, level, seed: Math.floor(h(6) * 1e6) };
    }
  }
  lakeCache.set(key, v);
  return v;
}
export function smallLakesNear(x, z, rad) {
  const out = [];
  const i0 = Math.floor((x - rad - 800) / LAKE_CELL), i1 = Math.floor((x + rad + 800) / LAKE_CELL);
  const j0 = Math.floor((z - rad - 800) / LAKE_CELL), j1 = Math.floor((z + rad + 800) / LAKE_CELL);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const l = smallLakeInCell(i, j);
    if (l && Math.abs(l.x - x) < rad + l.R * 1.6 && Math.abs(l.z - z) < rad + l.R * 1.6) out.push(l);
  }
  return out;
}
// distance from lake center normalised by R with a wobbly shore
function lakeShapeD(l, x, z) {
  const dx = x - l.x, dz = z - l.z;
  const a = Math.atan2(dz, dx);
  const wob = 1 + 0.22 * Math.sin(a * 3 + l.seed) + 0.12 * Math.sin(a * 5 + l.seed * 1.7) + 0.08 * noiseB(x / 90, z / 90);
  return Math.hypot(dx, dz) / (l.R * wob);
}

/* --------------------------- Height functions --------------------------- */
export function coastSDF(x, z) { return coastRaster ? sampleRaster(coastRaster, x, z, coastExact) : coastExact(x, z); }
export function lakeSDF(x, z) { return lakeRaster ? sampleRaster(lakeRaster, x, z, lakesExact) : lakesExact(x, z); }

// Natural ground before any water carving (metres above sea).
export function naturalHeight(x, z) {
  const e = x / 1000, n = -z / 1000;
  const coastKm = Math.max(0, coastSDF(x, z) / 1000);
  const R = region(e, n, coastKm);
  const cm = cityMask(x, z);
  const hills = fbm(noiseA, x / 1100, z / 1100, 4) * R.amp;
  const rolling = fbm(noiseB, x / 380, z / 380, 3) * R.amp * 0.35 * R.rough;
  const knobs = Math.max(0, noiseC(x / 160, z / 160)) ** 2 * 7 * R.rough;
  let h = R.base + hills + rolling + knobs;
  if (cm > 0) {
    // towns sit on gently graded ground
    const c = nearestCity(x, z);
    if (c) {
      if (c.baseH == null) c.baseH = rawHeight(c.x, c.z);
      h = lerp(h, c.baseH + (h - c.baseH) * 0.18, cm);
    }
  }
  return Math.max(h, 1.5);
}
function rawHeight(x, z) {
  const e = x / 1000, n = -z / 1000;
  const coastKm = Math.max(0, coastSDF(x, z) / 1000);
  const R = region(e, n, coastKm);
  return R.base + fbm(noiseA, x / 1100, z / 1100, 4) * R.amp;
}
function nearestCity(x, z) {
  let best = null, bd = Infinity;
  for (const c of CITIES) {
    const d = Math.hypot(x - c.x, z - c.z) - c.r;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// Distance to "level-0 water" (sea, big lakes, flat channels). Positive on land.
export function waterDistance(x, z) {
  const e = x / 1000, n = -z / 1000;
  const cm = cityMask(x, z);
  const ar = archipelago(e, n) * (1 - 0.85 * cm);
  const coast = coastSDF(x, z);
  let d = coast;
  if (coast < 1600) {
    const nz = fbm(noiseC, x / 1500, z / 1500, 3) * 260 + fbm(noiseA, x / 330, z / 330, 3) * 120;
    d = coast + nz * (0.25 + 0.95 * ar) * (1 - 0.6 * cm);
  }
  const lk = lakeSDF(x, z);
  if (lk > -1600) {
    const nz = fbm(noiseB, x / 700, z / 700, 3) * 200 + fbm(noiseC, x / 240, z / 240, 2) * 70;
    d = Math.min(d, -(lk + nz * (1 - 0.7 * cm)));
  }
  return d;
}

// River query: returns {d, level, w, valley} for the nearest river within range or null.
export function riverAt(x, z) {
  let best = null;
  for (const r of RIVERS) {
    if (x < r.bbox[0] || z < r.bbox[1] || x > r.bbox[2] || z > r.bbox[3]) continue;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const t = segParam(x, z, a[0], a[1], b[0], b[1]);
      const px = a[0] + (b[0] - a[0]) * t, pz = a[1] + (b[1] - a[1]) * t;
      const d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) {
        const fm = lerp(r.fromMouth[i - 1], r.fromMouth[i], t);
        best = { d, level: fm * r.slope, w: r.w, valley: r.valley, river: r };
      }
    }
  }
  if (best && best.d > best.w / 2 + best.valley + 150) return null;
  return best;
}

/* Ground height including all water bodies (no roads).
   Also returns the water surface level (or -Infinity when dry) via out param. */
export const waterOut = { level: -Infinity, kind: 0 };
export function terrainWater(x, z, out = waterOut) {
  let h = naturalHeight(x, z);
  out.level = -Infinity; out.kind = 0;
  // level-0 water (sea & big lakes)
  const D = waterDistance(x, z);
  if (D < 500) {
    if (D < 0) {
      h = Math.max(0.6 + D * 0.06, -24);
      out.level = 0; out.kind = 1;
    } else {
      const shore = 0.6 + D * 0.02;
      h = lerp(shore, Math.max(h, shore), smoothstep(0, 500, D));
      if (h < 0.15) { out.level = 0; out.kind = 1; }
    }
  }
  // rivers / channels
  const rv = riverAt(x, z);
  if (rv) {
    const half = rv.w / 2;
    const bank = rv.level + 1.2;
    if (rv.valley > 0) {
      // valley floor pulled down towards the river
      const vf = 1 - smoothstep(half, half + rv.valley, rv.d);
      h = lerp(h, Math.min(h, bank + (rv.d - half) * 0.03), vf);
    }
    if (rv.d < half) {
      const bed = rv.level - 0.8 - 4.5 * (1 - (rv.d / half) ** 2);
      h = Math.min(h, bed);
      out.level = Math.max(out.level, rv.level); out.kind = out.kind || 2;
    } else if (rv.d < half + 14) {
      const t = (rv.d - half) / 14;
      h = Math.min(h, lerp(rv.level - 0.6, Math.max(bank, h), smoothstep(0, 1, t)));
    }
  }
  // small lakes with their own level
  if (h > 1.0) {
    const ls = smallLakesNear(x, z, 0);
    for (const l of ls) {
      const d = lakeShapeD(l, x, z);
      if (d > 1.6) continue;
      if (d < 1) {
        const bed = l.level - 0.7 - 7 * smoothstep(1, 0.35, d);
        h = Math.min(h, bed);
        out.level = l.level; out.kind = 3;
      } else {
        const t = smoothstep(1, 1.6, d);
        h = lerp(l.level + 0.35, Math.max(h, l.level + 0.35), t);
      }
    }
  }
  return h;
}

export function isWater(x, z) {
  const o = { level: -Infinity, kind: 0 };
  const h = terrainWater(x, z, o);
  return o.level > h + 0.05;
}

// Exposed so tests and the map view can use it.
export const debugGeo = { archipelago, region, lakeShapeD };
export { pointInPoly, distToSeg };
