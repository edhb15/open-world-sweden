/* =====================================================================
   Lane graph built on top of the road network.
   - LanePath: a drivable polyline (a lane of a road, a junction
     connector or a roundabout arc) with exits to other paths.
   - Junction connectors carry conflict/yield relations.
   - Signals: fixed-time plans with Swedish red / red+amber / green /
     amber sequence.
   ===================================================================== */
import { clamp, lerp, bezier3, KMH, segIntersect } from '../core/math.js';

let PATH_ID = 0;

export class LanePath {
  constructor(kind, pts, props = {}) {
    this.id = PATH_ID++;
    this.kind = kind; // lane | conn | ring
    const n = pts.length;
    this.n = n;
    this.P = new Float32Array(n * 3);
    this.S = new Float32Array(n);
    this.RS = props.roadS ? new Float32Array(props.roadS) : null; // road-local s per point (lanes)
    for (let i = 0; i < n; i++) { this.P[i * 3] = pts[i][0]; this.P[i * 3 + 1] = pts[i][1]; this.P[i * 3 + 2] = pts[i][2]; }
    for (let i = 1; i < n; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][2] - pts[i - 1][2];
      this.S[i] = this.S[i - 1] + Math.hypot(dx, dz);
    }
    this.len = this.S[n - 1];
    this.exits = []; // {atS, to, toS, turn, node}
    this.entries = [];
    this.road = props.road || null;
    this.dir = props.dir || 0;
    this.lane = props.lane ?? -1;
    this.node = props.node || null;
    this.speed = props.speed || 50 * KMH;
    this.turn = props.turn || null;
    this.yieldTo = [];
    this.conflicts = [];
    this.control = null; // {node, type, group} at end of an approach lane
    this.stops = []; // [{s, kind, ref}]
    this.vehicles = [];
    this.left = null; this.right = null; // adjacent same-direction lanes (inner/outer)
    this.from = props.from || null; // for connectors: feeding path
    this.endsAt = null; // lane drop: 'merge'
    this.isRamp = !!props.isRamp;
  }
  // position at s -> writes into out {x,y,z,hx,hz}
  at(s, out) {
    const S = this.S, n = this.n;
    if (s <= 0) return this._seg(0, 0, out, s);
    if (s >= this.len) return this._seg(n - 2, 1, out, s - this.len);
    let lo = 0, hi = n - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m] <= s) lo = m; else hi = m - 1; }
    const t = (s - S[lo]) / Math.max(1e-6, S[lo + 1] - S[lo]);
    return this._seg(lo, t, out, 0);
  }
  _seg(i, t, out, extra) {
    const P = this.P, a = i * 3, b = a + 3;
    let hx = P[b] - P[a], hz = P[b + 2] - P[a + 2];
    const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l;
    out.x = P[a] + (P[b] - P[a]) * t + hx * extra;
    out.y = P[a + 1] + (P[b + 1] - P[a + 1]) * t;
    out.z = P[a + 2] + (P[b + 2] - P[a + 2]) * t + hz * extra;
    out.hx = hx; out.hz = hz;
    out.grade = (P[b + 1] - P[a + 1]) / l;
    return out;
  }
  roadSAt(s) {
    if (!this.RS) return 0;
    const S = this.S;
    let lo = 0, hi = this.n - 2;
    if (s <= 0) return this.RS[0];
    if (s >= this.len) return this.RS[this.n - 1];
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m] <= s) lo = m; else hi = m - 1; }
    const t = (s - S[lo]) / Math.max(1e-6, S[lo + 1] - S[lo]);
    return lerp(this.RS[lo], this.RS[lo + 1], t);
  }
  sAtRoadS(rs) {
    if (!this.RS) return 0;
    const RS = this.RS, n = this.n;
    const inc = RS[n - 1] >= RS[0];
    let lo = 0, hi = n - 1;
    // RS is monotonic (increasing for forward lanes, decreasing for backward)
    if (inc ? rs <= RS[0] : rs >= RS[0]) return 0;
    if (inc ? rs >= RS[n - 1] : rs <= RS[n - 1]) return this.len;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (inc ? RS[m] <= rs : RS[m] >= rs) lo = m; else hi = m;
    }
    const t = (rs - RS[lo]) / (RS[hi] - RS[lo] || 1);
    return lerp(this.S[lo], this.S[hi], clamp(t, 0, 1));
  }
}

