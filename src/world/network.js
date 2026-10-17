/* =====================================================================
   Road network: nodes, roads, cross-sections, elevation, bridges,
   junction surfaces and fast spatial queries.

   Lateral convention: d > 0 is to the RIGHT of the road's forward
   direction (start -> end). Swedish traffic drives on the right, so
   forward lanes have d > 0 and backward lanes d < 0.
   ===================================================================== */
import { clamp, lerp, smoothstep, catmullRom, resample, segIntersect, KMH } from '../core/math.js';
import { terrainWater, naturalHeight, setLakeBlocker } from './geo.js';

export const STEP = 4; // centreline sample spacing (m)

/* ----------------------------- Road types ----------------------------- */
// prio: elevation/importance order (lower = more important, built first).
export const ROAD_TYPES = {
  motorway:   { prio: 0, limited: true, laneW: 3.5, lanes: [2, 2], divider: 'median', medianW: 2.6, innerShoulder: 0.8, shoulder: 2.2, verge: 1.2, crown: 0.025, smooth: 120, grade: 0.04, speed: 110, surface: 'asphalt', edge: 'solid', laneLine: 'motorway', clearance: 9 },
  expressway: { prio: 1, limited: true, laneW: 3.25, lanes: [2, 1], divider: 'cable', medianW: 1.0, innerShoulder: 0, shoulder: 0.75, verge: 1.0, crown: 0.025, smooth: 90, grade: 0.055, speed: 100, surface: 'asphalt', edge: 'dashed', laneLine: 'dashed', clearance: 7 },
  primary:    { prio: 2, laneW: 3.5, lanes: [1, 1], divider: 'line', shoulder: 0.75, verge: 0.9, crown: 0.025, smooth: 60, grade: 0.07, speed: 90, surface: 'asphalt', edge: 'dashed', center: 'dashed', clearance: 6 },
  ramp:       { prio: 2, laneW: 3.75, lanes: [1, 0], divider: 'none', shoulder: 1.6, shoulderL: 0.6, verge: 0.9, crown: 0.02, smooth: 40, grade: 0.06, speed: 70, surface: 'asphalt', edge: 'solid', clearance: 6, oneway: true },
  secondary:  { prio: 3, laneW: 3.25, lanes: [1, 1], divider: 'line', shoulder: 0.3, verge: 0.7, crown: 0.025, smooth: 40, grade: 0.08, speed: 80, surface: 'asphalt', edge: 'dashed', center: 'dashed', clearance: 5 },
  local:      { prio: 4, laneW: 2.8, lanes: [1, 1], divider: 'none', shoulder: 0.1, verge: 0.6, crown: 0.025, smooth: 26, grade: 0.1, speed: 70, surface: 'asphalt', edge: 'none', clearance: 4 },
  gravel:     { prio: 5, laneW: 2.3, lanes: [1, 1], divider: 'none', shoulder: 0, verge: 0.4, crown: 0.03, smooth: 14, grade: 0.13, speed: 70, surface: 'gravel', edge: 'none', clearance: 3 },
  avenue:     { prio: 2, laneW: 3.25, lanes: [2, 2], divider: 'double', medianW: 0.6, shoulder: 0.25, sidewalk: 4.2, curb: 0.14, crown: 0.02, smooth: 50, grade: 0.07, speed: 50, surface: 'asphalt', edge: 'none', laneLine: 'dashed', clearance: 5, urban: true, lights: 30 },
  street:     { prio: 3, laneW: 3.2, lanes: [1, 1], divider: 'line', parking: 2.2, shoulder: 0.1, sidewalk: 2.8, curb: 0.13, crown: 0.02, smooth: 36, grade: 0.09, speed: 50, surface: 'asphalt', edge: 'none', center: 'dashed', clearance: 4, urban: true, lights: 32 },
  oldtown:    { prio: 4, laneW: 2.9, lanes: [1, 1], divider: 'none', shoulder: 0, sidewalk: 1.7, curb: 0.12, crown: 0.02, smooth: 26, grade: 0.1, speed: 30, surface: 'cobble', edge: 'none', clearance: 4, urban: true, lights: 26 },
  residential:{ prio: 4, laneW: 2.9, lanes: [1, 1], divider: 'none', shoulder: 0.1, sidewalk: 1.9, sidewalkL: 0, curb: 0.11, crown: 0.02, smooth: 26, grade: 0.1, speed: 30, surface: 'asphalt', edge: 'none', clearance: 4, urban: true, lights: 36 },
  access:     { prio: 4, laneW: 3.4, lanes: [1, 1], divider: 'none', shoulder: 0.3, sidewalk: 2.0, sidewalkL: 0, curb: 0.12, crown: 0.02, smooth: 30, grade: 0.08, speed: 30, surface: 'asphalt', edge: 'none', clearance: 4, urban: true, lights: 34 },
  service:    { prio: 5, laneW: 3.0, lanes: [1, 1], divider: 'none', shoulder: 0.2, verge: 0.3, crown: 0.015, smooth: 20, grade: 0.1, speed: 20, surface: 'asphalt', edge: 'none', clearance: 4 },
  rest:       { prio: 3, laneW: 3.6, lanes: [1, 0], divider: 'none', shoulder: 0.8, shoulderL: 0.5, verge: 0.5, crown: 0.02, smooth: 30, grade: 0.06, speed: 50, surface: 'asphalt', edge: 'solid', clearance: 4, oneway: true },
};

/* --------------------------- Cross-sections --------------------------- */
/* Builds the lateral layout. Returns breakpoints (for meshes & physics),
   lane offsets and edges. lanesF/lanesB override the type defaults. */
