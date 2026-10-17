/* =====================================================================
   Pedestrians and cyclists on sidewalks / cycle paths near the player.
   They follow sidewalks, turn at junction corners, wait at zebra
   crossings ("övergångsställe") and at signals, and cross when it is
   safe. Drivers (AI) yield to people on or about to step onto a
   crossing, as Swedish law requires. Rendered with instanced parts and
   a simple walk / pedal cycle.
   ===================================================================== */
import * as THREE from 'three';
import { settings } from '../core/settings.js';
import { clamp, RNG } from '../core/math.js';

const CAP = 96;
const CELL = 160;
const CLOTHES = [0x1d1f24, 0x2b3442, 0x3b4d63, 0x5b6470, 0x7d6a55, 0x9a8a72, 0x8b2a2a, 0x2f5d43, 0xd4c9b0, 0x1e3d70, 0xc76b2a, 0x6a4c7a, 0xe2e0da];
const WINTER = [0x15171b, 0x23272e, 0x2c3440, 0x3e2f27, 0x4a4f57, 0x1f2a3a, 0x6b1e22, 0x355040];
const PANTS = [0x1a1c20, 0x22303f, 0x3a3f48, 0x2c2a26, 0x4b5563, 0x6b5d4c];
const SKIN = [0xf1d3bf, 0xe8c1a0, 0xd9a882, 0xb98361, 0x8d5a3b, 0x5e3b25];
const HAIR = [0xd8c28a, 0xb08a52, 0x6b4a2b, 0x2a2018, 0x111111, 0x9a9a9a, 0xc9c9c9, 0x8a3b1d];
const HATS = [0x1d1f24, 0x8b2a2a, 0x1e3d70, 0xd9d4c8, 0x2f5d43, 0xe0b000];
const BIKES = [0x1d1f24, 0x2e4d7a, 0x8b2a2a, 0xd9d9d9, 0x2f5d43, 0xe0b000, 0x6d6f72];