/* ------------------------------ Signals ------------------------------ */
export class Signal {
  constructor(node, groups, offset = 0) {
    this.node = node;
    this.groups = groups; // array of arrays of end indices
    const nG = groups.length;
    this.green = nG === 2 ? [24, 16] : groups.map(() => 16);
    this.amber = 3; this.allRed = 2; this.redAmber = 1.5;
    this.cycle = 0;
    for (let g = 0; g < nG; g++) this.cycle += this.green[g] + this.amber + this.allRed;
    this.t = offset % this.cycle;
  }
  update(dt) { this.t = (this.t + dt) % this.cycle; }
  // state for group g: 'green' | 'amber' | 'red' | 'redamber'
  state(g) {
    let t = this.t, acc = 0;
    for (let k = 0; k < this.groups.length; k++) {
      const gStart = acc, gEnd = acc + this.green[k], aEnd = gEnd + this.amber, rEnd = aEnd + this.allRed;
      if (t >= gStart && t < rEnd) {
        if (k === g) return t < gEnd ? 'green' : t < aEnd ? 'amber' : 'red';
        // red+amber for the next group at the end of the all-red
        const nxt = (k + 1) % this.groups.length;
        if (nxt === g && t >= rEnd - this.redAmber) return 'redamber';
        return 'red';
      }
      acc = rEnd;
    }
    return 'red';
  }
  // seconds of green remaining for group g (0 if not green)
  greenLeft(g) {
    let acc = 0;
    for (let k = 0; k < g; k++) acc += this.green[k] + this.amber + this.allRed;
    const t = this.t;
    if (t >= acc && t < acc + this.green[g]) return acc + this.green[g] - t;
    return 0;
  }
  // pedestrians crossing an approach of group g may walk while another group has green
  pedWalk(g) {
    for (let k = 0; k < this.groups.length; k++) if (k !== g && this.state(k) === 'green' && this.greenLeft(k) > 4) return true;
    return false;
  }
}