export function makeXS(typeName, o = {}) {
  const T = ROAD_TYPES[typeName];
  const w = o.laneW || T.laneW;
  const lanesF = o.lanesF ?? T.lanes[0];
  const lanesB = o.lanesB ?? T.lanes[1];
  let c = 0;
  let mHalf = 0;
  const divider = o.divider || T.divider;
  if (divider === 'median') mHalf = (T.medianW || 2) / 2 + (T.innerShoulder || 0);
  else if (divider === 'cable') mHalf = (T.medianW || 1) / 2;
  else if (divider === 'double') mHalf = (T.medianW || 0.5) / 2;
  if (typeName === 'expressway') c = lanesF > lanesB ? -w / 2 : lanesF < lanesB ? w / 2 : 0;
  const oneway = lanesB === 0;
  if (oneway) c = -(lanesF * w) / 2; // centre the single carriageway on the centreline
  const parkR = o.parkingR ?? (T.parking || 0);
  const parkL = oneway ? 0 : o.parkingL ?? (T.parking || 0);
  const shR = T.shoulder || 0;
  const shL = T.shoulderL ?? T.shoulder ?? 0;
  const lanesOffF = [], lanesOffB = [];
  for (let k = 0; k < lanesF; k++) lanesOffF.push(c + mHalf + (k + 0.5) * w);
  for (let k = 0; k < lanesB; k++) lanesOffB.push(c - mHalf - (k + 0.5) * w);
  const travelR = c + mHalf + lanesF * w;
  const travelL = c - mHalf - lanesB * w;
  const edgeR = travelR + parkR + shR;
  const edgeL = travelL - parkL - shL;
  const swR = o.sidewalkR ?? (T.sidewalk || 0);
  const swL = oneway ? 0 : o.sidewalkL ?? (T.sidewalkL ?? T.sidewalk ?? 0);
  const verge = T.verge || 0;
  const curb = T.curb || 0;
  const outerR = edgeR + (swR > 0 ? swR : verge);
  const outerL = edgeL - (swL > 0 ? swL : verge);
  const xs = {
    type: typeName, T, w, lanesF, lanesB, c, mHalf, divider, oneway,
    lanesOffF, lanesOffB, travelR, travelL, edgeR, edgeL, outerR, outerL, swR, swL, verge, curb,
    parkR, parkL, surface: o.surface || T.surface, crown: T.crown,
    halfW: Math.max(outerR, -outerL),
  };
  // breakpoints across the section, left to right: {d, zone, dy}  (dy = extra vertical offset)
  const bp = [];
  if (swL > 0) {
    bp.push({ d: outerL, zone: 'sidewalk', dy: curb - 0.02, outer: true });
    bp.push({ d: edgeL, zone: 'sidewalk', dy: curb });
    bp.push({ d: edgeL, zone: 'road', dy: 0, curbFace: true });
  } else if (verge > 0) {
    bp.push({ d: outerL, zone: 'verge', dy: -0.06, outer: true });
    bp.push({ d: edgeL, zone: 'road', dy: 0 });
  } else bp.push({ d: edgeL, zone: 'road', dy: 0, outer: true });
  // crown peak or median
  if (divider === 'median') {
    bp.push({ d: c - mHalf, zone: 'road', dy: 0 });
    bp.push({ d: c - mHalf + 0.001, zone: 'median', dy: 0.0 });
    bp.push({ d: c + mHalf - 0.001, zone: 'median', dy: 0.0 });
    bp.push({ d: c + mHalf, zone: 'road', dy: 0 });
  } else if (!oneway) {
    bp.push({ d: c, zone: 'road', dy: 0 });
  }
  if (swR > 0) {
    bp.push({ d: edgeR, zone: 'road', dy: 0 });
    bp.push({ d: edgeR, zone: 'sidewalk', dy: curb, curbFace: true });
    bp.push({ d: outerR, zone: 'sidewalk', dy: curb - 0.02, outer: true });
  } else if (verge > 0) {
    bp.push({ d: edgeR, zone: 'road', dy: 0 });
    bp.push({ d: outerR, zone: 'verge', dy: -0.06, outer: true });
  } else bp.push({ d: edgeR, zone: 'road', dy: 0, outer: true });
  xs.bp = bp;
  return xs;
}

// Height offset of the surface at lateral d (piecewise linear between breakpoints).
export function xsOffset(xs, bank, d) {
  // crown profile
  let crownY;
  const ad = Math.abs(d - xs.c);
  if (xs.divider === 'median') crownY = ad > xs.mHalf ? -xs.crown * (ad - xs.mHalf) : 0;
  else if (xs.oneway) crownY = -xs.crown * 0.8 * (d - xs.edgeL);
  else crownY = -xs.crown * ad;
  const wb = smoothstep(0.006, 0.022, Math.abs(bank));
  let y = lerp(crownY, -bank * (d - xs.c), wb);
  // zone offsets
  if (d < xs.edgeL) {
    const t = (xs.edgeL - d) / Math.max(1e-3, xs.edgeL - xs.outerL);
    y = surfaceAtEdge(xs, bank, xs.edgeL) + (xs.swL > 0 ? xs.curb - 0.02 * t : -0.06 * t);
  } else if (d > xs.edgeR) {
    const t = (d - xs.edgeR) / Math.max(1e-3, xs.outerR - xs.edgeR);
    y = surfaceAtEdge(xs, bank, xs.edgeR) + (xs.swR > 0 ? xs.curb - 0.02 * t : -0.06 * t);
  }
  return y;
}
export function xsBase(xs, bank, d) { return surfaceAtEdge(xs, bank, d < xs.edgeL ? xs.edgeL : d > xs.edgeR ? xs.edgeR : d); }
function surfaceAtEdge(xs, bank, d) {
  let crownY;
  const ad = Math.abs(d - xs.c);
  if (xs.divider === 'median') crownY = ad > xs.mHalf ? -xs.crown * (ad - xs.mHalf) : 0;
  else if (xs.oneway) crownY = -xs.crown * 0.8 * (d - xs.edgeL);
  else crownY = -xs.crown * ad;
  const wb = smoothstep(0.006, 0.022, Math.abs(bank));
  return lerp(crownY, -bank * (d - xs.c), wb);
}
export function zoneAt(xs, d) {
  if (d < xs.edgeL) return xs.swL > 0 ? 'sidewalk' : 'verge';
  if (d > xs.edgeR) return xs.swR > 0 ? 'sidewalk' : 'verge';
  if (xs.divider === 'median' && Math.abs(d - xs.c) < xs.mHalf - (xs.T.innerShoulder || 0)) return 'median';
  return 'road';
}

/* ------------------------------ Classes ------------------------------ */
let NODE_ID = 0, ROAD_ID = 0;

export class Node {
  constructor(x, z, props = {}) {
    this.id = NODE_ID++;
    this.x = x; this.z = z; this.y = 0;
    this.fixedY = props.y != null;
    if (this.fixedY) this.y = props.y;
    this.kind = props.kind || null; // junction | continuation | roundabout | split | deadend
    this.control = props.control || null; // priority | signal | rhr | null
    this.name = props.name || null;
    this.roundabout = props.roundabout || null; // {r: outer radius, island}
    this.split = props.split || null; // {through: [roadIn, roadOut]}
    this.ends = [];
    this.connectors = [];
    this.setbacks = new Map();
    this.patch = null;
    this.city = props.city || null;
    this.crossings = props.crossings ?? null;
    this.tags = props.tags || {};
  }
}

export class Road {
  constructor(a, b, type, props = {}) {
    this.id = ROAD_ID++;
    this.a = a; this.b = b;
    this.type = type;
    this.T = ROAD_TYPES[type];
    this.prio = this.T.prio;
    this.ref = props.ref || null; // road number, e.g. "E4", "40", "263"
    this.name = props.name || null;
    this.route = props.route || null; // chain id for continuous elevation
    this.speed = props.speed || this.T.speed; // km/h
    this.ctrl = props.ctrl || null; // control points [[x,z]...] including ends
    this.xs = makeXS(type, props.xs || {});
    this.city = props.city || null;
    this.district = props.district || null;
    this.dest = props.dest || null; // {fwd: 'Uppsala', bwd: 'Stockholm'} for signs
    this.tags = props.tags || {};
    this.lanePathsF = []; this.lanePathsB = [];
    this.trimA = 0; this.trimB = 0;
  }
  get lanesF() { return this.xs.lanesF; }
  get lanesB() { return this.xs.lanesB; }
  otherNode(n) { return n === this.a ? this.b : this.a; }
}

/* ------------------------------ Network ------------------------------ */
export class Network {
  constructor() {
    this.nodes = [];
    this.roads = [];
    this.grid = new Map(); // spatial index cell -> encoded segments
    this.cell = 32;
    this.patchGrid = new Map();
    this.patchTris = []; // flat triangles for physics
    this.crossings = [];
  }
  addNode(x, z, props) {
    const n = new Node(x, z, props);
    this.nodes.push(n);
    return n;
  }
  addRoad(a, b, type, props = {}) {
    const r = new Road(a, b, type, props);
    if (!r.ctrl) r.ctrl = [[a.x, a.z], [b.x, b.z]];
    this.roads.push(r);
    a.ends.push({ road: r, atStart: true });
    b.ends.push({ road: r, atStart: false });
    return r;
  }
  removeRoad(r) {
    const i = this.roads.indexOf(r);
    if (i >= 0) this.roads.splice(i, 1);
    r.a.ends = r.a.ends.filter((e) => e.road !== r);
    r.b.ends = r.b.ends.filter((e) => e.road !== r);
  }

