/* =====================================================================
   Navigation: A* routing over the lane graph, turn-by-turn maneuvers
   with Swedish road names / numbers, route following and re-routing.
   ===================================================================== */
import { KMH } from '../core/math.js';

const VMAX = 120 * KMH;
const CELL = 64;

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(f, item) {
    const a = this.a; a.push([f, item]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

export class Router {
  constructor(world) {
    this.world = world;
    this.paths = world.paths;
    this.index = new Map();
    this.idx = new Map(); // path -> array index
    this.paths.forEach((p, i) => {
      this.idx.set(p, i);
      if (p.kind !== 'lane') return;
      for (let k = 0; k < p.n; k += 3) {
        const key = Math.floor(p.P[k * 3] / CELL) * 100003 + Math.floor(p.P[k * 3 + 2] / CELL);
        let L = this.index.get(key); if (!L) this.index.set(key, L = new Set());
        L.add(p);
      }
    });
    const n = this.paths.length;
    this.g = new Float64Array(n); this.entry = new Float32Array(n); this.parent = new Int32Array(n); this.parentS = new Float32Array(n); this.stamp = new Int32Array(n);
    this.run = 0;
  }

  /* nearest lane path to (x, z); optional heading (hx, hz) prefers lanes going that way */
  nearest(x, z, hx = 0, hz = 0, maxD = 150) {
    let best = null, bd = Infinity;
    const r = Math.ceil(maxD / CELL);
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const seen = new Set();
    for (let ring = 0; ring <= r; ring++) {
      for (let i = cx - ring; i <= cx + ring; i++) for (let j = cz - ring; j <= cz + ring; j++) {
        if (Math.max(Math.abs(i - cx), Math.abs(j - cz)) !== ring) continue;
        const L = this.index.get(i * 100003 + j);
        if (!L) continue;
        for (const p of L) {
          if (seen.has(p)) continue;
          seen.add(p);
          const pr = project(p, x, z);
          let d = pr.d;
          if (hx || hz) { const dot = pr.hx * hx + pr.hz * hz; d += dot < 0 ? 40 : (1 - dot) * 6; }
          if (p.road && (p.road.type === 'ramp')) d += 3;
          if (d < bd) { bd = d; best = { path: p, s: pr.s, d: pr.d }; }
        }
      }
      if (best && bd < ring * CELL) break;
    }
    return best;
  }

  /* candidate goal paths around a destination point (both directions) */
  goals(x, z, maxD = 90) {
    const out = new Map();
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), r = Math.ceil(maxD / CELL);
    for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++) {
      const L = this.index.get(i * 100003 + j);
      if (!L) continue;
      for (const p of L) {
        if (out.has(p)) continue;
        const pr = project(p, x, z);
        if (pr.d < maxD) out.set(p, { s: pr.s, d: pr.d });
      }
    }
    // only keep the best few
    const arr = [...out.entries()].sort((a, b) => a[1].d - b[1].d).slice(0, 12);
    return new Map(arr);
  }

  /* A* from a position/heading to a destination point. Returns a Route or null. */
  route(from, to) {
    const start = this.nearest(from.x, from.z, from.hx, from.hz);
    if (!start) return null;
    let goals = this.goals(to.x, to.z);
    if (!goals.size) { const g = this.nearest(to.x, to.z, 0, 0, 2000); if (g) goals = new Map([[g.path, { s: g.s, d: g.d }]]); }
    if (!goals.size) return null;
    const run = ++this.run;
    const G = this.g, E = this.entry, PA = this.parent, PS = this.parentS, ST = this.stamp;
    const heap = new Heap();
    const h = (p, s) => { const a = p.at(Math.min(p.len, s), tmpA); return Math.hypot(a.x - to.x, a.z - to.z) / VMAX; };
    const si = this.idx.get(start.path);
    ST[si] = run; G[si] = 0; E[si] = start.s; PA[si] = -1;
    heap.push(h(start.path, start.s), si);
    let found = null, bestGoal = Infinity;
    let iter = 0;
    while (heap.size && iter++ < 400000) {
      const [f, item] = heap.pop();
      if (item < 0) { // goal entry: -(index+1)
        found = -item - 1; break;
      }
      const i = item, p = this.paths[i];
      const g0 = G[i], s0 = E[i];
      const sp = Math.max(p.speed, 5);
      const goal = goals.get(p);
      if (goal && goal.s >= s0 - 1) {
        const gg = g0 + Math.max(0, goal.s - s0) / sp + goal.d / 8;
        if (gg < bestGoal) { bestGoal = gg; this.goalOf = { i, s: goal.s }; heap.push(gg, -i - 1); }
      }
      const relax = (q, toS, cost, exitS) => {
        const j = this.idx.get(q);
        if (j === undefined) return;
        const gn = g0 + cost;
        if (ST[j] === run && G[j] <= gn) return;
        ST[j] = run; G[j] = gn; E[j] = toS; PA[j] = i; PS[j] = exitS;
        heap.push(gn + h(q, toS), j);
      };
      for (const ex of p.exits) {
        if (ex.atS < s0 - 0.5) continue;
        let cost = (ex.atS - s0) / sp;
        const q = ex.to;
        if (q.kind === 'conn') cost += q.turn === 'left' ? 7 : q.turn === 'right' ? 3 : q.turn === 'uturn' ? 40 : 1;
        if (q.ringEntry) cost += 4;
        if (p.control && p.control.type === 'signal' && ex.atS >= p.len - 1) cost += 10;
        relax(q, ex.toS || 0, cost, ex.atS);
      }
      // lane changes to adjacent same-direction lanes
      if (p.kind === 'lane') for (const q of [p.left, p.right]) {
        if (!q) continue;
        const s = Math.min(q.len - 1, Math.max(0, s0 + 25));
        relax(q, s, 25 / sp + 2.5, Math.min(p.len, s0 + 25));
      }
    }
    if (found == null) return null;
    // reconstruct
    const segs = [];
    let i = found, s1 = this.goalOf.s;
    let guard = 0;
    while (i >= 0 && guard++ < 100000) {
      const p = this.paths[i];
      segs.push({ path: p, s0: Math.min(E[i], s1), s1 });
      s1 = PS[i];
      i = PA[i];
    }
    segs.reverse();
    return new Route(segs, to, this);
  }
}