/* ------------------------------ Builder ------------------------------ */
export function buildLanes(net) {
  const paths = [];
  const add = (p) => { paths.push(p); return p; };
  const _o = {};

  // ---- road lanes
  for (const r of net.roads) {
    r.lanePathsF = []; r.lanePathsB = [];
    const s0 = r.trimA, s1 = r.len - r.trimB;
    if (s1 - s0 < 1) continue;
    const sp = r.speed * KMH;
    const mk = (d, dir, k, sa, sb) => {
      const pts = [], rs = [];
      const push = (s) => { pts.push(net.pointAt(r, s, d)); rs.push(s); };
      if (dir > 0) {
        push(sa);
        for (let i = 0; i < r.n; i++) if (r.S[i] > sa + 0.5 && r.S[i] < sb - 0.5) push(r.S[i]);
        push(sb);
      } else {
        push(sb);
        for (let i = r.n - 1; i >= 0; i--) if (r.S[i] > sa + 0.5 && r.S[i] < sb - 0.5) push(r.S[i]);
        push(sa);
      }
      return add(new LanePath('lane', pts, { road: r, dir, lane: k, speed: sp, roadS: rs, isRamp: r.type === 'ramp' }));
    };
    for (let k = 0; k < r.xs.lanesF; k++) r.lanePathsF.push(mk(r.xs.lanesOffF[k], 1, k, s0, s1));
    for (let k = 0; k < r.xs.lanesB; k++) r.lanePathsB.push(mk(r.xs.lanesOffB[k], -1, k, s0, s1));
    for (const L of [r.lanePathsF, r.lanePathsB]) for (let k = 0; k < L.length; k++) {
      L[k].left = L[k - 1] || null; L[k].right = L[k + 1] || null;
    }
  }

  const link = (from, to, toS = 0, extra = {}) => {
    from.exits.push({ atS: from.len, to, toS, turn: extra.turn || 'straight', node: extra.node || null });
    to.entries.push(from);
  };
  const connector = (node, a, b, turn, opts = {}) => {
    // a: incoming path (use its end), b: outgoing path at toS
    const toS = opts.toS || 0;
    const fromS = opts.fromS ?? a.len;
    const pa = a.at(fromS, {}), pb = b.at(toS, {});
    const P0 = [pa.x, pa.y, pa.z], P3 = [pb.x, pb.y, pb.z];
    const dist = Math.hypot(P3[0] - P0[0], P3[2] - P0[2]);
    const k = dist * (turn === 'straight' ? 0.35 : 0.5) * (opts.k || 1);
    const P1 = [P0[0] + pa.hx * k, P0[1], P0[2] + pa.hz * k];
    const P2 = [P3[0] - pb.hx * k, P3[1], P3[2] - pb.hz * k];
    const steps = Math.max(3, Math.ceil(dist / 1.5));
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(bezier3(P0, P1, P2, P3, i / steps));
    const sp = turn === 'straight' ? Math.min(a.speed, b.speed) : Math.min(a.speed, b.speed, 30 * KMH);
    const c = add(new LanePath('conn', pts, { node, turn, speed: sp, from: a }));
    a.exits.push({ atS: fromS, to: c, toS: 0, turn, node });
    c.entries.push(a);
    c.exits.push({ atS: c.len, to: b, toS, turn: 'straight', node });
    b.entries.push(c);
    c.target = b; c.targetS = toS;
    node.connectors.push(c);
    return c;
  };

  // incoming / outgoing lanes for a node end
  const inLanes = (e) => (e.atStart ? e.road.lanePathsB : e.road.lanePathsF);
  const outLanes = (e) => (e.atStart ? e.road.lanePathsF : e.road.lanePathsB);
  const turnOf = (ei, eo) => {
    const vx = -ei.ux, vz = -ei.uz;
    const cross = vx * eo.uz - vz * eo.ux, dot = vx * eo.ux + vz * eo.uz;
    if (dot < -0.92) return 'uturn';
    if (dot > 0.8) return 'straight';
    return cross > 0 ? 'right' : 'left';
  };

  for (const node of net.nodes) {
    const E = node.ends;
    if (node.kind === 'continuation' || node.kind === 'deadend' || node.kind === 'split') {
      if (node.kind === 'deadend') {
        // turning: link incoming lane to outgoing via a U connector
        const e = E[0];
        const I = inLanes(e), O = outLanes(e);
        if (I.length && O.length) {
          for (const a of I) {
            const c = connector(node, a, O[O.length - 1], 'uturn', { k: 2.2 });
            c.speed = 12 * KMH;
          }
        }
        continue;
      }
      let pairs = [];
      if (node.kind === 'continuation') pairs = [[E[0], E[1]], [E[1], E[0]]];
      else {
        const [ri, ro] = node.split.through;
        const ei = E.find((e) => e.road === ri), eo = E.find((e) => e.road === ro);
        if (ei && eo) pairs = [[ei, eo], [eo, ei]];
      }
      for (const [ea, eb] of pairs) {
        const I = inLanes(ea), O = outLanes(eb);
        if (!I.length || !O.length) continue;
        // align from the outer (right-most) lane
        const nI = I.length, nO = O.length;
        for (let j = 0; j < Math.min(nI, nO); j++) {
          const a = I[nI - 1 - j], b = O[nO - 1 - j];
          if (node.transition) connector(node, a, b, 'straight'); else link(a, b, 0, { node });
        }
        // lane drop: extra incoming inner lanes merge into the next lane before the node
        for (let j = nO; j < nI; j++) {
          const a = I[nI - 1 - j], tgt = I[nI - j];
          a.endsAt = 'merge';
          // trim the dropped lane: it ends 110 m before the node and merges
          const cut = Math.max(10, a.len - 110);
          shortenPath(a, cut);
          const toS = Math.min(tgt.len - 5, cut + 45);
          const c = connector(node, a, tgt, 'straight', { toS });
          c.merge = true; c.isMergeOf = tgt;
        }
        // lane gain: extra outgoing inner lanes start 110 m after the node (entered by lane change only)
        for (let j = nI; j < nO; j++) {
          const b = O[nO - 1 - j];
          delayPathStart(b, Math.min(110, b.len * 0.4));
        }
      }
      if (node.kind === 'split') {
        const [ri, ro] = node.split.through;
        for (const er of E) {
          if (er.road === ri || er.road === ro) continue;
          const ox = er.px - node.x, oz = er.pz - node.z;
          const O = outLanes(er), I = inLanes(er);
          if (O.length) {
            // diverge: from the through incoming direction that has the ramp on its right
            for (const et of E) {
              if (et === er || (et.road !== ri && et.road !== ro)) continue;
              const TI = inLanes(et);
              if (!TI.length) continue;
              const vx = -et.ux, vz = -et.uz;
              if (vx * oz - vz * ox <= 0 || vx * er.ux + vz * er.uz < 0.3) continue;
              const a = TI[TI.length - 1];
              const toS = Math.min(O[0].len * 0.5, 55);
              const c = connector(node, a, O[0], 'right', { toS, k: 0.9 });
              c.speed = Math.min(a.speed, 80 * KMH);
              c.diverge = true;
            }
          }
          if (I.length) {
            for (const et of E) {
              if (et === er || (et.road !== ri && et.road !== ro)) continue;
              const TO = outLanes(et);
              if (!TO.length) continue;
              const vx = et.ux, vz = et.uz;
              if (vx * oz - vz * ox <= 0 || -er.ux * vx + -er.uz * vz < 0.3) continue;
              const b = TO[TO.length - 1];
              const toS = Math.min(b.len * 0.5, 75);
              const c = connector(node, I[0], b, 'straight', { toS, k: 0.9 });
              c.merge = true; c.isMergeOf = b;
              c.speed = Math.min(b.speed, 90 * KMH);
            }
          }
        }
      }
      continue;
    }

    if (node.kind === 'roundabout') { buildRoundabout(net, node, inLanes, outLanes, add); continue; }

    // ---- regular junction connectors
    for (const ei of E) {
      const I = inLanes(ei);
      if (!I.length) continue;
      for (const eo of E) {
        if (eo === ei) continue;
        const O = outLanes(eo);
        if (!O.length) continue;
        const turn = turnOf(ei, eo);
        if (turn === 'uturn') continue;
        if (turn === 'straight') {
          for (let k = 0; k < I.length; k++) connector(node, I[k], O[Math.min(k, O.length - 1)], 'straight');
        } else if (turn === 'right') connector(node, I[I.length - 1], O[O.length - 1], 'right');
        else connector(node, I[0], O[0], 'left');
      }
    }
    // every approach lane needs somewhere to go
    for (const ei of E) for (const a of inLanes(ei)) {
      if (a.exits.length) continue;
      let best = null, bd = -2;
      for (const eo of E) {
        if (eo === ei) continue;
        const O = outLanes(eo);
        if (!O.length) continue;
        const dot = -ei.ux * eo.ux + -ei.uz * eo.uz;
        if (dot > bd) { bd = dot; best = O[Math.min(a.lane, O.length - 1)]; }
      }
      if (best) connector(node, a, best, turnOf(ei, E.find((e) => outLanes(e).includes(best))) || 'straight');
    }
    computeConflicts(node, E, inLanes);
  }

  // controls: approach lanes ending at junction nodes
  for (const node of net.nodes) {
    if (node.kind !== 'junction') continue;
    for (let k = 0; k < node.ends.length; k++) {
      const e = node.ends[k];
      for (const p of inLanes(e)) {
        p.control = { node, type: node.control || 'priority', end: k, group: node.signal ? node.signal.groupOf[k] : -1, major: !!e.major };
      }
    }
  }
  return paths;
}