  /* --------------------------- Geometry --------------------------- */
  densify(r) {
    let pts = r.ctrl.length > 2 ? catmullRom(r.ctrl, STEP * 0.5) : r.ctrl;
    pts = resample(pts, STEP);
    if (pts.length < 2) pts = [r.ctrl[0], r.ctrl[r.ctrl.length - 1]];
    const n = pts.length;
    r.n = n;
    r.X = new Float64Array(n); r.Z = new Float64Array(n); r.Y = new Float32Array(n);
    r.S = new Float64Array(n); r.TX = new Float32Array(n); r.TZ = new Float32Array(n);
    r.K = new Float32Array(n); r.BANK = new Float32Array(n);
    r.bridge = new Uint8Array(n); // per segment i..i+1
    for (let i = 0; i < n; i++) { r.X[i] = pts[i][0]; r.Z[i] = pts[i][1]; }
    for (let i = 1; i < n; i++) r.S[i] = r.S[i - 1] + Math.hypot(r.X[i] - r.X[i - 1], r.Z[i] - r.Z[i - 1]);
    r.len = r.S[n - 1];
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let tx = r.X[i1] - r.X[i0], tz = r.Z[i1] - r.Z[i0];
      const l = Math.hypot(tx, tz) || 1;
      r.TX[i] = tx / l; r.TZ[i] = tz / l;
    }
    // curvature (signed, + = right turn) smoothed
    const kraw = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) {
      const ax = r.TX[i - 1], az = r.TZ[i - 1], bx = r.TX[i + 1], bz = r.TZ[i + 1];
      const cr = ax * bz - az * bx;
      const ds = Math.max(0.5, r.S[i + 1] - r.S[i - 1]);
      kraw[i] = Math.asin(clamp(cr, -1, 1)) / ds;
    }
    boxSmooth(kraw, r.K, 6);
    const vd = (r.speed * KMH) * 1.05;
    for (let i = 0; i < n; i++) {
      if (r.T.urban || r.type === 'gravel') { r.BANK[i] = 0; continue; }
      r.BANK[i] = clamp(0.55 * vd * vd * r.K[i] / 9.81, -0.06, 0.06);
    }
  }

  // Index segments of all roads in the plan grid (used for lakes, crossings, corridors, physics).
  buildIndex() {
    this.grid.clear();
    const C = this.cell;
    this.roads.forEach((r, ri) => {
      r.idx = ri;
      const pad = r.xs.halfW + 82;
      for (let i = 0; i < r.n - 1; i++) {
        const x0 = Math.min(r.X[i], r.X[i + 1]) - pad, x1 = Math.max(r.X[i], r.X[i + 1]) + pad;
        const z0 = Math.min(r.Z[i], r.Z[i + 1]) - pad, z1 = Math.max(r.Z[i], r.Z[i + 1]) + pad;
        const enc = ri * 65536 + i;
        for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++)
          for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
            const k = cx * 1000003 + cz;
            let a = this.grid.get(k);
            if (!a) { a = []; this.grid.set(k, a); }
            a.push(enc);
          }
      }
    });
  }
  cellList(x, z) { return this.grid.get(Math.floor(x / this.cell) * 1000003 + Math.floor(z / this.cell)); }

  // Plan-view distance from (x,z) to the nearest road centreline minus half width.
  nearestRoadClearance(x, z) {
    const list = this.cellList(x, z);
    if (!list) return Infinity;
    let best = Infinity;
    for (const enc of list) {
      const r = this.roads[(enc / 65536) | 0], i = enc & 65535;
      const d = pointSegDist(x, z, r.X[i], r.Z[i], r.X[i + 1], r.Z[i + 1]) - r.xs.halfW;
      if (d < best) best = d;
    }
    return best;
  }

  /* --------------------------- Finalize --------------------------- */
  finalize(log = () => {}) {
    // drop degenerate roads
    for (const r of this.roads.slice()) if (r.a === r.b) this.removeRoad(r);
    this.nodes = this.nodes.filter((n) => n.ends.length > 0);
    for (const r of this.roads) this.densify(r);
    this.computeEnds();
    this.buildIndex();
    log('index');
    // Lakes must stay clear of roads.
    setLakeBlocker((x, z, rad) => {
      const C = this.cell;
      for (let cx = Math.floor((x - rad) / C); cx <= Math.floor((x + rad) / C); cx += 2)
        for (let cz = Math.floor((z - rad) / C); cz <= Math.floor((z + rad) / C); cz += 2) {
          const l = this.grid.get(cx * 1000003 + cz);
          if (l && l.length) {
            for (const enc of l) {
              const r = this.roads[(enc / 65536) | 0], i = enc & 65535;
              if (pointSegDist(x, z, r.X[i], r.Z[i], r.X[i + 1], r.Z[i + 1]) < rad + r.xs.halfW) return true;
            }
          }
        }
      return false;
    });
    this.findCrossings();
    log('crossings');
    this.solveElevation();
    log('elevation');
    this.computeSetbacks();
    this.buildPatches();
    this.buildPatchIndex();
    log('junctions');
  }

  computeEnds() {
    for (const n of this.nodes) {
      for (const e of n.ends) {
        const r = e.road;
        let ux, uz, px, pz;
        if (e.atStart) { ux = r.TX[0]; uz = r.TZ[0]; px = r.X[0]; pz = r.Z[0]; }
        else { ux = -r.TX[r.n - 1]; uz = -r.TZ[r.n - 1]; px = r.X[r.n - 1]; pz = r.Z[r.n - 1]; }
        e.ux = ux; e.uz = uz; e.px = px; e.pz = pz;
        e.angle = Math.atan2(-uz, ux);
      }
      n.ends.sort((a, b) => a.angle - b.angle);
      if (!n.kind) {
        if (n.ends.length === 1) n.kind = 'deadend';
        else if (n.ends.length === 2) {
          const [a, b] = n.ends;
          const dot = a.ux * b.ux + a.uz * b.uz;
          n.kind = dot < -0.5 ? 'continuation' : 'junction';
          if (n.kind === 'junction' && a.road.T.urban !== true) n.kind = 'continuation';
        } else n.kind = 'junction';
      }
    }
  }

  // Grade-separated crossings: roads crossing without sharing a node.
  findCrossings() {
    const seen = new Set();
    const C = this.cell;
    const tight = new Map();
    this.roads.forEach((r, ri) => {
      for (let i = 0; i < r.n - 1; i++) {
        const x0 = Math.min(r.X[i], r.X[i + 1]), x1 = Math.max(r.X[i], r.X[i + 1]);
        const z0 = Math.min(r.Z[i], r.Z[i + 1]), z1 = Math.max(r.Z[i], r.Z[i + 1]);
        for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++)
          for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
            const k = cx * 1000003 + cz;
            let a = tight.get(k);
            if (!a) { a = []; tight.set(k, a); }
            a.push(ri * 65536 + i);
          }
      }
    });
    for (const [k, list] of tight) {
      if (list.length < 2) continue;
      for (let a = 0; a < list.length; a++) {
        const ra = this.roads[(list[a] / 65536) | 0], ia = list[a] & 65535;
        for (let b = a + 1; b < list.length; b++) {
          const rb = this.roads[(list[b] / 65536) | 0], ib = list[b] & 65535;
          if (ra === rb) continue;
          const sh = sharedNode(ra, rb);
          const hit = segIntersect(ra.X[ia], ra.Z[ia], ra.X[ia + 1], ra.Z[ia + 1], rb.X[ib], rb.Z[ib], rb.X[ib + 1], rb.Z[ib + 1]);
          if (!hit) continue;
          const sa = ra.S[ia] + hit.t * (ra.S[ia + 1] - ra.S[ia]);
          const sb = rb.S[ib] + hit.u * (rb.S[ib + 1] - rb.S[ib]);
          if (sh) {
            // near the shared node it's just the junction itself
            const da = sh === ra.a ? sa : ra.len - sa, db = sh === rb.a ? sb : rb.len - sb;
            if (da < 40 || db < 40) continue;
          }
          const key = ra.id < rb.id ? ra.id + ':' + rb.id + ':' + Math.round(sa / 20) : rb.id + ':' + ra.id + ':' + Math.round(sb / 20);
          if (seen.has(key)) continue;
          seen.add(key);
          // over = less important road (larger prio), ties -> larger id
          let over = ra, under = rb, so = sa, su = sb;
          if (rb.prio > ra.prio || (rb.prio === ra.prio && rb.id > ra.id)) { over = rb; under = ra; so = sb; su = sa; }
          const cosA = Math.abs(ra.TX[ia] * rb.TX[ib] + ra.TZ[ia] * rb.TZ[ib]);
          const sinA = Math.sqrt(Math.max(0.06, 1 - cosA * cosA));
          const span = (under.xs.halfW + 9) / sinA;
          this.crossings.push({ over, under, so, su, cosA, span, x: lerp(ra.X[ia], ra.X[ia + 1], hit.t), z: lerp(ra.Z[ia], ra.Z[ia + 1], hit.t) });
        }
      }
    }
    for (const c of this.crossings) {
      (c.over.crossOver ||= []).push(c);
      (c.under.crossUnder ||= []).push(c);
    }
  }

  /* -------------------------- Elevation -------------------------- */
  buildChains() {
    // link road ends through nodes where exactly two ends share the same route id,
    // or continuation nodes, or split "through" pairs.
    const link = new Map(); // key road.id+':a|b' -> {road, atStart}
    const key = (r, atStart) => r.id + (atStart ? ':a' : ':b');
    for (const n of this.nodes) {
      let pairs = [];
      if (n.kind === 'continuation' && n.ends.length === 2) pairs.push([n.ends[0], n.ends[1]]);
      else if (n.kind === 'split' && n.split) {
        const [ri, ro] = n.split.through;
        const ei = n.ends.find((e) => e.road === ri), eo = n.ends.find((e) => e.road === ro);
        if (ei && eo) pairs.push([ei, eo]);
      } else if (n.kind === 'junction') {
        const byRoute = new Map();
        for (const e of n.ends) if (e.road.route) { const l = byRoute.get(e.road.route) || []; l.push(e); byRoute.set(e.road.route, l); }
        for (const l of byRoute.values()) if (l.length === 2) pairs.push(l);
      }
      for (const [e1, e2] of pairs) {
        link.set(key(e1.road, e1.atStart), e2);
        link.set(key(e2.road, e2.atStart), e1);
      }
    }
    const used = new Set();
    const chains = [];
    for (const r of this.roads) {
      if (used.has(r)) continue;
      // walk backwards to the chain start
      let cur = r, curAtStartIsEntry = true; // we enter cur at its start
      const guard = new Set([r]);
      for (;;) {
        const prev = link.get(key(cur, curAtStartIsEntry));
        if (!prev || guard.has(prev.road) || used.has(prev.road)) break;
        guard.add(prev.road);
        cur = prev.road;
        curAtStartIsEntry = !prev.atStart; // we arrive at prev end; entry is the other end
      }
      // walk forward
      const seq = [];
      let atStartEntry = curAtStartIsEntry;
      for (;;) {
        seq.push({ road: cur, rev: !atStartEntry });
        used.add(cur);
        const nxt = link.get(key(cur, !atStartEntry));
        if (!nxt || used.has(nxt.road)) break;
        cur = nxt.road;
        atStartEntry = nxt.atStart;
      }
      let prio = 99;
      for (const s of seq) prio = Math.min(prio, s.road.prio);
      chains.push({ seq, prio });
    }
    chains.sort((a, b) => a.prio - b.prio || a.seq[0].road.id - b.seq[0].road.id);
    return chains;
  }

  solveElevation() {
    const wo = { level: -Infinity, kind: 0 };
    // Node heights for explicitly fixed nodes are kept.
    const chains = this.buildChains();
    let chainNo = 0;
    for (const ch of chains) {
      chainNo++;
      for (const sq of ch.seq) sq.road.chainNo = chainNo;
      // concatenate samples
      const xs = [], zs = [], idxMap = [];
      for (const { road, rev } of ch.seq) {
        const start = xs.length ? 1 : 0;
        for (let k = start; k < road.n; k++) {
          const i = rev ? road.n - 1 - k : k;
          xs.push(road.X[i]); zs.push(road.Z[i]); idxMap.push([road, i]);
        }
      }
      const n = xs.length;
      const T = ch.seq[0].road.T;
      const target = new Float32Array(n), nat = new Float32Array(n), lb = new Float32Array(n).fill(-1e9);
      const pinned = new Uint8Array(n), pinY = new Float32Array(n);
      const wet = new Uint8Array(n);
      let roadPrioMin = 99;
      for (const s of ch.seq) roadPrioMin = Math.min(roadPrioMin, s.road.prio);
      for (let i = 0; i < n; i++) {
        const h = terrainWater(xs[i], zs[i], wo);
        nat[i] = h;
        if (wo.level > h + 0.05) {
          wet[i] = 1;
          const clr = Math.min(T.clearance + 4, wo.kind === 1 ? T.clearance + 3 : wo.kind === 2 ? T.clearance : 3.2);
          target[i] = wo.level + clr;
          lb[i] = wo.level + Math.max(2.6, clr * 0.6);
        } else target[i] = Math.max(h, (wo.level > -1e8 ? wo.level : -1e9) + 1.0);
      }
      // pins at nodes already fixed (by earlier chains or explicit)
      const pinAt = (i, y) => { pinned[i] = 1; pinY[i] = y; };
      let sAcc = 0;
      const sArr = new Float32Array(n);
      for (let i = 1; i < n; i++) { sAcc += Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]); sArr[i] = sAcc; }
      // nodes along chain
      const nodeIdx = [];
      {
        let off = 0;
        for (let q = 0; q < ch.seq.length; q++) {
          const { road, rev } = ch.seq[q];
          const startNode = rev ? road.b : road.a, endNode = rev ? road.a : road.b;
          if (q === 0) nodeIdx.push([startNode, 0, road, !rev]);
          off += road.n - 1;
          nodeIdx.push([endNode, off, road, rev]);
        }
      }
      for (const [node, i, road, atStartOfRoad] of nodeIdx) {
        if (node.fixedY) pinAt(i, node.y);
        else if (node.kind === 'split' && node.split && !node.split.through.includes(road)) {
          // ramp attached to a through road: match that road's surface
          const thr = node.split.through[0];
          if (thr.elevDone) {
            const y = this.surfaceOnRoad(thr, xs[i], zs[i]);
            if (y != null) pinAt(i, y);
          }
        }
      }
      // grade separation: lower bounds when passing over, upper bounds when passing under
      const ub = new Float32Array(n).fill(1e9);
      for (const { road, rev } of ch.seq) {
        const base = this.chainOffsetOf(ch, road);
        const toChain = (k) => base + (rev ? road.n - 1 - k : k);
        if (road.crossOver) for (const c of road.crossOver) {
          if (!c.under.elevDone) continue;
          const req = c.under.yAtS(c.su) + Math.max(6.6, c.under.T.clearance || 6.6);
          for (let k = 0; k < road.n; k++) if (road.tags.flatOver || Math.abs(road.S[k] - c.so) <= c.span) {
            const ci = toChain(k); lb[ci] = Math.max(lb[ci], req);
          }
        }
        if (road.crossUnder) for (const c of road.crossUnder) {
          if (!c.over.elevDone) continue;
          const lim = c.over.yAtS(c.so) - Math.max(6.6, road.T.clearance || 6.6);
          const half = (c.over.xs.halfW + 12);
          for (let k = 0; k < road.n; k++) if (Math.abs(road.S[k] - c.su) <= half) {
            const ci = toChain(k); ub[ci] = Math.min(ub[ci], lim);
          }
        }
      }
      // 1) smooth target
      const win = Math.max(1, Math.round(T.smooth / STEP / 2));
      let y = new Float32Array(n);
      gaussSmooth(target, y, win);
      // keep above water mins
      for (let i = 0; i < n; i++) { if (y[i] < lb[i]) y[i] = lb[i]; if (y[i] > ub[i]) y[i] = ub[i]; }
      // 2) correction field from pins (relaxation with decay)
      const corr = new Float32Array(n);
      let anyPin = false;
      for (let i = 0; i < n; i++) if (pinned[i]) { corr[i] = pinY[i] - y[i]; anyPin = true; }
      if (anyPin) {
        const tmp = new Float32Array(n);
        const iters = 60;
        const r = Math.max(2, Math.round(Math.max(40, T.smooth) / STEP / 3));
        for (let it = 0; it < iters; it++) {
          boxSmooth(corr, tmp, r);
          for (let i = 0; i < n; i++) corr[i] = pinned[i] ? pinY[i] - y[i] : tmp[i] * 0.985;
        }
        for (let i = 0; i < n; i++) y[i] += corr[i];
      }
      // 3) grade limit with hard pins & lower bounds
      const g = T.grade;
      const gradePasses = (count) => { for (let pass = 0; pass < count; pass++) {
        for (let i = 1; i < n; i++) {
          if (pinned[i]) { y[i] = pinY[i]; continue; }
          const ds = sArr[i] - sArr[i - 1];
          y[i] = clamp(y[i], y[i - 1] - g * ds, y[i - 1] + g * ds);
          if (y[i] < lb[i]) y[i] = lb[i];
          if (y[i] > ub[i]) y[i] = ub[i];
        }
        for (let i = n - 2; i >= 0; i--) {
          if (pinned[i]) { y[i] = pinY[i]; continue; }
          const ds = sArr[i + 1] - sArr[i];
          y[i] = clamp(y[i], y[i + 1] - g * ds, y[i + 1] + g * ds);
          if (y[i] < lb[i]) y[i] = lb[i];
          if (y[i] > ub[i]) y[i] = ub[i];
        }
      } };
      gradePasses(3);
      // 4) light final smoothing keeping pins, then repair grades next to pins
      {
        const tmp = new Float32Array(n);
        for (let it = 0; it < 2; it++) {
          boxSmooth(y, tmp, 2);
          for (let i = 0; i < n; i++) y[i] = pinned[i] ? pinY[i] : Math.min(Math.max(tmp[i], lb[i]), ub[i]);
        }
      }
      gradePasses(2);
      // 5) infeasible pin pairs: spread the climb evenly between them
      {
        let prev = -1;
        for (let i = 0; i < n; i++) {
          if (!pinned[i] && i !== n - 1) continue;
          if (prev >= 0 && i - prev > 1 && (pinned[i] || i === n - 1)) {
            let maxG = 0;
            for (let k = prev; k < i; k++) maxG = Math.max(maxG, Math.abs(y[k + 1] - y[k]) / Math.max(0.5, sArr[k + 1] - sArr[k]));
            if (maxG > g * 1.35 && pinned[i]) {
              const s0 = sArr[prev], s1 = sArr[i];
              for (let k = prev + 1; k < i; k++) {
                const t = (sArr[k] - s0) / Math.max(1e-6, s1 - s0);
                y[k] = Math.max(lerp(y[prev], y[i], t), Math.min(lb[k], y[k]));
              }
            }
          }
          if (pinned[i]) prev = i;
        }
      }
      // write back (every road, including joint samples shared by two roads)
      for (const { road, rev } of ch.seq) {
        const base = this.chainOffsetOf(ch, road);
        for (let k = 0; k < road.n; k++) road.Y[rev ? road.n - 1 - k : k] = y[base + k];
      }
      for (const [node, i] of nodeIdx) {
        if (!node.fixedY) { node.y = y[i]; node.fixedY = true; node.fixedBy = chainNo; }
      }
      for (const { road } of ch.seq) road.elevDone = true;
      // bridges
      for (const { road, rev } of ch.seq) {
        const base = this.chainOffsetOf(ch, road);
        for (let k = 0; k < road.n - 1; k++) {
          const ci = base + (rev ? road.n - 1 - k : k);
          const cj = base + (rev ? road.n - 2 - k : k + 1);
          if ((wet[ci] || wet[cj]) || ((y[ci] - nat[ci] > 9 && y[cj] - nat[cj] > 9) && road.prio <= 3)) road.bridge[k] = 1;
        }
        if (road.crossOver) for (const c of road.crossOver) {
          for (let k = 0; k < road.n - 1; k++) {
            const sm = (road.S[k] + road.S[k + 1]) / 2;
            if (Math.abs(sm - c.so) < c.span - 2) road.bridge[k] = 2;
          }
        }
        // extend bridges a little onto land for abutments; drop tiny gaps
        const br = road.bridge;
        const ext = new Uint8Array(br);
        for (let k = 0; k < road.n - 1; k++) if (br[k]) {
          for (let q = 1; q <= 2; q++) { if (k - q >= 0 && !ext[k - q]) ext[k - q] = br[k]; if (k + q < road.n - 1 && !ext[k + q]) ext[k + q] = br[k]; }
        }
        road.bridge = ext;
        road.spans = [];
        let k0 = -1;
        for (let k = 0; k <= road.n - 1; k++) {
          const on = k < road.n - 1 && road.bridge[k];
          if (on && k0 < 0) k0 = k;
          if (!on && k0 >= 0) { road.spans.push([road.S[k0], road.S[k], road.bridge[k0]]); k0 = -1; }
        }
      }
    }
  }

  chainOffsetOf(ch, road) {
    // index in the concatenated chain where this road's k=0 (in chain order) sits
    let off = 0;
    for (const s of ch.seq) {
      if (s.road === road) return off;
      off += s.road.n - 1;
    }
    return 0;
  }

  /* --------------------------- Setbacks --------------------------- */
  computeSetbacks() {
    for (const n of this.nodes) {
      const E = n.ends;
      for (const e of E) n.setbacks.set(e, 0);
      if (n.kind === 'roundabout') {
        const R = n.roundabout.r;
        for (const e of E) n.setbacks.set(e, R + 4);
      } else if (n.kind === 'junction' && E.length >= 2) {
        for (let i = 0; i < E.length; i++) {
          const e = E[i];
          let sb = 0;
          for (const j of [(i + 1) % E.length, (i - 1 + E.length) % E.length]) {
            if (j === i) continue;
            const f = E[j];
            let dot = e.ux * f.ux + e.uz * f.uz;
            dot = clamp(dot, -1, 1);
            const th = Math.acos(dot);
            const a = halfWidthSide(e, i < j), b = halfWidthSide(f, i > j);
            let d;
            if (th > 2.6) d = 0;
            else d = (b + a * Math.cos(th)) / Math.max(0.2, Math.sin(th));
            sb = Math.max(sb, d);
          }
          const margin = e.road.T.urban ? 5 : 9;
          sb = clamp(sb + margin, 4, 45);
          n.setbacks.set(e, Math.min(sb, e.road.len * 0.45));
        }
      } else if (n.kind === 'continuation' && E.length === 2) {
        const [a, b] = E;
        if (a.road.type !== b.road.type || a.road.xs.lanesF !== b.road.xs.lanesF) {
          // tidy transition between different sections
          n.setbacks.set(a, Math.min(3, a.road.len * 0.3));
          n.setbacks.set(b, Math.min(3, b.road.len * 0.3));
          n.transition = true;
        }
      }
      for (const e of E) {
        const sb = n.setbacks.get(e);
        if (e.atStart) e.road.trimA = sb; else e.road.trimB = sb;
      }
    }
  }

  /* --------------------------- Patches --------------------------- */
  // Cross-section point at road-local s and lateral d.
  pointAt(r, s, d) {
    const i = sIndex(r, s);
    const t = (s - r.S[i]) / Math.max(1e-6, r.S[i + 1] - r.S[i]);
    const x = lerp(r.X[i], r.X[i + 1], t), z = lerp(r.Z[i], r.Z[i + 1], t);
    const tx = lerp(r.TX[i], r.TX[i + 1], t), tz = lerp(r.TZ[i], r.TZ[i + 1], t);
    const l = Math.hypot(tx, tz) || 1;
    const nx = -tz / l, nz = tx / l;
    const yc = lerp(r.Y[i], r.Y[i + 1], t);
    const bank = lerp(r.BANK[i], r.BANK[i + 1], t);
    return [x + nx * d, yc + xsOffset(r.xs, bank, d), z + nz * d];
  }
  yAtS(r, s) {
    const i = sIndex(r, s);
    const t = (s - r.S[i]) / Math.max(1e-6, r.S[i + 1] - r.S[i]);
    return lerp(r.Y[i], r.Y[i + 1], t);
  }

  // end cross-section points at setback in node-outward frame: returns {L, R, SL, SR, C}
  endSection(e, sb) {
    const r = e.road;
    const s = e.atStart ? sb : r.len - sb;
    const xs = r.xs;
    // outward-left corresponds to road's left (d<0) when atStart, right (d>0) when at end
    const dL = e.atStart ? xs.edgeL : xs.edgeR;
    const dR = e.atStart ? xs.edgeR : xs.edgeL;
    const swLw = e.atStart ? xs.swL : xs.swR, swRw = e.atStart ? xs.swR : xs.swL;
    const oL = e.atStart ? xs.outerL : xs.outerR, oR = e.atStart ? xs.outerR : xs.outerL;
    return {
      s, L: this.pointAt(r, s, dL), R: this.pointAt(r, s, dR),
      SL: swLw > 0 ? this.pointAt(r, s, oL) : null, SR: swRw > 0 ? this.pointAt(r, s, oR) : null,
      C: this.pointAt(r, s, xs.c),
      swL: swLw, swR: swRw, curb: xs.curb,
    };
  }

  buildPatches() {
    for (const n of this.nodes) {
      if (n.kind === 'junction' && n.ends.length >= 2) this.junctionPatch(n);
      else if (n.kind === 'roundabout') this.roundaboutPatch(n);
      else if (n.kind === 'continuation' && n.transition) this.junctionPatch(n);
      else if (n.kind === 'deadend' && n.ends[0].road.T.urban) this.culdesacPatch(n);
    }
  }

  junctionPatch(n) {
    const E = n.ends;
    const secs = E.map((e) => this.endSection(e, n.setbacks.get(e)));
    const boundary = []; // [x,y,z]
    const corners = [];
    for (let k = 0; k < E.length; k++) {
      const a = secs[k], b = secs[(k + 1) % E.length];
      const ea = E[k], eb = E[(k + 1) % E.length];
      boundary.push(a.R, a.L);
      if (E.length === 2 && k === 1) { /* closing edge for transitions */ }
      // fillet from a.L (going back along -u_a) to b.R (coming along -u_b)
      const fil = fillet(a.L, [-ea.ux, -ea.uz], b.R, [-eb.ux, -eb.uz], 8);
      for (const p of fil) boundary.push(p);
      if (a.SL && b.SR && E.length > 2) {
        const outer = fillet(a.SL, [-ea.ux, -ea.uz], b.SR, [-eb.ux, -eb.uz], 8);
        corners.push({ inner: [a.L, ...fil, b.R], outer: [a.SL, ...outer, b.SR], curb: Math.max(a.curb, b.curb) });
      }
    }
    const center = [n.x, n.y, n.z];
    n.patch = { boundary, center, corners, kind: 'junction' };
  }

  roundaboutPatch(n) {
    const R = n.roundabout.r;
    const Ri = n.roundabout.island ?? Math.max(4, R - 8);
    n.roundabout.island = Ri;
    n.roundabout.laneR = (R + Ri) / 2 + 0.4;
    const E = n.ends;
    const secs = E.map((e) => this.endSection(e, n.setbacks.get(e)));
    const boundary = [];
    const ang = (p) => Math.atan2(p[2] - n.z, p[0] - n.x);
    const corners = [];
    for (let k = 0; k < E.length; k++) {
      const a = secs[k], b = secs[(k + 1) % E.length];
      boundary.push(a.R, a.L);
      // arc on the outer circle from a.L angle to b.R angle (increasing angle in atan2(z,x) is clockwise on map)
      let a0 = ang(a.L), a1 = ang(b.R);
      // we walk the boundary in map-CCW order: atan2(dz, dx) decreases for map-CCW
      while (a1 > a0) a1 -= Math.PI * 2;
      const steps = Math.max(2, Math.ceil(((a0 - a1) * R) / 3));
      for (let q = 1; q < steps; q++) {
        const t = q / steps;
        const aa = lerp(a0, a1, t);
        const rr = R + 3.5 * Math.pow(Math.abs(Math.sin(Math.PI * t)), 0.25) * 0 + (1 - Math.sin(Math.PI * t)) * 2.5;
        boundary.push([n.x + Math.cos(aa) * rr, n.y, n.z + Math.sin(aa) * rr]);
      }
      if (a.SL && b.SR) {
        const out = [];
        const steps2 = steps;
        for (let q = 0; q <= steps2; q++) {
          const t = q / steps2;
          const aa = lerp(a0, a1, t);
          const rr = R + 3.5 + (1 - Math.sin(Math.PI * t)) * 2.5;
          out.push([n.x + Math.cos(aa) * rr, n.y, n.z + Math.sin(aa) * rr]);
        }
        const inner = [a.L];
        for (let q = 1; q < steps2; q++) {
          const t = q / steps2; const aa = lerp(a0, a1, t); const rr = R + (1 - Math.sin(Math.PI * t)) * 2.5;
          inner.push([n.x + Math.cos(aa) * rr, n.y, n.z + Math.sin(aa) * rr]);
        }
        inner.push(b.R);
        out[0] = a.SL; out[out.length - 1] = b.SR;
        corners.push({ inner, outer: out, curb: a.curb || 0.12 });
      }
    }
    n.patch = { boundary, center: [n.x, n.y, n.z], corners, kind: 'roundabout', island: Ri };
  }

  culdesacPatch(n) {
    const e = n.ends[0];
    const sec = this.endSection(e, 0);
    const r = e.road;
    const R = Math.max(7, -r.xs.edgeL + 3, r.xs.edgeR + 3);
    // bulb centred slightly beyond the end
    const cx = n.x - e.ux * (R - 2), cz = n.z - e.uz * (R - 2);
    const boundary = [sec.R, sec.L];
    const a0 = Math.atan2(sec.L[2] - cz, sec.L[0] - cx);
    let a1 = Math.atan2(sec.R[2] - cz, sec.R[0] - cx);
    while (a1 > a0) a1 -= Math.PI * 2;
    for (let q = 1; q < 16; q++) {
      const aa = lerp(a0, a1, q / 16);
      boundary.push([cx + Math.cos(aa) * R, n.y, cz + Math.sin(aa) * R]);
    }
    n.patch = { boundary, center: [cx, n.y, cz], corners: [], kind: 'culdesac', bulb: { x: cx, z: cz, R } };
  }

  buildPatchIndex() {
    this.patchTris = [];
    this.patchGrid.clear();
    const C = this.cell;
    for (const n of this.nodes) {
      if (!n.patch) continue;
      const { boundary, center } = n.patch;
      const tris = [];
      for (let k = 0; k < boundary.length; k++) {
        const a = boundary[k], b = boundary[(k + 1) % boundary.length];
        tris.push([center, a, b, 0]);
      }
      if (n.patch.kind === 'roundabout') {
        // island mound (raised) - handled as separate surface
        n.patch.islandSurf = { x: n.x, z: n.z, y: n.y, R: n.patch.island };
      }
      for (const c of n.patch.corners) {
        // sidewalk corner as strip triangles (raised)
        const L = Math.min(c.inner.length, c.outer.length);
        for (let q = 0; q < L - 1; q++) {
          const i0 = c.inner[q], i1 = c.inner[q + 1], o0 = c.outer[q], o1 = c.outer[q + 1];
          const up = (p) => [p[0], p[1] + c.curb, p[2]];
          tris.push([up(i0), up(o0), up(o1), 1], [up(i0), up(o1), up(i1), 1]);
        }
      }
      for (const t of tris) {
        const id = this.patchTris.length;
        this.patchTris.push({ a: t[0], b: t[1], c: t[2], zone: t[3] ? 'sidewalk' : 'road', node: n });
        const x0 = Math.min(t[0][0], t[1][0], t[2][0]), x1 = Math.max(t[0][0], t[1][0], t[2][0]);
        const z0 = Math.min(t[0][2], t[1][2], t[2][2]), z1 = Math.max(t[0][2], t[1][2], t[2][2]);
        for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++)
          for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
            const k = cx * 1000003 + cz;
            let l = this.patchGrid.get(k);
            if (!l) { l = []; this.patchGrid.set(k, l); }
            l.push(id);
          }
      }
      n.patch.tris = tris;
    }
  }

  /* ------------------------- Surface queries ------------------------- */
  // Surface of a specific road at (x,z) or null.
  surfaceOnRoad(r, x, z) {
    let best = null, bd = Infinity;
    for (let i = 0; i < r.n - 1; i++) {
      const d = pointSegDist(x, z, r.X[i], r.Z[i], r.X[i + 1], r.Z[i + 1]);
      if (d < bd) { bd = d; best = i; }
    }
    if (best == null) return null;
    const res = projectOnSeg(r, best, x, z);
    return r.Y[best] + (r.Y[best + 1] - r.Y[best]) * res.t + xsOffset(r.xs, lerp(r.BANK[best], r.BANK[best + 1], res.t), res.d);
  }

  /* Highest drivable surface under (x, yTop, z). Returns false if none.
     Writes into out: y, nx, ny, nz, zone, surface, road, s, d. */
  surfaceAt(x, z, yTop, out) {
    let found = false;
    let bestY = -Infinity;
    const list = this.cellList(x, z);
    if (list) {
      for (const enc of list) {
        const r = this.roads[(enc / 65536) | 0], i = enc & 65535;
        const pr = projectOnSeg(r, i, x, z);
        if (pr.t < -0.02 || pr.t > 1.02) continue;
        const xs = r.xs;
        if (pr.d < xs.outerL || pr.d > xs.outerR) continue;
        const s = r.S[i] + pr.t * (r.S[i + 1] - r.S[i]);
        if (s < r.trimA - 0.05 || s > r.len - r.trimB + 0.05) continue;
        const tt = clamp(pr.t, 0, 1);
        const bank = lerp(r.BANK[i], r.BANK[i + 1], tt);
        const off = xsOffset(xs, bank, pr.d);
        const yc = r.Y[i] + (r.Y[i + 1] - r.Y[i]) * tt;
        const y = yc + off;
        if (y > yTop + 0.6 || y <= bestY) continue;
        bestY = y; found = true;
        // normal
        const ds = Math.max(0.01, r.S[i + 1] - r.S[i]);
        const grade = (r.Y[i + 1] - r.Y[i]) / ds;
        const e = 0.05;
        const cross = (xsOffset(xs, bank, pr.d + e) - xsOffset(xs, bank, pr.d - e)) / (2 * e);
        const crossC = Math.abs(cross) > 0.5 ? 0 : cross; // ignore curb steps
        const tx = r.TX[i], tz = r.TZ[i];
        const gx = grade * tx + crossC * -tz, gz = grade * tz + crossC * tx;
        const nl = Math.hypot(gx, 1, gz);
        out.y = y; out.nx = -gx / nl; out.ny = 1 / nl; out.nz = -gz / nl;
        out.zone = zoneAt(xs, pr.d); out.surface = out.zone === 'road' ? xs.surface : out.zone;
        out.road = r; out.s = s; out.d = pr.d; out.bridge = r.bridge[i];
      }
    }
    const pl = this.patchGrid.get(Math.floor(x / this.cell) * 1000003 + Math.floor(z / this.cell));
    if (pl) {
      for (const id of pl) {
        const T = this.patchTris[id];
        const y = triHeight(T.a, T.b, T.c, x, z);
        if (y == null) continue;
        if (y > yTop + 0.6 || y <= bestY + 0.003) continue;
        bestY = y; found = true;
        const n = triNormal(T.a, T.b, T.c);
        out.y = y; out.nx = n[0]; out.ny = n[1]; out.nz = n[2];
        out.zone = T.zone; out.surface = T.zone === 'road' ? 'asphalt' : 'sidewalk';
        out.road = null; out.node = T.node; out.s = 0; out.d = 0; out.bridge = 0;
      }
    }
    return found;
  }

  /* Terrain corridor: blend natural ground (hNat) toward road heights.
     Returns the modified height. Bridges do not affect terrain. */
  corridor(x, z, hNat, info) {
    const list = this.cellList(x, z);
    if (info) info.w = 0;
    if (!list) return hNat;
    let bestW = 0, bestT = hNat, bestScore = -Infinity;
    for (const enc of list) {
      const r = this.roads[(enc / 65536) | 0], i = enc & 65535;
      if (r.bridge[i]) continue;
      const pr = projectOnSeg(r, i, x, z);
      const xs = r.xs;
      let ad;
      if (pr.t < 0) {
        if (i > 0) continue; // previous segment covers it
        ad = Math.hypot(x - r.X[0], z - r.Z[0]); pr.t = 0;
      } else if (pr.t > 1) {
        if (i < r.n - 2) continue;
        ad = Math.hypot(x - r.X[i + 1], z - r.Z[i + 1]); pr.t = 1;
      } else ad = Math.abs(pr.d);
      const side = pr.d > 0 ? xs.outerR : -xs.outerL;
      if (ad > side + 80) continue;
      const yc = r.Y[i] + (r.Y[i + 1] - r.Y[i]) * pr.t;
      const bank = lerp(r.BANK[i], r.BANK[i + 1], pr.t);
      const yEdge = yc + xsOffset(xs, bank, clamp(pr.d, xs.outerL, xs.outerR));
      let target, flat;
      const urban = r.T.urban;
      if (urban) { flat = side + 3; target = ad <= side ? yEdge - 0.25 : yEdge - 0.08; }
      else {
        const ditch = r.type === 'motorway' ? 4.5 : r.type === 'gravel' ? 2.2 : 3.4;
        flat = side + ditch;
        if (ad <= side) target = yEdge - 0.22;
        else {
          const u = (ad - side) / ditch;
          const depth = r.type === 'gravel' ? 0.45 : 0.8;
          target = yEdge - 0.25 - depth * Math.sin(Math.PI * clamp(u, 0, 1));
        }
      }
      const slopeLen = clamp(Math.abs(yEdge - hNat) * 1.7, 3, 62);
      const w = ad <= flat ? 1 : 1 - smoothstep(flat, flat + slopeLen, ad);
      if (w <= 0) continue;
      const score = w * 1000 - ad - (r.T.urban ? 0 : 0.5);
      if (score > bestScore) { bestScore = score; bestW = w; bestT = target; }
    }
    if (info) info.w = bestW;
    return bestW > 0 ? lerp(hNat, bestT, bestW) : hNat;
  }

  /* Info about the road at a position (for HUD, AI, fines). */
  roadInfoAt(x, z) {
    const list = this.cellList(x, z);
    if (!list) return null;
    let best = null, bd = Infinity;
    for (const enc of list) {
      const r = this.roads[(enc / 65536) | 0], i = enc & 65535;
      const pr = projectOnSeg(r, i, x, z);
      if (pr.t < -0.05 || pr.t > 1.05) continue;
      const ad = pr.d < 0 ? (pr.d < r.xs.edgeL ? r.xs.edgeL - pr.d : 0) : (pr.d > r.xs.edgeR ? pr.d - r.xs.edgeR : 0);
      const score = ad + Math.abs(pr.d) * 0.01;
      if (score < bd) { bd = score; best = { road: r, i, t: pr.t, d: pr.d, s: r.S[i] + pr.t * (r.S[i + 1] - r.S[i]), off: ad }; }
    }
    if (best && best.off > 3) return null;
    return best;
  }
}

