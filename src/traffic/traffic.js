/* =====================================================================
   AI traffic: Intelligent Driver Model car-following on the lane graph,
   traffic signals, priority / right-hand rule / roundabout yielding,
   merging, keep-right lane changes and overtaking, buses at stops,
   tractors and snow ploughs. Spawns around the player.
   ===================================================================== */
import * as THREE from 'three';
import { VEHICLE } from '../vehicle/specs.js';
import { Fleet } from './fleet.js';
import { RNG, clamp, lerp, smoothstep, KMH, hashStr } from '../core/math.js';
import { settings } from '../core/settings.js';
import { extraSpecs } from './aimodels.js';

const CAR_COLORS = [0x1c1d1f, 0x1c1d1f, 0xe9e9e6, 0xe9e9e6, 0x9ba3aa, 0x9ba3aa, 0x5d646b, 0x5d646b, 0x24364d, 0x6e1e22, 0x2f4a3a, 0x8a8f86, 0xc7c9c4, 0x3a3326, 0x0e2a52, 0xb3462d];
let ID = 0;

class AICar {
  constructor(spec, kind, rng) {
    this.id = ID++;
    this.spec = spec;
    this.kind = kind;
    this.len = spec.body.L; this.width = spec.body.W;
    this.mass = spec.mass;
    this.color = kind === 'bus' ? rng.pick(spec.colors) : kind === 'plough' ? 0xff8a00 : kind === 'tractor' ? rng.pick([0x2b7a3b, 0xc63a1f, 0x1f56a8]) : rng.pick(CAR_COLORS);
    this.parts = spec.parts || null;
    this.factor = kind === 'car' ? rng.float(0.93, 1.12) : kind === 'moto' ? rng.float(1.0, 1.15) : rng.float(0.92, 1.0);
    this.vmaxType = kind === 'truck' ? 85 * KMH : kind === 'bus' ? 88 * KMH : kind === 'tractor' ? 30 * KMH : kind === 'plough' ? 55 * KMH : 200 * KMH;
    this.amax = kind === 'truck' ? 0.75 : kind === 'bus' ? 0.95 : kind === 'tractor' ? 0.6 : kind === 'moto' ? 2.6 : rng.float(1.2, 1.8);
    this.bcomf = kind === 'truck' || kind === 'bus' ? 1.7 : 2.2;
    this.T = kind === 'truck' ? 1.9 : rng.float(1.2, 1.8);
    this.s0 = 2.2;
    this.path = null; this.s = 0; this.v = 0; this.acc = 0;
    this.next = null; this.next2 = null;
    this.latOff = 0; this.lcT = 1; this.lcFrom = 0; this.lcCool = rng.float(2, 6);
    this.wait = 0; this.state = 'drive';
    this.ind = 0; this.blink = rng.float(0, 0.7);
    this.lights = { head: 1, brake: false, indL: false, indR: false, rev: false };
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0; this.pitch = 0; this.roll = 0; this.wheelAngle = 0; this.steer = 0;
    this.vx = 0; this.vz = 0;
    this.busStopT = 0; this.busServed = new Set();
    this.overtake = 0;
  }
  velocity() { return [this.vx, this.vz]; }
  hit(jx, jz, player) {
    const dvx = jx / this.mass, dvz = jz / this.mass;
    const dv = Math.hypot(dvx, dvz);
    this.hitBy = player;
    if (dv < 1.5 && this.state === 'drive') { this.v = Math.max(0, this.v - dv * 1.5); this.shaken = 3; return; }
    this.state = 'crashed';
    this.cvx = this.vx + dvx; this.cvz = this.vz + dvz;
    this.crashT = 0;
    this.yawRate = (Math.random() - 0.5) * dv * 0.4;
  }
}