function shortenPath(p, newLen) {
  // keep points up to newLen, add exact end
  const out = [], rs = [];
  const tmp = {};
  for (let i = 0; i < p.n; i++) {
    if (p.S[i] >= newLen) break;
    out.push([p.P[i * 3], p.P[i * 3 + 1], p.P[i * 3 + 2]]);
    if (p.RS) rs.push(p.RS[i]);
  }
  p.at(newLen, tmp);
  out.push([tmp.x, tmp.y, tmp.z]);
  if (p.RS) rs.push(p.roadSAt(newLen));
  rebuildPath(p, out, rs);
}
function delayPathStart(p, startS) {
  const out = [], rs = [];
  const tmp = {};
  p.at(startS, tmp);
  out.push([tmp.x, tmp.y, tmp.z]);
  if (p.RS) rs.push(p.roadSAt(startS));
  for (let i = 0; i < p.n; i++) {
    if (p.S[i] <= startS + 0.5) continue;
    out.push([p.P[i * 3], p.P[i * 3 + 1], p.P[i * 3 + 2]]);
    if (p.RS) rs.push(p.RS[i]);
  }
  rebuildPath(p, out, rs);
  p.lateStart = true;
}
function rebuildPath(p, pts, rs) {
  const n = pts.length;
  p.n = n;
  p.P = new Float32Array(n * 3); p.S = new Float32Array(n);
  for (let i = 0; i < n; i++) { p.P[i * 3] = pts[i][0]; p.P[i * 3 + 1] = pts[i][1]; p.P[i * 3 + 2] = pts[i][2]; }
  for (let i = 1; i < n; i++) p.S[i] = p.S[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
  p.len = p.S[n - 1];
  if (rs && rs.length === n) p.RS = new Float32Array(rs);
  for (const ex of p.exits) ex.atS = Math.min(ex.atS, p.len);
}

/* ---------------------------- Roundabouts ---------------------------- */
function buildRoundabout(net, node, inLanes, outLanes, add) {
  const R = node.roundabout.laneR;
  const cx = node.x, cz = node.z, cy = node.y;
  const pos = (phi) => [cx + Math.cos(phi) * R, cy, cz - Math.sin(phi) * R]; // phi: map angle (CCW from east)
  // ports sorted by map angle (CCW)
  const ports = node.ends.map((e) => {
    const sb = node.setbacks.get(e);
    const p = net.pointAt(e.road, e.atStart ? sb : e.road.len - sb, 0);
    return { e, phi: Math.atan2(-(p[2] - cz), p[0] - cx) };
  }).sort((a, b) => a.phi - b.phi);
  const points = []; // {phi, type, port}
  for (const pt of ports) {
    const hw = Math.max(2.2, (pt.e.road.xs.edgeR - pt.e.road.xs.edgeL) / 4);
    const dl = Math.min(0.45, (hw + 1.5) / R);
    points.push({ phi: pt.phi - dl, type: 'exit', port: pt });
    points.push({ phi: pt.phi + dl, type: 'entry', port: pt });
  }
  // arcs between consecutive points (CCW = increasing phi)
  const arcs = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    let p0 = a.phi, p1 = b.phi;
    while (p1 <= p0) p1 += Math.PI * 2;
    const steps = Math.max(2, Math.ceil(((p1 - p0) * R) / 1.5));
    const pts = [];
    for (let k = 0; k <= steps; k++) pts.push(pos(lerp(p0, p1, k / steps)));
    const arc = add(new LanePath('ring', pts, { node, speed: 28 * KMH }));
    arc.ringFrom = a; arc.ringTo = b;
    arcs.push(arc);
    node.connectors.push(arc);
  }
  for (let i = 0; i < arcs.length; i++) {
    const a = arcs[i], b = arcs[(i + 1) % arcs.length];
    a.exits.push({ atS: a.len, to: b, toS: 0, turn: 'straight', node });
    b.entries.push(a);
  }
  // entries & exits
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const arcOut = arcs[i]; // starts at this point
    const arcIn = arcs[(i - 1 + arcs.length) % arcs.length]; // ends at this point
    if (pt.type === 'entry') {
      const I = inLanes(pt.port.e);
      for (const lane of I) {
        const c = bezierConn(lane, lane.len, arcOut, 0, node, add, 0.6);
        c.speed = 25 * KMH;
        c.ringEntry = true;
        c.yieldRing = [arcIn, arcs[(i - 2 + arcs.length) % arcs.length]];
        lane.control = { node, type: 'roundabout', end: -1, group: -1 };
      }
    } else {
      const O = outLanes(pt.port.e);
      if (O.length) {
        const c = bezierConn(arcIn, arcIn.len, O[O.length - 1], 0, node, add, 0.6);
        c.speed = 28 * KMH;
        c.ringExit = true;
        c.exitRoad = pt.port.e.road;
      }
    }
  }
  node.ringArcs = arcs;
}
function bezierConn(a, aS, b, bS, node, add, kf) {
  const pa = a.at(aS, {}), pb = b.at(bS, {});
  const P0 = [pa.x, pa.y, pa.z], P3 = [pb.x, pb.y, pb.z];
  const dist = Math.hypot(P3[0] - P0[0], P3[2] - P0[2]);
  const k = dist * kf;
  const P1 = [P0[0] + pa.hx * k, P0[1], P0[2] + pa.hz * k];
  const P2 = [P3[0] - pb.hx * k, P3[1], P3[2] - pb.hz * k];
  const steps = Math.max(3, Math.ceil(dist / 1.2));
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(bezier3(P0, P1, P2, P3, i / steps));
  const c = add(new LanePath('conn', pts, { node, turn: 'right', from: a }));
  a.exits.push({ atS: aS, to: c, toS: 0, turn: 'right', node });
  c.entries.push(a);
  c.exits.push({ atS: c.len, to: b, toS: bS, turn: 'straight', node });
  b.entries.push(c);
  c.target = b; c.targetS = bS;
  node.connectors.push(c);
  return c;
}