Road.prototype.yAtS = function (s) {
  const i = sIndex(this, s);
  const t = (s - this.S[i]) / Math.max(1e-6, this.S[i + 1] - this.S[i]);
  return lerp(this.Y[i], this.Y[i + 1], t);
};

/* ------------------------------ Helpers ------------------------------ */
export function sIndex(r, s) {
  // binary search for segment containing s
  let lo = 0, hi = r.n - 2;
  if (s <= 0) return 0;
  if (s >= r.len) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (r.S[mid] <= s) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const _pr = { t: 0, d: 0 };
export function projectOnSeg(r, i, x, z) {
  const ax = r.X[i], az = r.Z[i], bx = r.X[i + 1], bz = r.Z[i + 1];
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1e-9;
  const t = ((x - ax) * dx + (z - az) * dz) / l2;
  const l = Math.sqrt(l2);
  // right normal = (-dz, dx)/l
  const d = ((x - ax) * -dz + (z - az) * dx) / l;
  _pr.t = t; _pr.d = d;
  return _pr;
}

export function pointSegDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t - px, z = az + dz * t - pz;
  return Math.sqrt(x * x + z * z);
}

function sharedNode(ra, rb) {
  if (ra.a === rb.a || ra.a === rb.b) return ra.a;
  if (ra.b === rb.a || ra.b === rb.b) return ra.b;
  return null;
}