const tmpA = {};
function project(p, x, z) {
  let bd = Infinity, bs = 0, bhx = 1, bhz = 0;
  const P = p.P, S = p.S;
  for (let k = 0; k < p.n - 1; k++) {
    const ax = P[k * 3], az = P[k * 3 + 2], bx = P[k * 3 + 3], bz = P[k * 3 + 5];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
    let t = ((x - ax) * dx + (z - az) * dz) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < bd) { bd = d; bs = S[k] + (S[k + 1] - S[k]) * t; const L = Math.sqrt(L2); bhx = dx / L; bhz = dz / L; }
  }
  return { d: bd, s: bs, hx: bhx, hz: bhz };
}

/* ---------------------------------------------------------------------
   A computed route: polyline, maneuvers and progress tracking.
   --------------------------------------------------------------------- */
export class Route {
  constructor(segs, dest, router) {
    this.segs = segs;
    this.dest = dest;
    // polyline with cumulative distance
    const pts = [], cum = [];
    let D = 0;
    const tmp = {};
    for (const sg of segs) {
      sg.d0 = D;
      const L = Math.max(0, sg.s1 - sg.s0);
      const n = Math.max(1, Math.ceil(L / 8));
      for (let k = 0; k <= n; k++) {
        const s = sg.s0 + (L * k) / n;
        sg.path.at(s, tmp);
        if (pts.length) { const q = pts[pts.length - 1]; const dd = Math.hypot(tmp.x - q[0], tmp.z - q[1]); if (dd < 0.5) continue; D += dd; }
        pts.push([tmp.x, tmp.z, tmp.y]); cum.push(D);
      }
      sg.d1 = D;
    }
    this.pts = pts; this.cum = cum; this.length = D;
    this.maneuvers = buildManeuvers(segs);
    this.progress = 0; this.cursor = 0;
    this.offT = 0;
  }
  /* advance progress from a world position; returns distance to route */
  track(x, z) {
    const P = this.pts;
    let best = Infinity, bi = this.cursor, bt = 0;
    const i0 = Math.max(0, this.cursor - 3), i1 = Math.min(P.length - 1, this.cursor + 60);
    for (let i = i0; i < i1; i++) {
      const a = P[i], b = P[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - a[0]) * dx + (z - a[1]) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
      if (d < best - 0.01) { best = d; bi = i; bt = t; }
    }
    this.cursor = bi;
    this.progress = this.cum[bi] + (this.cum[bi + 1] - this.cum[bi] || 0) * bt;
    return best;
  }
  get remaining() { return Math.max(0, this.length - this.progress); }
  nextManeuver() {
    for (const m of this.maneuvers) if (m.d > this.progress - 2) return m;
    return null;
  }
  /* estimated remaining time in seconds */
  eta() {
    let t = 0;
    for (const sg of this.segs) {
      if (sg.d1 < this.progress) continue;
      const L = sg.d1 - Math.max(sg.d0, this.progress);
      t += L / Math.max(sg.path.speed * 0.85, 4);
    }
    return t;
  }
}