function part(geo, cap) {
  const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }), cap);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.setColorAt(0, new THREE.Color(1, 1, 1));
  m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = false;
  return m;
}
function bikeGeometry() {
  const geos = [];
  const wheel = new THREE.TorusGeometry(0.33, 0.025, 5, 18); wheel.rotateY(Math.PI / 2);
  const w1 = wheel.clone(); w1.translate(0, 0.35, 0.52); geos.push(w1);
  const w2 = wheel.clone(); w2.translate(0, 0.35, -0.52); geos.push(w2);
  const bar = (a, b, r = 0.022) => {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const len = va.distanceTo(vb);
    const g = new THREE.CylinderGeometry(r, r, len, 5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    g.applyQuaternion(q); const c = va.add(vb).multiplyScalar(0.5); g.translate(c.x, c.y, c.z);
    geos.push(g);
  };
  bar([0, 0.35, 0.52], [0, 0.82, 0.12]); bar([0, 0.82, 0.12], [0, 0.85, -0.3]); bar([0, 0.35, -0.02], [0, 0.85, -0.3]);
  bar([0, 0.35, -0.02], [0, 0.82, 0.12]); bar([0, 0.35, -0.52], [0, 0.85, -0.3]); bar([0, 0.35, -0.52], [0, 0.35, -0.02]);
  bar([0, 0.82, 0.12], [0, 1.0, 0.18]); bar([-0.25, 1.02, 0.2], [0.25, 1.02, 0.2], 0.018);
  const seat = new THREE.BoxGeometry(0.12, 0.05, 0.24); seat.translate(0, 0.9, -0.32); geos.push(seat);
  return mergeAll(geos);
}
function mergeAll(geos) {
  const list = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

export class Pedestrians {
  constructor(game) {
    this.game = game;
    this.net = game.net;
    this.rng = new RNG(4242);
    this.list = [];
    this.spawnT = 0;
    // sidewalk roads in a coarse grid
    this.grid = new Map();
    for (const r of this.net.roads) {
      if (!(r.xs.swR > 0 || r.xs.swL > 0) || r.len < 20) continue;
      const seen = new Set();
      for (let i = 0; i < r.n; i += 4) {
        const k = Math.floor(r.X[i] / CELL) * 100003 + Math.floor(r.Z[i] / CELL);
        if (seen.has(k)) continue; seen.add(k);
        let L = this.grid.get(k); if (!L) this.grid.set(k, L = []); L.push(r);
      }
    }
    // zebra crossings at urban junction approaches (same rule as the road markings)
    this.cw = new Map(); // key road.id + ':' + atStart
    for (const r of this.net.roads) {
      const xs = r.xs;
      if (!(r.T.urban && (xs.swL > 0 || xs.swR > 0))) continue;
      for (const atStart of [true, false]) {
        const node = atStart ? r.a : r.b;
        if (node.kind !== 'junction' || node.ends.length < 3) continue;
        const sEnd = atStart ? r.trimA : r.len - r.trimB;
        const dir = atStart ? 1 : -1;
        const k = node.ends.findIndex((q) => q.road === r && q.atStart === atStart);
        this.cw.set(r.id + ':' + atStart, { road: r, node, atStart, s: sEnd + dir * 2.5, k, group: node.signal ? node.signal.groupOf[k] : -1, peds: new Set() });
      }
    }
    // meshes
    const human = {
      leg: new THREE.CapsuleGeometry(0.068, 0.72, 2, 6).translate(0, -0.43, 0),
      arm: new THREE.CapsuleGeometry(0.048, 0.5, 2, 5).translate(0, -0.29, 0),
      torso: new THREE.CapsuleGeometry(0.17, 0.32, 3, 8).scale(1, 1, 0.68),
      head: new THREE.SphereGeometry(0.105, 10, 8),
      hair: new THREE.SphereGeometry(0.112, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55),
    };
    this.parts = {
      legL: part(human.leg, CAP), legR: part(human.leg, CAP), armL: part(human.arm, CAP), armR: part(human.arm, CAP),
      torso: part(human.torso, CAP), head: part(human.head, CAP), hair: part(human.hair, CAP), bike: part(bikeGeometry(), CAP),
    };
    this.parts.bike.material.metalness = 0.4; this.parts.bike.material.roughness = 0.5;
    this.group = new THREE.Group();
    for (const k in this.parts) this.group.add(this.parts[k]);
    game.scene.add(this.group);
    this.m = new THREE.Matrix4(); this.m2 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(0, 0, 0, 'YXZ');
    this.v = new THREE.Vector3(); this.s1 = new THREE.Vector3(1, 1, 1); this.col = new THREE.Color();
    if (game.traffic) game.traffic.peds = this;
  }

  roadsNear(x, z, r) {
    const out = new Set();
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
      const L = this.grid.get(i * 100003 + j); if (L) for (const q of L) out.add(q);
    }
    return [...out];
  }
  sideD(r, side) { return side > 0 ? r.xs.edgeR + r.xs.swR * (0.45 + 0.1 * Math.random()) : r.xs.edgeL - r.xs.swL * (0.45 + 0.1 * Math.random()); }
  hasSide(r, side) { return side > 0 ? r.xs.swR > 0.8 : r.xs.swL > 0.8; }

  desired() {
    const g = this.game;
    if (!settings.pedestrians) return 0;
    const kind = g.placeKind;
    const base = kind === 'city' ? 46 : kind === 'village' ? 12 : 4;
    const h = g.env.clock;
    const tod = h < 5 ? 0.08 : h < 7 ? 0.35 : h < 9 ? 1 : h < 16 ? 0.85 : h < 19 ? 1 : h < 22 ? 0.5 : 0.18;
    const W = g.env.weather;
    const wx = 1 - 0.55 * (W.rain || 0) - 0.3 * (W.snow || 0) - 0.4 * (W.storm || 0);
    const temp = g.conditions.temp;
    const cold = temp < -12 ? 0.55 : temp < -3 ? 0.8 : 1;
    const q = g.qualityName === 'low' ? 0.5 : 1;
    return Math.round(base * tod * Math.max(0.15, wx) * cold * q);
  }

  spawn(px, pz) {
    const rng = this.rng;
    const roads = this.roadsNear(px, pz, 170);
    if (!roads.length) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = roads[rng.int(0, roads.length - 1)];
      const side = this.hasSide(r, 1) && (!this.hasSide(r, -1) || rng.chance(0.5)) ? 1 : -1;
      if (!this.hasSide(r, side)) continue;
      const s0 = r.trimA + 3, s1 = r.len - r.trimB - 3;
      if (s1 <= s0) continue;
      const s = rng.float(s0, s1);
      const d = this.sideD(r, side);
      const p = this.net.pointAt(r, s, d);
      const dist = Math.hypot(p[0] - px, p[2] - pz);
      if (dist < 45 || dist > 165) continue;
      const bike = rng.chance(this.game.season === 'winter' ? 0.04 : 0.16) && (r.type === 'avenue' || r.type === 'street');
      const winter = this.game.season === 'winter' || this.game.conditions.temp < 4;
      const P = {
        road: r, s, side, d, dir: rng.chance(0.5) ? 1 : -1, state: 'walk', bike,
        v: bike ? rng.float(3.6, 5.6) : rng.float(1.05, 1.55), phase: rng.float(0, 6.28), x: p[0], y: p[1], z: p[2], yaw: 0,
        h: rng.float(0.9, 1.08), wait: 0, cw: null, t: 0, tx: 0, tz: 0, ty: 0,
        cloth: (winter ? WINTER : CLOTHES)[rng.int(0, (winter ? WINTER : CLOTHES).length - 1)], pants: PANTS[rng.int(0, PANTS.length - 1)],
        skin: rng.weighted(SKIN, [30, 26, 16, 10, 9, 6]), hair: winter && rng.chance(0.6) ? HATS[rng.int(0, HATS.length - 1)] : HAIR[rng.int(0, HAIR.length - 1)],
        bikeCol: BIKES[rng.int(0, BIKES.length - 1)],
      };
      this.list.push(P);
      return;
    }
  }

  endOf(r, P) {
    // decision point toward the end we are walking to
    const atStart = P.dir < 0;
    const cw = this.cw.get(r.id + ':' + atStart);
    const sEnd = atStart ? r.trimA + 1.2 : r.len - r.trimB - 1.2;
    return { atStart, cw, sDecide: cw ? cw.s : sEnd };
  }

  /* vehicles close to a crossing point (for pedestrians to wait) */
  trafficNear(x, z) {
    const T = this.game.traffic;
    const P = this.game.player;
    if (P) { const ph = P.phys; const d = Math.hypot(ph.p[0] - x, ph.p[2] - z); if (d < 16 && Math.abs(ph.speed) > 2.5) return true; }
    if (!T) return false;
    for (const c of T.cars) { if (Math.abs(c.x - x) > 18 || Math.abs(c.z - z) > 18) continue; if (Math.hypot(c.x - x, c.z - z) < 14 && c.v > 2.5) return true; }
    return false;
  }

  step(P, dt) {
    const net = this.net;
    if (P.state === 'walk') {
      const r = P.road;
      const E = this.endOf(r, P);
      P.s += P.dir * P.v * dt;
      const reached = P.dir > 0 ? P.s >= E.sDecide : P.s <= E.sDecide;
      if (reached) {
        P.s = E.sDecide;
        if (E.cw && !P.bike && this.rng.chance(0.55) && this.hasSide(r, -P.side)) { P.state = 'wait'; P.cw = E.cw; P.wait = 0; E.cw.peds.add(P); }
        else this.turnCorner(P, E.atStart);
      }
      const p = net.pointAt(r, P.s, P.d);
      P.x = p[0]; P.y = p[1]; P.z = p[2];
      const i = Math.min(r.n - 2, Math.max(0, Math.floor(P.s / 4)));
      P.yaw = Math.atan2(r.TX[i] * P.dir, r.TZ[i] * P.dir);
    } else if (P.state === 'wait') {
      const cw = P.cw;
      P.wait += dt;
      let ok = true;
      if (cw.node.signal && cw.group >= 0) ok = cw.node.signal.pedWalk(cw.group);
      else ok = !this.trafficNear(P.x, P.z);
      if (ok && P.wait > 0.6) {
        P.state = 'cross'; P.d0 = P.d; P.d1 = this.sideD(P.road, -P.side); P.t = 0;
        P.v = Math.max(P.v, 1.25);
      }
      const i = Math.min(P.road.n - 2, Math.max(0, Math.floor(P.s / 4)));
      P.yaw = Math.atan2(-P.side * -P.road.TZ[i], -P.side * P.road.TX[i]);
    } else if (P.state === 'cross') {
      const L = Math.abs(P.d1 - P.d0);
      P.t += (P.v * dt) / Math.max(L, 0.1);
      const tt = Math.min(1, P.t);
      P.d = P.d0 + (P.d1 - P.d0) * tt;
      const p = net.pointAt(P.road, P.s, P.d);
      P.x = p[0]; P.y = p[1]; P.z = p[2];
      const i = Math.min(P.road.n - 2, Math.max(0, Math.floor(P.s / 4)));
      const sg = Math.sign(P.d1 - P.d0);
      P.yaw = Math.atan2(sg * -P.road.TZ[i], sg * P.road.TX[i]);
      if (tt >= 1) {
        P.cw.peds.delete(P); P.cw = null;
        P.side = -P.side; P.state = 'walk';
        P.dir = -P.dir; // walk back along the road on the other side, or turn the corner next time
        if (this.rng.chance(0.5)) { P.dir = -P.dir; this.turnCorner(P, P.dir < 0); }
      }
    } else if (P.state === 'corner') {
      const dx = P.tx - P.x, dz = P.tz - P.z, L = Math.hypot(dx, dz);
      const k = Math.min(1, (P.v * dt) / Math.max(L, 1e-3));
      P.x += dx * k; P.z += dz * k; P.y += (P.ty - P.y) * k;
      P.yaw = Math.atan2(dx, dz);
      if (L < 0.2) { P.state = 'walk'; P.road = P.next.road; P.s = P.next.s; P.side = P.next.side; P.d = P.next.d; P.dir = P.next.dir; }
    }
    P.phase += dt * (P.bike ? P.v * 1.4 : P.v * 5.2) * (P.state === 'wait' ? 0 : 1);
  }

  turnCorner(P, atStart) {
    const r = P.road;
    const node = atStart ? r.a : r.b;
    let best = null, bd = 16;
    for (const e of node.ends) {
      if (e.road === r && e.atStart === atStart) continue;
      const q = e.road;
      for (const side of [1, -1]) {
        if (!this.hasSide(q, side)) continue;
        const s = e.atStart ? q.trimA + 1.2 : q.len - q.trimB - 1.2;
        const d = side > 0 ? q.xs.edgeR + q.xs.swR * 0.5 : q.xs.edgeL - q.xs.swL * 0.5;
        const p = this.net.pointAt(q, s, d);
        const dist = Math.hypot(p[0] - P.x, p[2] - P.z);
        if (dist < bd) { bd = dist; best = { road: q, s, side, d, dir: e.atStart ? 1 : -1, p }; }
      }
    }
    if (best && this.rng.chance(0.85)) {
      P.state = 'corner'; P.next = best; P.tx = best.p[0]; P.tz = best.p[2]; P.ty = best.p[1];
    } else P.dir = -P.dir;
  }

  /* ---------- queries from the traffic AI ---------- */
  occupied(cw) {
    // at unsignalled zebra crossings drivers also yield to people waiting at the kerb
    const sig = !!cw.node.signal;
    for (const P of cw.peds) if (P.state === 'cross' || (!sig && P.state === 'wait' && P.wait > 0.3)) return true;
    return false;
  }
  blockingCrossing(c, p, toEnd) {
    const r = p.road;
    if (!r) return null;
    const atStart = p.dir < 0; // backward lanes approach the start node
    const cw = this.cw.get(r.id + ':' + atStart);
    if (!cw || !cw.peds.size || !this.occupied(cw)) return null;
    const dist = toEnd - 5.4;
    if (dist < -0.5) return null; // already on the crossing: keep going
    return Math.max(0, dist);
  }
  blockingExitCrossing(c, conn) {
    const q = conn.target;
    if (!q || !q.road) return null;
    const atStart = q.dir > 0; // forward lanes leave from the start node
    const cw = this.cw.get(q.road.id + ':' + atStart);
    if (!cw || !cw.peds.size || !this.occupied(cw)) return null;
    const dist = conn.len - c.s - 0.8;
    if (dist < 1.5) return null;
    return dist;
  }

  update(dt, game) {
    const P = game.player;
    if (!P || game.paused) { this.render(); return; }
    const px = P.phys.p[0], pz = P.phys.p[2];
    const want = this.desired();
    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.list.length < Math.min(want, CAP)) { this.spawnT = 0.25; this.spawn(px, pz); }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const q = this.list[i];
      const d = Math.hypot(q.x - px, q.z - pz);
      if (d > 210 || (this.list.length > want + 6 && d > 120)) {
        if (q.cw) q.cw.peds.delete(q);
        this.list.splice(i, 1);
        continue;
      }
      this.step(q, dt);
      // step aside if the player's car comes onto the sidewalk
      const ph = P.phys;
      const dx = q.x - ph.p[0], dz = q.z - ph.p[2], dd = Math.hypot(dx, dz);
      if (dd < P.spec.body.L * 0.55 + 0.6 && Math.abs(ph.speed) > 0.3) { const k = (P.spec.body.L * 0.55 + 0.6 - dd) / Math.max(dd, 0.1); q.x += dx * k; q.z += dz * k; }
    }
    this.render();
  }

  render() {
    const Pm = this.parts, m = this.m, m2 = this.m2, q = this.q, e = this.e, v = this.v;
    let n = 0;
    const cam = this.game.camera.position;
    const set = (mesh, i, mat, col) => { mesh.setMatrixAt(i, mat); if (col != null) mesh.setColorAt(i, this.col.setHex(col)); };
    for (const P of this.list) {
      if (n >= CAP) break;
      if (Math.abs(P.x - cam.x) > 180 || Math.abs(P.z - cam.z) > 180) continue;
      const h = P.h;
      const sw = Math.sin(P.phase);
      // base transform
      const base = new THREE.Matrix4().compose(v.set(P.x, P.y, P.z), q.setFromEuler(e.set(0, P.yaw, 0)), this.s1.set(h, h, h));
      const local = (x, y, z, rx, ry = 0, rz = 0) => m2.multiplyMatrices(base, m.compose(v.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), this.s1.set(1, 1, 1)));
      if (P.bike) {
        set(Pm.bike, n, local(0, 0, 0, 0), P.bikeCol);
        const crank = P.phase;
        set(Pm.legL, n, local(-0.1, 0.92, -0.28, -0.5 + Math.sin(crank) * 0.35), P.pants);
        set(Pm.legR, n, local(0.1, 0.92, -0.28, -0.5 - Math.sin(crank) * 0.35), P.pants);
        set(Pm.torso, n, local(0, 1.2, -0.12, 0.45), P.cloth);
        set(Pm.armL, n, local(-0.2, 1.38, -0.02, -0.6), P.cloth);
        set(Pm.armR, n, local(0.2, 1.38, -0.02, -0.6), P.cloth);
        set(Pm.head, n, local(0, 1.55, 0.08, 0), P.skin);
        set(Pm.hair, n, local(0, 1.565, 0.07, -0.3), P.hair);
      } else {
        const a = P.state === 'wait' ? 0 : sw * 0.42;
        Pm.bike.setMatrixAt(n, m.makeScale(0, 0, 0));
        set(Pm.legL, n, local(-0.09, 0.9, 0, a), P.pants);
        set(Pm.legR, n, local(0.09, 0.9, 0, -a), P.pants);
        set(Pm.torso, n, local(0, 1.22, 0, 0.03), P.cloth);
        set(Pm.armL, n, local(-0.23, 1.47, 0, -a * 0.8, 0, -0.08), P.cloth);
        set(Pm.armR, n, local(0.23, 1.47, 0, a * 0.8, 0, 0.08), P.cloth);
        set(Pm.head, n, local(0, 1.64, 0.01, 0), P.skin);
        set(Pm.hair, n, local(0, 1.66, -0.005, -0.25), P.hair);
      }
      n++;
    }
    for (const k in Pm) {
      Pm[k].count = n;
      Pm[k].instanceMatrix.needsUpdate = true;
      if (Pm[k].instanceColor) Pm[k].instanceColor.needsUpdate = true;
    }
  }
  clear() { for (const P of this.list) if (P.cw) P.cw.peds.delete(P); this.list.length = 0; }
}