function halfWidthSide(e, leftSide) {
  // outward-left/right half width incl. sidewalks
  const xs = e.road.xs;
  const L = e.atStart ? -xs.outerL : xs.outerR;
  const R = e.atStart ? xs.outerR : -xs.outerL;
  return leftSide ? L : R;
}

// Quadratic fillet between point A (with back direction da) and point B (with back direction db).
function fillet(A, da, B, db, steps) {
  // lines: A + t*da, B + u*db
  const rx = da[0], rz = da[1], sx = db[0], sz = db[1];
  const den = rx * sz - rz * sx;
  const out = [];
  let Q = null;
  if (Math.abs(den) > 0.05) {
    const qx = B[0] - A[0], qz = B[2] - A[2];
    const t = (qx * sz - qz * sx) / den;
    const u = (qx * rz - qz * rx) / den;
    if (t > 0 && u > 0 && t < 60 && u < 60) Q = [A[0] + rx * t, (A[1] + B[1]) / 2, A[2] + rz * t];
  }
  for (let k = 1; k < steps; k++) {
    const tt = k / steps;
    if (Q) {
      const a = (1 - tt) * (1 - tt), b = 2 * (1 - tt) * tt, c = tt * tt;
      out.push([a * A[0] + b * Q[0] + c * B[0], a * A[1] + b * Q[1] + c * B[1], a * A[2] + b * Q[2] + c * B[2]]);
    } else out.push([lerp(A[0], B[0], tt), lerp(A[1], B[1], tt), lerp(A[2], B[2], tt)]);
  }
  return out;
}