/* ----------------------------- Conflicts ----------------------------- */
function polyIntersects(a, b) {
  // ignore the first/last 1.5 m where paths share lanes
  for (let i = 0; i < a.n - 1; i++) {
    if (a.S[i + 1] < 1.0 || a.S[i] > a.len - 1.0) continue;
    const ax = a.P[i * 3], az = a.P[i * 3 + 2], bx = a.P[i * 3 + 3], bz = a.P[i * 3 + 5];
    for (let j = 0; j < b.n - 1; j++) {
      if (b.S[j + 1] < 1.0 || b.S[j] > b.len - 1.0) continue;
      const hit = segIntersect(ax, az, bx, bz, b.P[j * 3], b.P[j * 3 + 2], b.P[j * 3 + 3], b.P[j * 3 + 5]);
      if (hit) return { sa: lerp(a.S[i], a.S[i + 1], hit.t), sb: lerp(b.S[j], b.S[j + 1], hit.u) };
    }
  }
  return null;
}

function computeConflicts(node, E, inLanes) {
  const C = node.connectors.filter((c) => c.kind === 'conn');
  const endOf = new Map();
  for (const c of C) {
    for (let k = 0; k < E.length; k++) if (inLanes(E[k]).includes(c.from)) endOf.set(c, k);
  }
  const ctl = node.control || 'priority';
  for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) {
    const a = C[i], b = C[j];
    if (a.from === b.from) continue;
    const sameTarget = a.target === b.target;
    const hit = sameTarget ? { sa: a.len, sb: b.len } : polyIntersects(a, b);
    if (!hit) continue;
    a.conflicts.push({ path: b, s: hit.sa, os: hit.sb });
    b.conflicts.push({ path: a, s: hit.sb, os: hit.sa });
    const ka = endOf.get(a), kb = endOf.get(b);
    const ea = E[ka], eb = E[kb];
    let aYields = false, bYields = false;
    const opposing = ea && eb && (ea.ux * eb.ux + ea.uz * eb.uz) < -0.7;
    if (ctl === 'signal') {
      const ga = node.signal.groupOf[ka], gb = node.signal.groupOf[kb];
      if (ga === gb) {
        if (a.turn === 'left' && b.turn !== 'left') aYields = true;
        else if (b.turn === 'left' && a.turn !== 'left') bYields = true;
        else if (sameTarget) { if (a.turn === 'right') aYields = true; else bYields = true; }
      }
    } else if (ctl === 'priority') {
      const ma = !!ea.major, mb = !!eb.major;
      if (ma && !mb) bYields = true;
      else if (mb && !ma) aYields = true;
      else if (ma && mb) {
        if (a.turn === 'left' && b.turn !== 'left') aYields = true;
        else if (b.turn === 'left' && a.turn !== 'left') bYields = true;
        else if (sameTarget) { if (a.turn === 'left') aYields = true; else bYields = true; }
      } else {
        rhr();
      }
    } else rhr();
    function rhr() {
      // högerregeln: yield to traffic from the right
      const va = [-ea.ux, -ea.uz], vb = [-eb.ux, -eb.uz];
      const bFromRight = va[0] * eb.uz - va[1] * eb.ux > 0.25; // eb's road lies to the right of a's travel
      const aFromRight = vb[0] * ea.uz - vb[1] * ea.ux > 0.25;
      if (opposing) {
        if (a.turn === 'left' && b.turn !== 'left') aYields = true;
        else if (b.turn === 'left' && a.turn !== 'left') bYields = true;
      } else if (bFromRight && !aFromRight) aYields = true;
      else if (aFromRight && !bFromRight) bYields = true;
    }
    if (aYields) a.yieldTo.push({ path: b, s: hit.sa, os: hit.sb });
    if (bYields) b.yieldTo.push({ path: a, s: hit.sb, os: hit.sa });
  }
}

