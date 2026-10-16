/* =====================================================================
   Wildlife on rural roads: moose (älg) and roe deer (rådjur). They step
   out of the forest ahead of the player, mostly at dawn, dusk and night,
   cross slowly (moose sometimes stop on the road). AI drivers brake for
   them; hitting one is a heavy, damaging collision.
   ===================================================================== */
import * as THREE from 'three';
import { clamp, RNG } from '../core/math.js';
import { forestDensity } from '../render/landcover.js';
import { t } from '../core/i18n.js';

const RURAL = new Set(['primary', 'secondary', 'local', 'gravel', 'expressway']);
const SPEC = {
  moose: { L: 2.7, W: 0.75, H: 2.05, mass: 450, v: 1.3, color: 0x3a2a1f, leg: 0x6b5a4a, legLen: 1.05 },
  deer: { L: 1.15, W: 0.35, H: 0.95, mass: 25, v: 2.2, color: 0x8a5a36, leg: 0x7a5a3e, legLen: 0.5 },
};

function animalGeometry(kind) {
  const S = SPEC[kind];
  const g = [];
  const box = (w, h, d, x, y, z, rx = 0) => { const b = new THREE.BoxGeometry(w, h, d); if (rx) b.rotateX(rx); b.translate(x, y, z); g.push(b); };
  if (kind === 'moose') {
    box(0.72, 0.85, 1.75, 0, 1.55, 0);            // body
    box(0.66, 0.5, 0.7, 0, 1.92, 0.5);            // shoulder hump
    box(0.32, 0.38, 0.75, 0, 1.95, 1.05, -0.75);  // neck
    box(0.3, 0.32, 0.62, 0, 1.9, 1.48, 0.35);     // head
    box(0.22, 0.22, 0.24, 0, 1.75, 1.75, 0.35);   // muzzle
    box(0.08, 0.3, 0.12, 0, 1.55, 1.45);          // bell
  } else {
    box(0.32, 0.36, 0.82, 0, 0.72, 0);
    box(0.13, 0.42, 0.14, 0, 0.98, 0.42, -0.5);
    box(0.13, 0.15, 0.3, 0, 1.16, 0.55, 0.25);
    box(0.06, 0.12, 0.04, -0.06, 1.28, 0.48); box(0.06, 0.12, 0.04, 0.06, 1.28, 0.48);
  }
  return merge(g);
}
function antlerGeometry() {
  const g = [];
  for (const sx of [-1, 1]) {
    const palm = new THREE.BoxGeometry(0.62, 0.06, 0.34); palm.rotateZ(sx * 0.35); palm.translate(sx * 0.38, 2.22, 1.32); g.push(palm);
    for (let k = 0; k < 4; k++) { const tine = new THREE.BoxGeometry(0.04, 0.18, 0.04); tine.translate(sx * (0.5 + k * 0.05), 2.36, 1.2 + k * 0.08); g.push(tine); }
  }
  return merge(g);
}
function merge(list) {
  const L = list.map((x) => (x.index ? x.toNonIndexed() : x));
  let n = 0; for (const x of L) n += x.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0; for (const x of L) { pos.set(x.attributes.position.array, o * 3); nor.set(x.attributes.normal.array, o * 3); o += x.attributes.position.count; }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

export class Wildlife {
  constructor(game) {
    this.game = game;
    this.net = game.net;
    this.rng = new RNG(911);
    this.list = [];
    this.timer = 20;
    this.warned = new WeakSet();
    this.meshes = {};
    for (const kind of ['moose', 'deer']) {
      const S = SPEC[kind];
      const body = new THREE.InstancedMesh(animalGeometry(kind), new THREE.MeshStandardMaterial({ color: S.color, roughness: 0.95 }), 4);
      const leg = new THREE.InstancedMesh(new THREE.BoxGeometry(kind === 'moose' ? 0.11 : 0.06, S.legLen, kind === 'moose' ? 0.13 : 0.07).translate(0, -S.legLen / 2, 0), new THREE.MeshStandardMaterial({ color: S.leg, roughness: 0.95 }), 16);
      for (const m of [body, leg]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; m.castShadow = true; game.scene.add(m); }
      this.meshes[kind] = { body, leg };
    }
    this.antlers = new THREE.InstancedMesh(antlerGeometry(), new THREE.MeshStandardMaterial({ color: 0xcdbb98, roughness: 0.8 }), 4);
    this.antlers.count = 0; this.antlers.frustumCulled = false; game.scene.add(this.antlers);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(0, 0, 0, 'YXZ'); this.v = new THREE.Vector3(); this.one = new THREE.Vector3(1, 1, 1);
    if (game.traffic) game.traffic.wildlife = this;
  }

  /* chance per check that an animal appears, by time of day and season */
  activity() {
    const env = this.game.env;
    const h = env.clock;
    const sunE = env.sunDir ? env.sunDir.y : 0.3;
    const twilight = sunE > -0.2 && sunE < 0.15 ? 1 : 0;
    const night = env.night;
    const day = this.game.env.day;
    const rut = day > 255 && day < 300 ? 1.5 : 1; // autumn moose rut & hunting season
    return (0.25 + twilight * 1.2 + night * 0.7) * rut * (h > 10 && h < 15 ? 0.6 : 1);
  }

  /* walk `dist` metres along the road network from (r, s) in direction dir */
  ahead(r, s, dir, dist) {
    for (let hop = 0; hop < 6; hop++) {
      const rem = dir > 0 ? r.len - r.trimB - s : s - r.trimA;
      if (dist <= rem) return { r, s: s + dir * dist };
      dist -= Math.max(0, rem);
      const node = dir > 0 ? r.b : r.a;
      const i = dir > 0 ? r.n - 2 : 0;
      const hx = r.TX[i] * dir, hz = r.TZ[i] * dir;
      let best = null, bd = -0.3;
      for (const e of node.ends) {
        if (e.road === r) continue;
        const q = e.road, j = e.atStart ? 0 : q.n - 2, sg = e.atStart ? 1 : -1;
        const dot = q.TX[j] * sg * hx + q.TZ[j] * sg * hz;
        if (dot > bd) { bd = dot; best = e; }
      }
      if (!best || !RURAL.has(best.road.type)) return null;
      r = best.road; dir = best.atStart ? 1 : -1; s = best.atStart ? r.trimA : r.len - r.trimB;
    }
    return null;
  }

  trySpawn(force = false) {
    const g = this.game, P = g.player;
    const ph = P.phys;
    const ri = P.roadInfo;
    if (!ri || !ri.road || !RURAL.has(ri.road.type) || g.placeKind === 'city') return false;
    const r0 = ri.road;
    const i = Math.min(r0.n - 2, Math.max(0, ri.i));
    const fwd = r0.TX[i] * ph.forward[0] + r0.TZ[i] * ph.forward[2] > 0 ? 1 : -1;
    for (const dist of [this.rng.float(220, 320), this.rng.float(150, 220), this.rng.float(100, 150)]) {
      const A0 = this.ahead(r0, ri.s, fwd, dist);
      if (!A0) continue;
      const r = A0.r, s = A0.s;
      if (s < r.trimA + 10 || s > r.len - r.trimB - 10) continue;
      const side = this.rng.chance(0.5) ? 1 : -1;
      const startD = side * (r.xs.halfW + this.rng.float(3, 8));
      const p = this.net.pointAt(r, s, startD);
      const h = g.terrain.height(p[0], p[2]);
      const forest = forestDensity(p[0], p[2], h);
      // moose keep to the forest; roe deer also graze along field edges
      const kind = forest > 0.25 && this.rng.chance(0.5) ? 'moose' : 'deer';
      if (forest < 0.25 && !force && !this.rng.chance(0.35)) continue;
      const n = kind === 'deer' && this.rng.chance(0.45) ? 2 : 1;
      for (let k = 0; k < n; k++) {
        this.list.push({
          kind, road: r, s: s + k * this.rng.float(2, 5), d: startD + side * k * 2, side, dir: -side, // crossing towards the other side
          v: SPEC[kind].v * this.rng.float(0.8, 1.2), phase: 0, x: p[0], y: h, z: p[2], yaw: 0, state: 'enter', pause: kind === 'moose' && this.rng.chance(0.45) ? this.rng.float(2, 7) : 0,
          bull: kind === 'moose' && this.rng.chance(0.5) && (g.env.day > 200 || g.env.day < 50), hit: false, vy: 0, vx: 0, vz: 0, rot: 0, t: 0,
        });
      }
      return true;
    }
    return false;
  }

  update(dt, game) {
    const P = game.player;
    if (!P || game.paused || game.inMenu) { this.render(); return; }
    const ph = P.phys;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.rng.float(18, 40);
      if (this.list.length < 3 && Math.abs(ph.speed) > 8 && this.rng.next() < 0.35 * this.activity()) this.trySpawn();
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const A = this.list[i];
      const S = SPEC[A.kind];
      if (A.hit) {
        // thrown by an impact
        A.t += dt;
        A.vy -= 9.81 * dt; A.x += A.vx * dt; A.y += A.vy * dt; A.z += A.vz * dt; A.rot += dt * 2.5;
        const gy = game.terrain.height(A.x, A.z);
        if (A.y < gy) { A.y = gy; A.vx *= 0.5; A.vz *= 0.5; A.vy = 0; }
        if (A.t > 25) this.list.splice(i, 1);
        continue;
      }
      const r = A.road;
      const far = r.xs.halfW + 6;
      if (A.state === 'enter' || A.state === 'cross') {
        if (A.state === 'enter' && Math.abs(A.d) < r.xs.halfW + 1) A.state = 'cross';
        let v = A.v;
        if (A.pause > 0 && A.state === 'cross' && Math.abs(A.d) < 1.5) { A.pause -= dt; v = 0; }
        // startled by a close, fast car: hurry
        const dp = Math.hypot(ph.p[0] - A.x, ph.p[2] - A.z);
        if (dp < 30 && Math.abs(ph.speed) > 5 && A.pause <= 0) v *= A.kind === 'deer' ? 2.6 : 1.4;
        A.d += A.dir * v * dt;
        A.phase += dt * v * (A.kind === 'moose' ? 2.6 : 5);
        if (A.dir * A.d > far) A.state = 'leave';
      } else {
        A.d += A.dir * A.v * dt; A.phase += dt * A.v * 3;
        if (A.dir * A.d > far + 25) { this.list.splice(i, 1); continue; }
      }
      const p = this.net.pointAt(r, A.s, A.d);
      A.x = p[0]; A.z = p[2];
      A.y = Math.abs(A.d) < r.xs.halfW ? p[1] : game.terrain.height(p[0], p[2]);
      const k = Math.min(r.n - 2, Math.max(0, Math.floor(A.s / 4)));
      A.yaw = Math.atan2(A.dir * -r.TZ[k], A.dir * r.TX[k]);
      // warning when one is on or next to the road ahead
      const dx = A.x - ph.p[0], dz = A.z - ph.p[2], dist = Math.hypot(dx, dz);
      if (!this.warned.has(A) && dist < 140 && (dx * ph.forward[0] + dz * ph.forward[2]) > 0 && Math.abs(A.d) < r.xs.halfW + 3) {
        this.warned.add(A);
        if (game.app && game.app.hud) game.app.hud.flash('⚠ ' + t(A.kind === 'moose' ? 'moose' : 'deer'), 2.5, 'warn');
      }
      // collision with the player
      if (dist < S.L * 0.5 + P.spec.body.L * 0.5) this.checkHit(A, P);
      if (dist > 700) this.list.splice(i, 1);
    }
    this.render();
  }

  checkHit(A, P) {
    const ph = P.phys, S = SPEC[A.kind];
    // car footprint (oriented box) vs animal centre with its half width
    const dx = A.x - ph.p[0], dz = A.z - ph.p[2];
    const f = ph.forward, r = ph.right;
    const lz = dx * f[0] + dz * f[2], lx = dx * r[0] + dz * r[2];
    const reachL = P.spec.body.L / 2 + S.W * 0.5, reachW = P.spec.body.W / 2 + S.L * 0.35;
    if (Math.abs(lz) > reachL || Math.abs(lx) > reachW) return;
    const vr = ph.v[0] * f[0] + ph.v[2] * f[2];
    const speed = Math.abs(ph.speed);
    if (speed < 1) return;
    A.hit = true;
    const mc = ph.m, ma = S.mass;
    // momentum exchange along the car's direction (inelastic-ish)
    const dv = vr * ma / (mc + ma) * 1.4;
    ph.applyImpulse(-f[0] * dv * mc, 0, -f[2] * dv * mc, ph.p[0] + f[0] * P.spec.body.L * 0.45, ph.p[1] + (A.kind === 'moose' ? 0.6 : 0), ph.p[2] + f[2] * P.spec.body.L * 0.45);
    const D = ph.damage;
    const sev = clamp(speed / 25, 0, 1.5) * (A.kind === 'moose' ? 1 : 0.25);
    D.front = clamp(D.front + sev * 0.7, 0, 1);
    D.body = clamp((D.body || 0) + sev * 0.3, 0, 1);
    if (A.kind === 'moose') { D.glass = clamp(D.glass + sev * 0.9, 0, 1); D.engine = clamp(D.engine + sev * 0.35, 0, 1); }
    A.vx = ph.v[0] * 0.6 + f[0] * 2; A.vz = ph.v[2] * 0.6 + f[2] * 2; A.vy = A.kind === 'moose' ? 2.5 : 4; A.t = 0;
    P.impacts.push({ speed: speed * (A.kind === 'moose' ? 1 : 0.4), x: A.x, z: A.z, kind: 'animal', lx: 0, lz: 1 });
    if (this.game.app && this.game.app.hud) this.game.app.hud.flash(t('collision'), 2, 'warn');
  }

  /* AI drivers: stop for animals on the road ahead */
  blockingAhead(c) {
    for (const A of this.list) {
      if (A.hit || Math.abs(A.d) > A.road.xs.halfW + 1.5) continue;
      const dx = A.x - c.x, dz = A.z - c.z;
      if (Math.abs(dx) > 80 || Math.abs(dz) > 80 || !c.path) continue;
      const tp = c.path.at(c.s, this.tmp || (this.tmp = {}));
      const hx = tp.hx, hz = tp.hz;
      const along = dx * hx + dz * hz, lat = Math.abs(-dx * hz + dz * hx);
      if (along > 0 && along < 70 && lat < 3.5) return along - 7;
    }
    return null;
  }

  render() {
    const m = this.m, q = this.q, e = this.e, v = this.v;
    const counts = { moose: 0, deer: 0 }, legs = { moose: 0, deer: 0 };
    let ant = 0;
    for (const A of this.list) {
      const M = this.meshes[A.kind], S = SPEC[A.kind];
      if (counts[A.kind] >= 4) continue;
      const base = new THREE.Matrix4().compose(v.set(A.x, A.y, A.z), q.setFromEuler(e.set(0, A.yaw, A.hit ? A.rot : 0)), this.one);
      M.body.setMatrixAt(counts[A.kind]++, base);
      if (A.bull) this.antlers.setMatrixAt(ant++, base);
      const sw = Math.sin(A.phase) * (A.kind === 'moose' ? 0.35 : 0.5);
      const hl = S.L * (A.kind === 'moose' ? 0.32 : 0.36), hw = S.W * 0.32, hy = S.legLen + (A.kind === 'moose' ? 0.08 : 0.05);
      for (const [lx, lz, ph] of [[-hw, hl, 1], [hw, hl, -1], [-hw, -hl, -1], [hw, -hl, 1]]) {
        const loc = new THREE.Matrix4().compose(v.set(lx, hy, lz), q.setFromEuler(e.set(sw * ph, 0, 0)), this.one);
        M.leg.setMatrixAt(legs[A.kind]++, m.multiplyMatrices(base, loc));
      }
    }
    for (const k in this.meshes) {
      const M = this.meshes[k];
      M.body.count = counts[k]; M.leg.count = legs[k];
      M.body.instanceMatrix.needsUpdate = true; M.leg.instanceMatrix.needsUpdate = true;
    }
    this.antlers.count = ant; this.antlers.instanceMatrix.needsUpdate = true;
  }
  clear() { this.list.length = 0; }
}