export class Traffic {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.fleet = new Fleet(game.scene);
    this.cars = [];
    this.rng = new RNG(99);
    this.tmp = {}; this.tmp2 = {};
    this.player = { isPlayer: true, path: null, s: 0, v: 0, len: 4.6, width: 1.9 };
    this.spawnT = 0;
    this.extra = extraSpecs();
    this.buildIndex();
    this.peds = null;
  }

  /* ---------------- spatial index of lane paths ---------------- */
  buildIndex() {
    const C = this.cell = 64;
    this.grid = new Map();
    for (const p of this.world.paths) {
      const seen = new Set();
      for (let i = 0; i < p.n; i++) {
        const k = Math.floor(p.P[i * 3] / C) * 100003 + Math.floor(p.P[i * 3 + 2] / C);
        if (seen.has(k)) continue;
        seen.add(k);
        let l = this.grid.get(k); if (!l) { l = []; this.grid.set(k, l); }
        l.push([p, p.S[i]]);
      }
    }
  }
  pathsNear(x, z) { return this.grid.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell)) || []; }

  // closest point on path near a guess s
  project(p, s0, x, z) {
    let best = s0, bd = Infinity;
    const lo = Math.max(0, s0 - 40), hi = Math.min(p.len, s0 + 40);
    for (let s = lo; s <= hi; s += 2) { p.at(s, this.tmp2); const d = (this.tmp2.x - x) ** 2 + (this.tmp2.z - z) ** 2; if (d < bd) { bd = d; best = s; } }
    for (let s = best - 2; s <= best + 2; s += 0.25) { p.at(s, this.tmp2); const d = (this.tmp2.x - x) ** 2 + (this.tmp2.z - z) ** 2; if (d < bd) { bd = d; best = s; } }
    p.at(best, this.tmp2);
    const lat = (x - this.tmp2.x) * -this.tmp2.hz + (z - this.tmp2.z) * this.tmp2.hx;
    return { s: Math.max(0, Math.min(p.len, best)), d: Math.sqrt(bd), lat, hx: this.tmp2.hx, hz: this.tmp2.hz };
  }

  /* ---------------- player tracking ---------------- */
  trackPlayer() {
    const P = this.game.player;
    const A = this.player;
    if (A.path) { const i = A.path.vehicles.indexOf(A); if (i >= 0) A.path.vehicles.splice(i, 1); }
    A.path = null;
    if (!P) return;
    const ph = P.phys;
    const x = ph.p[0], z = ph.p[2];
    const f = ph.forward;
    A.len = P.spec.body.L; A.width = P.spec.body.W;
    A.v = Math.max(0, ph.fwdSpeed);
    A.x = x; A.z = z;
    let best = null, bd = 2.6;
    for (const [p, s] of this.pathsNear(x, z)) {
      const pr = this.project(p, s, x, z);
      if (pr.d > bd) continue;
      if (pr.hx * f[0] + pr.hz * f[2] < 0.5) continue;
      bd = pr.d; best = { p, s: pr.s };
    }
    if (best) { A.path = best.p; A.s = best.s; best.p.vehicles.push(A); }
  }

  /* ---------------- spawning ---------------- */
  desiredCount() {
    const env = this.game.env;
    const h = env.clock;
    let tod = h < 5 ? 0.25 : h < 6.5 ? 0.5 : h < 9 ? 1.3 : h < 15 ? 0.95 : h < 18 ? 1.3 : h < 21 ? 0.8 : 0.45;
    const city = this.game.placeKind === 'city' ? 1.25 : this.game.placeKind === 'village' ? 0.7 : 0.6;
    const q = this.game.qualityName === 'low' ? 0.55 : this.game.qualityName === 'medium' ? 0.8 : 1;
    return Math.round(64 * settings.traffic * tod * city * q);
  }
  pickType(path) {
    const r = path.road;
    const rng = this.rng;
    const T = r ? r.type : 'street';
    const season = this.game.season;
    if (T === 'motorway' || T === 'expressway' || T === 'primary') {
      if (season === 'winter' && rng.chance(0.03)) return 'plough';
      return rng.weighted(['car', 'truck', 'van', 'bus', 'moto'], [70, 16, 8, 2, season === 'winter' ? 0 : 3]);
    }
    if (T === 'avenue' || T === 'street') return rng.weighted(['car', 'van', 'bus', 'moto', 'truck'], [80, 8, r.type === 'avenue' ? 7 : 3, season === 'winter' ? 0 : 3, 2]);
    if (T === 'gravel' || T === 'local' || T === 'secondary') return rng.weighted(['car', 'tractor', 'van', 'truck', 'moto'], [80, season === 'winter' ? 0 : 6, 6, 4, season === 'winter' ? 0 : 2]);
    return rng.weighted(['car', 'van'], [92, 8]);
  }
  specFor(kind) {
    const rng = this.rng;
    if (kind === 'car') return VEHICLE[rng.weighted(['v7', '245', 'kompis', 'xc', 'lyra', 'kronstad', '900', 'pv'], [24, 10, 22, 18, 12, 5, 5, 1])];
    if (kind === 'van') return VEHICLE.van;
    if (kind === 'truck' || kind === 'plough') return kind === 'plough' ? this.extra.plough : VEHICLE.truck;
    if (kind === 'bus') return VEHICLE.bus;
    if (kind === 'moto') return this.extra.moto;
    if (kind === 'tractor') return this.extra.tractor;
    return VEHICLE.v7;
  }
  trySpawn() {
    const P = this.game.player;
    if (!P) return;
    const ph = P.phys;
    const cam = this.game.camera;
    const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
    for (let attempt = 0; attempt < 6; attempt++) {
      const ang = this.rng.float(0, Math.PI * 2);
      const dist = this.rng.float(170, 560);
      const x = ph.p[0] + Math.cos(ang) * dist, z = ph.p[2] + Math.sin(ang) * dist;
      const list = this.pathsNear(x, z);
      if (!list.length) continue;
      const [p, s] = list[Math.floor(this.rng.next() * list.length)];
      if (p.kind !== 'lane' || p.len < 30) continue;
      if (p.road && (p.road.type === 'rest' || p.road.type === 'service')) continue;
      if (s < 10 || s > p.len - 10) continue;
      p.at(s, this.tmp);
      const dx = this.tmp.x - ph.p[0], dz = this.tmp.z - ph.p[2];
      const d = Math.hypot(dx, dz);
      if (d < 150) continue;
      // avoid popping in view nearby
      const inView = (dx * fwd.x + dz * fwd.z) / d > 0.55;
      if (inView && d < 330) continue;
      // free space on the path
      if (p.vehicles.some((v) => Math.abs(v.s - s) < 35)) continue;
      const kind = this.pickType(p);
      const spec = this.specFor(kind);
      if (!spec) continue;
      const car = new AICar(spec, kind, this.rng);
      car.path = p; car.s = s; car.v = Math.min(p.speed * 0.85, car.vmaxType);
      if (!this.fleet.add(car)) continue;
      p.vehicles.push(car);
      this.cars.push(car);
      this.pose(car, 0);
      return;
    }
  }
  despawn(car) {
    if (car.path) { const i = car.path.vehicles.indexOf(car); if (i >= 0) car.path.vehicles.splice(i, 1); }
    this.fleet.remove(car);
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
  }

  /* ---------------- routing choices ---------------- */
  chooseExit(car, p) {
    const ex = p.exits;
    if (!ex.length) return null;
    if (ex.length === 1) return ex[0];
    // weights: prefer straight, and roads of similar class; buses and trucks avoid small roads
    let tot = 0;
    const w = ex.map((e) => {
      let k = e.turn === 'straight' ? 3 : e.turn === 'uturn' ? 0.02 : 1;
      const tgt = e.to.target || e.to;
      const r = tgt.road;
      if (r) {
        if ((car.kind === 'truck' || car.kind === 'bus' || car.kind === 'plough') && (r.type === 'residential' || r.type === 'gravel' || r.type === 'oldtown')) k *= 0.05;
        if (r.type === 'rest') k *= car.kind === 'truck' ? 0.4 : 0.15;
        if (p.road && r.prio > p.road.prio + 1) k *= 0.5;
        if (r.lanePathsF.length + r.lanePathsB.length === 0) k = 0;
      }
      if (e.to.diverge) k *= 0.25;
      tot += k;
      return k;
    });
    if (tot <= 0) return ex[0];
    let r = this.rng.next() * tot;
    for (let i = 0; i < ex.length; i++) { r -= w[i]; if (r <= 0) return ex[i]; }
    return ex[ex.length - 1];
  }

  /* ---------------- main update ---------------- */
  update(dt, game) {
    if (!game.player) return;
    dt = Math.min(dt, 0.1);
    this.trackPlayer();
    // keep path vehicle lists sorted
    const touched = new Set();
    for (const c of this.cars) if (c.path) touched.add(c.path);
    if (this.player.path) touched.add(this.player.path);
    for (const p of touched) p.vehicles.sort((a, b) => a.s - b.s);
    // spawn / despawn
    this.spawnT -= dt;
    const want = this.desiredCount();
    if (this.spawnT <= 0) {
      this.spawnT = 0.12;
      if (this.cars.length < want) this.trySpawn();
    }
    const ph = game.player.phys;
    const cam = game.camera.position;
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const d = Math.hypot(c.x - ph.p[0], c.z - ph.p[2]);
      if (d > 820 || (this.cars.length > want + 8 && d > 400) || (c.state === 'crashed' && c.crashT > 40 && d > 120)) { this.despawn(c); continue; }
    }
    for (const c of this.cars) this.step(c, dt);
    this.fleet.commit(this.cars);
  }

  step(c, dt) {
    if (c.state === 'crashed') { this.stepCrashed(c, dt); return; }
    if (!c.path) return;
    if (!c.next) c.next = this.chooseExit(c, c.path);
    // desired speed
    const p = c.path;
    let v0 = Math.min(p.speed * c.factor, c.vmaxType);
    if (c.kind === 'truck' && p.road && p.road.type !== 'motorway') v0 = Math.min(v0, 80 * KMH);
    if (c.kind === 'bus' && p.road && p.road.T.urban) v0 = Math.min(v0, 45 * KMH);
    const W = this.game.conditions;
    if (W.snow > 0.3 || W.ice > 0.2) v0 *= 0.82;
    if (W.wet > 0.5) v0 *= 0.95;
    if (this.game.env.weather.fog > 0.5) v0 *= 0.8;
    // curvature ahead
    const vc = this.curveSpeed(c);
    v0 = Math.min(v0, vc);
    v0 = Math.max(v0, 1);
    // leaders & stop lines
    let accel = c.amax * (1 - Math.pow(c.v / v0, 4));
    const lead = this.findLeader(c);
    if (lead) accel = Math.min(accel, this.idm(c, v0, lead.gap, lead.v));
    const stop = this.stopDistance(c, dt);
    if (stop != null) accel = Math.min(accel, this.idm(c, v0, Math.max(0.1, stop), 0));
    // bus stop dwell
    if (c.busStopT > 0) { c.busStopT -= dt; accel = Math.min(accel, -3); if (c.busStopT <= 0) { c.ind = -1; c.indT = 3; } }
    c.acc = clamp(accel, -8, c.amax);
    c.v = Math.max(0, c.v + c.acc * dt);
    if (c.v < 0.05 && c.acc < 0) c.v = 0;
    let ds = c.v * dt;
    c.s += ds;
    c.wheelAngle = (c.wheelAngle + ds / c.spec.tire.r) % (Math.PI * 2);
    // transitions
    let guard = 0;
    while (c.next && c.s >= c.next.atS && guard++ < 6) {
      const over = c.s - c.next.atS;
      const ex = c.next;
      this.moveTo(c, ex.to, (ex.toS || 0) + over);
      c.next = this.chooseExit(c, c.path);
    }
    if (!c.next && c.s >= c.path.len) { c.s = c.path.len; c.v = 0; c.stuck = (c.stuck || 0) + dt; if (c.stuck > 5) this.despawn(c); return; }
    // waiting bookkeeping
    if (c.v < 0.3) c.wait += dt; else c.wait = 0;
    this.laneChange(c, dt, lead);
    if (c.indT > 0) { c.indT -= dt; if (c.indT <= 0) c.ind = 0; }
    this.pose(c, dt);
  }
  stepCrashed(c, dt) {
    c.crashT += dt;
    const sp = Math.hypot(c.cvx, c.cvz);
    const dec = Math.min(sp, 6 * dt);
    if (sp > 0) { c.cvx -= c.cvx / sp * dec; c.cvz -= c.cvz / sp * dec; }
    c.x += c.cvx * dt; c.z += c.cvz * dt;
    c.yaw += (c.yawRate || 0) * dt; c.yawRate *= Math.exp(-dt * 1.5);
    c.vx = c.cvx; c.vz = c.cvz;
    c.y = this.game.terrain.groundAt(c.x, c.z) + c.spec.cgH;
    const o = { y: 0 };
    if (this.game.net.surfaceAt(c.x, c.z, c.y + 1, o)) c.y = Math.max(c.y, o.y + c.spec.cgH);
    c.lights.brake = false;
    const blink = (this.game.time * 1.5) % 1 < 0.5;
    c.lights.indL = c.lights.indR = blink;
    if (c.path) { const i = c.path.vehicles.indexOf(c); if (i >= 0) c.path.vehicles.splice(i, 1); c.path = null; }
  }
  moveTo(c, path, s) {
    if (c.path) { const i = c.path.vehicles.indexOf(c); if (i >= 0) c.path.vehicles.splice(i, 1); }
    c.path = path; c.s = s;
    path.vehicles.push(c);
    path.vehicles.sort((a, b) => a.s - b.s);
    // lane-change offset must not survive into connectors
    if (path.kind !== 'lane') { c.latOff = 0; c.lcT = 1; }
  }
  idm(c, v0, gap, vL) {
    const v = c.v;
    const ss = c.s0 + Math.max(0, v * c.T + (v * (v - vL)) / (2 * Math.sqrt(c.amax * c.bcomf)));
    return c.amax * (1 - Math.pow(v / v0, 4) - (ss / Math.max(gap, 0.1)) ** 2);
  }
  curveSpeed(c) {
    const p = c.path, t = this.tmp;
    p.at(c.s, t);
    const h0x = t.hx, h0z = t.hz;
    let look = clamp(c.v * 2.5, 15, 60);
    // look into the next path when close to the end
    let q = p, s = c.s + look;
    if (s > q.len && c.next) { s = (c.next.toS || 0) + (s - q.len); q = c.next.to; }
    q.at(Math.min(s, q.len), t);
    const dot = clamp(h0x * t.hx + h0z * t.hz, -1, 1);
    const ang = Math.acos(dot);
    if (ang < 0.02) return 99;
    const R = look / ang;
    return Math.sqrt(2.6 * R);
  }
  findLeader(c) {
    const L = c.path.vehicles;
    const idx = L.indexOf(c);
    const half = c.len / 2;
    for (let i = idx + 1; i < L.length; i++) {
      const o = L[i];
      if (o === c || (o.state && o.state === 'crashed')) continue;
      if (o.s < c.s) continue;
      return { gap: o.s - c.s - half - o.len / 2, v: o.v, o };
    }
    // follow into next paths
    let dist = c.path.len - c.s;
    let ex = c.next, guard = 0, path = c.path;
    while (ex && dist < 160 && guard++ < 4) {
      const q = ex.to;
      const s0 = ex.toS || 0;
      let best = null;
      for (const o of q.vehicles) { if (o !== c && o.s >= s0 - 1 && (!best || o.s < best.s)) best = o; }
      if (best) return { gap: dist + (best.s - s0) - half - best.len / 2, v: best.v, o: best };
      dist += q.len - s0;
      ex = q === c.next?.to && c.next2 ? c.next2 : q.exits.length === 1 ? q.exits[0] : q.exits.find((e) => e.turn === 'straight') || q.exits[0];
      path = q;
    }
    // obstacle check: the player car anywhere in front within the lane corridor
    const A = this.player;
    if (A.x != null && this.game.player) {
      const t = this.tmp;
      c.path.at(c.s, t);
      const dx = A.x - c.x, dz = A.z - c.z;
      const lon = dx * t.hx + dz * t.hz, lat = dx * -t.hz + dz * t.hx;
      if (lon > 0 && lon < 60 && Math.abs(lat - c.latOff) < (c.width + A.width) / 2 + 0.4) {
        return { gap: lon - half - A.len / 2, v: Math.max(0, this.game.player.phys.fwdSpeed * 0.5), o: A };
      }
    }
    return null;
  }

  /* Distance to a point where the car must stop (signal, yield, roundabout, merge, crossing) or null. */
  stopDistance(c, dt) {
    const p = c.path;
    const toEnd = p.len - c.s;
    const ex = c.next;
    if (!ex) return toEnd - 1;
    const conn = ex.to;
    // pedestrians on the crossing just ahead
    if (this.peds && p.kind === 'lane' && toEnd < 30) {
      const cw = this.peds.blockingCrossing(c, p, toEnd);
      if (cw != null) return cw;
    }
    if (p.kind === 'conn' && p.merge && toEnd < 45) {
      if (!this.mergeGapOK(c, p)) return toEnd - 2;
    }
    if (p.kind === 'conn' && p.target && this.peds) {
      const cw = this.peds.blockingExitCrossing(c, p);
      if (cw != null) return cw;
    }
    const ctl = p.control;
    if (!ctl || toEnd > 90) return null;
    const v = c.v;
    if (ctl.type === 'signal') {
      const st = ctl.node.signal.state(ctl.group);
      if (st === 'red' || st === 'redamber') return toEnd - 0.5;
      if (st === 'amber') { if (toEnd > (v * v) / (2 * 3.5) + 2) return toEnd - 0.5; return null; }
      // green: left turns yield to oncoming
      if (conn.yieldTo && conn.yieldTo.length && toEnd < 40 && this.mustYield(c, conn)) return toEnd - 0.5;
      return null;
    }
    if (ctl.type === 'roundabout') {
      if (toEnd > 35) return null;
      if (this.ringBusy(c, conn)) { c.yielding = true; return toEnd - 0.5; }
      c.yielding = false;
      return null;
    }
    // priority / right-hand rule
    if (conn.yieldTo && conn.yieldTo.length && toEnd < 45) {
      if (this.mustYield(c, conn)) {
        if (c.wait > 7 && !this.conflictOccupied(conn)) return null; // break deadlocks politely
        return toEnd - 0.5;
      }
    }
    return null;
  }
  approachInfo(o, Y) {
    // time for vehicle o (on Y.from, heading for Y) to reach the junction
    const from = Y.from;
    const d = from.len - o.s;
    return { d, t: d / Math.max(o.v, 0.5) };
  }
  mustYield(c, conn) {
    for (const y of conn.yieldTo) {
      const Y = y.path;
      // somebody inside the conflicting connector before the conflict point
      for (const o of Y.vehicles) if (o !== c && o.s < y.os + 2) return true;
      // somebody approaching on its feeding lane
      const F = Y.from;
      if (!F) continue;
      for (const o of F.vehicles) {
        if (o === c) continue;
        const willUse = o.isPlayer ? true : o.next && o.next.to === Y;
        if (!willUse) continue;
        const d = F.len - o.s;
        if (d > 70) continue;
        const v = o.v;
        if (v < 0.5 && d > 6) continue; // waiting at their own line
        const t = d / Math.max(v, 0.5);
        if (t < 4.5) return true;
      }
    }
    return false;
  }
  conflictOccupied(conn) {
    for (const y of conn.conflicts || []) for (const o of y.path.vehicles) if (o.s < y.os + 2) return true;
    return false;
  }
  ringBusy(c, conn) {
    const arcs = conn.yieldRing || [];
    for (let k = 0; k < arcs.length; k++) {
      const a = arcs[k];
      for (const o of a.vehicles) {
        if (o === c) continue;
        const d = a.len - o.s + (k === 0 ? 0 : arcs[0].len);
        if (d < 22) return true;
      }
    }
    return false;
  }
  mergeGapOK(c, conn) {
    const T = conn.target;
    const sM = conn.targetS || 0;
    for (const o of T.vehicles) {
      if (o === c) continue;
      const rel = o.s - sM;
      const need = 8 + o.v * 1.6;
      if (rel > -need && rel < 10) return false;
    }
    return true;
  }

  /* ---------------- lane changes ---------------- */
  laneChange(c, dt, lead) {
    if (c.lcT < 1) {
      c.lcT = Math.min(1, c.lcT + dt / 3.2);
      c.latOff = c.lcFrom * (1 - smoothstep(0, 1, c.lcT));
      if (c.lcT >= 1) { c.latOff = 0; c.ind = 0; }
      return;
    }
    c.lcCool -= dt;
    const p = c.path;
    if (p.kind !== 'lane' || c.lcCool > 0 || c.kind === 'tractor') return;
    const toEnd = p.len - c.s;
    let target = null, dir = 0;
    // mandatory: lane ends ahead
    if (p.endsAt === 'merge' && toEnd < 260 && p.right) { target = p.right; dir = 1; }
    // keep right when the right lane is free
    else if (p.right && !p.right.lateStart && toEnd > 80 && (!lead || lead.gap > 60)) { target = p.right; dir = 1; }
    // overtake slower leader
    else if (p.left && lead && lead.gap < 50 && lead.v < c.v * 0.9 + 0.5 && lead.v < p.speed * c.factor - 2.5 && toEnd > 120) { target = p.left; dir = -1; }
    if (!target) return;
    const rs = p.roadSAt(c.s);
    const sT = target.sAtRoadS(rs);
    if (sT < 5 || sT > target.len - 40) return;
    // safety: gap behind and ahead on target lane
    for (const o of target.vehicles) {
      const rel = o.s - sT;
      if (rel > -(8 + o.v * 1.4) && rel < 12 + c.len) { c.lcCool = 1.5; return; }
      if (rel > 0 && rel < 40 && o.v < c.v - 3) { c.lcCool = 1.5; return; }
    }
    // perform
    const w = p.road ? p.road.xs.w : 3.4;
    this.moveTo(c, target, sT);
    c.next = null;
    c.lcFrom = dir < 0 ? w : -w; // currently to the right (+) or left (-) of the new lane
    c.latOff = c.lcFrom;
    c.lcT = 0;
    c.lcCool = 6 + this.rng.float(0, 6);
    c.ind = dir; c.indT = 3.5;
  }

  /* ---------------- pose ---------------- */
  pose(c, dt) {
    const t = this.tmp;
    const p = c.path;
    p.at(c.s, t);
    const nx = -t.hz, nz = t.hx;
    const x = t.x + nx * c.latOff, z = t.z + nz * c.latOff;
    c.vx = t.hx * c.v; c.vz = t.hz * c.v;
    c.x = x; c.z = z;
    c.y = t.y + c.spec.cgH + 0.02;
    let yaw = Math.atan2(-t.hx, -t.hz);
    if (c.lcT < 1) yaw += (c.lcFrom > 0 ? 1 : -1) * Math.sin(Math.PI * c.lcT) * 0.06;
    c.yaw = yaw;
    c.pitch = Math.atan(t.grade || 0);
    c.roll = 0;
    // steering angle for the front wheels from path curvature
    p.at(c.s + 4, this.tmp2);
    const cr = t.hx * this.tmp2.hz - t.hz * this.tmp2.hx;
    c.steer = clamp(Math.asin(clamp(cr, -1, 1)) * c.spec.body.wb / 4 * 2.2, -0.6, 0.6);
    // indicators: upcoming turn
    const toEnd = p.len - c.s;
    if (c.ind === 0 && c.next && toEnd < 55 && p.kind === 'lane') {
      const tn = c.next.to.turn || c.next.turn;
      if (tn === 'left') c.ind = -1, c.indT = 6;
      else if (tn === 'right' && !c.next.to.ringEntry) c.ind = 1, c.indT = 6;
    }
    if (p.kind === 'ring' && c.next && c.next.to.ringExit && p.len - c.s < 15) { c.ind = 1; c.indT = 2.5; }
    c.blink += dt;
    const on = c.blink % 0.72 < 0.36;
    c.lights.indL = c.ind === -1 && on; c.lights.indR = c.ind === 1 && on;
    c.lights.brake = c.acc < -0.9 || c.v < 0.3;
    const env = this.game.env;
    c.lights.head = env.night > 0.2 || env.daylight < 0.5 || env.weather.fog > 0.3 || env.weather.rain > 0.4 ? 1 : 0;
    if (c.kind === 'plough') { c.lights.indL = c.lights.indR = (this.game.time * 2) % 1 < 0.3; }
  }

  /* ---------------- queries for the player ---------------- */
  boxesNear(x, z, r) {
    const out = this._boxes || (this._boxes = []);
    out.length = 0;
    for (const c of this.cars) {
      if (Math.abs(c.x - x) > r || Math.abs(c.z - z) > r) continue;
      // obb: width axis = right of heading
      const rot = Math.atan2(Math.cos(c.yaw), -Math.sin(c.yaw)) * 0 + (-c.yaw);
      out.push({ type: 'obb', x: c.x, z: c.z, hw: c.width / 2, hd: c.len / 2, rot: -c.yaw, y0: c.y - c.spec.cgH, y1: c.y - c.spec.cgH + c.spec.body.H, ref: c });
    }
    return out;
  }
  leaderGap(player) {
    const A = this.player;
    if (!A.path) return null;
    const L = A.path.vehicles;
    const i = L.indexOf(A);
    for (let k = i + 1; k < L.length; k++) if (L[k] !== A) return { dist: L[k].s - A.s - L[k].len / 2 - A.len / 2, speed: L[k].v };
    return null;
  }
  clear() { for (const c of this.cars.slice()) this.despawn(c); }
}