export function triHeight(a, b, c, x, z) {
  const v0x = b[0] - a[0], v0z = b[2] - a[2], v1x = c[0] - a[0], v1z = c[2] - a[2], v2x = x - a[0], v2z = z - a[2];
  const den = v0x * v1z - v1x * v0z;
  if (Math.abs(den) < 1e-9) return null;
  const v = (v2x * v1z - v1x * v2z) / den;
  const w = (v0x * v2z - v2x * v0z) / den;
  const u = 1 - v - w;
  if (u < -1e-4 || v < -1e-4 || w < -1e-4) return null;
  return u * a[1] + v * b[1] + w * c[1];
}
export function triNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

export function boxSmooth(src, dst, r) {
  const n = src.length;
  let acc = 0;
  const w = 2 * r + 1;
  // clamp-to-edge running sum
  for (let k = -r; k <= r; k++) acc += src[clamp(k, 0, n - 1)];
  for (let i = 0; i < n; i++) {
    dst[i] = acc / w;
    acc += src[clamp(i + r + 1, 0, n - 1)] - src[clamp(i - r, 0, n - 1)];
  }
}
function gaussSmooth(src, dst, r) {
  const a = new Float32Array(src.length), b = new Float32Array(src.length);
  const rr = Math.max(1, Math.round(r / 1.7));
  boxSmooth(src, a, rr); boxSmooth(a, b, rr); boxSmooth(b, dst, rr);
}

export { naturalHeight };