/* Identify the decision points of a route and describe them. */
function buildManeuvers(segs) {
  const M = [];
  const roadOf = (k) => { for (let j = k; j < segs.length; j++) if (segs[j].path.kind === 'lane' && segs[j].path.road) return segs[j].path.road; return null; };
  let lastRoad = null;
  for (let k = 0; k < segs.length; k++) {
    const sg = segs[k], p = sg.path;
    if (p.kind === 'lane') {
      const r = p.road;
      // motorway diverge: lane continues into a ramp road
      if (lastRoad && r !== lastRoad && r.type === 'ramp' && lastRoad.type !== 'ramp') {
        const nr = roadOf(k + 1) || r;
        M.push({ d: sg.d0, type: 'exit', road: describe(r.ref ? r : nr), dest: (r.dest && (r.dest.fwd || r.dest.bwd)) || (nr.dest && (nr.dest.fwd || nr.dest.bwd)) || null, x: p.P[0], z: p.P[2] });
      }
      lastRoad = r;
      continue;
    }
    if (p.ringEntry) {
      // count the exits passed until we leave the ring
      let n = 1, j = k + 1, exitRoad = null;
      for (; j < segs.length; j++) {
        const q = segs[j].path;
        if (q.kind === 'ring') {
          // an exit connector leaves at the end of this arc (other than ours)?
          const hasExit = q.exits.some((e) => e.to.ringExit);
          const next = segs[j + 1] && segs[j + 1].path;
          if (hasExit && next && !next.ringExit) n++;
          continue;
        }
        if (q.ringExit) { exitRoad = q.exitRoad; break; }
      }
      const r = roadOf(j + 1) || exitRoad;
      M.push({ d: sg.d0, type: 'roundabout', n, road: r ? describe(r) : null, x: p.P[0], z: p.P[2] });
      k = j;
      lastRoad = r;
      continue;
    }
    if (p.kind === 'conn' && !p.ringExit) {
      const next = roadOf(k + 1);
      const turn = p.turn || 'straight';
      if (turn === 'straight' && next && lastRoad && (next === lastRoad || sameName(next, lastRoad))) continue;
      if (turn === 'straight' && next && lastRoad && next.type === lastRoad.type && !next.name && !next.ref) continue;
      M.push({ d: sg.d0, type: turn === 'left' ? 'left' : turn === 'right' ? 'right' : turn === 'uturn' ? 'uturn' : 'straight', road: next ? describe(next) : null, x: p.P[0], z: p.P[2] });
    }
  }
  const last = segs[segs.length - 1];
  M.push({ d: last.d1, type: 'arrive', road: null, x: 0, z: 0 });
  // a turn that only leads onto an exit ramp is announced as the exit
  for (let i = M.length - 2; i >= 0; i--) if (['left', 'right', 'straight'].includes(M[i].type) && M[i + 1].type === 'exit' && M[i + 1].d - M[i].d < 150) M.splice(i, 1);
  // drop maneuvers that are too close to the previous one with the same type
  return M.filter((m, i) => i === 0 || !(m.type === M[i - 1].type && m.d - M[i - 1].d < 12 && m.type !== 'arrive'));
}
function sameName(a, b) { return (a.ref && a.ref === b.ref) || (a.name && a.name === b.name); }
const GENERIC = /^(avfart|påfart|ramp)$/i;
function describe(r) { return { ref: r.ref || null, name: r.name && !GENERIC.test(r.name) ? r.name : null, type: r.type, dest: r.dest || null }; }