/* Assign junction control (signals / priority / right-hand rule).
   Must run before buildLanes. */
export function assignControls(net, rng) {
  for (const node of net.nodes) {
    if (node.kind !== 'junction') continue;
    const E = node.ends;
    if (E.length < 3 && !node.control) { node.control = 'priority'; }
    // majors: the two highest-priority ends (lowest prio number), preferring collinear pairs
    let best = null, bestScore = Infinity;
    for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
      const dot = E[i].ux * E[j].ux + E[i].uz * E[j].uz;
      const sc = E[i].road.prio + E[j].road.prio + (dot > -0.6 ? 3 : 0) + (E[i].road.route && E[i].road.route === E[j].road.route ? -2 : 0);
      if (sc < bestScore) { bestScore = sc; best = [i, j]; }
    }
    if (!node.control) {
      const prios = E.map((e) => e.road.prio).sort((a, b) => a - b);
      const urban = E.every((e) => e.road.T.urban);
      if (urban && E.length >= 4 && prios[0] <= 2 && prios[2] <= 3) node.control = 'signal';
      else if (urban && E.length >= 3 && prios[0] <= 2 && prios[1] <= 2 && prios[2] <= 2) node.control = 'signal';
      else if (urban && prios[0] >= 4) node.control = 'rhr';
      else node.control = 'priority';
    }
    if (node.control === 'priority' && best) { E[best[0]].major = true; E[best[1]].major = true; }
    if (node.control === 'rhr') for (const e of E) e.major = false;
    if (node.control === 'signal') {
      // group ends by axis
      const ref = E[best ? best[0] : 0];
      const groupOf = E.map((e) => {
        const dot = Math.abs(e.ux * ref.ux + e.uz * ref.uz);
        return dot > 0.6 ? 0 : 1;
      });
      if (!groupOf.includes(1)) groupOf[groupOf.length - 1] = 1;
      const groups = [[], []];
      groupOf.forEach((g, k) => groups[g].push(k));
      node.signal = new Signal(node, groups, rng ? rng.float(0, 60) : 0);
      node.signal.groupOf = groupOf;
    }
  }
}
